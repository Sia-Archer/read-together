'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESOURCE_URI = 'ui://guichao-books/reader-v12.html';

function buildChatGptWidget(options = {}) {
  const root = options.root || path.resolve(__dirname, '..', '..');
  const readerPath = options.readerPath || path.join(root, 'web', 'reader.html');
  let html = fs.readFileSync(readerPath, 'utf8');

  html = inlineAsset(html, root, '/reading/assets/bookmark-outline.svg?v=20261029-2', 'web/assets/bookmark-outline.svg', 'image/svg+xml');
  html = inlineAsset(html, root, '/reading/assets/bookmark-filled.svg?v=20261029-2', 'web/assets/bookmark-filled.svg', 'image/svg+xml');
  html = html.replace("const API = '/reading/api';", "const API = 'books-app://api';");
  html = html.replace('body.reader-open .shelf {', 'html:not([data-books-display-mode="inline"]) body.reader-open .shelf {');
  html = html.replace(
    "return book && book.hasCover ? `${API}/cover/${book.bookId}` : '';",
    "return book && book.coverDataUrl ? book.coverDataUrl : '';"
  );
  html = html.replace(
    "if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {",
    "if (!window.__BOOKS_CHATGPT_HOST__ && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {"
  );
  html = html.replace(
    '</style>',
    chatGptHostStyles() + '.imp-btn,#imp-file,.logout-btn{display:none!important}.shelf-topbar{padding-right:22px}</style>'
  );
  html = html.replace('.reader-foot { text-align:', '.reader-foot { min-height: calc(24px + max(10px, env(safe-area-inset-bottom))); line-height: 18px; text-align:');
  html = html.replace('boot();', readerViewStateSource());
  html = html.replace("if (mode === 'detail') startDetailPolling();", "if (mode === 'detail') { startDetailPolling(); window.__booksFlushShare?.(); }");
  html = html.replace("await refreshAnnos({ rerender: reader.classList.contains('open') });", "await refreshAnnos({ rerender: reader.classList.contains('open') });\n    window.__booksFlushShare?.();");
  html = html.replace("if (!reader.classList.contains('open') || !R.chapters[R.ch]) return;", "if (!reader.classList.contains('open') || !R.chapters[R.ch] || !rViewport.getClientRects().length) return;");
  html = html.replace('  await openBookDirect(book.bookId);', '  if (reader.classList.contains(\'open\') && R.book?.bookId === book.bookId) return;\n  await openBookDirect(book.bookId);');
  const avatars = options.avatarDataUrls || {};
  html = html.replace('<script>', `<script>globalThis.__BOOKS_HOST_AVATARS__ = ${JSON.stringify(avatars)};</script>\n<script>${hostBridgeSource()}${statsViewSource(root)}</script>\n<script>`);
  return html;
}

