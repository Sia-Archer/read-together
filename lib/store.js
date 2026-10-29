const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.resolve(process.env.READING_DATA_DIR || path.join(__dirname, "..", "data"));
const BOOKS_DIR = path.join(DATA_DIR, "books");
const ANNO_DIR = path.join(DATA_DIR, "annotations");
const MARK_DIR = path.join(DATA_DIR, "bookmarks");
const STATE_FILE = path.join(DATA_DIR, "state.json");

for (const dir of [DATA_DIR, BOOKS_DIR, ANNO_DIR, MARK_DIR]) fs.mkdirSync(dir, { recursive: true });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

// ── books ──

function listBookIds() {
  try {
    return fs.readdirSync(BOOKS_DIR).filter((name) => fs.existsSync(path.join(BOOKS_DIR, name, "manifest.json")));
  } catch {
    return [];
  }
}

function bookDir(bookId) {
  const safe = String(bookId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("bad bookId");
  return path.join(BOOKS_DIR, safe);
}

function readManifest(bookId) {
  return readJson(path.join(bookDir(bookId), "manifest.json"), null);
}

function readChapter(bookId, idx) {
  return readJson(path.join(bookDir(bookId), "chapters", `${Number(idx)}.json`), null);
}

// ── state (progress / sessions) ──

function readState() {
  return readJson(STATE_FILE, { books: {} });
}

function writeState(state) {
  writeJson(STATE_FILE, state);
}

function bookState(state, bookId) {
  if (!state.books[bookId]) {
    state.books[bookId] = {
      furthestSeq: -1,
      pushedRanges: [],
      lastPos: null,
      lastOpenedAt: "",
      totalPushedChars: 0,
      totalReadMs: 0,
      session: null,
    };
  }
  ensureReaders(state.books[bookId]);
  return state.books[bookId];
}

function ensureReaders(book) {
  if (!book.readers || typeof book.readers !== "object" || Array.isArray(book.readers)) book.readers = {};
  if (!book.readers.human || typeof book.readers.human !== "object") {
    book.readers.human = {
      lastPos: book.lastPos || null,
      lastReadAt: String(book.lastReadAt || book.lastOpenedAt || ""),
    };
  }
  if (!book.readers.ai || typeof book.readers.ai !== "object") {
    book.readers.ai = { lastPos: null, lastReadAt: "", readRanges: [] };
  }
  if (!Array.isArray(book.readers.ai.readRanges)) {
    const start = Number(book.readers.ai?.lastPos?.seqTop);
    const end = Number(book.readers.ai?.lastPos?.seqEnd);
    book.readers.ai.readRanges = Number.isInteger(start) && start >= 0
      ? [[start, Number.isInteger(end) && end >= start ? end : start]]
      : [];
  }
  return book.readers;
}

function readerState(book, role) {
  const readers = ensureReaders(book);
  if (!Object.prototype.hasOwnProperty.call(readers, role)) readers[role] = { lastPos: null, lastReadAt: "", readRanges: [] };
  return readers[role];
}

function setReaderProgress(book, role, position, at = new Date().toISOString()) {
  const reader = readerState(book, role);
  reader.lastPos = position ? { ...position } : null;
  reader.lastReadAt = String(at || "");
  if (role === "human") {
    book.lastPos = reader.lastPos ? { ...reader.lastPos } : null;
    book.lastReadAt = reader.lastReadAt;
  }
  return reader;
}

function mergeRange(ranges, start, end) {
  const merged = [];
  let [s, e] = [start, end];
  for (const [rs, re] of ranges) {
    if (re < s - 1 || rs > e + 1) {
      merged.push([rs, re]);
    } else {
      s = Math.min(s, rs);
      e = Math.max(e, re);
    }
  }
  merged.push([s, e]);
  merged.sort((a, b) => a[0] - b[0]);
  return merged;
}

function recordReaderRange(book, role, start, end) {
  const reader = readerState(book, role);
  const ranges = Array.isArray(reader.readRanges) ? reader.readRanges : [];
  reader.readRanges = mergeRange(ranges, start, end);
  return reader.readRanges;
}

function inRanges(ranges, seq) {
  return ranges.some(([s, e]) => seq >= s && seq <= e);
}

function missingSeqs(ranges, start, end) {
  const missing = [];
  for (let seq = start; seq <= end; seq += 1) {
    if (!inRanges(ranges, seq)) missing.push(seq);
  }
  return missing;
}

// ── annotations ──

function annoFile(bookId) {
  return path.join(ANNO_DIR, `${String(bookId).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

function readAnnotations(bookId) {
  return readJson(annoFile(bookId), []);
}

function writeAnnotations(bookId, annotations) {
  writeJson(annoFile(bookId), annotations);
}

// ── 书签（读者私有） ──

function markFile(bookId) {
  return path.join(MARK_DIR, `${String(bookId).replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

function readBookmarks(bookId) {
  return readJson(markFile(bookId), []);
}

function writeBookmarks(bookId, bookmarks) {
  writeJson(markFile(bookId), bookmarks);
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

module.exports = {
  DATA_DIR,
  BOOKS_DIR,
  readJson,
  writeJson,
  listBookIds,
  bookDir,
  readManifest,
  readChapter,
  readState,
  writeState,
  bookState,
  ensureReaders,
  readerState,
  setReaderProgress,
  recordReaderRange,
  mergeRange,
  inRanges,
  missingSeqs,
  readAnnotations,
  writeAnnotations,
  readBookmarks,
  writeBookmarks,
  newId,
};
