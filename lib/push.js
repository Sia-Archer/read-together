const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUTBOX_LOG = path.join(require("./store").DATA_DIR, "outbox.log");

// 推送通道按优先级三选一：
// 1. 设了 READING_PUSH_WEBHOOK   → POST 到该地址
// 2. 设了 READING_PUSH_ENABLED=1 → 写 cyberboss 系统消息队列
// 3. 都没设                       → DRY-RUN，只写日志不外发
const WEBHOOK = process.env.READING_PUSH_WEBHOOK || "";
const WEBHOOK_SECRET = process.env.READING_PUSH_WEBHOOK_SECRET || "";
const CYBERBOSS_STATE_DIR = process.env.CYBERBOSS_STATE_DIR || path.join(process.env.HOME || "/root", ".cyberboss");
const QUEUE_FILE = path.join(CYBERBOSS_STATE_DIR, "system-message-queue.json");
const SESSIONS_FILE = path.join(CYBERBOSS_STATE_DIR, "sessions.json");
const PUSH_ENABLED = Boolean(WEBHOOK) || process.env.READING_PUSH_ENABLED === "1";

function logOutbox(status, text) {
  const line = `${new Date().toISOString()} [${status}] ${text.replace(/\n/g, "\\n").slice(0, 400)}\n`;
  try {
    fs.appendFileSync(OUTBOX_LOG, line);
  } catch {}
}

// cyberboss：从 sessions.json 找到已绑定的会话（推送目标）
function resolveTarget() {
  const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  const bindings = Object.values(sessions?.bindings || {});
  const binding = bindings.find((b) => b?.accountId && b?.senderId);
  if (!binding) throw new Error("no cyberboss binding found in sessions.json");
  return {
    accountId: binding.accountId,
    senderId: binding.senderId,
    workspaceRoot: binding.activeWorkspaceRoot || process.env.HOME || "/root",
  };
}

// cyberboss：把消息原子追加进系统消息队列
function pushCyberboss(text, { sourceMessageId = "" } = {}) {
  const target = resolveTarget();
  const message = {
    id: sourceMessageId || crypto.randomUUID(),
    accountId: target.accountId,
    senderId: target.senderId,
    workspaceRoot: target.workspaceRoot,
    text,
    createdAt: new Date().toISOString(),
  };

  const state = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      return { messages: Array.isArray(parsed?.messages) ? parsed.messages : [] };
    } catch {
      return { messages: [] };
    }
  })();
  state.messages.push(message);

  const tmp = `${QUEUE_FILE}.reading-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, QUEUE_FILE);

  logOutbox("SENT", text);
  return { ok: true, id: message.id };
}

function webhookRequest(text, { timeout = false, sourceMessageId = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (WEBHOOK_SECRET) headers.Authorization = `Bearer ${WEBHOOK_SECRET}`;
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "reading",
      replyTarget: "reading",
      sourceMessageId,
      text,
      createdAt: new Date().toISOString(),
      waitForCompletion: false,
    }),
    ...(timeout && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(5000) }
      : {}),
  };
}

// 普通阅读事件不阻塞页面，结果异步记日志。
function pushWebhook(text, options = {}) {
  fetch(WEBHOOK, webhookRequest(text, options))
    .then((r) => logOutbox(r.ok ? "SENT" : `HTTP-${r.status}`, text))
    .catch((error) => logOutbox("ERROR " + (error?.message || error), text));
  return { ok: true };
}

// 用户主动回复需要准确反馈：等消息桥确认接收后再告诉前端。
async function pushWebhookWithReceipt(text, options = {}) {
  try {
    const response = await fetch(WEBHOOK, webhookRequest(text, { ...options, timeout: true }));
    logOutbox(response.ok ? "SENT" : `HTTP-${response.status}`, text);
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, reason: `HTTP ${response.status}` };
  } catch (error) {
    logOutbox("ERROR " + (error?.message || error), text);
    return { ok: false, reason: String(error?.message || error) };
  }
}

function enqueueSystemMessage(text, options = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  if (!PUSH_ENABLED) {
    logOutbox("DRY-RUN", trimmed);
    return { ok: true, dryRun: true };
  }

  try {
    if (WEBHOOK) return pushWebhook(trimmed, options);
    return pushCyberboss(trimmed, options);
  } catch (error) {
    logOutbox("ERROR " + (error?.message || error), trimmed);
    return { ok: false, reason: String(error?.message || error) };
  }
}

async function enqueueSystemMessageWithReceipt(text, options = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (!PUSH_ENABLED) {
    logOutbox("DRY-RUN", trimmed);
    return { ok: false, dryRun: true, reason: "push disabled" };
  }
  if (WEBHOOK) return pushWebhookWithReceipt(trimmed, options);
  try {
    return pushCyberboss(trimmed, options);
  } catch (error) {
    logOutbox("ERROR " + (error?.message || error), trimmed);
    return { ok: false, reason: String(error?.message || error) };
  }
}

module.exports = { enqueueSystemMessage, enqueueSystemMessageWithReceipt, PUSH_ENABLED };