function readerViewStateSource() {
  return String.raw`
window.__booksShareError = () => toast('批注已保存，但发送到当前对话失败，请在对话里叫我查看。');
let restoringHostView = true;
let lastHostView = '';
window.__booksCaptureView = (annotationId) => {
  if (restoringHostView || !window.openai?.setWidgetState) return;
  const reading = reader.classList.contains('open');
  if (reading && !rViewport.getClientRects().length) return;
  const detail = R.annos.find(item => item.id === annotationId) || (R.sheetMode === 'detail' ? R.detailAnno : null);
  const seq = reading ? detail?.seq ?? currentParaRange()?.seqStart ?? 0 : 0;
  const paragraph = R.chapters[R.ch];
  const firstPage = paragraph ? R.paraPages[seq - paragraph.baseSeq]?.start : 0;
  const view = {
    version: 1, reading,
    bookId: (reading ? R.book?.bookId : activeShelfBook()?.bookId) || null,
    chapter: reading ? R.ch : 0,
    seq,
    pageOffset: reading ? Math.max(0, R.page - (firstPage || 0)) : 0,
    annotationId: annotationId || (sheet.classList.contains('open') && R.sheetMode === 'detail' ? R.detailAnno?.id : null)
  };
  const serialized = JSON.stringify(view);
  if (serialized === lastHostView) return;
  window.openai.setWidgetState({ modelContent: {}, privateContent: { booksView: view } });
  lastHostView = serialized;
};
window.__booksResumeView = async (restoring = false) => {
  if ((restoring || reader.classList.contains('open')) && window.openai?.displayMode === 'inline') {
    const result = await window.openai.requestDisplayMode?.({ mode: 'fullscreen' });
    if (result?.mode) window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { displayMode: result.mode } } }));
  }
};
boot().then(async () => {
  const view = window.openai?.widgetState?.privateContent?.booksView || window.openai?.widgetState?.booksView;
  try {
    if (view?.version === 1 && view.bookId && R.books.some(book => book.bookId === view.bookId)) {
      Shelf.active = R.books.findIndex(book => book.bookId === view.bookId);
      renderShelfCards();
      renderShelfContent();
      if ((view.reading || view.annotationId) && await loadBookData(view.bookId)) {
        if (view.reading) {
          const chapter = clamp(Number(view.chapter) || 0, 0, R.manifest.chapterCount - 1);
          await window.__booksResumeView(true);
          await new Promise(requestAnimationFrame);
          await enterReader(chapter, Number(view.seq) || 0);
          if (Number.isInteger(view.pageOffset) && view.pageOffset > 0) gotoPage(R.page + view.pageOffset, { silentIfSame: true });
        }
        const annotation = R.annos.find(item => item.id === view.annotationId);
        if (annotation) openSheet('detail', annotation, { jump: !view.reading });
      }
    }
  } finally {
    restoringHostView = false;
    const observer = new MutationObserver(() => window.__booksCaptureView());
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(sheet, { attributes: true, attributeFilter: ['class'] });
    observer.observe(rFoot, { childList: true, subtree: true, characterData: true });
  }
}).catch(error => toast('阅读位置恢复失败：' + error.message));
`;
}

function statsViewSource(root) {
  const stats = fs.readFileSync(path.join(root, 'web', 'stats.html'), 'utf8');
  const style = stats.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/:root(\[[^\]]+\])/g, ':host($1)').replaceAll(':root', ':host');
  const main = stats.match(/<main[\s\S]*?<\/main>/)[0];
  const scripts = [...stats.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const script = scripts.at(-1)[1]
    .replace("const API = '/reading/api';", "const API = 'books-app://api';")
    .replace("location.assign(HOME_HOSTED ? '/reading/?hosted=1' : '/reading/');", "closeStats();");
  const markup = JSON.stringify('<style>' + style + '</style>' + main).replace(/</g, '\\u003c');
  return `
(() => {
  document.addEventListener('click', event => {
    if (!event.target?.closest?.('#stats-btn')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.getElementById('books-stats-view')) return;
    const view = document.createElement('section');
    view.id = 'books-stats-view';
    view.setAttribute('aria-label', '共读记录');
    view.dataset.theme = document.documentElement.dataset.theme || 'pink';
    const root = view.attachShadow({ mode: 'open' });
    root.innerHTML = ${markup};
    const shelf = document.getElementById('shelf');
    shelf.inert = true;
    document.body.appendChild(view);
    const closeStats = () => {
      view.remove();
      shelf.inert = false;
      document.getElementById('stats-btn').focus();
    };
    const scopedDocument = {
      documentElement: document.documentElement,
      getElementById: id => root.getElementById(id),
      querySelector: selector => root.querySelector(selector) || document.querySelector(selector)
    };
    ((document) => { ${script} })(scopedDocument);
    root.getElementById('back').focus();
  }, true);
})();`;
}

