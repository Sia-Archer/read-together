'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web', 'reader.html'), 'utf8');
const stats = fs.readFileSync(path.join(root, 'web', 'stats.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'web', 'sw.js'), 'utf8');
const nginx = fs.readFileSync(path.join(root, 'deploy', 'nginx-reading.conf'), 'utf8');

test('Books is a Home-owned room with no separate install or sign-in surface', () => {
  assert.equal(fs.existsSync(path.join(root, 'web', 'manifest.webmanifest')), false);
  assert.doesNotMatch(html, /rel="manifest"|apple-mobile-web-app-capable|apple-touch-icon/);
  assert.doesNotMatch(html, /serviceWorker\.register/);
  assert.match(html, /serviceWorker\.getRegistration\('\/reading\/'\)[\s\S]*registration\?\.update/);
  assert.doesNotMatch(html, /login-screen|login-password|退出书房|\/auth\/login|\/auth\/logout/);
  assert.match(nginx, /location = \/_guichao_reading_home_auth[\s\S]*127\.0\.0\.1:8787\/api\/appearance/);
  assert.match(nginx, /location \/reading\/ \{[\s\S]*auth_request \/_guichao_reading_home_auth/);
  assert.match(nginx, /location \/reading\/api\/ \{[\s\S]*auth_request \/_guichao_reading_home_auth/);
  assert.match(nginx, /proxy_set_header X-Guichao-Home-Authenticated "1"/);
});

test('Home-hosted Books consumes the outer top safe area exactly once', () => {
  assert.match(html, /document\.documentElement\.dataset\.homeHosted = '1'/);
  assert.match(html, /--reading-top-safe: env\(safe-area-inset-top\)/);
  assert.match(html, /:root\[data-home-hosted="1"\] \{[^}]*--reading-top-safe: 0px;/);
  assert.match(html, /\.shelf-topbar \{[^}]*var\(--reading-top-safe\)/);
  assert.match(html, /\.reader-top \{[^}]*var\(--reading-top-safe\)/);
  assert.match(html, /const HOME_HOSTED = document\.documentElement\.dataset\.homeHosted === '1'/);
  assert.match(html, /safe-area-inset-bottom/);
  assert.match(html, /:root\[data-home-hosted="1"\] \{[^}]*height: 100%[^}]*overflow: hidden[^}]*overscroll-behavior: none/);
  assert.match(html, /:root\[data-home-hosted="1"\] body \{[^}]*height: 100%[^}]*overflow: hidden[^}]*overscroll-behavior: none/);
  assert.match(html, /:root\[data-home-hosted="1"\] \.shelf \{[^}]*overflow-y: auto[^}]*-webkit-overflow-scrolling: touch[^}]*touch-action: pan-y[^}]*scrollbar-width: none/);
  assert.match(html, /:root\[data-home-hosted="1"\] \.shelf::\-webkit-scrollbar \{ display: none; \}/);
});

