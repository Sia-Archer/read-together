#!/usr/bin/env node
// 共读后端：书库 API + 阅读心跳/进度解锁 + 划线分享 + 批注存储
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/store");
const { readerKey, belongsTo, visibleTo, visibleAnnotation, commentChannel } = require("./lib/channels");
const { enqueueSystemMessage, enqueueSystemMessageWithReceipt, PUSH_ENABLED } = require("./lib/push");
const { parseEpub } = require("./lib/epub");
const { parseTxt } = require("./lib/txt");
const { importParsed } = require("./lib/import");
const libraryStore = require("./lib/library");

const PORT = Number(process.env.READING_PORT || 18004);
const DWELL_MS = Number(process.env.READING_DWELL_MS || 15000);
const IDLE_CLOSE_MS = Number(process.env.READING_IDLE_MS || 5 * 60 * 1000);
const DWELL_MIN_S = 5;
const DWELL_MAX_S = 60;
const PRESENCE_STALE_MS = Math.max(30_000, Number(process.env.READING_PRESENCE_STALE_MS || 65_000));
const CHATGPT_CONTROL_TOKEN = String(process.env.READING_CHATGPT_CONTROL_TOKEN || "").trim();
const MCP_CONTROL_TOKEN = String(process.env.READING_MCP_CONTROL_TOKEN || "").trim();

// 停留时长可被前端设置覆盖（存 state.json），否则用环境变量/默认值
function dwellMsOf(state) {
  const v = Number(state.settings?.dwellMs);
  return Number.isFinite(v) && v >= DWELL_MIN_S * 1000 && v <= DWELL_MAX_S * 1000 ? v : DWELL_MS;
}
const READER_NAME = process.env.READING_READER_NAME || "TA";
const HUMAN_READER_LABEL = process.env.READING_HUMAN_LABEL || "读者";
const AI_READER_LABEL = process.env.READING_AI_LABEL || "共读者";
const sharedParagraphContexts = new Set();

// ── 阅读状态与划线分享 ──

function pct(bs, manifest) {
  if (!manifest.paraCount) return 0;
  return Math.min(100, Math.round(((bs.furthestSeq + 1) / manifest.paraCount) * 1000) / 10);
}

function positionPct(reader, manifest) {
  const seq = Number(reader?.lastPos?.seqTop);
  if (!manifest?.paraCount || !Number.isInteger(seq) || seq < 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((seq + 1) / manifest.paraCount) * 100)));
}

function readerSummary(bs, manifest, role, label) {
  const reader = store.readerState(bs, role);
  return {
    role,
    label,
    progressPct: positionPct(reader, manifest),
    lastReadAt: String(reader?.lastReadAt || ""),
  };
}

function readerSummaries(bs, manifest, channel = "codex") {
  return {
    human: readerSummary(bs, manifest, "human", HUMAN_READER_LABEL),
    ai: { ...readerSummary(bs, manifest, readerKey(channel), AI_READER_LABEL), role: "ai", channel },
  };
}

function minutesOf(ms) {
  return Math.max(0, Math.round((Number(ms) || 0) / 60000));
}

function rootAnnotationComment(annotation) {
  const direct = String(annotation?.note || annotation?.comment || "").trim();
  if (direct) return direct;
  const first = Array.isArray(annotation?.comments) ? annotation.comments[0] : null;
  return first && first.author === annotation.createdBy && first.kind !== "reply" ? String(first.text || "").trim() : "";
}

function annotationReplyCount(annotation) {
  const comments = Array.isArray(annotation?.comments) ? annotation.comments : [];
  const firstIsRoot = !String(annotation?.note || annotation?.comment || "").trim()
    && comments[0] && comments[0].author === annotation.createdBy && comments[0].kind !== "reply";
  return Math.max(0, comments.length - (firstIsRoot ? 1 : 0));
}

function readerHasReachedEnd(reader, manifest) {
  const lastSeq = Number(manifest?.paraCount) - 1;
  if (lastSeq < 0) return false;
  const ranges = Array.isArray(reader?.readRanges) ? reader.readRanges : [];
  if (store.inRanges(ranges, lastSeq)) return true;
  const end = Number(reader?.lastPos?.seqEnd ?? reader?.lastPos?.seqTop);
  return Number.isInteger(end) && end >= lastSeq;
}

