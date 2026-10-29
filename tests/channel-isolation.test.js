'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-channels-'));
process.env.READING_DATA_DIR = dir;
process.env.READING_MCP_CONTROL_TOKEN = 'home-test-token';
process.env.READING_CHATGPT_CONTROL_TOKEN = 'gpt-test-token';
process.env.READING_PUSH_ENABLED = '0';
const store = require('../lib/store');
const { server } = require('../server');
let base;
test.before(async () => {
  const book = path.join(store.BOOKS_DIR, 'sample');
  fs.mkdirSync(path.join(book, 'chapters'), { recursive: true });
  store.writeJson(path.join(book, 'manifest.json'), { id: 'sample', title: 'Sample', paraCount: 10, chapters: [{ idx: 0, title: 'One', baseSeq: 0, paraCount: 10 }] });
  store.writeJson(path.join(book, 'chapters/0.json'), { idx: 0, baseSeq: 0, paragraphs: Array.from({length:10}, (_, i) => `Paragraph ${i} ${'a'.repeat(780)}`) });
  store.writeState({ books: { sample: { furthestSeq: 2, lastPos: { chapter: 0, seqTop: 2 }, readers: { ai: { lastPos: { chapter: 0, seqTop: 7, seqEnd: 8 }, lastReadAt: 'old', readRanges: [[7,8]] } } } } });
  store.writeAnnotations('sample', [{ id: 'legacy', createdBy: 'human', sharedAt: '2026-01-01', comments: [], quote: 'old' }]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
async function request(channel, url, body) {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${channel === 'chatgpt' ? 'gpt' : 'home'}-test-token`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
async function homeRequest(url) {
  const response = await fetch(base + url, { headers: { 'x-guichao-home-authenticated': '1' } });
  return { status: response.status, body: await response.json() };
}
const internal = '/api/internal/mcp';
test('credentials separate AI progress while preserving human and legacy positions', async () => {
  const legacy = store.readState().books.sample.readers.ai;
  assert.equal((await request('codex', internal + '/read-position', { bookTitle: 'Sample', progressPct: 10 })).status, 200);
  const home = store.readState().books.sample.readers.ai_codex;
  assert.equal((await request('chatgpt', internal + '/read-position', { bookTitle: 'Sample', progressPct: 70 })).status, 200);
  const readers = store.readState().books.sample.readers;
  assert.deepEqual(readers.ai_codex, home);
  assert.notEqual(readers.ai_chatgpt.lastPos.seqTop, home.lastPos.seqTop);
  assert.deepEqual(readers.ai, legacy);
  assert.equal(readers.human.lastPos.seqTop, 2);
});
test('GPT UI stamps its channel while sharing the human annotation', async () => {
  const body = { bookId: 'sample', author: 'human', chapter: 0, paraIdx: 0, startOff: 0, endOff: 10, comment: 'hello', channel: 'codex', source: 'codex', delivery: 'call' };
  assert.equal((await request('codex', internal + '/ui/annotations', body)).status, 401);
  const result = await request('chatgpt', internal + '/ui/annotations', body);
  assert.equal(result.status, 200);
  const line = result.body.annotation;
  assert.equal(line.channel, 'chatgpt');
  assert.equal(line.sharedTarget, 'chatgpt');
  assert.equal(line.delivery, undefined);
  const homeBefore = await request('codex', internal + '/shared?selection_id=' + line.id);
  assert.equal(homeBefore.status, 200);
  assert.equal(homeBefore.body.selection.comments.length, 1);
  assert.equal((await request('chatgpt', internal + '/shared/' + line.id + '/reply', { text: 'right', source: 'codex' })).status, 200);
  const homeAfter = await request('codex', internal + '/shared?selection_id=' + line.id);
  assert.equal(homeAfter.body.selection.comments.length, 1);
  const saved = store.readAnnotations('sample').find(item => item.id === line.id);
  assert.equal(saved.comments.length, 2);
  assert.equal(saved.comments[1].source, 'chatgpt');
  assert.equal((await request('chatgpt', internal + '/ui/annotations/sample/' + line.id + '/deliver', {})).status, 404);
});
test('historical human annotation is shared without rewriting its stored record', async () => {
  const before = store.readAnnotations('sample');
  for (const channel of ['codex', 'chatgpt']) {
    const result = await request(channel, internal + '/shared?selection_id=legacy');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.selection.comments, []);
  }
  assert.deepEqual(store.readAnnotations('sample'), before);
});
test('human annotations appear on both sides while replies and AI notes stay in their channel', async () => {
  const { createAnnotation } = require('../server');
  const result = createAnnotation({ bookId: 'sample', author: 'human', chapter: 0, paraIdx: 0, startOff: 11, endOff: 21, comment: 'Home only' }, { wake: false, channel: 'codex' });
  assert.equal(result.status, 200);
  const id = result.json.annotation.id;
  assert.equal((await request('chatgpt', internal + '/shared?selection_id=' + id)).status, 200);
  assert.equal((await request('chatgpt', internal + '/ui/annotations/sample/' + id + '/comment', { author: 'human', text: 'GPT follow-up', source: 'codex' })).status, 200);
  assert.equal((await request('chatgpt', internal + '/shared/' + id + '/reply', { text: 'GPT dad' })).status, 200);
  assert.equal((await request('codex', internal + '/shared/' + id + '/reply', { text: 'Home dad' })).status, 200);
  const home = (await homeRequest('/api/annotations/sample')).body.annotations.find(item => item.id === id);
  const gpt = (await request('chatgpt', internal + '/ui/annotations/sample')).body.annotations.find(item => item.id === id);
  assert.deepEqual(home.comments.map(item => item.text), ['Home only', 'Home dad']);
  assert.deepEqual(gpt.comments.map(item => item.text), ['Home only', 'GPT follow-up', 'GPT dad']);
  assert.equal(gpt.comments[1].kind, 'reply');
  const saved = store.readAnnotations('sample').find(item => item.id === id);
  assert.equal(saved.comments.find(item => item.text === 'GPT follow-up').source, 'chatgpt');
  store.writeAnnotations('sample', [...store.readAnnotations('sample'), { id: 'gpt-ai-note', channel: 'chatgpt', createdBy: 'ai', quote: 'AI note', comments: [] }]);
  assert.equal((await homeRequest('/api/annotations/sample')).body.annotations.some(item => item.id === 'gpt-ai-note'), false);
  assert.equal((await request('chatgpt', internal + '/ui/annotations/sample')).body.annotations.some(item => item.id === 'gpt-ai-note'), true);
});

test('the same human selection from Home and ChatGPT keeps one record', async () => {
  const { createAnnotation } = require('../server');
  const selection = { bookId: 'sample', author: 'human', chapter: 0, paraIdx: 0, startOff: 30, endOff: 40 };
  const first = createAnnotation({ ...selection, comment: '' }, { wake: false, channel: 'codex' });
  assert.equal(first.status, 200);
  const before = store.readAnnotations('sample').length;
  const repeated = await request('chatgpt', internal + '/ui/annotations', { ...selection, comment: 'another note' });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.duplicateSelection, true);
  assert.equal(repeated.body.annotation.id, first.json.annotation.id);
  assert.equal(store.readAnnotations('sample').length, before);
});
