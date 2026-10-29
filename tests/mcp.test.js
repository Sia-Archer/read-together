'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { TOOLS, callTool, createMcpServer } = require('../server/mcp/server');

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function withServer(client, fn) {
  const server = createMcpServer({ client, accessToken: 'secret', requireAuth: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(base, payload, token = 'secret') {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
}

test('Books MCP exposes the seven bounded co-reading tools', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'see_current_reading',
    'read_book_position',
    'read_shared_line',
    'reply_to_shared_line',
    'leave_margin_note',
    'search_read_text',
    'see_library_overview'
  ]);
});

test('book reading uses only a title and an optional whole-book progress', async () => {
  const calls = [];
  const client = {
    async readBookPosition(args) { calls.push(args); return { title: '示例书', progressPct: 10, text: '一小段' }; }
  };
  const result = await callTool('read_book_position', { book_title: '示例书', progress_pct: 10 }, {}, client);
  assert.equal(result.progressPct, 10);
  assert.deepEqual(calls, [{ book_title: '示例书', progress_pct: 10 }]);
  const schema = TOOLS.find((tool) => tool.name === 'read_book_position').inputSchema;
  assert.deepEqual(schema.required, ['book_title']);
  assert.equal(schema.properties.chapter, undefined);
  assert.equal(schema.properties.page, undefined);
});

test('MCP requires bearer auth', async () => {
  await withServer({}, async (base) => {
    const response = await post(base, rpc('tools/list', {}), 'wrong');
    assert.equal(response.status, 401);
  });
});

test('tool calls preserve normal reply and page-margin action as separate operations', async () => {
  const calls = [];
  const client = {
    async readSharedLine(args) { calls.push(['read', args]); return { selection: { selectionId: 'line-1', quote: '一句话' } }; },
    async replyToSharedLine(args, context) { calls.push(['reply', args, context]); return { ok: true }; }
  };
  await withServer(client, async (base) => {
    let response = await post(base, rpc('tools/call', { name: 'read_shared_line', arguments: { selection_id: 'line-1' } }, 7));
    let body = await response.json();
    assert.equal(body.result.isError, undefined);
    response = await post(base, rpc('tools/call', { name: 'reply_to_shared_line', arguments: { selection_id: 'line-1', text: '我在。', reply_id: 'reply-1', part_index: 0, final: false } }, 8));
    body = await response.json();
    assert.equal(body.result.isError, undefined);
    assert.equal(body.result.content[0].text, JSON.stringify({ ok: true }, null, 2));
  });
  assert.deepEqual(calls[0], ['read', { selection_id: 'line-1' }]);
  assert.deepEqual(calls[1][0], 'reply');
  assert.equal(calls[1][1].text, '我在。');
  assert.equal(calls[1][1].reply_id, 'reply-1');
  assert.equal(calls[1][1].part_index, 0);
  assert.equal(calls[1][1].final, false);
  assert.equal(calls[1][2].requestId, 8);
});

test('page reply schema supports real sentence-by-sentence delivery', () => {
  const tool = TOOLS.find((item) => item.name === 'reply_to_shared_line');
  assert.match(tool.description, /同一条页边对话/);
  assert.equal(tool.inputSchema.properties.final.type, 'boolean');
  assert.equal(tool.inputSchema.properties.part_index.minimum, 0);
});

test('write tools keep their model-visible receipt compact', async () => {
  const calls = [];
  const client = {
    async leaveMarginNote(args) { calls.push(args); return { ok: true, annotation: { id: 'hidden' } }; }
  };
  const result = await callTool('leave_margin_note', { book_id: 'book-1', quote: '一句', comment: '一条批注' }, {}, client);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
});