function fmtDur(ms) {
  const minutes = Math.round((ms || 0) / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function chapterOfSeq(manifest, seq) {
  let found = manifest.chapters[0];
  for (const ch of manifest.chapters) {
    if (ch.baseSeq <= seq) found = ch;
    else break;
  }
  return found;
}

function buildPresence(bookId, manifest, bs, now = Date.now()) {
  const lastBeatAt = Number(bs?.session?.lastBeatAt || 0);
  if (!manifest || !bs?.session || !lastBeatAt || now - lastBeatAt > PRESENCE_STALE_MS) return null;
  const chapter = bs.lastPos && manifest.chapters[bs.lastPos.chapter]
    ? manifest.chapters[bs.lastPos.chapter]
    : manifest.chapters[0];
  return {
    active: true,
    bookId,
    title: manifest.title,
    chapterTitle: chapter?.title || "",
    progressPct: pct(bs, manifest),
    lastBeatAt: new Date(lastBeatAt).toISOString(),
    actionUrl: "/reading/",
  };
}

function currentPresence(now = Date.now()) {
  const state = store.readState();
  return Object.keys(state.books || {})
    .map((bookId) => buildPresence(bookId, store.readManifest(bookId), store.bookState(state, bookId), now))
    .filter(Boolean)
    .sort((a, b) => b.lastBeatAt.localeCompare(a.lastBeatAt))[0] || { active: false };
}

function currentReadingOverview(now = Date.now(), channel = "codex") {
  const state = store.readState();
  const books = Object.keys(state.books || {}).map((bookId) => {
    const manifest = store.readManifest(bookId);
    if (!manifest) return null;
    const bs = store.bookState(state, bookId);
    const presence = buildPresence(bookId, manifest, bs, now);
    const readers = readerSummaries(bs, manifest, channel);
    const recentAt = [bs.lastOpenedAt, readers.human.lastReadAt, readers.ai.lastReadAt]
      .map((value) => String(value || ""))
      .sort()
      .at(-1) || "";
    return { bookId, manifest, bs, presence, readers, recentAt };
  }).filter(Boolean);
  const selected = books.filter((item) => item.presence)
    .sort((a, b) => b.presence.lastBeatAt.localeCompare(a.presence.lastBeatAt))[0]
    || books.sort((a, b) => b.recentAt.localeCompare(a.recentAt))[0];
  if (!selected) return { active: false, source: null, bookId: null, title: null };
  const { bookId, manifest, bs, presence, readers } = selected;
  const humanChapter = readers.human.progressPct > 0 && bs.readers?.human?.lastPos
    ? manifest.chapters[bs.readers.human.lastPos.chapter]
    : manifest.chapters[0];
  return {
    active: Boolean(presence),
    source: presence ? "active" : "last_opened",
    bookId,
    title: manifest.title,
    author: manifest.author || "",
    chapterTitle: humanChapter?.title || "",
    sharedReadingMinutes: minutesOf(bs.totalReadMs),
    userProgressPct: readers.human.progressPct,
    userLastReadAt: readers.human.lastReadAt,
    assistantProgressPct: readers.ai.progressPct,
    assistantLastReadAt: readers.ai.lastReadAt,
    actionUrl: "/reading/",
  };
}

function libraryOverview(channel = "codex") {
  const state = store.readState();
  let sharedReadingMs = 0;
  let sharedFinishedCount = 0;
  let userReadingCount = 0;
  let userFinishedCount = 0;
  let userWantToReadCount = 0;
  let assistantReadBookCount = 0;
  let highlightCount = 0;
  let annotationCount = 0;
  let sharedReplyCount = 0;
  let totalBookCount = 0;
  for (const bookId of store.listBookIds()) {
    const manifest = store.readManifest(bookId);
    if (!manifest) continue;
    totalBookCount += 1;
    const bs = store.bookState(state, bookId);
    const userProgress = pct(bs, manifest);
    const readers = readerSummaries(bs, manifest, channel);
    if (userProgress >= 100) userFinishedCount += 1;
    else if (userProgress > 0) userReadingCount += 1;
    else userWantToReadCount += 1;
    if (Number.isInteger(Number(bs.readers?.[readerKey(channel)]?.lastPos?.seqTop)) && Number(bs.readers[readerKey(channel)].lastPos.seqTop) >= 0) {
      assistantReadBookCount += 1;
    }
    if (userProgress >= 100 && readerHasReachedEnd(bs.readers?.[readerKey(channel)], manifest)) sharedFinishedCount += 1;
    sharedReadingMs += Number(bs.totalReadMs) || 0;
    const annotations = store.readAnnotations(bookId).map(item => visibleAnnotation(item, channel)).filter(Boolean);
    highlightCount += annotations.length;
    annotationCount += annotations.filter((annotation) => rootAnnotationComment(annotation)).length;
    sharedReplyCount += annotations.reduce((sum, annotation) => sum + annotationReplyCount(annotation), 0);
  }
  return {
    totalBookCount,
    sharedReadingMinutes: minutesOf(sharedReadingMs),
    sharedFinishedCount,
    userReadingCount,
    userFinishedCount,
    userWantToReadCount,
    assistantReadBookCount,
    highlightCount,
    annotationCount,
    sharedReplyCount,
  };
}

function selectionWakeText({ manifest, chapterTitle, annotation, paragraph, note = "", includeContext = true }) {
  const safeParagraph = String(paragraph || "").trim().slice(0, 1200);
  const safeNote = String(note || "").trim().slice(0, 600);
  return [
    "[Books shared line]",
    `${READER_NAME}在《${manifest.title}》${chapterTitle ? `·${chapterTitle}` : ""}划了一句给共读者看：`,
    `「${annotation.quote}」`,
    includeContext && safeParagraph && safeParagraph !== annotation.quote ? `这一段：${safeParagraph}` : "",
    safeNote ? `${READER_NAME}留的话：${safeNote}` : "",
    `selection_id=${annotation.id}`,
  ].filter(Boolean).join("\n");
}

function followUpWakeText({ manifest, annotation, comment }) {
  return [
    "[Books follow-up]",
    `${READER_NAME}在《${manifest?.title || "正在读的书"}》的页边回了一句：`,
    `「${String(comment?.text || "").trim().slice(0, 600)}」`,
    `selection_id=${annotation.id}`,
    `comment_id=${comment.id}`,
  ].join("\n");
}

// ── 停留判定 ──

function evaluatePending(state, bookId) {
  const bs = store.bookState(state, bookId);
  const session = bs.session;
  if (!session || !session.pending) return;
  const pending = session.pending;
  if (Date.now() - pending.since < dwellMsOf(state)) return;

  const manifest = store.readManifest(bookId);
  if (!manifest) return;
  const missing = store.missingSeqs(bs.pushedRanges, pending.seqStart, pending.seqEnd);
  if (!missing.length) return;

  const chapter = store.readChapter(bookId, pending.chapter);
  if (!chapter) return;
  const texts = [];
  let chars = 0;
  for (const seq of missing) {
    const para = chapter.paragraphs[seq - chapter.baseSeq];
    if (typeof para === "string") {
      texts.push(para);
      chars += para.length;
    }
  }
  if (!texts.length) return;

  // 停留只解锁阅读进度，不再把整页原文推入聊天上下文。
  bs.pushedRanges = store.mergeRange(bs.pushedRanges, missing[0], missing[missing.length - 1]);
  bs.furthestSeq = Math.max(bs.furthestSeq, pending.seqEnd);
  bs.totalPushedChars += chars;
  session.pushedChars += chars;
}

// ── 心跳 ──

function handleBeat(body) {
  const { bookId, event } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };

  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const now = Date.now();

  const ensureSession = () => {
    if (bs.session) return;
    bs.session = { openedAt: now, lastBeatAt: now, pending: null, pushedChars: 0 };
    bs.lastOpenedAt = new Date().toISOString();
  };

  if (event === "open") {
    if (!bs.session) ensureSession();
    else bs.session.lastBeatAt = now;
  } else if (event === "page" || event === "beat") {
    ensureSession();
    evaluatePending(state, bookId);
    bs.session.lastBeatAt = now;
    const chapter = Number(body.chapter);
    const seqStart = Number(body.seqStart);
    const seqEnd = Number(body.seqEnd);
    if (Number.isInteger(chapter) && Number.isInteger(seqStart) && Number.isInteger(seqEnd) && seqEnd >= seqStart) {
      store.setReaderProgress(bs, "human", {
        chapter,
        seqTop: seqStart,
        seqEnd,
        pageKey: String(body.pageKey || ""),
      }, new Date(now).toISOString());
      if (event === "page" || !bs.session.pending || bs.session.pending.pageKey !== String(body.pageKey || "")) {
        bs.session.pending = { pageKey: String(body.pageKey || ""), since: now, chapter, seqStart, seqEnd };
      }
    }
  } else if (event === "close") {
    if (bs.session) {
      evaluatePending(state, bookId);
      const sessionMs = Math.max(0, now - bs.session.openedAt);
      bs.totalReadMs = (bs.totalReadMs || 0) + sessionMs;
      bs.lastClosedAt = now;
      bs.session = null;
    }
  } else {
    return { status: 400, json: { error: "bad event" } };
  }

  store.writeState(state);
  return {
    status: 200,
    json: { ok: true, furthestSeq: bs.furthestSeq, progressPct: pct(bs, manifest), pushEnabled: PUSH_ENABLED },
  };
}

// 空闲扫描：心跳断了视为放下书，但不因此唤醒聊天。
function sweepIdleSessions() {
  try {
    const state = store.readState();
    let dirty = false;
    for (const bookId of Object.keys(state.books)) {
      const bs = state.books[bookId];
      if (bs.session && Date.now() - bs.session.lastBeatAt > IDLE_CLOSE_MS) {
        const manifest = store.readManifest(bookId);
        evaluatePending(state, bookId);
        // 掐掉断连后的空转时间，只算到最后一次心跳
        const sessionMs = Math.max(0, bs.session.lastBeatAt - bs.session.openedAt);
        bs.totalReadMs = (bs.totalReadMs || 0) + sessionMs;
        bs.session = null;
        dirty = true;
      }
    }
    if (dirty) store.writeState(state);
  } catch (error) {
    console.error("[reading] idle sweep error", error);
  }
}

// ── 批注 ──

function createAnnotation(body, { gate = false, wake = true, sharedTarget = "", channel = "codex" } = {}) {
  const { bookId, author, comment } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  if (!["human", "ai"].includes(author)) return { status: 400, json: { error: "author must be human|ai" } };
  const cleanComment = String(comment || "").trim();
  if (gate && !cleanComment) return { status: 400, json: { error: "comment required" } };
  if (cleanComment.length > 1000) return { status: 400, json: { error: "comment too long" } };

  let seq;
  let startOff;
  let endOff;
  let quote = String(body.quote || "").trim();

  if (gate) {
    // AI 侧：只在刚刚读到的这一小页里定位，避免扩大成全文扫描。
    if (!quote) return { status: 400, json: { error: "quote required" } };
    const state = store.readState();
    const bs = store.bookState(state, bookId);
    const ai = store.readerState(bs, readerKey(channel));
    const pageStart = Number(ai?.lastPos?.seqTop);
    const pageEnd = Number(ai?.lastPos?.seqEnd);
    if (!Number.isInteger(pageStart) || pageStart < 0) {
      return { status: 409, json: { error: "请先用 read_book_position 读到这句话所在的一页。" } };
    }
    const lastSeq = Number.isInteger(pageEnd) && pageEnd >= pageStart ? pageEnd : pageStart;
    const matches = [];
    const ch = chapterOfSeq(manifest, pageStart);
    const chapter = store.readChapter(bookId, ch.idx);
    for (let s = pageStart; s <= lastSeq; s += 1) {
      if (chapterOfSeq(manifest, s).idx !== ch.idx) break;
      const para = chapter?.paragraphs?.[s - ch.baseSeq];
      if (typeof para !== "string") continue;
      let at = para.indexOf(quote);
      while (at >= 0) {
        matches.push({ seq: s, startOff: at, endOff: at + quote.length, preview: para.slice(0, 40) });
        at = para.indexOf(quote, at + 1);
      }
    }
    if (!matches.length) return { status: 404, json: { error: "quote not found on the last page（请逐字引用刚读到的正文）" } };
    if (matches.length > 1) return { status: 409, json: { error: "quote ambiguous, give a longer quote", matches: matches.slice(0, 5) } };
    ({ seq, startOff, endOff } = matches[0]);
  } else {
    // 人类侧：前端给精确锚点
    const chapterIdx = Number(body.chapter);
    const paraIdx = Number(body.paraIdx);
    const chapter = store.readChapter(bookId, chapterIdx);
    if (!chapter || typeof chapter.paragraphs[paraIdx] !== "string") {
      return { status: 400, json: { error: "bad anchor" } };
    }
    const para = chapter.paragraphs[paraIdx];
    startOff = Math.max(0, Number(body.startOff) || 0);
    endOff = Math.min(para.length, Number(body.endOff) || 0);
    if (endOff <= startOff) return { status: 400, json: { error: "bad offsets" } };
    seq = chapter.baseSeq + paraIdx;
    quote = para.slice(startOff, endOff);
  }

  const annotations = store.readAnnotations(bookId);
  const clientId = String(body.clientId || "").trim().slice(0, 120);
  if (clientId) {
    const existing = annotations.find((item) => item.clientId === clientId && belongsTo(item, channel));
    if (existing) return { status: 200, json: { ok: true, duplicate: true, annotation: existing } };
  }
  const sameSelection = annotations.find((item) => item.seq === seq
    && item.startOff === startOff && item.endOff === endOff
    && item.createdBy === author && (author === "human" || belongsTo(item, channel)));
  if (sameSelection) {
    return { status: 200, json: { ok: true, duplicateSelection: true, annotation: visibleAnnotation(sameSelection, channel) } };
  }
  const now = new Date().toISOString();
  const ch = chapterOfSeq(manifest, seq);
  const chapter = store.readChapter(bookId, ch.idx);
  const paragraph = String(chapter?.paragraphs?.[seq - ch.baseSeq] || "");
  const annotation = {
    id: store.newId(),
    clientId: clientId || undefined,
    seq,
    startOff,
    endOff,
    quote,
    chapter: ch.idx,
    chapterTitle: ch.title,
    context: paragraph.slice(0, 1200),
    channel,
    source: author === "ai" ? channel : undefined,
    createdBy: author,
    createdAt: now,
    sharedAt: author === "human" ? now : undefined,
    sharedTarget: author === "human" && sharedTarget ? sharedTarget : undefined,
    delivery: author === "human" && sharedTarget === "call" ? {
      target: "call",
      status: "pending",
      deliveryId: "",
      updatedAt: now,
    } : undefined,
    comments: cleanComment ? [{ id: store.newId(), author, text: cleanComment, createdAt: now }] : [],
  };
  if (annotation.delivery) annotation.delivery.deliveryId = annotation.id;
  annotations.push(annotation);
  store.writeAnnotations(bookId, annotations);
  if (author === "human" && wake && channel === "codex") {
    const paragraphKey = `${bookId}:${seq}`;
    const result = enqueueSystemMessage(selectionWakeText({
      manifest,
      chapterTitle: ch.title,
      annotation,
      paragraph,
      note: cleanComment,
      includeContext: !sharedParagraphContexts.has(paragraphKey),
    }), { sourceMessageId: `books:${annotation.id}` });
    if (result?.ok) sharedParagraphContexts.add(paragraphKey);
  }
  return { status: 200, json: { ok: true, annotation } };
}

function addCommentToAnnotation(bookId, annotations, annotation, body, channel = "codex") {
  const { author, text } = body || {};
  if (!["human", "ai"].includes(author)) return { status: 400, json: { error: "author must be human|ai" } };
  if (!text || !String(text).trim()) return { status: 400, json: { error: "text required" } };
  if (!Array.isArray(annotation.comments)) annotation.comments = [];
  const clientId = String(body.clientId || "").trim().slice(0, 120);
  if (clientId) {
    const existing = annotation.comments.find((item) => item.clientId === clientId && commentChannel(item, annotation) === channel);
    if (existing) return { status: 200, json: { ok: true, duplicate: true, comment: existing } };
  }
  const aiReply = author === "ai" ? normalizeAiReplyPart(visibleAnnotation(annotation, channel).comments, body) : null;
  const comment = {
    id: store.newId(),
    clientId: clientId || undefined,
    author,
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    source: channel,
    kind: "reply",
    ...(aiReply || {}),
  };
  if (author === "human" && String(body.delivery || "") === "call") {
    comment.delivery = {
      target: "call",
      status: "pending",
      deliveryId: comment.id,
      updatedAt: comment.createdAt,
    };
  }
  annotation.comments.push(comment);
  store.writeAnnotations(bookId, annotations);
  return { status: 200, json: { ok: true, comment } };
}

function addComment(bookId, annoId, body, channel = "codex") {
  const annotations = store.readAnnotations(bookId);
  const annotation = annotations.find((a) => a.id === annoId && visibleTo(a, channel));
  if (!annotation) return { status: 404, json: { error: "unknown annotation" } };
  return addCommentToAnnotation(bookId, annotations, annotation, body, channel);
}

async function addCommentWithDelivery(bookId, annoId, body, { wake = false, channel = "codex" } = {}) {
  const out = addComment(bookId, annoId, body, channel);
  if (out.status !== 200 || body?.author !== "human" || !wake || channel !== "codex") return out;
  const existingDelivery = out.json.comment?.delivery?.status;
  if (out.json.duplicate && existingDelivery === "accepted") {
    out.json.delivery = out.json.comment.delivery;
    return out;
  }
  if (out.json.duplicate && !body.retryDelivery && existingDelivery !== "failed") return out;

  const annotations = store.readAnnotations(bookId);
  const annotation = annotations.find((item) => item.id === annoId);
  const comment = annotation?.comments?.find((item) => item.id === out.json.comment?.id);
  const manifest = store.readManifest(bookId);
  if (!annotation || !comment || !manifest) return out;

  const result = await enqueueSystemMessageWithReceipt(followUpWakeText({ manifest, annotation, comment }), {
    sourceMessageId: `books:${comment.id}`,
  });
  comment.delivery = {
    target: "home",
    status: result?.ok ? "accepted" : "failed",
    deliveryId: comment.id,
    updatedAt: new Date().toISOString(),
  };
  store.writeAnnotations(bookId, annotations);
  out.json.comment = comment;
  out.json.delivery = comment.delivery;
  return out;
}

function updateCallDelivery(bookId, annoId, body = {}) {
  const status = String(body.status || "");
  if (!["accepted", "failed"].includes(status)) return { status: 400, json: { error: "invalid delivery status" } };
  const deliveryId = String(body.deliveryId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(deliveryId)) return { status: 400, json: { error: "invalid delivery id" } };
  const annotations = store.readAnnotations(bookId);
  const annotation = annotations.find((item) => item.id === annoId && belongsTo(item, "codex"));
  if (!annotation) return { status: 404, json: { error: "unknown annotation" } };
  const commentId = String(body.commentId || "").trim();
  const target = commentId
    ? annotation.comments?.find((item) => item.id === commentId && item.delivery?.deliveryId === deliveryId)
    : annotation.delivery?.deliveryId === deliveryId ? annotation : null;
  if (!target) return { status: 404, json: { error: "unknown delivery" } };
  target.delivery = { target: "call", status, deliveryId, updatedAt: new Date().toISOString() };
  store.writeAnnotations(bookId, annotations);
  return { status: 200, json: { ok: true, delivery: target.delivery, ...(commentId ? { comment: target } : { annotation }) } };
}

async function deliverAnnotationToHome(bookId, annoId, body = {}) {
  const annotations = store.readAnnotations(bookId);
  const annotation = annotations.find((item) => item.id === annoId && belongsTo(item, "codex"));
  const manifest = store.readManifest(bookId);
  if (!annotation || !manifest) return { status: 404, json: { error: "unknown annotation" } };
  const deliveryId = String(body.deliveryId || annotation.id).trim();
  if (deliveryId !== annotation.id) return { status: 400, json: { error: "invalid delivery id" } };
  if (annotation.delivery?.target === "home" && annotation.delivery?.status === "accepted") {
    return { status: 200, json: { ok: true, duplicate: true, annotation, delivery: annotation.delivery } };
  }
  const note = annotation.comments?.find((item) => item.author === "human")?.text || "";
  const paragraphKey = `${bookId}:${annotation.seq}`;
  const result = await enqueueSystemMessageWithReceipt(selectionWakeText({
    manifest,
    chapterTitle: annotation.chapterTitle,
    annotation,
    paragraph: annotation.context || annotation.quote,
    note,
    includeContext: !sharedParagraphContexts.has(paragraphKey),
  }), { sourceMessageId: `books:${deliveryId}` });
  annotation.sharedTarget = "home";
  annotation.delivery = {
    target: "home",
    status: result?.ok ? "accepted" : "failed",
    deliveryId,
    updatedAt: new Date().toISOString(),
  };
  if (result?.ok) sharedParagraphContexts.add(paragraphKey);
  store.writeAnnotations(bookId, annotations);
  return { status: result?.ok ? 200 : 502, json: { ok: Boolean(result?.ok), annotation, delivery: annotation.delivery } };
}

function normalizeAiReplyPart(comments, body = {}) {
  const suppliedReplyId = String(body.replyId || "").trim();
  const lastHumanIndex = comments.reduce((last, item, index) => item?.author === "human" ? index : last, -1);
  const openParts = comments.filter((item, index) => index > lastHumanIndex && item?.author === "ai" && item?.final === false);
  const openReplyId = String(openParts.at(-1)?.replyId || "").trim();
  const replyId = /^[A-Za-z0-9_-]{1,120}$/.test(suppliedReplyId)
    ? suppliedReplyId
    : openReplyId || `reply-${store.newId()}`;
  const sameReply = comments.filter((item) => item?.author === "ai" && item?.replyId === replyId);
  const suppliedPartIndex = Number(body.partIndex);
  const partIndex = Number.isInteger(suppliedPartIndex) && suppliedPartIndex >= 0
    ? suppliedPartIndex
    : sameReply.reduce((max, item) => Math.max(max, Number(item.partIndex) || 0), -1) + 1;
  return { replyId, partIndex, final: body.final !== false };
}

function findSharedSelectionRecord(selectionId = "", { target = "codex" } = {}) {
  const id = String(selectionId || "").trim();
  let latest = null;
  for (const bookId of store.listBookIds()) {
    const annotations = store.readAnnotations(bookId);
    for (const annotation of annotations) {
      if (!visibleTo(annotation, target)) continue;
      if (id) {
        if (annotation.id !== id) continue;
        const hasHumanFollowUp = visibleAnnotation(annotation, target).comments?.some((comment) => comment?.author === "human" && comment?.kind === "reply");
        if ((annotation.createdBy === "human" && annotation.sharedAt) || hasHumanFollowUp) {
          return { bookId, annotations, annotation };
        }
        continue;
      }
      if (annotation.createdBy !== "human" || !annotation.sharedAt) continue;
      const record = { bookId, annotations, annotation };
      if (!latest || annotation.sharedAt.localeCompare(latest.annotation.sharedAt) > 0) latest = record;
    }
  }
  return latest;
}

function findSharedSelection(selectionId = "", options = {}) {
  const record = findSharedSelectionRecord(selectionId, options);
  if (!record) return null;
  const { bookId, annotation } = record;
  const manifest = store.readManifest(bookId);
  return {
    selectionId: annotation.id,
    bookId,
    title: manifest?.title || "",
    author: manifest?.author || "",
    chapter: annotation.chapter,
    chapterTitle: annotation.chapterTitle || "",
    quote: annotation.quote,
    context: annotation.context || annotation.quote,
    sharedAt: annotation.sharedAt,
    comments: visibleAnnotation(annotation, options.target || "codex").comments,
  };
}

function replyToSharedSelection(selectionId, body, channel = "codex") {
  const record = findSharedSelectionRecord(selectionId, { target: channel });
  if (!record) return { status: 404, json: { error: "shared selection not found" } };
  return addCommentToAnnotation(record.bookId, record.annotations, record.annotation, {
    ...body,
    source: channel,
    author: "ai",
  }, channel);
}

function isAllowedBooksUiRoute(method, pathname) {
  const rules = [
    ["GET", /^\/api\/books$/],
    ["GET", /^\/api\/book\/[\w-]+$/],
    ["GET", /^\/api\/book\/[\w-]+\/chapter\/\d+$/],
    ["GET", /^\/api\/annotations\/[\w-]+$/],
    ["GET", /^\/api\/bookmarks\/[\w-]+$/],
    ["POST", /^\/api\/beat$/],
    ["POST", /^\/api\/annotations$/],
    ["POST", /^\/api\/annotations\/[\w-]+\/[\w-]+\/comment$/],
    ["POST", /^\/api\/bookmarks$/],
    ["DELETE", /^\/api\/bookmarks\/[\w-]+\/[\w-]+$/],
  ];
  return rules.some(([expectedMethod, pattern]) => expectedMethod === method && pattern.test(pathname));
}

function isHomeUiAuthorized(req) {
  const address = String(req.socket?.remoteAddress || "").toLowerCase();
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  return loopback && String(req.headers["x-guichao-home-authenticated"] || "") === "1";
}

function coverDataUrl(bookId, manifest) {
  if (!manifest?.coverExt) return "";
  const file = path.join(store.bookDir(bookId), `cover${manifest.coverExt}`);
  try {
    const mime = manifest.coverExt === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return "";
  }
}

function mcpChannel(req) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const suppliedBytes = Buffer.from(supplied);
  const matches = token => {
    const expected = Buffer.from(token || "");
    return expected.length > 0 && suppliedBytes.length === expected.length
      && crypto.timingSafeEqual(suppliedBytes, expected);
  };
  if (CHATGPT_CONTROL_TOKEN && CHATGPT_CONTROL_TOKEN === MCP_CONTROL_TOKEN) return null;
  if (CHATGPT_CONTROL_TOKEN && CHATGPT_CONTROL_TOKEN !== MCP_CONTROL_TOKEN && matches(CHATGPT_CONTROL_TOKEN)) return "chatgpt";
  if (matches(MCP_CONTROL_TOKEN)) return "codex";
  return null;
}

