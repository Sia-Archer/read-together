const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../web/reader.html'), 'utf8');
const code = html.slice(html.indexOf('let detailPollGeneration = 0;'), html.indexOf('\nfunction resizeAnnotationInput()'));

test('a newly created annotation receives replies while its detail remains open', async () => {
  const initial = { id: 'one', seq: 0, startOff: 0, endOff: 4, createdBy: 'human', comments: [{ author: 'human', text: 'note' }] };
  const fresh = { ...initial, comments: [...initial.comments, { author: 'ai', text: 'reply' }] };
  let next, renders = 0;
  const ctx = { R: { book: { bookId: 'book' }, detailAnno: initial, annos: [initial], detailPollTimer: null }, sheet: { classList: { contains: () => true } }, Date, JSON,
    setTimeout(fn) { next = fn; return 1; }, clearTimeout() {},
    selectionGroup: anno => ctx.R.annos.filter(a => a.seq === anno.seq && a.startOff === anno.startOff && a.endOff === anno.endOff),
    apiGet: async () => ({ annotations: [fresh] }), renderComments: () => { renders++; },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx); ctx.startDetailPolling();
  assert.equal(typeof next, 'function');
  await next();
  assert.equal(ctx.R.detailAnno.comments[1].text, 'reply');
  assert.equal(renders, 1);
  ctx.stopDetailPolling();
});

test('a late response cannot replace a newly opened annotation', async () => {
  const first = { id: 'one', createdBy: 'human' }, second = { id: 'two', createdBy: 'human' };
  let next, complete;
  const ctx = { R: { book: { bookId: 'book' }, detailAnno: first, annos: [first], detailPollTimer: null }, sheet: { classList: { contains: () => true } }, Date, JSON,
    setTimeout(fn) { next = fn; return 1; }, clearTimeout() {}, selectionGroup: () => [], renderComments() { throw Error('stale update rendered'); },
    apiGet: () => new Promise(resolve => { complete = resolve; }),
  };
  vm.createContext(ctx); vm.runInContext(code, ctx); ctx.startDetailPolling();
  const pending = next();
  ctx.stopDetailPolling(); ctx.R.detailAnno = second;
  complete({ annotations: [first] }); await pending;
  assert.equal(ctx.R.detailAnno.id, 'two');
});
