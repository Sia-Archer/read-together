'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-overview-'));
process.env.READING_DATA_DIR = dataDir;

const store = require('../lib/store');
const { currentReadingOverview, libraryOverview } = require('../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function writeBook(bookId, title, state, annotations = []) {
  const dir = path.join(store.BOOKS_DIR, bookId);
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  store.writeJson(path.join(dir, 'manifest.json'), {
    id: bookId,
    title,
    author: '作者',
    paraCount: 10,
    chapterCount: 1,
    chapters: [{ idx: 0, title: '第一章', baseSeq: 0, paraCount: 10 }],
  });
  store.writeJson(path.join(dir, 'chapters', '0.json'), {
    idx: 0,
    title: '第一章',
    baseSeq: 0,
    paragraphs: Array.from({ length: 10 }, (_, index) => `第${index + 1}段`),
  });
  store.writeAnnotations(bookId, annotations);
  return state;
}

function seed() {
  const books = {};
  books.current = writeBook('current', '正在读的书', {
    furthestSeq: 4,
    pushedRanges: [[0, 4]],
    lastPos: { chapter: 0, seqTop: 4 },
    lastOpenedAt: '2026-10-01T01:00:00.000Z',
    totalPushedChars: 0,
    totalReadMs: 125 * 60_000,
    session: null,
    readers: {
      human: { lastPos: { chapter: 0, seqTop: 4 }, lastReadAt: '2026-10-01T01:00:00.000Z' },
      ai_codex: { lastPos: { chapter: 0, seqTop: 2, seqEnd: 3 }, lastReadAt: '2026-10-01T02:00:00.000Z', readRanges: [[2, 3]] },
    },
  }, [{
    id: 'line-1',
    seq: 2,
    quote: '第3段',
    channel: 'codex',
    createdBy: 'human',
    createdAt: '2026-10-01T01:10:00.000Z',
    sharedAt: '2026-10-01T01:10:00.000Z',
    comments: [
      { id: 'root', author: 'human', text: '批注', createdAt: '2026-10-01T01:10:00.000Z' },
      { id: 'reply', author: 'ai', text: '回复', createdAt: '2026-10-01T01:11:00.000Z' },
    ],
  }, {
    id: 'line-2',
    seq: 3,
    quote: '第4段',
    channel: 'codex',
    createdBy: 'human',
    createdAt: '2026-10-01T01:12:00.000Z',
    sharedAt: '2026-10-01T01:12:00.000Z',
    comments: [],
  }]);
  books.finished = writeBook('finished', '一起读完的书', {
    furthestSeq: 9,
    pushedRanges: [[0, 9]],
    lastPos: { chapter: 0, seqTop: 9 },
    lastOpenedAt: '2026-09-01T01:00:00.000Z',
    totalPushedChars: 0,
    totalReadMs: 55 * 60_000,
    session: null,
    readers: {
      human: { lastPos: { chapter: 0, seqTop: 5 }, lastReadAt: '2026-09-01T01:00:00.000Z' },
      ai_codex: { lastPos: { chapter: 0, seqTop: 5, seqEnd: 5 }, lastReadAt: '2026-09-01T02:00:00.000Z', readRanges: [[0, 9]] },
    },
  });
  books.want = writeBook('want', '还没开始的书', {
    furthestSeq: -1,
    pushedRanges: [],
    lastPos: null,
    lastOpenedAt: '',
    totalPushedChars: 0,
    totalReadMs: 0,
    session: null,
  });
  store.writeState({ books });
}

test('current reading falls back to the most recent book and returns both readers plus this-book time', () => {
  seed();
  const out = currentReadingOverview(Date.parse('2026-10-01T03:00:00.000Z'));
  assert.equal(out.active, false);
  assert.equal(out.source, 'last_opened');
  assert.equal(out.bookId, 'current');
  assert.equal(out.sharedReadingMinutes, 125);
  assert.equal(out.userProgressPct, 50);
  assert.equal(out.assistantProgressPct, 30);
});

test('library overview uses user progress for reading states and keeps aggregate counts compact', () => {
  seed();
  assert.deepEqual(libraryOverview(), {
    totalBookCount: 3,
    sharedReadingMinutes: 180,
    sharedFinishedCount: 1,
    userReadingCount: 1,
    userFinishedCount: 1,
    userWantToReadCount: 1,
    assistantReadBookCount: 2,
    highlightCount: 2,
    annotationCount: 1,
    sharedReplyCount: 1,
  });
});