// ── 书签（读者私有：不推送，也不进 AI 侧 gate） ──

function createBookmark(body) {
  const { bookId } = body || {};
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const seq = Number(body.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq >= manifest.paraCount) {
    return { status: 400, json: { error: "bad seq" } };
  }
  const bookmarks = store.readBookmarks(bookId);
  if (bookmarks.some((m) => m.seq === seq)) return { status: 409, json: { error: "bookmark exists" } };
  const ch = chapterOfSeq(manifest, seq);
  const chapter = store.readChapter(bookId, ch.idx);
  const para = chapter ? chapter.paragraphs[seq - ch.baseSeq] : "";
  const bookmark = {
    id: store.newId(),
    seq,
    chapter: ch.idx,
    chapterTitle: ch.title,
    excerpt: String(para || "").slice(0, 40),
    createdAt: new Date().toISOString(),
  };
  bookmarks.push(bookmark);
  bookmarks.sort((a, b) => a.seq - b.seq);
  store.writeBookmarks(bookId, bookmarks);
  return { status: 200, json: { ok: true, bookmark } };
}

function deleteBookmark(bookId, markId) {
  const bookmarks = store.readBookmarks(bookId);
  const next = bookmarks.filter((m) => m.id !== markId);
  if (next.length === bookmarks.length) return { status: 404, json: { error: "unknown bookmark" } };
  store.writeBookmarks(bookId, next);
  return { status: 200, json: { ok: true } };
}

