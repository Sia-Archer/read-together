'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-read-position-'));
process.env.READING_DATA_DIR = dataDir;

const store = require('../lib/store');
const { createAnnotation, readBookPosition, searchBookText } = require('../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seed() {
  const bookId = 'tokyo-8m2';
  const dir = path.join(store.BOOKS_DIR, bookId);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  store.writeJson(path.join(dir, 'manifest.json'), {
    id: bookId,
    title: '示例书',
    author: '吉井忍',
    paraCount: 10,
    chapterCount: 1,
    chapters: [{ idx: 0, title: '自序', baseSeq: 0, paraCount: 10 }]
  });
  store.writeJson(path.join(dir, 'chapters', '0.json'), {
    idx: 0,
    title: '自序',
    baseSeq: 0,
    paragraphs: Array.from({ length: 10 }, (_, index) => `第${index + 1}段${'字'.repeat(780)}`)
  });
  store.writeState({
    books: {
      [bookId]: {
        furthestSeq: 5,
        pushedRanges: [[0, 5]],
        lastPos: { chapter: 0, seqTop: 5 },
        lastOpenedAt: '2026-08-22T00:00:00.000Z',
        totalPushedChars: 0,
        totalReadMs: 0,
        session: null
      }
    }
  });
  store.writeAnnotations(bookId, [{
    id: 'line-1',
    seq: 2,
    quote: '第3段',
    context: `第3段${'字'.repeat(780)}`,
    chapter: 0,
    chapterTitle: '自序',
    channel: 'codex',
    createdBy: 'human',
    createdAt: '2026-08-22T00:00:00.000Z',
    sharedAt: '2026-08-22T00:00:00.000Z',
    comments: [
      { id: 'root-1', author: 'human', text: '读者写在这里。', createdAt: '2026-08-22T00:00:00.000Z' },
      { id: 'reply-1', author: 'ai', text: '共读者看见了。', createdAt: '2026-08-22T00:01:00.000Z' }
    ]
  }]);
  return bookId;
}

test('reading by title and approximate whole-book progress returns one bounded segment and records AI progress', () => {
  const bookId = seed();
  const out = readBookPosition({ bookTitle: '示例书', progressPct: 20 });
  assert.equal(out.status, 200);
  assert.equal(out.json.title, '示例书');
  assert.equal(out.json.progressPct, 30);
  assert.ok(out.json.text.length <= 1602);
  assert.equal(out.json.paragraphs, undefined);
  assert.equal(out.json.annotations.length, 1);
  assert.deepEqual(out.json.annotations[0], {
    selection_id: 'line-1',
    quote: '第3段',
    comment: '读者写在这里。',
    created_at: '2026-08-22T00:00:00.000Z'
  });

  const state = store.readState();
  assert.equal(state.books[bookId].readers.human.lastPos.seqTop, 5);
  assert.equal(state.books[bookId].readers.ai_codex.lastPos.seqTop, 2);
  assert.equal(state.books[bookId].readers.ai_codex.lastPos.seqEnd, 3);
  assert.deepEqual(state.books[bookId].readers.ai_codex.readRanges, [[2, 3]]);
  assert.ok(state.books[bookId].readers.ai_codex.lastReadAt);
});

test('omitting progress continues after the AI last position', () => {
  seed();
  readBookPosition({ bookTitle: '示例书', progressPct: 20 });
  const out = readBookPosition({ bookTitle: '示例书' });
  assert.equal(out.status, 200);
  assert.equal(out.json.text.startsWith('第5段'), true);
  const state = store.readState();
  assert.deepEqual(state.books['tokyo-8m2'].readers.ai_codex.readRanges, [[2, 5]]);
});

test('AI can read beyond the human-unlocked range without moving human progress', () => {
  const bookId = seed();
  const out = readBookPosition({ bookTitle: '示例书', progressPct: 90 });
  assert.equal(out.status, 200);
  assert.equal(out.json.atEnd, true);
  assert.match(out.json.text, /^第9段/);
  const state = store.readState();
  assert.equal(state.books[bookId].readers.human.lastPos.seqTop, 5);
  assert.equal(state.books[bookId].readers.ai_codex.lastPos.seqTop, 8);
  assert.deepEqual(state.books[bookId].readers.ai_codex.readRanges, [[8, 9]]);
});

test('AI margin notes locate quotes only inside the last returned page', () => {
  const bookId = seed();
  readBookPosition({ bookTitle: '示例书', progressPct: 90 });
  let out = createAnnotation({ bookId, author: 'ai', quote: '第9段', comment: '共读者读到这里。' }, { gate: true, wake: false });
  assert.equal(out.status, 200);
  out = createAnnotation({ bookId, author: 'ai', quote: '第3段', comment: '不该跨页查找。' }, { gate: true, wake: false });
  assert.equal(out.status, 404);
});

test('AI text search covers the whole imported book without moving either reader', () => {
  const bookId = seed();
  const before = store.readState();
  const out = searchBookText(bookId, '第10段');
  assert.equal(out.status, 200);
  assert.equal(out.json.scope, '整本已导入正文');
  assert.equal(out.json.hits.length, 1);
  assert.equal(out.json.hits[0].seq, 9);
  assert.deepEqual(store.readState(), before);
});
