'use strict';

const crypto = require('node:crypto');

function createBooksClient(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.BOOKS_CORE_URL || 'http://127.0.0.1:18004').replace(/\/+$/, '');
  const controlToken = String(options.controlToken ?? process.env.BOOKS_MCP_CONTROL_TOKEN ?? '').trim();
  const timeoutMs = positiveInteger(options.timeoutMs || process.env.BOOKS_MCP_CORE_TIMEOUT_MS, 8_000, 60_000);
  const fetchImpl = options.fetch || global.fetch;

  async function request(pathname, requestOptions = {}) {
    if (!controlToken) throw clientError('mcp_control_not_configured', 'Books MCP control connection is not configured.', 503);
    const url = new URL(pathname, `${baseUrl}/`);
    if (requestOptions.query) {
      for (const [key, value] of Object.entries(requestOptions.query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: requestOptions.method || 'GET',
        headers: {
          authorization: `Bearer ${controlToken}`,
          accept: 'application/json',
          ...(requestOptions.body ? { 'content-type': 'application/json' } : {})
        },
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
        signal: controller.signal,
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw clientError(payload.error || 'core_request_failed', payload.message || `Books Core HTTP ${response.status}`, response.status, payload);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw clientError('core_timeout', 'Books Core timed out.', 504);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function seeCurrentReading() {
    return request('/api/internal/mcp/current');
  }

  function seeLibraryOverview() {
    return request('/api/internal/mcp/overview');
  }

  function readSharedLine(args = {}) {
    const selectionId = cleanId(args.selection_id, false, 'selection_id');
    return request('/api/internal/mcp/shared', { query: { selection_id: selectionId } });
  }

  function readBookPosition(args = {}) {
    const bookTitle = boundedText(args.book_title, 'book_title', 160, true);
    const progressPct = optionalProgress(args.progress_pct);
    return request('/api/internal/mcp/read-position', {
      method: 'POST',
      body: {
        bookTitle,
        ...(progressPct === null ? {} : { progressPct })
      }
    });
  }

  function replyToSharedLine(args = {}, context = {}) {
    const selectionId = cleanId(args.selection_id, true, 'selection_id');
    const text = boundedText(args.text, 'text', 800, true);
    const replyId = cleanId(args.reply_id, false, 'reply_id');
    const partIndex = optionalPartIndex(args.part_index);
    return request(`/api/internal/mcp/shared/${encodeURIComponent(selectionId)}/reply`, {
      method: 'POST',
      body: {
        text,
        clientId: mutationKey('reply', args.request_id),
        ...(replyId ? { replyId } : {}),
        ...(partIndex === null ? {} : { partIndex }),
        ...(["chatgpt", "codex"].includes(String(context.source || "")) ? { source: String(context.source) } : {}),
        final: args.final !== false
      }
    });
  }

  function leaveMarginNote(args = {}, context = {}) {
    const bookId = cleanId(args.book_id, true, 'book_id');
    const quote = boundedText(args.quote, 'quote', 800, true);
    const comment = boundedText(args.comment, 'comment', 1000, true);
    return request('/api/internal/mcp/annotate', {
      method: 'POST',
      body: { bookId, quote, comment, clientId: mutationKey('annotate', args.request_id) }
    });
  }

  function searchReadText(args = {}) {
    const bookId = cleanId(args.book_id, true, 'book_id');
    const query = boundedText(args.query, 'query', 160, true);
    return request(`/api/internal/mcp/books/${encodeURIComponent(bookId)}/search`, { query: { q: query } });
  }

  function booksUiRequest(args = {}) {
    const method = String(args.method || 'GET').trim().toUpperCase();
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw clientError('invalid_method', 'method is invalid.', 400);
    const pathname = normalizeUiPath(args.path);
    return request(`/api/internal/mcp/ui${pathname}`, {
      method,
      ...(args.body && typeof args.body === 'object' ? { body: args.body } : {})
    });
  }

  return { seeCurrentReading, seeLibraryOverview, readBookPosition, readSharedLine, replyToSharedLine, leaveMarginNote, searchReadText, booksUiRequest };
}

function normalizeUiPath(value) {
  const pathname = String(value || '').trim();
  if (!pathname.startsWith('/') || pathname.includes('://') || pathname.includes('..')) {
    throw clientError('invalid_path', 'path is invalid.', 400);
  }
  if (pathname.length > 240) throw clientError('invalid_path', 'path is too long.', 400);
  return pathname;
}

function cleanId(value, required, name) {
  const id = String(value || '').trim();
  if (required && !id) throw clientError(`invalid_${name}`, `${name} is required.`, 400);
  if (id && !/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw clientError(`invalid_${name}`, `${name} is invalid.`, 400);
  return id;
}

function boundedText(value, name, maxLength, required) {
  const text = String(value || '').trim();
  if (required && !text) throw clientError(`invalid_${name}`, `${name} is required.`, 400);
  if (text.length > maxLength) throw clientError(`invalid_${name}`, `${name} must be <= ${maxLength} characters.`, 400);
  return text;
}

function optionalPartIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 999) throw clientError('invalid_part_index', 'part_index is invalid.', 400);
  return number;
}

function optionalProgress(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) throw clientError('invalid_progress_pct', 'progress_pct must be an integer from 0 to 100.', 400);
  return number;
}

function mutationKey(action, supplied) {
  const seed = String(supplied || `uuid:${crypto.randomUUID()}`).trim();
  const compact = seed.length <= 90 ? seed : `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
  return `books-mcp:${action}:${compact}`.slice(0, 120);
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function clientError(code, message, status = 400, payload = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.payload = payload;
  return error;
}

module.exports = { createBooksClient, mutationKey, normalizeUiPath };