// ── 门禁读取（AI 侧） ──

function gateInfo(bookId) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const unlockedChapters = manifest.chapters
    .filter((ch) => ch.baseSeq <= bs.furthestSeq)
    .map((ch) => ({ idx: ch.idx, title: ch.title, baseSeq: ch.baseSeq, paraCount: ch.paraCount }));
  return {
    status: 200,
    json: {
      bookId,
      title: manifest.title,
      author: manifest.author,
      furthestSeq: bs.furthestSeq,
      pushedRanges: bs.pushedRanges,
      progressPct: pct(bs, manifest),
      reading: Boolean(bs.session),
      lastOpenedAt: bs.lastOpenedAt,
      unlockedChapters,
      note: "unlockedChapters 之外的章节标题也是保密的",
    },
  };
}

function gateText(bookId, from, to) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 200) {
    return { status: 400, json: { error: "bad range (max 200 paras)" } };
  }
  const paragraphs = [];
  const locked = [];
  for (let seq = start; seq <= end; seq += 1) {
    if (!store.inRanges(bs.pushedRanges, seq)) {
      locked.push(seq);
      continue;
    }
    const ch = chapterOfSeq(manifest, seq);
    const chapter = store.readChapter(bookId, ch.idx);
    const para = chapter.paragraphs[seq - ch.baseSeq];
    if (typeof para === "string") paragraphs.push({ seq, chapter: ch.idx, chapterTitle: ch.title, text: para });
  }
  return { status: 200, json: { paragraphs, locked: locked.length ? `${locked.length}段未解锁` : undefined } };
}

