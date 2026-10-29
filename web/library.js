'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let books = [];
let groups = [];
const API='/reading/api';
async function api(path,options={}){
 const response=await fetch(API+path,options);
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(result.error||`请求失败 (${response.status})`);
 return result;
}
async function loadLibrary(){
 const [listed,library]=await Promise.all([api('/books'),api('/library')]);
 books=listed.books.map(b=>({id:b.bookId,title:b.title,author:b.author,status:b.status,removed:b.removed,progress:Math.round(b.progressPct),hasCover:b.hasCover}));
 groups=library.groups;
 render();routeBookPage();
}
async function setBookStatus(book,status){
 await api('/library/book/'+encodeURIComponent(book.id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
 book.status=status;
 render();
}
const detailViews=new Map(),detailCache=new Map();
let detailRequest=0,passageLookup=false;
function detailView(id){if(!detailViews.has(id))detailViews.set(id,{query:'',tab:'annotations',scroll:0});return detailViews.get(id);}
let filter = 'reading';
let selectedGroup = '';
let query = '';
let currentBook = null;
let editingGroup = null;
let toastTimer;
let currentDetailTab='annotations';let readingFrameKey='';let readerReturnBookId='';let directReaderReady=false;let readerSession=null;
const people={human:{name:'读者',avatarUrl:'',initial:'读'},companion:{name:'共读者',avatarUrl:'',initial:'伴'}};
const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function detailAvatar(author){const person=author==='human'?people.human:people.companion;return `<span class="note-avatar">${person.avatarUrl?`<img src="${esc(person.avatarUrl)}" alt="" onerror="this.style.display='none'">`:''}<span>${person.initial}</span></span>`;}
function detailRoot(item){const comments=item.comments||[],first=comments[0],direct=String(item.note||item.comment||'').trim();const hasFirst=!direct&&first?.author===item.createdBy&&first.kind!=='reply';return{text:direct||String(hasFirst?first.text||'':'').trim(),at:hasFirst?first.createdAt||item.createdAt:item.createdAt,replies:hasFirst?comments.slice(1):comments.filter(c=>c.kind==='reply')};}
function detailSelectionKey(item){return Number.isInteger(item.seq)&&Number.isInteger(item.startOff)&&Number.isInteger(item.endOff)?`${item.seq}:${item.startOff}:${item.endOff}`:`id:${item.id}`;}
const statusLabels = {reading:'在读',finished:'已读',unread:'未开始'};
const readDate = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '还没开始';
function readDuration(ms){const min=Math.round((Number(ms)||0)/60000);return min<1?'尚未记录':min<60?`${min} 分钟`:`${Math.floor(min/60)} 小时 ${min%60} 分钟`;}
function toast(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),1800);}
function closePopovers(){document.querySelectorAll(':popover-open').forEach(e=>e.hidePopover());}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(e=>e.close());}
function openDialog(id){closePopovers();closeDialogs();$('#'+id).showModal();}
function syncHostSheet(){
 if(document.documentElement.dataset.homeHosted!=='1')return;
 const open=document.body.dataset.booksSheet==='open'||!!document.querySelector(':popover-open,dialog[open]');
 const mask=getComputedStyle(document.documentElement).getPropertyValue('--books-sheet-mask').trim()||'rgba(0, 0, 0, 0.45)';
 window.parent.postMessage({type:'guichao-books:sheet',open,mask},location.origin);
}
new MutationObserver(syncHostSheet).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
function placePopover(popover,button){
 const width=parseFloat(getComputedStyle(popover).width)||popover.offsetWidth;
 if(popover.id==='add-menu'&&document.documentElement.dataset.homeHosted==='1'){
  popover.style.top='12px';
  popover.style.left=Math.max(12,innerWidth-width-24)+'px';
  return;
 }
 const r=button.getBoundingClientRect();
 popover.style.top=(r.bottom+7)+'px';
 popover.style.left=Math.max(12,Math.min(r.right-width,innerWidth-width-12))+'px';
}
function prepareImport(){
 $('#import-group').value=selectedGroup;
 $('#import-group-current').textContent=groups.find(group=>group.id===selectedGroup)?.name||'暂不分组';
 $$('#import-group-options button').forEach(button=>button.setAttribute('aria-current',String(button.dataset.importGroup===selectedGroup)));
}
for(const [buttonId,menuId] of [['add-toggle','add-menu'],['group-toggle','group-menu']]){
 const button=$('#'+buttonId),menu=$('#'+menuId);
 menu.addEventListener('beforetoggle',event=>{if(event.newState==='open'){if(buttonId==='add-toggle')prepareImport();placePopover(menu,button);}});
 menu.addEventListener('toggle',event=>{const open=event.newState==='open';button.setAttribute('aria-expanded',String(open));syncHostSheet();if(buttonId==='add-toggle'){
  button.setAttribute('aria-label',open?'收起添加面板':'添加');
  if(document.documentElement.dataset.homeHosted==='1')window.parent.postMessage({type:'guichao-books:import-state',open},location.origin);
 }});
}
window.addEventListener('resize',closePopovers);
window.addEventListener('scroll',closePopovers,{passive:true});
function render(){
 const active=books.filter(b=>!b.removed),group=groups.find(g=>g.id===selectedGroup);
 const shown=active.filter(b=>b.status===filter&&(!group||group.books.includes(b.id))&&(!query||`${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase())));
 $('#total-count').textContent=active.length+' 本书';$('#view-count').textContent=shown.length+' 本';$('#view-label').textContent=group?group.name:filter==='reading'?'正在阅读':filter==='unread'?'尚未开始':'已经读完';
 $('#book-grid').innerHTML=shown.map(b=>`<button class="book-card" data-book="${b.id}" aria-label="查看《${esc(b.title)}》"><span class="cover-wrap">${b.hasCover?`<img src="${API}/cover/${b.id}" alt="《${esc(b.title)}》封面">`:`<span class="cover-placeholder">${esc(b.title)}</span>`}</span><span class="book-title">${esc(b.title)}</span><span class="book-author">${esc(b.author)}</span><span class="book-meta"><span>${statusLabels[b.status]}</span><span>${b.progress?b.progress+'%':''}</span></span><span class="progress"><span style="width:${b.progress}%"></span></span></button>`).join('');
 const carousel=filter==='reading'&&shown.length>0;
 $('#book-grid').hidden=filter==='reading';$('#reading-view').hidden=!carousel;$('#view-label').parentElement.hidden=filter==='reading';document.body.classList.toggle('shelf-view',filter==='reading');
 if(carousel&&!document.body.classList.contains('book-page-open')&&!document.body.classList.contains('reader-detail'))refreshReadingFrame(shown);
 $('#empty-state').hidden=shown.length>0;$('#empty-text').textContent=query?'没有找到这本书':group?'这个分组还空着':'这里还没有书';
 $('#group-menu').innerHTML=`<div class="menu-caption">分组</div><button data-group=""><i class="icon ${!selectedGroup?'check':'folder'}" aria-hidden="true"></i><span>全部分组</span><span class="group-count">${active.length}</span></button>`+groups.map(g=>`<div class="group-option"><button data-group="${g.id}"><i class="icon ${g.id===selectedGroup?'check':'folder'}" aria-hidden="true"></i><span>${esc(g.name)}</span><span class="group-count">${g.books.filter(id=>active.some(b=>b.id===id)).length}</span></button><button class="icon-button" data-edit-group="${g.id}" aria-label="整理分组 ${esc(g.name)}"><i class="icon edit" aria-hidden="true"></i></button></div>`).join('')+'<button data-action="new-group"><i class="icon plus" aria-hidden="true"></i>新建分组</button><div class="divider"></div><button data-action="trash"><i class="icon trash" aria-hidden="true"></i>回收站</button>';
 const importGroup=$('#import-group').value;
 $('#import-group').value=groups.some(g=>g.id===importGroup)?importGroup:selectedGroup;
 $('#import-group-current').textContent=groups.find(g=>g.id===$('#import-group').value)?.name||'暂不分组';
 $('#import-group-options').innerHTML=[{id:'',name:'暂不分组'},...groups].map(g=>`<button type="button" data-import-group="${g.id}" aria-current="${g.id===$('#import-group').value}">${esc(g.name)}</button>`).join('');
 $$('.segments button').forEach(b=>{const selected=b.dataset.status===filter;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});$('.segments').style.setProperty('--selected-tab',['reading','unread','finished'].indexOf(filter));
}
function refreshReadingFrame(shown,openId='',passage=null){
 const ids=shown.map(b=>b.id).join(',');const key=ids+'|'+openId+'|'+JSON.stringify(passage);if(readingFrameKey===key)return;readingFrameKey=key;
 document.body.classList.add('reader-frame-loading');
 $('#original-reader').src='/reading/?hosted=1&library=1&ids='+encodeURIComponent(ids)+(openId?'&open='+encodeURIComponent(openId):'')+(passage?'&chapter='+passage.chapter+'&seq='+passage.seq:'');
}
async function readPosition(bookId){
 const response=await fetch('/reading/api/book/'+bookId);
 if(!response.ok)throw new Error('reading position unavailable');
 const detail=await response.json();
 return {end:Number(detail.lastPos?.seqEnd??detail.lastPos?.seqTop??-1),last:Number(detail.manifest.paraCount)-1};
}
function noteReaderOpened(){
 if(passageLookup)return;
 const frame=$('#original-reader').contentWindow;
 const id=readerReturnBookId||frame.activeShelfBook?.()?.bookId;
 if(!id||readerSession?.id===id)return;
 const session={id,start:readPosition(id).catch(()=>null)};
 readerSession=session;
 const book=books.find(b=>b.id===id);
 if(book?.status==='unread')setBookStatus(book,'reading').catch(error=>toast(error.message));
}
async function noteReaderClosed(){
 const session=readerSession;
 readerSession=null;
 if(!session)return;
 try{
  const start=await session.start;
  const end=await readPosition(session.id);
  const book=books.find(b=>b.id===session.id);
  if(book){
   book.progress=Math.max(book.progress,Math.round((end.end+1)/(end.last+1)*100));
   if(book.status==='reading'&&start&&start.end<start.last&&end.end>=end.last){
    await setBookStatus(book,'finished');
    toast('读完啦，已放进「已读」');
   }
   await loadLibrary();
   if(currentBook?.id===book.id)renderBookDetail(book);
  }
 }catch{}
}
$('#back-home').addEventListener('click',()=>{if(document.documentElement.dataset.homeHosted==='1')window.parent.postMessage({type:'guichao-books:back'},location.origin);else history.back();});
$('.library').addEventListener('click',event=>{
 if(event.target===$('.library')&&document.body.dataset.booksSheet==='open')$('#original-reader').contentWindow.postMessage({type:'guichao-books:sheet-close'},location.origin);
});
$('#stats-toggle').addEventListener('click',()=>{readerReturnBookId='';directReaderReady=false;readingFrameKey='';document.body.classList.add('reader-frame-loading');$('#original-reader').src='/reading/stats.html?hosted=1&library=1';document.body.classList.add('reader-detail');$('#reading-view').hidden=false;notifyHomeView(true);});
window.addEventListener('message',event=>{
 if(event.origin!==location.origin)return;
 if(event.source===window.parent&&document.documentElement.dataset.homeHosted==='1'){
  if(event.data?.type==='guichao-books:sheet-close'){closePopovers();closeDialogs();$('#original-reader').contentWindow.postMessage(event.data,location.origin);return;}
  if(event.data?.type==='guichao-books:import'){$('#add-menu').togglePopover();return;}
  if(event.data?.type==='guichao-books:people'||event.data?.type==='guichao-books:host-ready'){
   if(event.data?.type==='guichao-books:people')for(const key of ['human','companion']){const incoming=event.data.people?.[key];if(incoming?.avatarUrl)people[key].avatarUrl=String(incoming.avatarUrl);}
   $('#original-reader').contentWindow?.postMessage(event.data,location.origin);
   if(currentBook)renderDetailLibrary(currentBook);
   window.parent.postMessage({type:'guichao-books:theme',bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),ink:getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()},location.origin);
  }
  return;
 }
 if(event.source!==$('#original-reader').contentWindow)return;
 if(event.data?.type==='guichao-books:sheet'){
  document.body.dataset.booksSheet=event.data.open===true?'open':'closed';
  if(typeof event.data.mask==='string'&&CSS.supports('color',event.data.mask))document.documentElement.style.setProperty('--books-sheet-mask',event.data.mask);
  if(event.data.open===true){
   const library=$('.library'),reading=$('#reading-view');
   library.style.setProperty('--sheet-chrome-height',Math.max(0,reading.getBoundingClientRect().top-library.getBoundingClientRect().top)+'px');
  }
  syncHostSheet();
  return;
 }
 if(event.data?.type==='guichao-books:book-detail'){const book=books.find(item=>item.id===event.data.bookId&&!item.removed);if(book)openBookPage(book);return;}
 if(event.data?.type==='guichao-books:stats-close'){document.body.classList.add('reader-frame-loading');document.body.classList.remove('reader-detail');readingFrameKey='';render();notifyHomeView(false);return;}
 if(event.data?.type==='guichao-books:theme'){
  const theme=({'#f7f6f1':'yellow','#f4f1f3':'pink','#151514':'night'})[event.data.bg];
  if(theme){
   document.documentElement.dataset.theme=theme;
   document.querySelector('meta[name="theme-color"]').content=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
   if(document.documentElement.dataset.homeHosted==='1')window.parent.postMessage({type:'guichao-books:theme',bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),ink:getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()},location.origin);
  }
 }
 if(event.data?.type==='guichao-books:people-request'&&document.documentElement.dataset.homeHosted==='1')window.parent.postMessage(event.data,location.origin);
 if(event.data?.type==='guichao-books:stats'){document.body.classList.add('reader-frame-loading');$('#original-reader').src='/reading/stats.html?hosted=1&library=1';document.body.classList.add('reader-detail');$('#reading-view').hidden=false;notifyHomeView(true);}
 if(event.data?.type==='guichao-books:view'){
  const detail=event.data.view!=='shelf';
  if(document.documentElement.dataset.homeHosted==='1')window.parent.postMessage({type:'guichao-books:view',view:detail?'reader':'shelf'},location.origin);
  if(detail)noteReaderOpened();else noteReaderClosed();
  if(readerReturnBookId){
   if(detail){
    if(!directReaderReady){
     directReaderReady=true;
     history.replaceState(null,'',location.pathname+location.search);
     document.body.classList.add('reader-detail');
     routeBookPage();
     $('#reading-view').hidden=false;
    }
    return;
   }
   if(!directReaderReady)return;
   const book=books.find(b=>b.id===readerReturnBookId);
   readerReturnBookId='';directReaderReady=false;passageLookup=false;document.body.classList.remove('reader-detail');
   if(book)openBookPage(book);else render();
   return;
  }
  document.body.classList.toggle('reader-detail',detail);if(!detail)render();
 }
});
$('#original-reader').addEventListener('load',()=>{
 document.body.classList.remove('reader-frame-loading');
 document.body.dataset.booksSheet='closed';
 syncHostSheet();
 $('#original-reader').contentWindow.postMessage({type:'guichao-books:host-ready'},location.origin);
});
let tabSwipe=null;
$('.segments').addEventListener('pointerdown',event=>{tabSwipe={x:event.clientX,y:event.clientY};});
$('.segments').addEventListener('pointerup',event=>{if(!tabSwipe)return;const dx=event.clientX-tabSwipe.x,dy=event.clientY-tabSwipe.y;tabSwipe=null;if(Math.abs(dx)>30&&Math.abs(dx)>Math.abs(dy)*1.3){const tabs=['reading','unread','finished'];filter=tabs[Math.max(0,Math.min(2,tabs.indexOf(filter)+(dx<0?1:-1)))];render();}});
$('#search-toggle').addEventListener('click',()=>{closePopovers();const open=$('#search-row').hidden;$('#search-row').hidden=!open;$('#search-toggle').setAttribute('aria-expanded',String(open));if(open)$('#search-input').focus();else{query='';$('#search-input').value='';render();}});
function closeSearch(){$('#search-row').hidden=true;$('#search-toggle').setAttribute('aria-expanded','false');query='';$('#search-input').value='';render();$('#search-toggle').focus();}
$('#search-close').addEventListener('click',closeSearch);
$('#search-input').addEventListener('input',event=>{query=event.target.value.trim();render();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open],:popover-open')&&!$('#search-row').hidden)closeSearch();});
$('.segments').addEventListener('click',event=>{const button=event.target.closest('[data-status]');if(button){filter=button.dataset.status;render();}});
$('#group-menu').addEventListener('click',event=>{const button=event.target.closest('[data-group]');if(button){selectedGroup=button.dataset.group;closePopovers();render();}});
function groupForm(group=null){editingGroup=group;$('#group-title').textContent=group?'整理分组':'新建分组';$('#group-name').value=group?.name||'';$('#group-error').textContent='';$('#group-books').innerHTML=books.filter(b=>!b.removed).map(b=>`<label class="pick-item"><input type="checkbox" name="group-book" value="${b.id}" ${group?.books.includes(b.id)?'checked':''}><span>${esc(b.title)}</span><small>${statusLabels[b.status]}</small></label>`).join('');openDialog('group-dialog');$('#group-name').focus();}
$('#group-form').addEventListener('submit',async event=>{event.preventDefault();const name=$('#group-name').value.trim();if(!name)return;const ids=$$('#group-books input:checked').map(e=>e.value);try{const result=await api('/library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:editingGroup?.id,name,books:ids})});selectedGroup=result.group.id;filter=books.find(b=>ids.includes(b.id)&&!b.removed)?.status||'reading';$('#group-dialog').close();await loadLibrary();toast('分组已放好');}catch(error){$('#group-error').textContent=error.message;}});
async function renderBookDetail(book){
 $('#book-detail').innerHTML=`<div class="book-hero">${book.hasCover?`<img src="${API}/cover/${book.id}" alt="《${esc(book.title)}》封面">`:`<div class="hero-cover-placeholder">${esc(book.title)}</div>`}<div class="book-hero-info"><div class="book-hero-title"><h2>${esc(book.title)}</h2><div class="book-status-wrap"><button type="button" class="book-status-button" id="detail-status-toggle" aria-label="状态：${statusLabels[book.status]}，点按更改" aria-haspopup="menu" aria-expanded="false"><span>${statusLabels[book.status]}</span><i class="icon caret" aria-hidden="true"></i></button><div class="book-status-menu" id="detail-status-menu" role="menu" hidden>${Object.entries(statusLabels).map(([value,label])=>`<button type="button" role="menuitemradio" aria-checked="${value===book.status}" data-status-choice="${value}">${label}</button>`).join('')}</div></div></div><p>${esc(book.author)}</p><button class="book-read-button" data-open-reader="${book.id}">阅读</button></div></div><section class="book-record" aria-label="这本书的共读记录"><h3>我们的共读记录</h3><div id="book-record-content" class="record-content">正在整理…</div></section><div class="library-seg" data-selected="${currentDetailTab}" role="tablist" aria-label="书签与批注"><button type="button" data-detail-tab="bookmarks" role="tab" class="${currentDetailTab==='bookmarks'?'on':''}" aria-selected="${currentDetailTab==='bookmarks'}">书签</button><button type="button" data-detail-tab="annotations" role="tab" class="${currentDetailTab==='annotations'?'on':''}" aria-selected="${currentDetailTab==='annotations'}">批注</button></div><label class="detail-search"><i class="icon search" aria-hidden="true"></i><input id="detail-search-input" type="search" aria-label="搜索这本书的记录" placeholder="搜索批注、引文、回复…" value="${esc(detailView(book.id).query)}"></label><div id="detail-library-content" class="detail-library-content"></div>`;
 try{
  const response=await fetch('/reading/api/book/'+book.id);
  if(!response.ok)throw new Error('record unavailable');
  const detail=await response.json();
  if(currentBook?.id!==book.id)return;
  const human=detail.readers?.human,ai=detail.readers?.ai;
  const readerStat=(name,reader)=>`<div class="reader-stat"><div><span>${name} · 上次读到</span><strong>${reader?.progressPct||0}%</strong></div><small>${reader?.lastReadAt?'上次 '+readDate(reader.lastReadAt):'尚未开始'}</small></div>`;
  $('#book-record-content').innerHTML=`<div class="record-readers">${readerStat('读者',human)}${readerStat('共读者',ai)}</div><div class="record-summary"><span>共读 ${readDuration(detail.totalReadMs)}</span><span>最近翻开 ${readDate(detail.lastOpenedAt)}</span></div>`;
 }catch{if(currentBook?.id===book.id)$('#book-record-content').textContent='暂时没读到这本书的记录';}
 await renderDetailLibrary(book);
 if(currentBook?.id===book.id)document.querySelector('.book-page-scroll').scrollTop=detailView(book.id).scroll;
}
function notifyHomeView(detail){if(document.documentElement.dataset.homeHosted==='1')window.parent.postMessage({type:'guichao-books:view',view:detail?'reader':'shelf'},location.origin);}
function routeBookPage(){
 const match=location.hash.match(/^#book-([\w-]+)$/),book=books.find(b=>b.id===match?.[1]&&!b.removed);
 document.body.classList.toggle('book-page-open',Boolean(book));$('#book-page').hidden=!book;
 notifyHomeView(Boolean(book)||document.body.classList.contains('reader-detail'));
 if(book&&currentBook?.id!==book.id){currentBook=book;currentDetailTab=detailView(book.id).tab;renderBookDetail(book);}
 if(!book)currentBook=null;
}
function openBookPage(book){closePopovers();closeDialogs();if(!book)return;location.hash='book-'+book.id;routeBookPage();}
function closeBookPage(){history.replaceState(null,'',location.pathname+location.search);routeBookPage();render();}
$('#book-page-back').addEventListener('click',closeBookPage);
$('#book-page-delete').addEventListener('click',async()=>{if(!currentBook)return;try{await api('/library/book/'+encodeURIComponent(currentBook.id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removed:true})});currentBook.removed=true;closeBookPage();await loadLibrary();toast('已移到回收站，可以恢复');}catch(error){toast(error.message);}});
window.addEventListener('hashchange',routeBookPage);
async function renderDetailLibrary(book){
 const tab=currentDetailTab,root=$('#detail-library-content'),request=++detailRequest;
 const query=detailView(book.id).query.trim().toLocaleLowerCase(),key=book.id+':'+tab;
 if(!detailCache.has(key)){
  root.textContent='正在读取…';
  try{const response=await fetch('/reading/api/'+(tab==='annotations'?'annotations/':'bookmarks/')+book.id);if(!response.ok)throw new Error();const body=await response.json();detailCache.set(key,tab==='annotations'?body.annotations:body.bookmarks);}
  catch{if(request===detailRequest)root.textContent='暂时没读到记录，请重新打开';return;}
 }
 if(request!==detailRequest||currentBook?.id!==book.id||currentDetailTab!==tab||!root.isConnected)return;
 const all=detailCache.get(key)||[];
 const groups=new Map();
 if(tab==='annotations')for(const item of all){const anchor=detailSelectionKey(item);if(!groups.has(anchor))groups.set(anchor,[]);groups.get(anchor).push(item);}
 const list=(tab==='annotations'?[...groups.values()]:all).filter(entry=>{const items=Array.isArray(entry)?entry:[entry];return !query||items.some(item=>[item.quote,item.excerpt,item.note,item.comment,...(item.comments||[]).map(c=>c.text)].some(text=>String(text||'').toLocaleLowerCase().includes(query)));});
 const original=item=>Number.isInteger(item.seq)&&Number.isInteger(item.chapter)?`<button class="note-original" data-original-seq="${item.seq}" data-original-chapter="${item.chapter}">看原文 <span aria-hidden="true">›</span></button>`:'';
 root.innerHTML=list.map((entry,index)=>{
  const item=Array.isArray(entry)?entry[0]:entry;
  if(tab==='bookmarks')return `<article class="saved-bookmark"><header class="note-head"><small>${esc(item.chapterTitle)}</small>${original(item)}</header><p>${esc(item.excerpt)}</p></article>`;
  const notes=entry.map((annotation,n)=>{const note=detailRoot(annotation),replyId=`note-replies-${index}-${n}`,expanded=Boolean(query&&note.replies.some(c=>String(c.text||'').toLocaleLowerCase().includes(query)));
   return `<div class="note-root">${note.text?`<div class="note-message">${detailAvatar(annotation.createdBy)}<span><span class="note-author">${annotation.createdBy==='human'?'读者':'共读者'}</span><span class="note-text">${esc(note.text)}</span></span></div>`:`<div class="note-line-only">划线 · ${readDate(note.at)}</div>`}${note.replies.length?`<button type="button" class="note-replies-toggle" aria-expanded="${expanded}" aria-controls="${replyId}" data-replies-toggle>${note.replies.length} 条回复 <i class="icon caret" aria-hidden="true"></i></button><div class="note-replies" id="${replyId}" ${expanded?'':'hidden'}>${note.replies.map(c=>`<p class="note-message"><span class="note-author">${c.author==='human'?'读者':'共读者'}</span><span class="note-text">${esc(c.text)}</span></p>`).join('')}</div>`:''}</div>`;
  }).join('');
  return `<article class="saved-note"><header class="note-head"><span>${esc(item.chapterTitle||'书中')} · ${readDate(item.createdAt)}</span>${original(item)}</header><div class="note-quote">${esc(item.quote)}</div><div class="note-annotations">${notes}</div></article>`;
 }).join('')||`<p class="subtle">${query?'没有找到相关记录':'这里还没有记录'}</p>`;
}
$('#book-grid').addEventListener('click',event=>{const card=event.target.closest('[data-book]');if(card)openBookPage(books.find(b=>b.id===card.dataset.book));});
$('#book-detail').addEventListener('input',event=>{if(event.target.id==='detail-search-input'&&currentBook){detailView(currentBook.id).query=event.target.value;renderDetailLibrary(currentBook);}});
$('#book-detail').addEventListener('click',event=>{
 const original=event.target.closest('[data-original-seq]');
 if(original&&currentBook){const id=currentBook.id;detailCache.delete(id+':annotations');detailCache.delete(id+':bookmarks');detailView(id).scroll=document.querySelector('.book-page-scroll').scrollTop;passageLookup=true;readerReturnBookId=id;directReaderReady=false;readingFrameKey='';refreshReadingFrame(books.filter(b=>!b.removed),id,{chapter:Number(original.dataset.originalChapter),seq:Number(original.dataset.originalSeq)});return;}
 const tab=event.target.closest('[data-detail-tab]'),read=event.target.closest('[data-open-reader]'),replies=event.target.closest('[data-replies-toggle]'),statusToggle=event.target.closest('#detail-status-toggle'),statusChoice=event.target.closest('[data-status-choice]');
 if(statusToggle){const menu=$('#detail-status-menu');menu.hidden=!menu.hidden;statusToggle.setAttribute('aria-expanded',String(!menu.hidden));}
 if(statusChoice){
  const choice=statusChoice.dataset.statusChoice;
  setBookStatus(currentBook,choice).catch(error=>toast(error.message));
  const label=statusLabels[currentBook.status];
  $('#detail-status-toggle span').textContent=label;
  $('#detail-status-toggle').setAttribute('aria-label',`状态：${label}，点按更改`);
  $('#detail-status-toggle').setAttribute('aria-expanded','false');
  $$('#detail-status-menu [data-status-choice]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.statusChoice===choice)));
  $('#detail-status-menu').hidden=true;
  render();
 }
 if(tab){currentDetailTab=tab.dataset.detailTab;detailView(currentBook.id).tab=currentDetailTab;$('.library-seg').dataset.selected=currentDetailTab;$$('.library-seg button').forEach(b=>{const on=b.dataset.detailTab===currentDetailTab;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on));});renderDetailLibrary(currentBook);}
 if(replies){const panel=document.getElementById(replies.getAttribute('aria-controls'));panel.hidden=!panel.hidden;replies.setAttribute('aria-expanded',String(!panel.hidden));}
 if(read){const id=read.dataset.openReader;detailView(id).scroll=document.querySelector('.book-page-scroll').scrollTop;passageLookup=false;detailCache.delete(id+':annotations');detailCache.delete(id+':bookmarks');readerReturnBookId=id;directReaderReady=false;readingFrameKey='';refreshReadingFrame(books.filter(b=>!b.removed),id);}
});
document.addEventListener('click',event=>{const menu=$('#detail-status-menu');if(menu&&!event.target.closest('.book-status-wrap')){menu.hidden=true;$('#detail-status-toggle').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('#detail-status-menu')&&!$('#detail-status-menu').hidden){$('#detail-status-menu').hidden=true;$('#detail-status-toggle').setAttribute('aria-expanded','false');$('#detail-status-toggle').focus();}});
function showTrash(){$('#trash-list').innerHTML=books.filter(b=>b.removed).map(b=>`<div class="manage-row"><span>${esc(b.title)}</span><button class="text-button" data-restore="${b.id}">恢复</button></div>`).join('')||'<div class="empty-state"><p>这里还是空的</p></div>';openDialog('trash-dialog');}
document.addEventListener('click',async event=>{const close=event.target.closest('[data-close]'),action=event.target.closest('[data-action]'),edit=event.target.closest('[data-edit-group]'),restore=event.target.closest('[data-restore]');if(close)close.closest('dialog').close();if(event.target.closest('[data-close-popover]'))closePopovers();if(edit)groupForm(groups.find(g=>g.id===edit.dataset.editGroup));if(restore){try{await api('/library/book/'+encodeURIComponent(restore.dataset.restore),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removed:false})});await loadLibrary();showTrash();toast('书已经回到书库');}catch(error){toast(error.message);}}if(action){if(action.dataset.action==='new-group')groupForm();if(action.dataset.action==='trash')showTrash();}});
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}));
let importPending=false,importRequest=0;
function updateImport(){const file=$('#book-file').files[0];$('#import-save').disabled=importPending||!file||!$('#import-name').value.trim();}
function closeImportGroups(){const options=$('#import-group-options');options.hidden=true;$('#import-group-toggle').setAttribute('aria-expanded','false');}
$('#import-group-toggle').addEventListener('click',()=>{const options=$('#import-group-options');options.hidden=!options.hidden;$('#import-group-toggle').setAttribute('aria-expanded',String(!options.hidden));});
$('#import-group-options').addEventListener('click',event=>{const button=event.target.closest('[data-import-group]');if(!button)return;$('#import-group').value=button.dataset.importGroup;$('#import-group-current').textContent=button.textContent;$$('#import-group-options button').forEach(option=>option.setAttribute('aria-current',String(option===button)));closeImportGroups();$('#import-group-toggle').focus();});
document.addEventListener('click',event=>{if(!event.target.closest('#import-group-toggle,#import-group-options'))closeImportGroups();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#import-group-options').hidden){closeImportGroups();$('#import-group-toggle').focus();}});
$('#book-file').addEventListener('change',async event=>{
 const file=event.target.files[0],request=++importRequest;
 $('#file-label').textContent=file?.name||'选择 EPUB 或 TXT';
 $('#import-name').value='';$('#import-author').value='';
 importPending=Boolean(file);updateImport();
 if(!file){$('#import-note').textContent='选择文件后自动识别，可修改书名和作者。';return;}
 $('#import-note').textContent='正在识别书名和作者…';
 try{
  const response=await fetch(API+'/import/metadata?filename='+encodeURIComponent(file.name),{method:'POST',body:file});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'识别失败');
  if(request!==importRequest)return;
  $('#import-name').value=result.title||file.name.replace(/\.(epub|txt)$/i,'');$('#import-author').value=result.author||'';
  $('#import-note').textContent=result.author?'已自动识别，可修改。':'已带出书名，文件中未识别到作者，可选填。';
 }catch(error){if(request!==importRequest)return;$('#import-name').value=file.name.replace(/\.(epub|txt)$/i,'');$('#import-note').textContent='未能识别书内信息，暂用文件名；可以重新选择文件。';}
 finally{if(request===importRequest){importPending=false;updateImport();}}
});
$('#import-name').addEventListener('input',updateImport);
$('#import-form').addEventListener('submit',async event=>{event.preventDefault();if($('#import-save').disabled)return;const file=$('#book-file').files[0];importPending=true;updateImport();$('#import-note').textContent='正在导入书籍…';try{const params=new URLSearchParams({filename:file.name,title:$('#import-name').value.trim(),author:$('#import-author').value.trim(),group:$('#import-group').value});const result=await api('/import?'+params,{method:'POST',body:file});closePopovers();$('#import-form').reset();$('#file-label').textContent='选择 EPUB 或 TXT';await loadLibrary();toast(`《${result.book.title}》已加入书房`);}catch(error){$('#import-note').textContent='导入失败：'+error.message;}finally{importPending=false;updateImport();}});
loadLibrary().catch(error=>{$('#empty-text').textContent='书房暂时打不开：'+error.message;$('#empty-state').hidden=false;});
