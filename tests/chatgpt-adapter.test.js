'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');

const { buildChatGptWidget, RESOURCE_URI, hostBridgeSource } = require('../server/chatgpt/widget');
const { TOOLS, createChatGptServer } = require('../server/chatgpt/server');
const { createBooksClient, normalizeUiPath } = require('../server/mcp/client');
const { isAllowedBooksUiRoute } = require('../server');

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function withServer(client, fn, options = {}) {
  const server = createChatGptServer({ client, accessToken: 'private', requireAuth: true, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(base, payload, token = 'private') {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
}

test('ChatGPT widget reuses the approved Books shelf instead of creating another bookshelf', () => {
  const html = buildChatGptWidget();
  assert.match(html, /class="shelf-stage"/);
  assert.match(html, /class="reading-panel"/);
  assert.match(html, /books-app:\/\/api/);
  assert.match(html, /books_ui_request/);
  assert.match(html, /给共读者看/);
  assert.match(html, /window\.__BOOKS_CHATGPT_HOST__ = true/);
  assert.match(html, /data-books-host/);
  assert.match(html, /grid-template-columns:minmax\(0,1\.1fr\)/);
  assert.match(html, /data-books-display-mode="inline"/);
  assert.match(html, /grid-template-columns:minmax\(112px,\.42fr\)/);
  assert.match(html, /:not\(\[data-books-display-mode="inline"\]\)/);
  assert.match(html, /sheet\[data-mode="detail"\].*max-height:min\(560px/);
  assert.doesNotMatch(html, /sheet\[data-mode="detail"\] \.sheet-input\{display:none\}/);
  assert.match(html, /padding-bottom:var\(--books-host-safe-bottom,0px\)/);
  assert.match(html, /selection-tools \{ position: fixed; left: var\(--books-selection-left/);
  assert.match(html, /rViewport\.addEventListener\('pointerup', syncNativeSelectionAfterPointer\)/);
  assert.match(html, /sendSelectionToChatGpt/);
  assert.match(html, /请正常回应读者，并用 reply_to_shared_line 把同一回复写回这条页边对话/);
  assert.match(html, /data-books-display-mode="inline".*height:auto!important/);
  assert.match(html, /data-books-display-mode="inline".*\.sheet.*display:none!important/);
  assert.match(html, /height:min\(100dvh,var\(--books-host-max-height,100dvh\)\)!important/);
  assert.match(html, /\.sheet\{visibility:hidden;pointer-events:none/);
  assert.match(html, /ResizeObserver/);
  assert.equal(RESOURCE_URI, 'ui://guichao-books/reader-v12.html');
  assert.doesNotMatch(html, /src="\/reading\/assets\/bookmark/);
});

test('ChatGPT widget keeps embedded height intrinsic and fullscreen at the viewport', () => {
  const styles = new Map();
  const listeners = new Map();
  const dispatched = [];
  const window = {
    fetch: () => {},
    openai: { maxHeight: 720, displayMode: 'fullscreen', safeArea: { insets: { top: 47, bottom: 90 } }, notifyIntrinsicHeight(height) { dispatched.push(`height:${height}`); } },
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent(event) { dispatched.push(event.type); },
    setTimeout(fn) { fn(); },
    setInterval() { throw new Error('host maxHeight was already available'); },
    clearInterval() {},
  };
  const document = {
    documentElement: {
      dataset: {},
      style: { getPropertyValue(name) { return styles.get(name) || ''; }, setProperty(name, value) { styles.set(name, value); } },
    },
    getElementById(id) {
      if (id === 'shelf') return { getBoundingClientRect() { return { height: 356 }; } };
      if (id === 'login-screen') return { classList: { contains() { return true; } } };
      return null;
    },
    addEventListener() {},
  };
  vm.runInNewContext(hostBridgeSource(), {
    window,
    document,
    Event: class Event { constructor(type) { this.type = type; } },
    Response: class Response {},
    URL,
    Promise,
    String,
    Number,
    Map,
  });
  assert.equal(styles.get('--books-host-max-height'), '720px');
  assert.equal(styles.get('--books-host-safe-top'), '47px');
  assert.equal(styles.get('--books-host-safe-bottom'), '90px');
  assert.equal(styles.has('--books-host-height'), false);
  assert.equal(document.documentElement.dataset.booksDisplayMode, 'fullscreen');
  listeners.get('openai:set_globals')({ detail: { globals: { maxHeight: 684, displayMode: 'inline', safeArea: { insets: { top: 54, bottom: 90 } } } } });
  assert.equal(styles.get('--books-host-max-height'), '684px');
  assert.equal(styles.get('--books-host-safe-top'), '54px');
  assert.equal(styles.has('--books-host-height'), false);
  assert.equal(document.documentElement.dataset.booksDisplayMode, 'inline');
  assert.deepEqual(dispatched, ['resize', 'height:356', 'resize']);
  listeners.get('openai:set_globals')({ detail: { globals: { maxHeight: 684, displayMode: 'inline', safeArea: { insets: { top: 54, bottom: 90 } } } } });
  assert.deepEqual(dispatched, ['resize', 'height:356', 'resize']);
});

test('ChatGPT widget catches maxHeight when the host injects globals after startup', () => {
  const styles = new Map();
  const listeners = new Map();
  let poll = null;
  let cleared = false;
  const window = {
    fetch: () => {},
    openai: {},
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent() {},
    setTimeout(fn) { fn(); },
    setInterval(fn, delay) {
      assert.equal(delay, 250);
      poll = fn;
      return 7;
    },
    clearInterval(id) {
      assert.equal(id, 7);
      cleared = true;
    },
  };
  const document = {
    documentElement: {
      dataset: {},
      style: { getPropertyValue(name) { return styles.get(name) || ''; }, setProperty(name, value) { styles.set(name, value); } },
    },
    getElementById() { return null; },
    addEventListener() {},
  };
  vm.runInNewContext(hostBridgeSource(), {
    window,
    document,
    Event: class Event { constructor(type) { this.type = type; } },
    Response: class Response {},
    URL,
    Promise,
    String,
    Number,
    Map,
  });
  assert.equal(typeof poll, 'function');
  window.openai.maxHeight = 676;
  window.openai.displayMode = 'fullscreen';
  poll();
  assert.equal(styles.has('--books-host-height'), false);
  assert.equal(document.documentElement.dataset.booksDisplayMode, 'fullscreen');
  assert.equal(cleared, true);
  assert.equal(listeners.has('openai:set_globals'), true);
});

test('ChatGPT adapter exposes one renderer, one app-only page bridge and all seven co-reading tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'open_books',
    'books_ui_request',
    'see_current_reading',
    'read_book_position',
    'read_shared_line',
    'reply_to_shared_line',
    'leave_margin_note',
    'search_read_text',
    'see_library_overview'
  ]);
  assert.equal(TOOLS[0]._meta.ui.resourceUri, RESOURCE_URI);
  assert.deepEqual(TOOLS[1]._meta.ui.visibility, ['app']);
  assert.equal(TOOLS[5].inputSchema.properties.final.type, 'boolean');
  assert.match(TOOLS[5].description, /同一条页边对话/);
  assert.equal(TOOLS[3].inputSchema.properties.chapter, undefined);
  assert.equal(TOOLS[3].inputSchema.properties.page, undefined);
});

test('ChatGPT adapter keeps page payload component-only', async () => {
  const client = {
    async booksUiRequest(args) {
      assert.deepEqual(args, { method: 'GET', path: '/book/demo/chapter/0' });
      return { title: '私有章节', paragraphs: ['只给组件的正文'] };
    }
  };
  await withServer(client, async (base) => {
    const response = await post(base, rpc('tools/call', {
      name: 'books_ui_request',
      arguments: { method: 'GET', path: '/book/demo/chapter/0' }
    }));
    const body = await response.json();
    assert.equal(body.result.content[0].text, 'Books 页面已同步。');
    assert.deepEqual(body.result._meta.payload.body.paragraphs, ['只给组件的正文']);
    assert.equal(body.result.structuredContent, undefined);
    assert.doesNotMatch(body.result.content[0].text, /只给组件的正文/);
  });
});

test('official ChatGPT replies are written back with an explicit source', async () => {
  const calls = [];
  const client = {
    async replyToSharedLine(args, context) {
      calls.push({ args, context });
      return { ok: true };
    }
  };
  await withServer(client, async (base) => {
    const response = await post(base, rpc('tools/call', {
      name: 'reply_to_shared_line',
      arguments: { selection_id: 'line-1', text: '我也在这里。', final: true }
    }, 9));
    assert.equal(response.status, 200);
  });
  assert.equal(calls[0].context.source, 'chatgpt');
  assert.equal(calls[0].context.requestId, 9);
});

test('Books Core client persists the ChatGPT source without changing the existing reply schema', async () => {
  let sent;
  const client = createBooksClient({
    controlToken: 'control',
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.replyToSharedLine(
    { selection_id: 'line-1', text: '官端的一句话', final: true },
    { requestId: 4, source: 'chatgpt' }
  );
  assert.equal(sent.source, 'chatgpt');
  assert.equal(sent.final, true);
});

test('Books Core client sends title and optional progress to the bounded read endpoint', async () => {
  let target;
  let sent;
  const client = createBooksClient({
    controlToken: 'control',
    fetch: async (url, init) => {
      target = String(url);
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ title: '东京八平米', progressPct: 10 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.readBookPosition({ book_title: '东京八平米', progress_pct: 10 });
  assert.match(target, /\/api\/internal\/mcp\/read-position$/);
  assert.deepEqual(sent, { bookTitle: '东京八平米', progressPct: 10 });
});

test('ChatGPT UI resource is returned only through an authenticated MCP connection', async () => {
  await withServer({}, async (base) => {
    const denied = await post(base, rpc('resources/read', { uri: RESOURCE_URI }), 'wrong');
    assert.equal(denied.status, 401);

    const response = await post(base, rpc('resources/read', { uri: RESOURCE_URI }));
    const body = await response.json();
    assert.equal(body.result.contents[0].uri, RESOURCE_URI);
    assert.equal(body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(body.result.contents[0].text, /class="shelf-stage"/);
  });
});

test('new ChatGPT widget reads the current private Home portraits', async () => {
  let image = 'data:image/png;base64,YQ==';
  await withServer({}, async (base) => {
    const read = async () => (await (await post(base, rpc('resources/read', { uri: RESOURCE_URI }))).json()).result.contents[0].text;
    assert.match(await read(), /data:image\/png;base64,YQ==/);
    image = 'data:image/png;base64,Yg==';
    assert.match(await read(), /data:image\/png;base64,Yg==/);
  }, { avatarProvider: async () => ({ human: image, companion: image }) });
});

test('HTTPS adapter publishes OAuth metadata and completes the authorization-code flow', async () => {
  await withServer({}, async (base) => {
    let response = await fetch(`${base}/.well-known/oauth-protected-resource`);
    let body = await response.json();
    assert.equal(body.resource, 'https://books.example.test/books-mcp/mcp');
    assert.deepEqual(body.authorization_servers, ['https://books.example.test/books-mcp']);

    response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    body = await response.json();
    assert.equal(body.authorization_endpoint, 'https://books.example.test/books-mcp/oauth/authorize');
    assert.equal(body.token_endpoint, 'https://books.example.test/books-mcp/oauth/token');
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);

    const verifier = 'books-pkce-verifier-' + 'a'.repeat(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const resource = 'https://books.example.test/books-mcp/mcp';
    const callback = 'https://chatgpt.com/connector/oauth/books-test';
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', 'books-client');
    authorize.searchParams.set('redirect_uri', callback);
    authorize.searchParams.set('state', 'state-1');
    authorize.searchParams.set('resource', resource);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    response = await fetch(authorize, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const redirect = new URL(response.headers.get('location'));
    assert.equal(redirect.searchParams.get('state'), 'state-1');
    const code = redirect.searchParams.get('code');
    assert.ok(code);

    response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'books-client', client_secret: 'books-secret', code, redirect_uri: callback, code_verifier: verifier, resource })
    });
    body = await response.json();
    assert.equal(body.access_token, 'oauth-access');
    assert.equal(body.refresh_token, 'oauth-refresh');
    assert.equal(Object.hasOwn(body, 'expires_in'), false);

    response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'books-client', client_secret: 'books-secret', refresh_token: 'oauth-refresh', resource })
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.access_token, 'oauth-access');

    response = await post(base, rpc('initialize', { protocolVersion: '2025-06-18' }), 'oauth-access');
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('mcp-session-id'));
  }, {
    accessToken: 'oauth-access',
    requireAuth: true,
    oauthClientId: 'books-client',
    oauthClientSecret: 'books-secret',
    oauthRefreshToken: 'oauth-refresh',
    publicBaseUrl: 'https://books.example.test/books-mcp'
  });
});

test('component bridge rejects absolute and traversal paths before reaching Books Core', () => {
  assert.equal(normalizeUiPath('/books'), '/books');
  assert.throws(() => normalizeUiPath('https://example.com/private'), /invalid/);
  assert.throws(() => normalizeUiPath('/book/../data'), /invalid/);
});

test('Books Core gives the official component only the existing reading surface', () => {
  assert.equal(isAllowedBooksUiRoute('GET', '/api/books'), true);
  assert.equal(isAllowedBooksUiRoute('GET', '/api/book/demo/chapter/0'), true);
  assert.equal(isAllowedBooksUiRoute('POST', '/api/annotations'), true);
  assert.equal(isAllowedBooksUiRoute('POST', '/api/beat'), true);
  assert.equal(isAllowedBooksUiRoute('POST', '/api/import'), false);
  assert.equal(isAllowedBooksUiRoute('POST', '/api/settings'), false);
  assert.equal(isAllowedBooksUiRoute('GET', '/api/gate/demo/text'), false);
});

test('ChatGPT adapter fails closed when only the Home control credential exists', async () => {
  const oldHome = process.env.BOOKS_MCP_CONTROL_TOKEN;
  const oldGpt = process.env.BOOKS_CHATGPT_CONTROL_TOKEN;
  process.env.BOOKS_MCP_CONTROL_TOKEN = 'home-only';
  delete process.env.BOOKS_CHATGPT_CONTROL_TOKEN;
  try {
    await withServer(undefined, async base => {
      const response = await post(base, rpc('tools/call', { name: 'see_current_reading', arguments: {} }));
      const payload = await response.json();
      assert.equal(payload.result.isError, true);
      assert.equal(payload.result._meta.payload.body.error, 'mcp_control_not_configured');
    });
  } finally {
    if (oldHome === undefined) delete process.env.BOOKS_MCP_CONTROL_TOKEN; else process.env.BOOKS_MCP_CONTROL_TOKEN = oldHome;
    if (oldGpt === undefined) delete process.env.BOOKS_CHATGPT_CONTROL_TOKEN; else process.env.BOOKS_CHATGPT_CONTROL_TOKEN = oldGpt;
  }
});

test('selection actions stay beside visible text and above the host composer', () => {
  const listeners = new Map();
  const styles = new Map();
  let rect = { left: 70, right: 230, top: 480, bottom: 506, width: 160, height: 26 };
  const toolbar = { offsetHeight: 48, offsetWidth: 220, style: { setProperty(key, value) { styles.set(key, value); } } };
  const window = {
    innerWidth: 390, innerHeight: 800,
    fetch() {},
    openai: { maxHeight: 800, displayMode: 'fullscreen', safeArea: { insets: { bottom: 190 } } },
    getSelection() { return { rangeCount: 1, isCollapsed: false, getRangeAt() { return { getClientRects() { return [rect]; } }; } }; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent() {}, setTimeout(fn) { fn(); },
  };
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    getElementById(id) { return id === 'selection-tools' ? toolbar : null; },
    addEventListener() {},
  };
  const reader = require('node:fs').readFileSync(require('node:path').join(__dirname, '../web/reader.html'), 'utf8');
  const positioning = reader.slice(reader.indexOf('function activeSelectionRange()'), reader.indexOf('function hideSelectionTools()'));
  const PaintSelect = { range: null };
  vm.runInNewContext(positioning, { window, document, PaintSelect });
  listeners.get('resize')();
  assert.equal(styles.get('--books-selection-top'), '518px');
  assert.equal(styles.get('--books-selection-left'), '150px');
  rect = { left: 2, right: 90, top: 10, bottom: 36, width: 88, height: 26 };
  listeners.get('resize')();
  assert.equal(styles.get('--books-selection-top'), '48px');
  assert.equal(styles.get('--books-selection-left'), '118px');
  rect = { left: 210, right: 388, top: 590, bottom: 616, width: 178, height: 26 };
  listeners.get('resize')();
  assert.ok(parseFloat(styles.get('--books-selection-top')) + toolbar.offsetHeight < 610);
  // 荧光笔范围优先于系统选区，操作条按可用空间定位。
  PaintSelect.range = { getClientRects() { return [{ left: 100, right: 260, top: 300, bottom: 326, width: 160, height: 26 }]; } };
  listeners.get('resize')();
  assert.equal(styles.get('--books-selection-top'), '338px');
  assert.equal(styles.get('--books-selection-left'), '180px');
  PaintSelect.range = null;
  window.openai = undefined;
  rect = { left: 90, right: 250, top: 500, bottom: 526, width: 160, height: 26 };
  listeners.get('resize')();
  assert.equal(styles.get('--books-selection-top'), '538px');
  rect = { left: 90, right: 250, top: 740, bottom: 766, width: 160, height: 26 };
  listeners.get('resize')();
  assert.equal(styles.get('--books-selection-top'), '680px');
});

test('GPT remount restores the saved book, paragraph and annotation without sharing again', async () => {
  const { readerViewStateSource } = require('../server/chatgpt/widget');
  const calls = [];
  let reading = false;
  const annotation = { id: 'saved-note', seq: 23 };
  const R = { books: [{bookId:'sample'}], chapters:{}, paraPages:[], page:0, annos:[annotation], manifest:{chapterCount:3}, ch:0 };
  const window = {openai:{widgetState:{other:'keep',booksView:{version:1,reading:true,bookId:'sample',chapter:1,seq:23,annotationId:'saved-note'}},displayMode:'inline',
    async requestDisplayMode(){calls.push('expand');this.displayMode='fullscreen';return {mode:'fullscreen'}},
    setWidgetState(state){this.widgetState=state}}, dispatchEvent(){}};
  const context = {requestAnimationFrame:fn=>fn(),rViewport:{getClientRects:()=>[{}]},window,R,Shelf:{},reader:{classList:{contains:()=>reading}},sheet:{classList:{contains:()=>true}},rFoot:{},document:{body:{}},
    MutationObserver:class{observe(){}},CustomEvent:class{},boot:async()=>{},renderShelfCards(){},renderShelfContent(){},
    loadBookData:async id=>{calls.push(['load',id]);R.book={bookId:id};return true},
    enterReader:async(ch,seq)=>{calls.push(['read',ch,seq]);reading=true;R.ch=ch},
    openSheet:(mode,anno)=>{calls.push(['note',mode,anno.id]);R.sheetMode=mode;R.detailAnno=anno},
    currentParaRange:()=>({seqStart:23}),activeShelfBook:()=>R.books[0],clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),toast:msg=>{throw Error(msg)}};
  await vm.runInNewContext(readerViewStateSource(),context);
  assert.deepEqual(calls,[['load','sample'],'expand',['read',1,23],['note','detail','saved-note']]);
  window.__booksCaptureView();
  assert.equal(window.openai.widgetState.privateContent.booksView.seq,23);
  assert.equal(window.openai.widgetState.privateContent.booksView.annotationId,'saved-note');
  assert.equal(window.openai.widgetState.booksView,undefined);
  assert.deepEqual(Object.keys(window.openai.widgetState.modelContent),[]);
});

test('a conflicting duplicate reply cannot be reported as newly saved', async () => {
  await withServer({ replyToSharedLine: async()=>({ok:true,duplicate:true,comment:{id:'old',text:'旧内容'}}) }, async base=>{
    const response=await post(base,rpc('tools/call',{name:'reply_to_shared_line',arguments:{selection_id:'line-1',text:'新内容'}},0));
    const body=await response.json();
    assert(body.error || body.result?.isError);
    assert.match(JSON.stringify(body),/本次内容未写入/);
  });
});

test('reply receipts distinguish created and duplicate and preserve the stored record id', async () => {
  for (const duplicate of [false,true]) {
    await withServer({replyToSharedLine:async()=>({ok:true,duplicate,comment:{id:'persisted-record',text:'同一回复'}})},async base=>{
      const response=await post(base,rpc('tools/call',{name:'reply_to_shared_line',arguments:{selection_id:'line-1',text:'同一回复',request_id:'reply-unique'}},0));
      const body=await response.json();
      assert.deepEqual(body.result.structuredContent,{ok:true,status:duplicate?'duplicate':'created',comment_id:'persisted-record'});
    });
  }
});