function gateSearch(bookId, q) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const query = String(q || "").trim();
  if (!query) return { status: 400, json: { error: "q required" } };
  const state = store.readState();
  const bs = store.bookState(state, bookId);
  const hits = [];
  for (const [rs, re] of bs.pushedRanges) {
    for (let seq = rs; seq <= re && hits.length < 20; seq += 1) {
      const ch = chapterOfSeq(manifest, seq);
      const chapter = store.readChapter(bookId, ch.idx);
      const para = chapter.paragraphs[seq - ch.baseSeq];
      if (typeof para === "string" && para.includes(query)) {
        hits.push({ seq, chapter: ch.idx, chapterTitle: ch.title, text: para });
      }
    }
  }
  return { status: 200, json: { hits, scope: "仅已解锁范围" } };
}

function searchBookText(bookId, q) {
  const manifest = store.readManifest(bookId);
  if (!manifest) return { status: 404, json: { error: "unknown book" } };
  const query = String(q || "").trim();
  if (!query) return { status: 400, json: { error: "q required" } };
  const hits = [];
  for (const ch of manifest.chapters) {
    const chapter = store.readChapter(bookId, ch.idx);
    if (!chapter) continue;
    for (let paraIdx = 0; paraIdx < chapter.paragraphs.length && hits.length < 20; paraIdx += 1) {
      const text = String(chapter.paragraphs[paraIdx] || "");
      const at = text.indexOf(query);
      if (at < 0) continue;
      const seq = ch.baseSeq + paraIdx;
      const start = Math.max(0, at - 180);
      const end = Math.min(text.length, at + query.length + 180);
      hits.push({
        seq,
        chapter: ch.idx,
        chapterTitle: ch.title,
        progressPct: manifest.paraCount ? Math.round(((seq + 1) / manifest.paraCount) * 1000) / 10 : 0,
        excerpt: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      });
    }
    if (hits.length >= 20) break;
  }
  return { status: 200, json: { bookId, title: manifest.title, query, hits, count: hits.length, truncated: hits.length >= 20, scope: "整本已导入正文" } };
}

