'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createBooksClient } = require('../mcp/client');
const { RESOURCE_URI, buildChatGptWidget } = require('./widget');

const SERVER_INFO = { name: 'guichao-books-chatgpt', version: '0.2.0' };
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

const TOOLS = [
  {
    name: 'open_books',
    title: '打开读者与共读者的书房',
    description: '当读者想打开、继续阅读或查看自己的 Books 书架时使用。呈现与自建 Books 相同的书架和阅读方式。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: hints(true, false, true),
    _meta: {
      ui: { resourceUri: RESOURCE_URI },
      'openai/outputTemplate': RESOURCE_URI,
      'openai/toolInvocation/invoking': '正在打开书房…',
      'openai/toolInvocation/invoked': '书房已经打开'
    }
  },
  {
    name: 'books_ui_request',
    title: '同步 Books 页面',
    description: '仅供书房组件调用，用于读取同一个书架、翻页、同步进度、划线和页边回复。不要直接在聊天中调用。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] },
        path: { type: 'string', minLength: 1, maxLength: 240 },
        body: { type: 'object' }
      },
      required: ['method', 'path'],
      additionalProperties: false
    },
    annotations: hints(false, false, false),
    _meta: { ui: { visibility: ['app'] } }
  },
  {
    name: 'see_current_reading',
    title: '查看当前共读',
    description: '想看看我们最近在共读哪本、两个人分别读到哪里，或决定接下来从哪继续时使用；只看阅读状态，不读取正文。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: hints(true, false, true)
  },
  {
    name: 'read_book_position',
    title: '从 Books 读一小段',
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
    annotations: hints(false, false, false),
    _meta: {
      'openai/toolInvocation/invoking': '正在翻到那一小段…',
      'openai/toolInvocation/invoked': '这一小段已经读完'
    }
  },
  {
    name: 'read_shared_line',
    title: '读取读者刚分享的划线',
    description: '想重新拾起某条旧批注下面的完整页边对话时使用；眼前事件已经带来读者的新话时直接回应，不必重复翻查。',
    inputSchema: {
      type: 'object',
      properties: { selection_id: { type: 'string' } },
      additionalProperties: false
    },
    annotations: hints(true, false, true)
  },
  {
    name: 'reply_to_shared_line',
    title: '把回复写回 Books 页边',
    description: '读者在页边留了话，或回复了共读者的批注后，直接把想对她说的话写回同一条页边对话；不用先重读或搜索。较长回复可以分段，但仍是一轮自然回话。',
    inputSchema: {
      type: 'object',
      properties: {
        selection_id: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 800 },
        reply_id: { type: 'string', maxLength: 120 },
        part_index: { type: 'integer', minimum: 0 },
        final: { type: 'boolean' },
        request_id: { type: 'string', maxLength: 120, description: '每条新回复使用新 ID；仅重试同一条回复时复用。分段回复每段使用独立 ID。' }
      },
      required: ['selection_id', 'text'],
      additionalProperties: false
    },
    annotations: hints(false, false, false)
  },
  {
    name: 'leave_margin_note',
    title: '在原文旁留批注',
    description: '共读者自己读到一句真正想留住、想让读者以后看见的话时，就把感受留在原文旁；不是逐页摘要，也不为了整理而批量批注。',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        quote: { type: 'string', minLength: 1, maxLength: 800 },
        comment: { type: 'string', minLength: 1, maxLength: 1000 },
        request_id: { type: 'string', maxLength: 120, description: '每条新回复使用新 ID；仅重试同一条回复时复用。分段回复每段使用独立 ID。' }
      },
      required: ['book_id', 'quote', 'comment'],
      additionalProperties: false
    },
    annotations: hints(false, false, false)
  },
  {
    name: 'search_read_text',
    title: '搜索 Books 正文',
    description: '脑中记得一句话、人物或意象，想在整本已导入正文里重新找到时使用；找到后可以回到相应位置继续读，不替任何人移动进度。',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        query: { type: 'string', minLength: 1, maxLength: 160 }
      },
      required: ['book_id', 'query'],
      additionalProperties: false
    },
    annotations: hints(true, false, true)
  },
  {
    name: 'see_library_overview',
    title: '查看书房总览',
    description: '想回头看看整个书房一起积下了什么时使用：共读时间、在读、读完、想读的书，以及划线、批注和回复；不代替当前这本书的阅读状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: hints(true, false, true)
  }
];