test('the former Books worker removes its cache and unregisters itself', () => {
  assert.match(sw, /RETIRED_CACHE_PREFIX = 'guichao-books-pwa-'/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /registration\.unregister/);
  assert.doesNotMatch(sw, /addEventListener\('fetch'/);
});

test('shelf shows two compact progress and time lines without chapter or page labels', () => {
  assert.match(html, /id="home-progress-human">读者 · 未开始/);
  assert.match(html, /id="home-progress-ai">共读者 · 未开始/);
  assert.match(html, /readerProgressText\(book\.readers\?\.human, '读者'\)/);
  assert.match(html, /readerProgressText\(book\.readers\?\.ai, '共读者'\)/);
  assert.doesNotMatch(html, /id="home-chapter"/);
  assert.doesNotMatch(html, /readerProgressText[\s\S]{0,240}chapter/);
});

test('shelf is manual, compact and uses the library pink', () => {
  assert.match(html, /pointerdown/);
  assert.match(html, /pointermove/);
  assert.match(html, /\.shelf-stage \{[^}]*touch-action: pan-y/);
  assert.doesNotMatch(html, /pointerdown[\s\S]{0,320}setPointerCapture/);
  assert.match(html, /Shelf\.axis === 'horizontal'[\s\S]{0,180}setPointerCapture/);
  assert.doesNotMatch(html, /else openBookDirect\(book\.bookId\)/);
  assert.doesNotMatch(html, /左右滑动选书/);
  assert.doesNotMatch(html, /#4a6b52|#5d8a6d/i);
  assert.match(html, /--accent: #947780/);
  assert.match(html, /class="stats-btn"/);
  assert.match(html, /guichao-books:stats/);
  assert.match(html, /guichao-books:import/);
  assert.match(html, /guichao-books:host-ready/);
  assert.doesNotMatch(html, />导入<\/button>/);
});

test('stats is a real themed Books page backed by current room data', () => {
  assert.match(stats, /localStorage\.getItem\('readalong-settings'\)/);
  assert.match(stats, /getJson\('\/books'\)/);
  assert.match(stats, /getJson\('\/annotations\/'/);
  assert.match(stats, /guichao-books:view', view: 'stats'/);
  assert.match(stats, /guichao-books:theme/);
  assert.doesNotMatch(stats, /17 小时 42 分|48h 21m|31h 08m|>126<|>73<|>41</);
});

test('shelf keeps one recent annotation and restores bookmarks and notes in one library sheet', () => {
  assert.match(html, /id="home-notes-all"[^>]*>查看全部<\/button>/);
  assert.match(html, /const annotated = annotations\.filter\(\(item\) => annotationRoot\(item\)\.text\)/);
  assert.match(html, /renderHomeNote\(book, latest, annotated\.length\)/);
  assert.match(html, /id="sheet-library"/);
  assert.match(html, /data-library-tab="bookmarks"/);
  assert.match(html, /data-library-tab="annotations"/);
  assert.match(html, /openLibrarySheet\('annotations'\)/);
  assert.match(html, /id="sheet-quote-wrap"[\s\S]*id="sheet-jump"[\s\S]*看原文/);
  assert.doesNotMatch(html, /↩|跳转到原文/);
  assert.match(html, /\.sheet-jump \{[^}]*color: var\(--muted\)[^}]*font-size: 12px/);
  assert.match(html, /await enterReader\(Number\(mark\.chapter\) \|\| 0, mark\.seq\)/);
});

test('reader center opens an Apple-like stacked menu with one combined library entry', () => {
  assert.match(html, /class="reader-menu-primary" id="rb-toc"/);
  assert.match(html, /id="rb-library"[\s\S]*书签与批注/);
  assert.match(html, /id="rb-theme"[\s\S]*主题与设置/);
  assert.doesNotMatch(html, /id="rb-marks"|id="rb-notes"/);
  assert.doesNotMatch(html, /id="rb-prev"|id="rb-next"/);
  assert.match(html, /class="reader-quick-actions"[\s\S]*id="r-mark"/);
  assert.match(html, /bookmark-outline\.svg/);
  assert.match(html, /bookmark-filled\.svg/);
  assert.doesNotMatch(html, /&#x2691;/);
  assert.match(html, /if \(settings\.pageMode === 'tap' && x < 0\.33\) turnPage\(-1\);[\s\S]*else if \(settings\.pageMode === 'tap' && x > 0\.67\) turnPage\(1\);[\s\S]*else openBar\(\)/);
});

test('annotation detail quote line follows the highlighter author color', () => {
  assert.match(html, /\.sheet-quote-wrap\.by-ai \{ border-left-color: var\(--ai\); \}/);
  assert.match(html, /quoteWrap\.classList\.toggle\('by-ai', mode === 'detail' && anno\?\.createdBy === 'ai'\)/);
});

test('ChatGPT is a reply channel, not a separate person in the page margin', () => {
  assert.doesNotMatch(html, /return People\.chatgpt/);
  assert.match(html, /if \(item\?\.author === 'ai' \|\| item\?\.createdBy === 'ai'\) return People\.companion\.name/);
  assert.match(html, /function personFor\([\s\S]*return People\.companion;/);
});

test('reader opens directly, fills the Home room and keeps native selection distinct from page swipes', () => {
  assert.doesNotMatch(html, /id="overlay-book"/);
  assert.match(html, /body\.reader-open/);
  assert.match(html, /height: 100dvh/);
  assert.match(html, /\.reader-flow, \.reader-flow \* \{ -webkit-user-select: text/);
  assert.match(html, /pendingFromNativeSelection/);
  assert.match(html, /selection-share/);
  assert.match(html, /rViewport\.addEventListener\('touchstart'/);
  assert.match(html, /await turnPage\(dx < 0 \? 1 : -1\)/);
  assert.match(html, /Math\.ceil\(\(rFlow\.scrollWidth - 1\) \/ R\.step\)/);
});

test('night reading is one quiet surface with the same back icon and a stable room switch', () => {
  assert.match(html, /:root\[data-theme="night"\] \{[\s\S]*--bg: #151514;[\s\S]*--card: #1c1c1b;/);
  assert.match(html, /:root\[data-theme="night"\] \.shelf \{ background: var\(--bg\); \}/);
  assert.doesNotMatch(html, /:root\[data-theme="night"\] \.shelf \{[^}]*radial-gradient/);
  assert.match(html, /<button class="r-back"[^>]+aria-label="返回书房"><svg[^>]+><path d="M20 12H4m7-7-7 7 7 7"\/>/);
  assert.match(html, /\.reader \{[^}]*visibility: hidden[^}]*opacity: 0[^}]*pointer-events: none/);
  assert.match(html, /\.reader\.open \{[^}]*visibility: visible[^}]*opacity: 1[^}]*pointer-events: auto/);
  assert.doesNotMatch(html, /\.reader \{[^}]*(?:transform|transition):/);
  assert.match(html, /body\.reader-open \.shelf \{ visibility: hidden;/);
  assert.match(stats, /night: \{ bg: '#151514', ink: '#dedbd9' \}/);
});

test('reading access uses Home auth while private presence stays unpublished', () => {
  assert.match(nginx, /location = \/reading\/api\/presence[\s\S]*return 404/);
  assert.match(nginx, /location \/reading\/api\/[\s\S]*auth_request \/_guichao_reading_home_auth/);
  assert.match(html, /window\.top\.location\.assign\('\/login\.html'\)/);
});

test('page-margin annotations keep one real Home avatar while replies stay avatar-free', () => {
  assert.match(html, /\.annotation-block \{[^}]*grid-template-columns: 40px minmax\(0,1fr\)/);
  assert.match(html, /\.thread-avatar \{[^}]*width: 40px; height: 40px/);
  assert.match(html, /guichao-books:people-request/);
  assert.match(html, /guichao-books:people/);
  assert.match(html, /class="\$\{personNameClass\(creator\)\}"/);
  assert.doesNotMatch(html, /reply-meta[^\n]+personNameClass/);
  assert.doesNotMatch(html, /reply-row[^\n]+avatarHtml/);
});

test('page-margin reply feedback follows delivery truth instead of a missing-reply guess', () => {
  assert.match(html, /delivery\?\.status === 'failed'/);
  assert.match(html, /comment\.final === false/);
  assert.match(html, /正在送给\$\{replyPartnerLabel\(\)\}/);
  assert.match(html, /\$\{replyPartnerLabel\(\)\}在回你/);
  assert.match(html, /return People\.companion\.name/);
  assert.match(html, /这次没送到/);
  assert.match(html, /data-retry-reply/);
  assert.doesNotMatch(html, /那里了/);
  assert.doesNotMatch(html, /正在读这一句|function isWaitingForAiReply/);
});

test('annotation send keeps the keyboard focus so one tap sends', () => {
  assert.match(html, /sheetSendButton\.addEventListener\('mousedown', \(event\) => event\.preventDefault\(\)\)/);
  assert.match(html, /sheetSendButton\.addEventListener\('touchend'[\s\S]{0,400}event\.preventDefault\(\);\s*if \(!sheetSendButton\.disabled\) sendSheet\(\);/);
});