function findBookByTitle(value) {
  const wanted = String(value || "").trim().toLocaleLowerCase();
  if (!wanted) return { error: "book_title required", status: 400 };
  const books = store.listBookIds().map((bookId) => ({ bookId, manifest: store.readManifest(bookId) })).filter((item) => item.manifest);
  const exact = books.filter(({ bookId, manifest }) => bookId.toLocaleLowerCase() === wanted || String(manifest.title || "").trim().toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = books.filter(({ manifest }) => String(manifest.title || "").trim().toLocaleLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (exact.length > 1 || partial.length > 1) return { error: "book title is ambiguous", status: 409 };
  return { error: "book not found", status: 404 };
}

function readBookPosition(body, channel = "codex") {
  const found = findBookByTitle(body?.bookTitle);
  if (!found.manifest) return { status: found.status, json: { error: found.error } };
  const { bookId, manifest } = found;
  const state = store.readState();
  const bs = store.bookState(state, bookId);

  const rawProgress = body?.progressPct;
  const hasProgress = rawProgress !== undefined && rawProgress !== null && rawProgress !== "";
  const progress = Number(rawProgress);
  if (hasProgress && (!Number.isInteger(progress) || progress < 0 || progress > 100)) {
    return { status: 400, json: { error: "progress_pct must be an integer from 0 to 100" } };
  }

  const ai = store.readerState(bs, readerKey(channel));
  let requestedSeq;
  if (hasProgress) {
    requestedSeq = Math.min(manifest.paraCount - 1, Math.max(0, Math.round((progress / 100) * Math.max(0, manifest.paraCount - 1))));
  } else if (Number.isInteger(Number(ai?.lastPos?.seqEnd))) {
    requestedSeq = Number(ai.lastPos.seqEnd) + 1;
  } else if (Number.isInteger(Number(ai?.lastPos?.seqTop))) {
    requestedSeq = Number(ai.lastPos.seqTop) + 1;
  } else {
    requestedSeq = 0;
  }

  const startSeq = requestedSeq;
  if (!Number.isInteger(startSeq) || startSeq < 0 || startSeq >= manifest.paraCount) {
    return { status: 409, json: { error: "共读者已经读到这本书的末尾。" } };
  }
  const startChapter = chapterOfSeq(manifest, startSeq);
  const source = store.readChapter(bookId, startChapter.idx);
  if (!source) return { status: 404, json: { error: "这个位置没有可读正文。" } };
  const paragraphs = [];
  let chars = 0;
  let endSeq = startSeq - 1;
  for (let seq = startSeq; seq < manifest.paraCount; seq += 1) {
    const chapter = chapterOfSeq(manifest, seq);
    if (chapter.idx !== startChapter.idx) break;
    const text = String(source?.paragraphs?.[seq - chapter.baseSeq] || "").trim();
    if (!text) continue;
    if (paragraphs.length && chars + text.length > 1600) break;
    const bounded = text.slice(0, Math.max(1, 1600 - chars));
    paragraphs.push(bounded);
    chars += bounded.length;
    endSeq = seq;
    if (chars >= 1600) break;
  }
  if (!paragraphs.length || endSeq < startSeq) return { status: 404, json: { error: "这个位置没有可读正文。" } };

  const now = new Date().toISOString();
  store.setReaderProgress(bs, readerKey(channel), {
    chapter: startChapter.idx,
    seqTop: startSeq,
    seqEnd: endSeq,
  }, now);
  store.recordReaderRange(bs, readerKey(channel), startSeq, endSeq);
  store.writeState(state);
  const annotations = store.readAnnotations(bookId)
    .filter((annotation) => visibleTo(annotation, channel) && annotation.createdBy === "human"
      && annotation.sharedAt
      && Number(annotation.seq) >= startSeq
      && Number(annotation.seq) <= endSeq)
    .map((annotation) => ({
      selection_id: annotation.id,
      quote: annotation.quote,
      comment: rootAnnotationComment(annotation) || null,
      created_at: annotation.createdAt || annotation.sharedAt || "",
    }));
  return {
    status: 200,
    json: {
      bookId,
      title: manifest.title,
      author: manifest.author || "",
      progressPct: Math.max(0, Math.round(((startSeq + 1) / manifest.paraCount) * 100)),
      endProgressPct: Math.max(0, Math.round(((endSeq + 1) / manifest.paraCount) * 100)),
      chapter: startChapter.idx,
      chapterTitle: startChapter.title || "",
      text: paragraphs.join("\n\n"),
      annotations,
      atEnd: endSeq >= manifest.paraCount - 1,
      lastReadAt: now,
      scope: "整本已导入正文",
    },
  };
}

// ── HTTP 路由 ──

function send(res, status, json, headers = {}) {
  const body = JSON.stringify(json);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers));
  res.end(body);
}

