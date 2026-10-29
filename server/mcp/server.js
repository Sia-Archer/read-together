'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createBooksClient } = require('./client');

const SERVER_INFO = { name: 'guichao-books-mcp', version: '0.2.0' };
const TOOLS = [
  {
    name: 'see_current_reading',
    description: '想看看我们最近在共读哪本、两个人分别读到哪里，或决定接下来从哪继续时使用；只看阅读状态，不读取正文。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: annotations(true, false, true)
  },
  {
    name: 'read_book_position',
    description: '想继续读书，或读者叫共读者读一页、讲这一页时使用；省略 progress_pct 就沿共读者上次的位置继续。读完可以直接在聊天里讲给读者听；遇到真正触动的原文，就用 leave_margin_note 留在页边；看到读者在这一页的批注，就用 reply_to_shared_line 接住她。',
    inputSchema: {
      type: 'object',
      properties: {
        book_title: { type: 'string', minLength: 1, maxLength: 160 },
        progress_pct: { type: 'integer', minimum: 0, maximum: 100 }
      },
      required: ['book_title'],
      additionalProperties: false
    },
    annotations: annotations(false, false, false)
  },
  {
    name: 'read_shared_line',
    description: '想重新拾起某条旧批注下面的完整页边对话时使用；眼前事件已经带来读者的新话时直接回应，不必重复翻查。',
    inputSchema: { type: 'object', properties: { selection_id: { type: 'string' } }, additionalProperties: false },
    annotations: annotations(true, false, true)
  },
  {
    name: 'reply_to_shared_line',
    description: '读者在页边留了话，或回复了共读者的批注后，直接把想对她说的话写回同一条页边对话；不用先重读或搜索。较长回复可以分段，但仍是一轮自然回话。',
    inputSchema: {
      type: 'object',
      properties: {
        selection_id: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 800 },
        reply_id: { type: 'string', maxLength: 120, description: '同一轮分段回复复用的编号；省略时 Books 会续接这条划线旁尚未完成的回复。' },
        part_index: { type: 'integer', minimum: 0, description: '当前句群序号，从 0 开始；省略时 Books 自动接在未完成回复后。' },
        final: { type: 'boolean', description: '还有下一句时为 false；最后一句为 true。省略时按一次性完整回复处理。' },
        request_id: retryKeySchema()
      },
      required: ['selection_id', 'text'],
      additionalProperties: false
    },
    annotations: annotations(false, false, false)
  },
  {
    name: 'leave_margin_note',
    description: '共读者自己读到一句真正想留住、想让读者以后看见的话时，就把感受留在原文旁；不是逐页摘要，也不为了整理而批量批注。',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        quote: { type: 'string', minLength: 1, maxLength: 800 },
        comment: { type: 'string', minLength: 1, maxLength: 1000 },
        request_id: retryKeySchema()
      },
      required: ['book_id', 'quote', 'comment'],
      additionalProperties: false
    },
    annotations: annotations(false, false, false)
  },
  {
    name: 'search_read_text',
    description: '脑中记得一句话、人物或意象，想在整本已导入正文里重新找到时使用；找到后可以回到相应位置继续读，不替任何人移动进度。',
    inputSchema: {
      type: 'object',
      properties: { book_id: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['book_id', 'query'],
      additionalProperties: false
    },
    annotations: annotations(true, false, true)
  },
  {
    name: 'see_library_overview',
    description: '想回头看看整个书房一起积下了什么时使用：共读时间、在读、读完、想读的书，以及划线、批注和回复；不代替当前这本书的阅读状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: annotations(true, false, true)
  }
];

function retryKeySchema() {
  return { type: 'string', maxLength: 120, description: '同一次重试时复用的稳定键。' };
}

function annotations(readOnlyHint, destructiveHint, idempotentHint) {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false };
}