function chatGptHostStyles() {
  return [
    '#books-stats-view{position:fixed;inset:0;width:100%;height:100%;overflow:auto;z-index:1000;background:var(--bg)}',
    'html[data-books-host="chatgpt"]{width:100%;min-height:0!important;overflow:hidden!important}',
    'html[data-books-host="chatgpt"] body{position:relative;width:100%;min-height:0!important;overflow:hidden!important;overscroll-behavior:none}',
    'html[data-books-host="chatgpt"] .shelf{width:100%;max-width:none;min-height:0;margin:0;padding-bottom:0;overflow:hidden;overscroll-behavior:contain}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"],html[data-books-host="chatgpt"][data-books-display-mode="inline"] body,html[data-books-host="chatgpt"][data-books-display-mode="inline"] body.reader-open{height:auto!important;max-height:none!important}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf{height:auto!important}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .reader,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .overlay,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .dlg-mask,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .sheet-mask,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .sheet,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .selection-tools,html[data-books-host="chatgpt"][data-books-display-mode="inline"] .toast{display:none!important}',
    'html[data-books-host="chatgpt"]:not([data-books-display-mode="inline"]),html[data-books-host="chatgpt"]:not([data-books-display-mode="inline"]) body,html[data-books-host="chatgpt"]:not([data-books-display-mode="inline"]) body.reader-open{height:min(100dvh,var(--books-host-max-height,100dvh))!important;max-height:100dvh!important}',
    'html[data-books-host="chatgpt"]:not([data-books-display-mode="inline"]) .shelf{height:100%;overflow-y:auto;padding-bottom:24px}',
    'html[data-books-host="chatgpt"] .reader{height:100%;min-height:0;box-sizing:border-box;padding-bottom:var(--books-host-safe-bottom,0px)}',
    'html[data-books-host="chatgpt"]{--books-chat-clearance:var(--books-host-safe-bottom,0px);--reading-top-safe:var(--books-host-safe-top,0px)}',
    'html[data-books-host="chatgpt"] .rbar{bottom:calc(44px + var(--books-chat-clearance))}',
    'html[data-books-host="chatgpt"] .sheet{visibility:hidden;pointer-events:none;bottom:var(--books-chat-clearance);max-height:min(320px,calc(100% - var(--books-chat-clearance) - 24px));border-radius:18px}',
    'html[data-books-host="chatgpt"] .sheet.open{visibility:visible;pointer-events:auto}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"]{max-height:min(560px,calc(70dvh - var(--books-chat-clearance)));box-sizing:border-box;padding:16px 18px}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"] .sheet-quote-wrap{flex-shrink:0;margin-bottom:12px}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"] .sheet-quote{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;max-height:none;overflow:hidden}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"] .sheet-comments{min-height:0;max-height:none;overflow-y:auto;margin-bottom:0}',
    'html[data-books-host="chatgpt"] body:has(#sheet[data-mode="detail"].open) .sheet-mask{background:rgba(0,0,0,.12)}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf{display:grid;grid-template-columns:minmax(112px,.42fr) minmax(220px,1fr);grid-template-rows:auto auto auto;column-gap:18px;padding:18px 20px 14px;overflow:hidden}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-topbar{display:none}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-stage{grid-column:1;grid-row:1/3;align-self:stretch;width:100%;height:auto;min-height:0}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-book{top:50%;width:112px;height:166px;margin-top:-83px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-stage::after{bottom:calc(50% - 103px);width:136px;height:17px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .page-dots{display:none}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .book-info{grid-column:2;grid-row:1;min-height:0;padding:5px 0 11px;text-align:left}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .book-info h2{font-size:20px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .book-info .author{margin-top:4px;font-size:12px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .reading-panel{grid-column:2;grid-row:2;align-self:start;margin:0;padding:13px 14px;border-radius:18px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .track{margin:9px 0 7px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .reader-progresses{gap:2px;margin-bottom:8px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .continue{min-width:92px;height:34px;padding:0 14px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .notes{grid-column:1/-1;grid-row:3;padding:10px 0 0;overflow:hidden}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .section-head{margin-bottom:3px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .section-head h3{font-size:14px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .note-card{min-height:0;padding:8px 10px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .home-quote{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;font-size:12px;line-height:1.5}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .note-meta{margin:4px 0 0 14px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .empty-note{min-height:38px}',
    '@media (max-width:520px){',
    'html[data-books-host="chatgpt"] #sheet-toc{max-height:min(60dvh,calc(var(--books-host-max-height,100dvh) - var(--books-chat-clearance) - 80px));box-sizing:border-box}',
    'html[data-books-host="chatgpt"]:not([data-books-display-mode="inline"]){--reading-top-safe:max(52px,var(--books-host-safe-top,0px))}',
    'html[data-books-host="chatgpt"] .reader-top{min-height:calc(56px + var(--reading-top-safe))}',
    'html[data-books-host="chatgpt"] #sheet:has(#sheet-text:focus){top:calc(56px + var(--reading-top-safe));bottom:auto;max-height:min(320px,calc(100% - 64px - var(--reading-top-safe)));box-sizing:border-box}',
    'html[data-books-host="chatgpt"] .reader-foot{min-height:34px;padding:6px 0 10px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf{grid-template-columns:92px minmax(0,1fr);column-gap:12px;padding:14px 13px 12px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-book{width:88px;height:131px;margin-top:-66px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .shelf-stage::after{bottom:calc(50% - 82px);width:104px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .reading-panel{padding:11px 12px}',
    'html[data-books-host="chatgpt"][data-books-display-mode="inline"] .read-time{display:none}',
    '}',
    '@media (min-width:900px) and (min-height:640px){',
    'html[data-books-host="chatgpt"] .overlay{align-items:center;justify-content:center;padding:32px}',
    'html[data-books-host="chatgpt"] .panel{width:min(720px,100%);max-height:min(760px,86vh);border-radius:20px;padding:22px}',
    'html[data-books-host="chatgpt"] .sheet:not([data-mode="detail"]){left:50%;right:auto;width:min(720px,calc(100% - 48px));border-radius:20px 20px 0 0;transform:translate(-50%,105%)}',
    'html[data-books-host="chatgpt"] .sheet:not([data-mode="detail"]).open{transform:translate(-50%,0)}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"]{top:50%;bottom:auto;left:50%;right:auto;width:min(680px,calc(100% - 64px));max-height:min(500px,calc(100dvh - var(--books-chat-clearance) - 120px));border-radius:20px;transform:translate(-50%,calc(-50% + 18px)) scale(.98)}',
    'html[data-books-host="chatgpt"] .sheet[data-mode="detail"].open{transform:translate(-50%,-50%) scale(1)}',
    'html[data-books-host="chatgpt"] .reader-top,html[data-books-host="chatgpt"] .reader-viewport,html[data-books-host="chatgpt"] .reader-foot{width:min(1120px,100%);margin-left:auto;margin-right:auto}',
    'html[data-books-host="chatgpt"] .reader-viewport{padding-top:14px;padding-bottom:12px}',
    'html[data-books-host="chatgpt"] .reader-flow{font-size:18px;line-height:1.9}',
    '}',
  ].join('');
}