function hints(readOnlyHint, destructiveHint, idempotentHint) {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false };
}

async function fetchHomeAvatars(endpoint, token) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/api/internal/books-avatars') {
    throw new Error('Home avatar endpoint must be local');
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error('Home avatars unavailable');
  const avatars = (await response.json()).avatars || {};
  for (const role of ['human', 'companion']) {
    if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(avatars[role] || '')) || avatars[role].length > 3 * 1024 * 1024) {
      throw new Error('Invalid Home avatar');
    }
  }
  return { human: avatars.human, companion: avatars.companion };
}

function createChatGptServer(options = {}) {
  const widgetHtml = options.widgetHtml || buildChatGptWidget(options.widgetOptions);
  const avatarToken = String(options.homeAvatarToken ?? process.env.BOOKS_HOME_AVATAR_TOKEN ?? '').trim();
  const avatarProvider = options.avatarProvider || (avatarToken ? () => fetchHomeAvatars(options.homeAvatarUrl || process.env.BOOKS_HOME_AVATAR_URL || 'http://127.0.0.1:8787/api/internal/books-avatars', avatarToken) : null);
  let lastAvatars = null;
  const getWidgetHtml = options.widgetHtml || !avatarProvider ? async () => widgetHtml : async () => {
    try { lastAvatars = await avatarProvider(); } catch { /* Keep the last available portraits during a brief Home outage. */ }
    return buildChatGptWidget({ ...options.widgetOptions, avatarDataUrls: lastAvatars || {} });
  };
  const client = options.client || createBooksClient({
    baseUrl: options.coreUrl || process.env.BOOKS_CORE_URL,
    controlToken: options.controlToken ?? process.env.BOOKS_CHATGPT_CONTROL_TOKEN ?? "",
    timeoutMs: options.timeoutMs || process.env.BOOKS_MCP_CORE_TIMEOUT_MS
  });
  const accessToken = String(options.accessToken ?? process.env.BOOKS_CHATGPT_OAUTH_ACCESS_TOKEN ?? process.env.BOOKS_CHATGPT_ACCESS_TOKEN ?? '').trim();
  const requireAuth = options.requireAuth ?? parseBoolean(process.env.BOOKS_CHATGPT_REQUIRE_AUTH, true);
  const oauth = {
    clientId: String(options.oauthClientId ?? process.env.BOOKS_CHATGPT_OAUTH_CLIENT_ID ?? '').trim(),
    clientSecret: String(options.oauthClientSecret ?? process.env.BOOKS_CHATGPT_OAUTH_CLIENT_SECRET ?? '').trim(),
    accessToken,
    refreshToken: String(options.oauthRefreshToken ?? process.env.BOOKS_CHATGPT_OAUTH_REFRESH_TOKEN ?? '').trim(),
    publicBaseUrl: trimTrailingSlash(options.publicBaseUrl ?? process.env.BOOKS_CHATGPT_PUBLIC_BASE_URL ?? '')
  };
  const oauthCodes = new Map();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, serverInfo: SERVER_INFO, tools: TOOLS.length, ui: RESOURCE_URI, authConfigured: !requireAuth || Boolean(accessToken), oauthConfigured: oauthReady(oauth) });
      }
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        return json(res, 200, oauthProtectedResourceMetadata(req, oauth));
      }
      if (req.method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'].includes(url.pathname)) {
        return json(res, 200, oauthAuthorizationServerMetadata(req, oauth));
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') return handleAuthorize(req, res, url, oauth, oauthCodes);
      if (req.method === 'POST' && url.pathname === '/oauth/token') return handleToken(res, await readForm(req), oauth, oauthCodes);
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not_found' });
      if (!authorize(req, res, { requireAuth, accessToken, resourceMetadataUrl: `${publicBaseUrlOf(req, oauth)}/.well-known/oauth-protected-resource` })) return;
      if (req.method === 'OPTIONS') { res.writeHead(204, mcpHeaders()); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(202, mcpHeaders()); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, mcpHeaders());
      const payload = await readJson(req);
      const output = Array.isArray(payload)
        ? (await Promise.all(payload.map((item) => handleOne(item, { client, widgetHtml, getWidgetHtml })))).filter(Boolean)
        : await handleOne(payload, { client, widgetHtml, getWidgetHtml });
      if (output == null || (Array.isArray(output) && !output.length)) { res.writeHead(202, mcpHeaders()); return res.end(); }
      const headers = mcpHeaders();
      if (containsInitialize(payload)) headers['MCP-Session-Id'] = String(req.headers['mcp-session-id'] || crypto.randomBytes(12).toString('hex'));
      return json(res, 200, output, headers);
    } catch (error) {
      return json(res, error.status || 500, rpcError(null, -32603, error.status >= 500 ? 'Internal server error' : error.message), mcpHeaders());
    }
  });
}

