const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../web/reader.html'), 'utf8');
const code = html.slice(html.indexOf('const PAINT_HOLD_MS'), html.indexOf('if (PaintSelect.enabled) {'));
const pending = html.slice(html.indexOf('function pendingFromParagraph('), html.indexOf('function pendingFromNativeSelection()'));

function paintContext(caretAt) {
  const shown = [];
  const ctx = {
    R: { ch: 0, chapters: [{ title: '第一章', paragraphs: ['一二三四五六七八九十', '下一段'] }], pendingSel: null, suppressReaderClickUntil: 0 },
    PaintSelect: { enabled: false, timer: 0, active: true, paraIdx: 0, anchorOff: 4, focusOff: 4, range: null },
    rFlow: { querySelector: () => ({}) },
    document: {
      createRange: () => ({ setStart() {}, setEnd() {} }),
      createTreeWalker: () => ({ nextNode: () => null }),
      caretRangeFromPoint: (x) => caretAt(x),
    },
    NodeFilter: { SHOW_TEXT: 4 },
    selectionTools: { classList: { add: (name) => shown.push(name) } },
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    pointInParagraph: (node) => node,
    positionSelectionTools() {},
    clearNativeSelection() { ctx.cleared = true; },
    makeSelectionClientId: () => 'client',
    clearTimeout() {}, Date, Math,
  };
  vm.createContext(ctx);
  vm.runInContext(pending + code, ctx);
  ctx.shown = shown;
  return ctx;
}

const caret = (paraIdx, off) => ({ startContainer: { paraIdx, off }, startOffset: off });

test('dragging forward paints from the held character to the finger', () => {
  const ctx = paintContext(() => caret(0, 8));
  ctx.movePaintFocus(1, 1);
  ctx.finishPaint();
  assert.equal(ctx.R.pendingSel.quote, '五六七八');
  assert.deepEqual([ctx.R.pendingSel.startOff, ctx.R.pendingSel.endOff], [4, 8]);
  assert.deepEqual(ctx.shown, ['show']);
});

test('dragging backward keeps the held character painted', () => {
  const ctx = paintContext(() => caret(0, 1));
  ctx.movePaintFocus(1, 1);
  ctx.finishPaint();
  assert.equal(ctx.R.pendingSel.quote, '二三四五');
});

test('a long press without moving paints one character', () => {
  const ctx = paintContext(() => caret(0, 4));
  ctx.finishPaint();
  assert.equal(ctx.R.pendingSel.quote, '五');
});

test('leaving the paragraph stops at its edge instead of crossing it', () => {
  const ctx = paintContext(() => caret(1, 2));
  ctx.movePaintFocus(1, 1);
  ctx.finishPaint();
  assert.equal(ctx.R.pendingSel.quote, '五六七八九十');
  assert.equal(ctx.R.pendingSel.paraIdx, 0);
});

test('touch highlight keeps text selectable for WebKit rendering', () => {
  assert.match(html, /enabled: Boolean\(globalThis\.CSS\?\.highlights && globalThis\.Highlight\) && matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)\.matches/);
  assert.match(html, /:root\.paint-select \.reader-flow, :root\.paint-select \.reader-flow \* \{ -webkit-touch-callout: none; \}/);
  assert.match(html, /::highlight\(books-paint\) \{ background-color: color-mix\(in srgb, var\(--human\) 30%, transparent\); \}/);
});
