'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildPresence,
  followUpWakeText,
  isHomeUiAuthorized,
  normalizeAiReplyPart,
  readerSummaries,
  selectionWakeText,
} = require('../server');

test('Home UI authorization requires the Nginx marker on a loopback request', () => {
  assert.equal(isHomeUiAuthorized({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-guichao-home-authenticated': '1' } }), true);
  assert.equal(isHomeUiAuthorized({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-guichao-home-authenticated': '1' } }), true);
  assert.equal(isHomeUiAuthorized({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false);
  assert.equal(isHomeUiAuthorized({ socket: { remoteAddress: '203.0.113.8' }, headers: { 'x-guichao-home-authenticated': '1' } }), false);
});

test('AI reply parts keep one reply id until the final sentence', () => {
  const first = normalizeAiReplyPart([], {
    replyId: 'reply-demo',
    partIndex: 0,
    final: false
  });
  assert.deepEqual(first, {
    replyId: 'reply-demo',
    partIndex: 0,
    final: false
  });

  const second = normalizeAiReplyPart([
    { author: 'human', text: 'share' },
    { author: 'ai', replyId: 'reply-demo', partIndex: 0, final: false }
  ], { final: true });
  assert.deepEqual(second, {
    replyId: 'reply-demo',
    partIndex: 1,
    final: true
  });
});

test('a newer human comment does not reopen an older unfinished reply', () => {
  const next = normalizeAiReplyPart([
    { author: 'human', text: 'first share' },
    { author: 'ai', replyId: 'reply-old', partIndex: 0, final: false },
    { author: 'human', text: 'new follow-up' }
  ], { final: false });
  assert.notEqual(next.replyId, 'reply-old');
  assert.equal(next.partIndex, 0);
  assert.equal(next.final, false);
});

test('presence is small, active only while the reading heartbeat is fresh', () => {
  const now = Date.now();
  const manifest = {
    title: '示例书',
    paraCount: 100,
    chapters: [{ idx: 0, title: '第一章', baseSeq: 0 }]
  };
  const state = {
    furthestSeq: 19,
    lastPos: { chapter: 0 },
    session: { lastBeatAt: now - 10_000 }
  };
  assert.deepEqual(buildPresence('gone-with-the-wind', manifest, state, now), {
    active: true,
    bookId: 'gone-with-the-wind',
    title: '示例书',
    chapterTitle: '第一章',
    progressPct: 20,
    lastBeatAt: new Date(now - 10_000).toISOString(),
    actionUrl: '/reading/'
  });
  assert.equal(buildPresence('gone-with-the-wind', manifest, state, now + 70_000), null);
});

test('human and AI keep independent positions and last-read times', () => {
  const manifest = {
    paraCount: 100,
    chapters: [{ idx: 0, title: '第一章', baseSeq: 0 }]
  };
  const state = {
    lastPos: { chapter: 0, seqTop: 9 },
    lastOpenedAt: '2026-08-20T10:00:00.000Z',
    readers: {
      human: { lastPos: { chapter: 0, seqTop: 9 }, lastReadAt: '2026-08-20T10:00:00.000Z' },
      ai_codex: { lastPos: { chapter: 0, seqTop: 7 }, lastReadAt: '2026-08-21T10:00:00.000Z' }
    }
  };
  const summaries = readerSummaries(state, manifest);
  assert.equal(summaries.human.progressPct, 10);
  assert.equal(summaries.ai.progressPct, 8);
  assert.equal(summaries.human.lastReadAt, '2026-08-20T10:00:00.000Z');
  assert.equal(summaries.ai.lastReadAt, '2026-08-21T10:00:00.000Z');
});

test('selection wake contains only the selected line and a bounded local context', () => {
  const text = selectionWakeText({
    manifest: { title: '示例书' },
    chapterTitle: '第一章',
    annotation: { id: 'line-1', quote: '她抬起眼睛。' },
    paragraph: '她抬起眼睛。窗外正在下雨。',
    note: '你能看到吗？'
  });
  assert.match(text, /selection_id=line-1/);
  assert.match(text, /她抬起眼睛/);
  assert.doesNotMatch(text, /整页|全文|下一章/);
});

test('a second selection in the same paragraph can omit the repeated paragraph context', () => {
  const text = selectionWakeText({
    manifest: { title: '示例书' },
    chapterTitle: '第一章',
    annotation: { id: 'line-2', quote: '窗外正在下雨。' },
    paragraph: '她抬起眼睛。窗外正在下雨。',
    note: '这一句也想给共读者看。',
    includeContext: false,
  });
  assert.match(text, /窗外正在下雨/);
  assert.match(text, /这一句也想给共读者看/);
  assert.doesNotMatch(text, /这一段：/);
});

test('a new page-margin follow-up wakes with only the new comment and ids', () => {
  const text = followUpWakeText({
    manifest: { title: '示例书' },
    annotation: { id: 'line-1', quote: '不应重复发送的原文' },
    comment: { id: 'comment-2', text: '那共读者再陪我一会。' },
  });
  assert.match(text, /那共读者再陪我一会/);
  assert.match(text, /selection_id=line-1/);
  assert.match(text, /comment_id=comment-2/);
  assert.doesNotMatch(text, /不应重复发送的原文/);
});

test('reader offers optional line sharing and has no full-page push controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'reader.html'), 'utf8');
  assert.match(html, /给共读者看/);
  assert.match(html, /savePendingSelection\(''\)/);
  assert.match(html, /id="selection-write"[^>]*>写一句/);
  assert.doesNotMatch(html, /正在读这一句/);
  assert.match(html, /R\.detailPollUntil = Date\.now\(\) \+ 10 \* 60 \* 1000/);
  assert.match(html, /remainingMs > 8 \* 60 \* 1000 \? 2000 : 10000/);
  assert.doesNotMatch(html, /推送给 AI|AI 的 token|dwell-row|dwell-dlg/);
});

test('hosted reader waits for Call acceptance and falls back to Home with the same delivery id', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'reader.html'), 'utf8');
  const push = fs.readFileSync(path.join(__dirname, '..', 'lib', 'push.js'), 'utf8');
  const nginx = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx-reading.conf'), 'utf8');
  assert.match(html, /guichao-books:call-status/);
  assert.match(html, /guichao-books:call-selection/);
  assert.match(html, /guichao-books:call-accepted/);
  assert.match(html, /guichao-books:call-committed/);
  assert.match(html, /delivery: routeToCall \? 'call' : 'home'/);
  assert.match(html, /await sendSelectionToCall\(annotation, comment, annotation\.id\)/);
  assert.match(html, /commitCallDelivery\(accepted\.requestId\)/);
  assert.match(html, /\/annotations\/\$\{R\.book\.bookId\}\/\$\{annotation\.id\}\/deliver/);
  assert.match(html, /deliveryId: result\.comment\.id/);
  assert.match(html, /retryDelivery: true, delivery: 'home'/);
  assert.match(push, /replyTarget: "reading"/);
  assert.match(push, /sourceMessageId/);
  assert.match(push, /waitForCompletion: false/);
  assert.match(nginx, /X-Frame-Options "SAMEORIGIN"/);
  assert.match(nginx, /Content-Security-Policy "frame-ancestors 'self'"/);
  assert.match(nginx, /X-Content-Type-Options "nosniff"/);
  assert.match(nginx, /Referrer-Policy "no-referrer"/);
});