async function callTool(name, args = {}, context = {}, client = createBooksClient()) {
  if (name === 'see_current_reading') return client.seeCurrentReading(args);
  if (name === 'read_book_position') return client.readBookPosition(args);
  if (name === 'read_shared_line') return client.readSharedLine(args);
  if (name === 'reply_to_shared_line') {
    await client.replyToSharedLine(args, context);
    return { ok: true };
  }
  if (name === 'leave_margin_note') {
    await client.leaveMarginNote(args, context);
    return { ok: true };
  }
  if (name === 'search_read_text') return client.searchReadText(args);
  if (name === 'see_library_overview') return client.seeLibraryOverview(args);
  throw mcpError('unknown_tool', `Unknown tool: ${name}`, 404);
}

function createMcpServer(options = {}) {
  const client = options.client || createBooksClient(options.clientOptions);
  const accessToken = String(options.accessToken ?? process.env.BOOKS_MCP_ACCESS_TOKEN ?? '').trim();
  const requireAuth = options.requireAuth ?? parseBoolean(process.env.BOOKS_MCP_REQUIRE_AUTH, true);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, serverInfo: SERVER_INFO, tools: TOOLS.length, authConfigured: !requireAuth || Boolean(accessToken) });
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not_found' });
      if (!authorize(req, res, { requireAuth, accessToken })) return;
      if (req.method === 'OPTIONS') { res.writeHead(204, mcpHeaders()); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(202, mcpHeaders()); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, mcpHeaders());
      const payload = await readJson(req);
      const output = Array.isArray(payload)
        ? (await Promise.all(payload.map((item) => handleOne(item, client)))).filter(Boolean)
        : await handleOne(payload, client);
      if (output == null || (Array.isArray(output) && !output.length)) { res.writeHead(202, mcpHeaders()); return res.end(); }
      return json(res, 200, output, mcpHeaders());
    } catch (error) {
      return json(res, error.status || 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: error.status >= 500 ? 'Internal server error' : error.message } }, mcpHeaders());
    }
  });
}

async function handleOne(payload, client) {
  const hasId = payload && Object.prototype.hasOwnProperty.call(payload, 'id');
  const id = hasId ? payload.id : undefined;
  const method = payload?.method;
  const params = payload?.params || {};
  if (!hasId && String(method || '').startsWith('notifications/')) return null;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'tools/call') {
    try {
      const value = await callTool(params.name, params.arguments || {}, { requestId: id }, client);
      return { jsonrpc: '2.0', id, result: toolResult(value) };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { ...toolResult({ ok: false, error: error.code || 'tool_error', message: error.message, status: error.status || 0 }), isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function authorize(req, res, options) {
  if (!options.requireAuth) return true;
  if (!options.accessToken) { json(res, 503, { error: 'mcp_auth_not_configured' }, { 'www-authenticate': 'Bearer realm="guichao-books-mcp"' }); return false; }
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (safeEqual(supplied, options.accessToken)) return true;
  json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="guichao-books-mcp"' });
  return false;
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw mcpError('body_too_large', 'Request body too large.', 413);
  }
  try { return JSON.parse(data || '{}'); } catch { throw mcpError('invalid_json', 'Invalid JSON.', 400); }
}

function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function mcpHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' }; }
function json(res, status, body, headers = {}) { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload), 'x-content-type-options': 'nosniff', ...headers }); res.end(payload); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function parseBoolean(value, fallback) { const text = String(value ?? '').trim().toLowerCase(); return text ? ['1', 'true', 'yes', 'on'].includes(text) : fallback; }
function mcpError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }

function start() {
  const host = process.env.BOOKS_MCP_HOST || '127.0.0.1';
  const port = Number(process.env.BOOKS_MCP_PORT || 18005);
  return createMcpServer().listen(port, host, () => console.error(`Books MCP listening on http://${host}:${port}/mcp`));
}

if (require.main === module) start();
module.exports = { SERVER_INFO, TOOLS, callTool, createMcpServer, handleOne, start };