function inlineAsset(html, root, publicPath, relativePath, mimeType) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) return html;
  const dataUrl = `data:${mimeType};base64,${fs.readFileSync(file).toString('base64')}`;
  return html.replaceAll(publicPath, dataUrl);
}

function hostBridgeSource() {
  return String.raw`
(() => {
  window.__BOOKS_CHATGPT_HOST__ = true;
  document.documentElement.dataset.booksHost = 'chatgpt';
  document.documentElement.dataset.booksDisplayMode = 'inline';
  const nativeFetch = window.fetch.bind(window);
  const cache = { books: [], annotations: new Map() };
  const sentParagraphContexts = new Set();
  let pendingShare = null;
  window.__booksFlushShare = () => {
    const share = pendingShare;
    pendingShare = null;
    if (share) void share().catch(() => window.__booksShareError?.());
  };
  let lastInlineHeight = 0;

  function notifyInlineHeight() {
    if (document.documentElement.dataset.booksDisplayMode !== 'inline') return;
    window.setTimeout(() => {
      const shelf = document.getElementById?.('shelf');
      const login = document.getElementById?.('login-screen');
      const target = login && !login.classList?.contains('hidden') ? login : shelf;
      const height = Math.ceil(Number(target?.getBoundingClientRect?.().height) || 0);
      if (height <= 0 || Math.abs(height - lastInlineHeight) < 2) return;
      lastInlineHeight = height;
      if (typeof window.openai?.notifyIntrinsicHeight === 'function') {
        window.openai.notifyIntrinsicHeight(height);
      }
    }, 0);
  }

  function syncHostViewport(globals = {}) {
    const height = Number(globals.maxHeight ?? window.openai?.maxHeight);
    const displayMode = globals.displayMode ?? window.openai?.displayMode ?? document.documentElement.dataset.booksDisplayMode ?? 'inline';
    const safeArea = globals.safeArea ?? window.openai?.safeArea;
    let didSync = false;
    if (Number.isFinite(height) && height > 0) {
      const value = String(Math.floor(height)) + 'px';
      if (document.documentElement.style.getPropertyValue('--books-host-max-height') !== value) {
        document.documentElement.style.setProperty('--books-host-max-height', value);
        didSync = true;
      }
    }
    if (typeof displayMode === 'string' && displayMode && document.documentElement.dataset.booksDisplayMode !== displayMode) {
      document.documentElement.dataset.booksDisplayMode = displayMode;
      didSync = true;
    }
    const safeBottom = Number(safeArea?.insets?.bottom ?? safeArea?.bottom);
    const safeTop = Number(safeArea?.insets?.top ?? safeArea?.top);
    if (Number.isFinite(safeTop) && safeTop >= 0) {
      const value = String(Math.floor(safeTop)) + 'px';
      if (document.documentElement.style.getPropertyValue('--books-host-safe-top') !== value) {
        document.documentElement.style.setProperty('--books-host-safe-top', value);
        didSync = true;
      }
    }
    if (Number.isFinite(safeBottom) && safeBottom >= 0) {
      const value = String(Math.floor(safeBottom)) + 'px';
      if (document.documentElement.style.getPropertyValue('--books-host-safe-bottom') !== value) {
        document.documentElement.style.setProperty('--books-host-safe-bottom', value);
        didSync = true;
      }
    }
    if (didSync) {
      window.setTimeout(() => {
        if (displayMode !== 'fullscreen') notifyInlineHeight();
        window.dispatchEvent(new Event('resize'));
      }, 0);
    }
    return Number.isFinite(height) && height > 0;
  }

  if (!syncHostViewport()) {
    let remainingChecks = 40;
    const viewportPollId = window.setInterval(() => {
      remainingChecks -= 1;
      if (syncHostViewport() || remainingChecks <= 0) {
        window.clearInterval(viewportPollId);
      }
    }, 250);
  }
  window.addEventListener('openai:set_globals', (event) => {
    syncHostViewport(event?.detail?.globals || {});
  }, { passive: true });
  window.addEventListener('load', () => {
    const shelf = document.getElementById?.('shelf');
    if (shelf && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => notifyInlineHeight()).observe(shelf);
    }
    notifyInlineHeight();
  }, { once: true });

  function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload || {}), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  function toolPayload(result) {
    if (result && result._meta && result._meta.payload) return result._meta.payload;
    if (result && result.structuredContent && result.structuredContent.payload) return result.structuredContent.payload;
    return null;
  }

  async function callTool(name, args) {
    if (!window.openai || typeof window.openai.callTool !== 'function') {
      throw new Error('ChatGPT host bridge is unavailable');
    }
    return window.openai.callTool(name, args);
  }

  function remember(pathname, payload) {
    if (pathname === '/books' && Array.isArray(payload && payload.books)) cache.books = payload.books;
    const match = pathname.match(/^\/annotations\/([A-Za-z0-9_-]+)$/);
    if (match && Array.isArray(payload && payload.annotations)) cache.annotations.set(match[1], payload.annotations);
  }

  function bookTitle(bookId) {
    const book = cache.books.find((item) => item.bookId === bookId);
    return book && book.title ? book.title : '正在读的书';
  }

  async function sendSelectionToChatGpt(annotation, bookId, note) {
    if (!annotation || !window.openai || typeof window.openai.sendFollowUpMessage !== 'function') return;
    const paragraphKey = bookId + ':' + String(annotation.seq ?? '');
    const includeContext = !sentParagraphContexts.has(paragraphKey);
    const lines = [
      '[Books shared line]',
      '《' + bookTitle(bookId) + '》',
      '“' + String(annotation.quote || '').slice(0, 800) + '”',
      includeContext && annotation.context && annotation.context !== annotation.quote
        ? '这一小段：' + String(annotation.context).slice(0, 1200)
        : '',
      note ? '读者留下的话：' + String(note).slice(0, 600) : '',
      'selection_id=' + annotation.id,
      '请正常回应读者，并用 reply_to_shared_line 把同一回复写回这条页边对话。'
    ].filter(Boolean);
    window.__booksCaptureView?.(annotation.id);
    await window.openai.sendFollowUpMessage({ prompt: lines.join('\n'), scrollToBottom: false });
    await window.__booksResumeView?.();
    sentParagraphContexts.add(paragraphKey);
  }

  async function sendFollowUpComment(pathname, comment) {
    if (!comment || !window.openai || typeof window.openai.sendFollowUpMessage !== 'function') return;
    const match = pathname.match(/^\/annotations\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/comment$/);
    if (!match) return;
    const bookId = match[1];
    const annotationId = match[2];
    const lines = [
      '[Books follow-up]',
      '《' + bookTitle(bookId) + '》',
      '“' + String(comment.text || '').slice(0, 600) + '”',
      'selection_id=' + annotationId,
      'comment_id=' + String(comment.id || ''),
      '请直接回应，并用 reply_to_shared_line 把同一回复写回这条页边对话。'
    ].filter(Boolean);
    window.__booksCaptureView?.(annotationId);
    await window.openai.sendFollowUpMessage({ prompt: lines.join('\n'), scrollToBottom: false });
    await window.__booksResumeView?.();
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!url || !url.startsWith('books-app://api')) return nativeFetch(input, init);
    const pathname = url.slice('books-app://api'.length) || '/';
    const method = String(init.method || 'GET').toUpperCase();

    if (pathname.startsWith('/import')) return jsonResponse(405, { error: '请在自建 Books 中导入书籍' });

    let body;
    if (typeof init.body === 'string' && init.body) {
      try { body = JSON.parse(init.body); } catch { return jsonResponse(400, { error: 'bad json' }); }
    }

    try {
      const result = await callTool('books_ui_request', { method, path: pathname, ...(body ? { body } : {}) });
      const payload = toolPayload(result);
      if (!payload) return jsonResponse(502, { error: 'Books 页面没有收到数据' });
      if (payload.status && payload.status >= 400) return jsonResponse(payload.status, payload.body || { error: 'request failed' });
      const responseBody = payload.body || {};
      remember(pathname, responseBody);
      if (method === 'POST' && pathname === '/annotations' && responseBody.annotation && !responseBody.duplicateSelection) {
        pendingShare = () => sendSelectionToChatGpt(responseBody.annotation, body && body.bookId, body && body.comment);
      } else if (method === 'POST' && /\/comment$/.test(pathname)) {
        pendingShare = () => sendFollowUpComment(pathname, responseBody.comment);
      }
      return jsonResponse(payload.status || 200, responseBody);
    } catch (error) {
      return jsonResponse(502, { error: String(error && error.message || error) });
    }
  };

  document.addEventListener('click', (event) => {
    if (!event.target || !event.target.closest || !event.target.closest('#home-read-btn')) return;
    try {
      void Promise.resolve(window.openai?.requestDisplayMode?.({ mode: 'fullscreen' }))
        .then((result) => syncHostViewport({ displayMode: result?.mode || window.openai?.displayMode || 'inline' }))
        .catch(() => syncHostViewport({ displayMode: window.openai?.displayMode || 'inline' }));
    } catch {}
  }, true);
})();
`;
}

module.exports = { RESOURCE_URI, buildChatGptWidget, hostBridgeSource, readerViewStateSource };