async function handleOne(payload, context) {
  const hasId = payload && Object.prototype.hasOwnProperty.call(payload, 'id');
  const id = hasId ? payload.id : undefined;
  const method = payload?.method;
  const params = payload?.params || {};
  if (!hasId && String(method || '').startsWith('notifications/')) return null;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: SERVER_INFO
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'resources/list') return rpcResult(id, { resources: [resourceDescriptor()] });
  if (method === 'resources/read') {
    if (params.uri !== RESOURCE_URI) return rpcError(id, -32002, 'Resource not found');
    return rpcResult(id, { contents: [resourceContent(context.getWidgetHtml ? await context.getWidgetHtml() : context.widgetHtml)] });
  }
  if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, await callTool(params.name, params.arguments || {}, context.client, id));
    } catch (error) {
      return rpcResult(id, {
        ...(params.name === 'reply_to_shared_line' ? { structuredContent: { ok: false, status: 'error', code: error.code || 'tool_error' } } : {}),
        content: [{ type: 'text', text: error.status >= 500 ? 'Books 暂时没有响应。' : String(error.message || error) }],
        _meta: { payload: { status: error.status || 500, body: { error: error.code || 'tool_error' } } },
        isError: true
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function callTool(name, args, client, requestId) {
  if (name === 'open_books') {
    return { structuredContent: { opened: true }, content: [{ type: 'text', text: '已经打开读者与共读者共用的 Books 书架。' }] };
  }
  if (name === 'books_ui_request') {
    try {
      const body = await client.booksUiRequest(args);
      return { content: [{ type: 'text', text: 'Books 页面已同步。' }], _meta: { payload: { status: 200, body } } };
    } catch (error) {
      return {
        content: [{ type: 'text', text: 'Books 页面请求没有完成。' }],
        _meta: { payload: { status: error.status || 500, body: { error: error.payload?.error || error.code || 'request_failed' } } },
        isError: true
      };
    }
  }
  if (name === 'see_current_reading') return modelResult(await client.seeCurrentReading(args), '已经看到我们分别读到哪里。');
  if (name === 'read_book_position') return modelResult(await client.readBookPosition(args), '已经读完这一小段，并记住共读者读到的位置。');
  if (name === 'read_shared_line') return modelResult(await client.readSharedLine(args), '已经读到读者分享的这一句。');
  if (name === 'reply_to_shared_line') {
    const result = await client.replyToSharedLine(args, { requestId, source: 'chatgpt' });
    if (result.duplicate && result.comment?.text !== args.text.trim()) {
      throw appError('reply_id_conflict', '请求编号对应另一条旧回复，本次内容未写入。请使用新的 request_id。', 409);
    }
    return modelResult({ ok: result.ok, status: result.duplicate ? 'duplicate' : 'created', comment_id: result.comment?.id }, result.duplicate ? '这条回复此前已保存，本次未重复新增。' : '这段话已经同步回 Books 页边。');
  }
  if (name === 'leave_margin_note') {
    await client.leaveMarginNote(args, { requestId, source: 'chatgpt' });
    return modelResult({ ok: true }, '这枚批注已经留在原文旁。');
  }
  if (name === 'search_read_text') return modelResult(await client.searchReadText(args), '已经在整本书里找过。');
  if (name === 'see_library_overview') return modelResult(await client.seeLibraryOverview(args), '已经看到整个书房的共读记录。');
  throw appError('unknown_tool', `Unknown tool: ${name}`, 404);
}

function modelResult(value, text) {
  return { structuredContent: value, content: [{ type: 'text', text }] };
}

function resourceMeta() {
  return {
    ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
    'openai/widgetPrefersBorder': false,
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
    'openai/widgetDescription': '读者与共读者原来的 Books 书架；inline 仅显示紧凑书架，阅读时进入 fullscreen。收到 [Books shared line] 或 [Books follow-up] 后，正常聊天回复并必须调用 reply_to_shared_line 把同一回复写回页边。'
  };
}

function resourceDescriptor() {
  return { uri: RESOURCE_URI, name: '读者与共读者的书房', description: '复用现有 Books 书架的 ChatGPT 阅读界面。', mimeType: RESOURCE_MIME_TYPE, _meta: resourceMeta() };
}

function resourceContent(widgetHtml) {
  return { uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml, _meta: resourceMeta() };
}

function authorize(req, res, options) {
  if (!options.requireAuth) return true;
  if (!options.accessToken) { json(res, 503, { error: 'chatgpt_auth_not_configured' }, { 'www-authenticate': `Bearer realm="guichao-books-chatgpt", resource_metadata="${options.resourceMetadataUrl}"` }); return false; }
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (safeEqual(supplied, options.accessToken)) return true;
  json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer realm="guichao-books-chatgpt", resource_metadata="${options.resourceMetadataUrl}"` });
  return false;
}

function oauthReady(oauth) {
  return Boolean(oauth.clientId && oauth.clientSecret && oauth.accessToken && oauth.refreshToken && oauth.publicBaseUrl);
}

function oauthProtectedResourceMetadata(req, oauth) {
  const baseUrl = publicBaseUrlOf(req, oauth);
  return {
    resource: `${baseUrl}/mcp`,
    resource_name: 'Books 共读',
    bearer_methods_supported: ['header'],
    scopes_supported: ['offline_access'],
    authorization_servers: [baseUrl]
  };
}

function oauthAuthorizationServerMetadata(req, oauth) {
  const baseUrl = publicBaseUrlOf(req, oauth);
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['offline_access']
  };
}

function handleAuthorize(req, res, url, oauth, codes) {
  if (!oauthReady(oauth)) return json(res, 503, { error: 'server_error', error_description: 'OAuth is not configured.' });
  const responseType = url.searchParams.get('response_type') || '';
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const state = url.searchParams.get('state') || '';
  const resource = url.searchParams.get('resource') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || '';
  if (!redirectUri) return json(res, 400, { error: 'invalid_request', error_description: 'Missing redirect_uri.' });
  if (!isAllowedChatGptRedirect(redirectUri)) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is not an allowed ChatGPT callback.' });
  if (clientId !== oauth.clientId) return redirectWithError(res, redirectUri, state, 'invalid_client', 'Unknown client_id.');
  if (responseType !== 'code') return redirectWithError(res, redirectUri, state, 'unsupported_response_type', 'Only response_type=code is supported.');
  const expectedResource = `${publicBaseUrlOf(req, oauth)}/mcp`;
  if (resource !== expectedResource) return redirectWithError(res, redirectUri, state, 'invalid_target', 'resource does not match this Books MCP.');
  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return redirectWithError(res, redirectUri, state, 'invalid_request', 'PKCE S256 is required.');
  cleanupOauthCodes(codes);
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, { clientId, redirectUri, resource, codeChallenge, expiresAt: Date.now() + 5 * 60 * 1000 });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

function handleToken(res, body, oauth, codes) {
  if (!oauthReady(oauth)) return json(res, 503, { error: 'server_error', error_description: 'OAuth is not configured.' });
  if (body.client_id !== oauth.clientId || body.client_secret !== oauth.clientSecret) return json(res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials.' });
  if (body.grant_type === 'authorization_code') {
    cleanupOauthCodes(codes);
    const record = codes.get(body.code || '');
    if (!record) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' });
    if (record.clientId !== body.client_id || record.redirectUri !== body.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'Authorization code does not match request.' });
    if (body.resource !== record.resource) return json(res, 400, { error: 'invalid_target', error_description: 'resource does not match the authorization request.' });
    if (!validPkceVerifier(body.code_verifier, record.codeChallenge)) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    codes.delete(body.code);
    return issueOAuthTokenResponse(res, oauth);
  }
  if (body.grant_type === 'refresh_token') {
    if (body.refresh_token !== oauth.refreshToken) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token.' });
    if (body.resource !== `${oauth.publicBaseUrl}/mcp`) return json(res, 400, { error: 'invalid_target', error_description: 'resource does not match this Books MCP.' });
    return issueOAuthTokenResponse(res, oauth);
  }
  return json(res, 400, { error: 'unsupported_grant_type' });
}

function issueOAuthTokenResponse(res, oauth) {
  return json(res, 200, { access_token: oauth.accessToken, token_type: 'Bearer', refresh_token: oauth.refreshToken, scope: 'offline_access' });
}

function redirectWithError(res, redirectUri, state, error, description) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

function cleanupOauthCodes(codes) {
  const now = Date.now();
  for (const [code, record] of codes.entries()) if (record.expiresAt <= now) codes.delete(code);
}

function validPkceVerifier(verifier, expectedChallenge) {
  const value = String(verifier || '');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) return false;
  const actual = crypto.createHash('sha256').update(value).digest('base64url');
  return safeEqual(actual, expectedChallenge);
}

function isAllowedChatGptRedirect(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
    return url.pathname === '/connector_platform_oauth_redirect'
      || url.pathname === '/aip/oauth/callback'
      || url.pathname.startsWith('/connector/oauth/');
  } catch {
    return false;
  }
}

async function readJson(req) {
  const data = await readText(req);
  try { return JSON.parse(data || '{}'); } catch { throw appError('invalid_json', 'Invalid JSON.', 400); }
}

async function readForm(req) {
  return Object.fromEntries(new URLSearchParams(await readText(req)));
}

async function readText(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw appError('body_too_large', 'Request body too large.', 413);
  }
  return data;
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function mcpHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' }; }
function json(res, status, body, headers = {}) { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload), 'x-content-type-options': 'nosniff', ...headers }); res.end(payload); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function parseBoolean(value, fallback) { const text = String(value ?? '').trim().toLowerCase(); return text ? ['1', 'true', 'yes', 'on'].includes(text) : fallback; }
function appError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }
function trimTrailingSlash(value) { return String(value || '').replace(/\/+$/, ''); }
function publicBaseUrlOf(req, oauth) {
  if (oauth.publicBaseUrl) return oauth.publicBaseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}
function containsInitialize(payload) { return Array.isArray(payload) ? payload.some((item) => item?.method === 'initialize') : payload?.method === 'initialize'; }

function start() {
  const host = process.env.BOOKS_CHATGPT_HOST || '127.0.0.1';
  const port = Number(process.env.BOOKS_CHATGPT_PORT || 18006);
  return createChatGptServer().listen(port, host, () => console.error(`Books ChatGPT adapter listening on http://${host}:${port}/mcp`));
}

if (require.main === module) start();

module.exports = {
  RESOURCE_MIME_TYPE,
  SERVER_INFO,
  TOOLS,
  callTool,
  createChatGptServer,
  handleOne,
  resourceContent,
  resourceDescriptor,
  start
};