const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("文件太大（上限50MB）"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = url.pathname;
  let m;

  try {
    const authenticatedChannel = mcpChannel(req);
    const channel = authenticatedChannel || "codex";
    const booksUiPrefix = "/api/internal/mcp/ui";
    const isInternalBooksUi = p === booksUiPrefix || p.startsWith(`${booksUiPrefix}/`);
    if (isInternalBooksUi) {
      if (authenticatedChannel !== "chatgpt") return send(res, 401, { error: "unauthorized" });
      const mappedPath = `/api${p.slice(booksUiPrefix.length) || "/"}`;
      if (!isAllowedBooksUiRoute(req.method, mappedPath)) return send(res, 404, { error: "ui route not allowed" });
      p = mappedPath;
    }

    const isInternalMcp = p.startsWith("/api/internal/mcp/");
    const isLoopbackPresence = p === "/api/presence";
    if (p.startsWith("/api/") && !isInternalMcp && !isInternalBooksUi && !isLoopbackPresence && !isHomeUiAuthorized(req)) {
      return send(res, 401, { error: "authentication required" }, { "Cache-Control": "no-store" });
    }

    if (req.method === "GET" && p === "/api/books") {
      const state = store.readState();
      const library = libraryStore.read();
      const books = store.listBookIds().map((bookId) => {
        const manifest = store.readManifest(bookId);
        const bs = store.bookState(state, bookId);
        return {
          bookId,
          title: manifest.title,
          author: manifest.author,
          chapterCount: manifest.chapterCount,
          totalChars: manifest.totalChars,
          progressPct: pct(bs, manifest),
          lastOpenedAt: bs.lastOpenedAt,
          lastPos: bs.lastPos,
          readingChapter: bs.lastPos && manifest.chapters[bs.lastPos.chapter] ? manifest.chapters[bs.lastPos.chapter].title : "",
          readers: readerSummaries(bs, manifest, channel),
          totalReadMs: bs.totalReadMs || 0,
          hasCover: Boolean(manifest.coverExt),
          ...(isInternalBooksUi && manifest.coverExt ? { coverDataUrl: coverDataUrl(bookId, manifest) } : {}),
          annotationCount: store.readAnnotations(bookId).filter(item => visibleTo(item, channel)).length,
          status: libraryStore.statusFor(library.books[bookId], pct(bs, manifest)),
          removed: Boolean(library.books[bookId]?.removed),
        };
      });
      return send(res, 200, { books });
    }

    if (req.method === "GET" && p === "/api/library") {
      return send(res, 200, libraryStore.read(), { "Cache-Control": "no-store" });
    }

    if (req.method === "POST" && (m = p.match(/^\/api\/library\/book\/([\w-]+)$/))) {
      try { return send(res, 200, { ok: true, book: libraryStore.updateBook(m[1], await readBody(req)) }); }
      catch (error) { return send(res, error.status || 400, { error: error.message }); }
    }

    if (req.method === "POST" && p === "/api/library/group") {
      try { return send(res, 200, { ok: true, group: libraryStore.saveGroup(await readBody(req)) }); }
      catch (error) { return send(res, error.status || 400, { error: error.message }); }
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/book\/([\w-]+)$/))) {
      const manifest = store.readManifest(m[1]);
      if (!manifest) return send(res, 404, { error: "unknown book" });
      const state = store.readState();
      const bs = store.bookState(state, m[1]);
      return send(res, 200, {
        manifest,
        progressPct: pct(bs, manifest),
        lastPos: bs.lastPos,
        lastOpenedAt: bs.lastOpenedAt,
        readers: readerSummaries(bs, manifest, channel),
        totalReadMs: bs.totalReadMs || 0,
      });
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/book\/([\w-]+)\/chapter\/(\d+)$/))) {
      const chapter = store.readChapter(m[1], m[2]);
      if (!chapter) return send(res, 404, { error: "unknown chapter" });
      return send(res, 200, chapter);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/cover\/([\w-]+)$/))) {
      const manifest = store.readManifest(m[1]);
      if (!manifest || !manifest.coverExt) return send(res, 404, { error: "no cover" });
      const file = path.join(store.bookDir(m[1]), `cover${manifest.coverExt}`);
      const type = manifest.coverExt === ".png" ? "image/png" : "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=86400" });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === "POST" && (p === "/api/import" || p === "/api/import/metadata")) {
      // 前端上传：文件二进制作请求体，文件名走查询参数（免 multipart）
      try {
        const filename = decodeURIComponent(url.searchParams.get("filename") || "");
        const ext = path.extname(filename).toLowerCase();
        if (![".epub", ".txt"].includes(ext)) return send(res, 400, { error: "只支持 .epub 和 .txt" });
        const buffer = await readRawBody(req, IMPORT_MAX_BYTES);
        if (!buffer.length) return send(res, 400, { error: "empty file" });
        const parsed = ext === ".epub"
          ? parseEpub(buffer)
          : parseTxt(buffer, { fallbackTitle: path.basename(filename, ext) });
        if (p === "/api/import/metadata") return send(res, 200, { title: parsed.metadata.title || path.basename(filename, ext), author: parsed.metadata.author || "" });
        const title = String(url.searchParams.get("title") || parsed.metadata.title || "").trim();
        const author = String(url.searchParams.get("author") || parsed.metadata.author || "").trim();
        if (!title || title.length > 200 || author.length > 160) return send(res, 400, { error: "书名或作者太长" });
        const groupId = url.searchParams.get("group") || "";
        if (groupId && !libraryStore.read().groups.some(group => group.id === groupId)) return send(res, 400, { error: "unknown group" });
        parsed.metadata = { ...parsed.metadata, title, author };
        const book = importParsed(parsed, {
          bookId: url.searchParams.get("id") || undefined,
          sourceFile: filename,
          allowOverwrite: false,
        });
        libraryStore.addToGroup(book.bookId, groupId);
        return send(res, 200, { ok: true, book });
      } catch (error) {
        return send(res, error.status || 400, { error: String(error?.message || error) });
      }
    }

    if (req.method === "GET" && p === "/api/settings") {
      const state = store.readState();
      return send(res, 200, { dwellSec: Math.round(dwellMsOf(state) / 1000), min: DWELL_MIN_S, max: DWELL_MAX_S });
    }

    if (req.method === "POST" && p === "/api/settings") {
      const body = await readBody(req);
      const sec = Number(body.dwellSec);
      if (!Number.isInteger(sec) || sec < DWELL_MIN_S || sec > DWELL_MAX_S) {
        return send(res, 400, { error: `dwellSec 需为 ${DWELL_MIN_S}-${DWELL_MAX_S} 的整数` });
      }
      const state = store.readState();
      state.settings = Object.assign({}, state.settings, { dwellMs: sec * 1000 });
      store.writeState(state);
      return send(res, 200, { ok: true, dwellSec: sec });
    }

    if (req.method === "POST" && p === "/api/beat") {
      const out = handleBeat(await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && p === "/api/presence") {
      return send(res, 200, currentPresence());
    }

    if (p.startsWith("/api/internal/mcp/")) {
      if (!authenticatedChannel) return send(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && p === "/api/internal/mcp/current") {
        return send(res, 200, currentReadingOverview(Date.now(), channel));
      }

      if (req.method === "GET" && p === "/api/internal/mcp/overview") {
        return send(res, 200, libraryOverview(channel));
      }

      if (req.method === "POST" && p === "/api/internal/mcp/read-position") {
        const out = readBookPosition(await readBody(req), channel);
        return send(res, out.status, out.json);
      }

      if (req.method === "GET" && p === "/api/internal/mcp/shared") {
        const selection = findSharedSelection(url.searchParams.get("selection_id"), { target: channel });
        return selection
          ? send(res, 200, { selection })
          : send(res, 404, { error: "shared selection not found" });
      }

      if (req.method === "POST" && (m = p.match(/^\/api\/internal\/mcp\/shared\/([\w-]+)\/reply$/))) {
        const body = await readBody(req);
        const out = replyToSharedSelection(m[1], body, channel);
        return send(res, out.status, out.json);
      }

      if (req.method === "POST" && p === "/api/internal/mcp/annotate") {
        const body = await readBody(req);
        body.author = "ai";
        const out = createAnnotation(body, { gate: true, channel });
        return send(res, out.status, out.json);
      }

      if (req.method === "GET" && (m = p.match(/^\/api\/internal\/mcp\/books\/([\w-]+)\/search$/))) {
        const out = searchBookText(m[1], url.searchParams.get("q"));
        return send(res, out.status, out.json);
      }
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/annotations\/([\w-]+)$/))) {
      return send(res, 200, { annotations: store.readAnnotations(m[1]).map(item => visibleAnnotation(item, channel)).filter(Boolean) });
    }

    if (req.method === "POST" && p === "/api/annotations") {
      const body = await readBody(req);
      const callDelivery = !isInternalBooksUi && String(body.delivery || "") === "call";
      const out = createAnnotation(body, {
        gate: false,
        channel,
        wake: !isInternalBooksUi && !callDelivery,
        sharedTarget: isInternalBooksUi ? "chatgpt" : callDelivery ? "call" : "",
      });
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && p === "/api/annotate") {
      const body = await readBody(req);
      body.author = "ai";
      const out = createAnnotation(body, { gate: true, channel });
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && (m = p.match(/^\/api\/annotations\/([\w-]+)\/([\w-]+)\/delivery$/))) {
      const out = updateCallDelivery(m[1], m[2], await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && (m = p.match(/^\/api\/annotations\/([\w-]+)\/([\w-]+)\/deliver$/))) {
      const out = await deliverAnnotationToHome(m[1], m[2], await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "POST" && (m = p.match(/^\/api\/annotations\/([\w-]+)\/([\w-]+)\/comment$/))) {
      const body = await readBody(req);
      const callDelivery = !isInternalBooksUi && String(body.delivery || "") === "call";
      const out = await addCommentWithDelivery(m[1], m[2], body, { wake: !isInternalBooksUi && !callDelivery, channel });
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/bookmarks\/([\w-]+)$/))) {
      return send(res, 200, { bookmarks: store.readBookmarks(m[1]) });
    }

    if (req.method === "POST" && p === "/api/bookmarks") {
      const out = createBookmark(await readBody(req));
      return send(res, out.status, out.json);
    }

    if (req.method === "DELETE" && (m = p.match(/^\/api\/bookmarks\/([\w-]+)\/([\w-]+)$/))) {
      const out = deleteBookmark(m[1], m[2]);
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)$/))) {
      const out = gateInfo(m[1]);
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)\/text$/))) {
      const out = gateText(m[1], url.searchParams.get("from"), url.searchParams.get("to"));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && (m = p.match(/^\/api\/gate\/([\w-]+)\/search$/))) {
      const out = gateSearch(m[1], url.searchParams.get("q"));
      return send(res, out.status, out.json);
    }

    if (req.method === "GET" && p === "/health") {
      return send(res, 200, { ok: true, pushEnabled: PUSH_ENABLED });
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message || error) });
  }
});

let idleTimer = null;

function start() {
  if (!idleTimer) {
    idleTimer = setInterval(sweepIdleSessions, 60 * 1000);
    idleTimer.unref?.();
  }
  return server.listen(PORT, "127.0.0.1", () => {
    console.log(`[reading] listening on 127.0.0.1:${PORT} pushEnabled=${PUSH_ENABLED} dwell=${DWELL_MS}ms idle=${IDLE_CLOSE_MS}ms`);
  });
}

if (require.main === module) start();

module.exports = {
  addComment,
  addCommentWithDelivery,
  buildPresence,
  createAnnotation,
  currentPresence,
  currentReadingOverview,
  deliverAnnotationToHome,
  findSharedSelection,
  followUpWakeText,
  handleBeat,
  isAllowedBooksUiRoute,
  isHomeUiAuthorized,
  libraryOverview,
  normalizeAiReplyPart,
  readBookPosition,
  replyToSharedSelection,
  readerSummary,
  readerSummaries,
  selectionWakeText,
  searchBookText,
  server,
  start,
  sweepIdleSessions,
  updateCallDelivery,
};
