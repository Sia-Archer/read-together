'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-shared-selection-'));
process.env.READING_DATA_DIR = dataDir;

const store = require('../lib/store');
const { addCommentWithDelivery, findSharedSelection, replyToSharedSelection, updateCallDelivery } = require('../server');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seedSharedSelection() {
  const bookId = 'shared-book';
  const dir = path.join(store.BOOKS_DIR, bookId);
  fs.mkdirSync(dir, { recursive: true });
  store.writeJson(path.join(dir, 'manifest.json'), {
    id: bookId,
    title: '共读测试',
    author: '读者',
  });
  store.writeAnnotations(bookId, [{
    id: 'line-1',
    channel: 'codex',
    createdBy: 'human',
    sharedAt: '2026-09-30T00:00:00.000Z',
    quote: '这一句。',
    context: '这一句。下一句。',
    comments: [],
  }]);
  return bookId;
}

test('selection-id lookup reads the matched manifest only once', () => {
  seedSharedSelection();
  let manifestReads = 0;
  const original = store.readManifest;
  store.readManifest = (...args) => {
    manifestReads += 1;
    return original(...args);
  };
  try {
    const selection = findSharedSelection('line-1');
    assert.equal(selection.bookId, 'shared-book');
    assert.equal(selection.title, '共读测试');
    assert.equal(manifestReads, 1);
  } finally {
    store.readManifest = original;
  }
});

test('replying to a shared selection locates and writes the annotation in one read', () => {
  const bookId = seedSharedSelection();
  let annotationReads = 0;
  const original = store.readAnnotations;
  store.readAnnotations = (...args) => {
    annotationReads += 1;
    return original(...args);
  };
  try {
    const out = replyToSharedSelection('line-1', {
      text: '共读者看见了。',
      clientId: 'reply-1',
      final: true,
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.equal(annotationReads, 1);
  } finally {
    store.readAnnotations = original;
  }

  const [annotation] = store.readAnnotations(bookId);
  assert.equal(annotation.comments.length, 1);
  assert.equal(annotation.comments[0].author, 'ai');
  assert.equal(annotation.comments[0].text, '共读者看见了。');
});

test('replying to a human follow-up on an AI margin note writes back to the same thread', () => {
  const bookId = seedSharedSelection();
  store.writeAnnotations(bookId, [{
    id: 'ai-line-1',
    channel: 'codex',
    createdBy: 'ai',
    createdAt: '2026-10-03T00:00:00.000Z',
    quote: '共读者先留下的一句。',
    context: '共读者先留下的一句。',
    comments: [
      { id: 'ai-root', author: 'ai', text: '共读者的批注。', createdAt: '2026-10-03T00:00:00.000Z' },
      { id: 'human-follow-up', author: 'human', text: '读者接着回。', createdAt: '2026-10-05T00:00:00.000Z' },
    ],
  }]);

  const out = replyToSharedSelection('ai-line-1', {
    text: '共读者沿着同一条页边回来。',
    clientId: 'reply-to-human-follow-up',
    final: true,
  });

  assert.equal(out.status, 200);
  const [annotation] = store.readAnnotations(bookId);
  assert.equal(annotation.comments.length, 3);
  assert.equal(annotation.comments[2].author, 'ai');
  assert.equal(annotation.comments[2].text, '共读者沿着同一条页边回来。');
});

test('an AI-only margin note is not exposed as a shared selection', () => {
  const bookId = seedSharedSelection();
  store.writeAnnotations(bookId, [{
    id: 'ai-only-line',
    channel: 'codex',
    createdBy: 'ai',
    createdAt: '2026-10-03T00:00:00.000Z',
    quote: '没有读者回复的一句。',
    comments: [{ id: 'ai-root', author: 'ai', text: '只有共读者。', createdAt: '2026-10-03T00:00:00.000Z' }],
  }]);

  const out = replyToSharedSelection('ai-only-line', { text: '不应该写入。' });
  assert.equal(out.status, 404);
  assert.equal(store.readAnnotations(bookId)[0].comments.length, 1);
});

test('a human follow-up records failed delivery without duplicating the saved reply', async () => {
  const bookId = seedSharedSelection();
  const body = { author: 'human', text: 'A test reply', clientId: 'human-reply-1' };
  let out = await addCommentWithDelivery(bookId, 'line-1', body, { wake: true });
  assert.equal(out.status, 200);
  assert.equal(out.json.delivery.status, 'failed');

  out = await addCommentWithDelivery(bookId, 'line-1', { ...body, retryDelivery: true }, { wake: true });
  assert.equal(out.status, 200);
  assert.equal(out.json.delivery.status, 'failed');
  const [annotation] = store.readAnnotations(bookId);
  assert.equal(annotation.comments.length, 1);
  assert.equal(annotation.comments[0].delivery.status, 'failed');
  assert.equal(annotation.comments[0].delivery.target, 'home');
  assert.equal(annotation.comments[0].delivery.deliveryId, annotation.comments[0].id);
});

test('a Call-bound follow-up is persisted pending and can be marked accepted without another comment', async () => {
  const bookId = seedSharedSelection();
  const body = { author: 'human', text: '电话里继续说', clientId: 'human-call-1', delivery: 'call' };
  const out = await addCommentWithDelivery(bookId, 'line-1', body, { wake: false });
  assert.equal(out.status, 200);
  assert.equal(out.json.comment.delivery.status, 'pending');
  assert.equal(out.json.comment.delivery.target, 'call');

  const accepted = updateCallDelivery(bookId, 'line-1', {
    deliveryId: out.json.comment.id,
    commentId: out.json.comment.id,
    status: 'accepted',
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.delivery.status, 'accepted');
  const [annotation] = store.readAnnotations(bookId);
  assert.equal(annotation.comments.length, 1);
  assert.equal(annotation.comments[0].delivery.status, 'accepted');
});

test('a Call-bound selection can be marked accepted by its own delivery id', () => {
  const bookId = seedSharedSelection();
  const [annotation] = store.readAnnotations(bookId);
  annotation.delivery = { target: 'call', status: 'pending', deliveryId: annotation.id };
  store.writeAnnotations(bookId, [annotation]);

  const accepted = updateCallDelivery(bookId, annotation.id, {
    deliveryId: annotation.id,
    status: 'accepted',
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.annotation.delivery.status, 'accepted');
  assert.equal(store.readAnnotations(bookId)[0].comments.length, 0);
});

test('independent replies with reused RPC ids persist; explicit retry keys deduplicate', async () => {
  const bookId = seedSharedSelection();
  const { createBooksClient } = require('../server/mcp/client');
  const client = createBooksClient({ controlToken: 'test', fetch: async (_url, init) => {
    const out = replyToSharedSelection('line-1', JSON.parse(init.body));
    return new Response(JSON.stringify(out.json), { status: out.status });
  }});
  await client.replyToSharedLine({selection_id:'line-1',text:'第一次回复'}, {requestId:0});
  await client.replyToSharedLine({selection_id:'line-1',text:'第二次回复'}, {requestId:0});
  await client.replyToSharedLine({selection_id:'line-1',text:'明确重试',request_id:'stable-retry'}, {requestId:0});
  const retried = await client.replyToSharedLine({selection_id:'line-1',text:'明确重试',request_id:'stable-retry'}, {requestId:1});
  assert.equal(retried.duplicate,true);
  assert.deepEqual(store.readAnnotations(bookId)[0].comments.map(c=>c.text), ['第一次回复','第二次回复','明确重试']);
});
