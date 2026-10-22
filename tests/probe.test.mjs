// 离线测试：用假 fetch 模拟麦当劳 MCP，不连网、不需要 Token。
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, parseSse } from '../scripts/mcp-client.mjs';
import { probe, toMarkdown } from '../scripts/probe-tools.mjs';

const FAKE_TOKEN = 'test-token-not-real';

const TOOLS_PAGE1 = [
  {
    name: 'query-nearby-stores',
    description: '查询附近门店',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: '地址' } },
      required: ['address'],
    },
  },
  { name: 'now-time-info', description: '当前时间', inputSchema: { type: 'object', properties: {} } },
];
const TOOLS_PAGE2 = [{ name: 'create-order', description: '下单', inputSchema: { type: 'object' } }];

/** 构造一个假的 MCP 服务端，记录所有请求 */
function fakeServer({ status = 200, sse = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    if (status !== 200) return new Response('denied', { status });
    if (!('id' in body)) return new Response(null, { status: 202 });

    let result;
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-mcd', version: '1' }, capabilities: {} };
    } else if (body.method === 'tools/list') {
      result = body.params?.cursor ? { tools: TOOLS_PAGE2 } : { tools: TOOLS_PAGE1, nextCursor: 'p2' };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: '2026-10-22' }] };
    }
    const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const headers = { 'mcp-session-id': 'sess-123' };
    return sse
      ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { ...headers, 'content-type': 'text/event-stream' } })
      : new Response(msg, { headers: { ...headers, 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('parseSse 解析多事件和多行 data，忽略非 JSON 心跳', () => {
  const text = 'data: {"id":1}\n\n: ping\n\ndata: {"id":\ndata: 2}\n\ndata: not-json\n\n';
  assert.deepEqual(parseSse(text), [{ id: 1 }, { id: 2 }]);
});

for (const sse of [true, false]) {
  test(`probe 完整链路（${sse ? 'SSE' : 'JSON'} 响应）：握手、翻页、只读标记`, async () => {
    const { calls, fetchImpl } = fakeServer({ sse });
    const { meta, summary } = await probe({ token: FAKE_TOKEN, fetchImpl });

    assert.equal(meta.protocolVersion, '2025-06-18');
    assert.equal(summary.length, 3, '应翻页拿到两页共 3 个工具');
    const stores = summary.find((t) => t.name === 'query-nearby-stores');
    assert.deepEqual(stores.params, [{ name: 'address', type: 'string', required: true, description: '地址' }]);
    assert.equal(stores.readOnly, true);
    assert.equal(summary.find((t) => t.name === 'create-order').readOnly, false);

    // 握手顺序：initialize → initialized 通知 → tools/list
    assert.deepEqual(calls.slice(0, 3).map((c) => c.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
    // 握手后的请求要带上 session id 和协议版本
    assert.equal(calls[1].headers['Mcp-Session-Id'], 'sess-123');
    assert.equal(calls[2].headers['MCP-Protocol-Version'], '2025-06-18');
    // 默认绝不调用任何工具
    assert.ok(!calls.some((c) => c.body.method === 'tools/call'), '默认不应发 tools/call');
  });
}

test('--smoke 只调用 now-time-info', async () => {
  const { calls, fetchImpl } = fakeServer();
  const { meta } = await probe({ token: FAKE_TOKEN, fetchImpl, smoke: true });
  const toolCalls = calls.filter((c) => c.body.method === 'tools/call');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].body.params.name, 'now-time-info');
  assert.equal(meta.smoke.ok, true);
});

test('401 翻译成可操作的建议，且错误信息不含 Token', async () => {
  const { fetchImpl } = fakeServer({ status: 401 });
  await assert.rejects(probe({ token: FAKE_TOKEN, fetchImpl }), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.status, 401);
    assert.match(e.hint, /MCD_MCP_TOKEN/);
    assert.ok(!JSON.stringify({ m: e.message, h: e.hint }).includes(FAKE_TOKEN));
    return true;
  });
});

test('429 限流有提示', async () => {
  const { fetchImpl } = fakeServer({ status: 429 });
  await assert.rejects(probe({ token: FAKE_TOKEN, fetchImpl }), (e) => e.status === 429 && /600/.test(e.hint));
});

test('不在白名单的工具（下单/领券/未知新工具）未经确认拒绝调用，且不发请求', async () => {
  const { calls, fetchImpl } = fakeServer();
  const c = new McpClient({ token: FAKE_TOKEN, fetchImpl });
  for (const name of ['create-order', 'auto-bind-coupons', 'mall-create-order', 'some-new-tool']) {
    await assert.rejects(c.callTool(name, {}), /白名单/);
  }
  assert.equal(calls.length, 0);
});

test('Token 不会被枚举或序列化出来', () => {
  const c = new McpClient({ token: FAKE_TOKEN, fetchImpl: async () => {} });
  assert.ok(!JSON.stringify(c).includes(FAKE_TOKEN));
  assert.ok(!Object.values(c).includes(FAKE_TOKEN));
});

test('缺少 Token 直接报错', () => {
  assert.throws(() => new McpClient({}), McpError);
});

test('fetch 以独立函数调用（Cloudflare Workers 要求 this 不能是客户端对象）', async () => {
  let seenThis = 'unset';
  const strict = async function () {
    seenThis = this;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json' } });
  };
  const c = new McpClient({ token: FAKE_TOKEN, fetchImpl: strict });
  await c.request('initialize', {});
  assert.ok(!(seenThis instanceof McpClient), 'fetch 不应以 McpClient 实例作为 this 被调用');
});

test('toMarkdown 生成表格并转义竖线', () => {
  const md = toMarkdown(
    [{ name: 'x', title: '', description: 'd', readOnly: false, params: [{ name: 'a', type: 'string', required: true, description: 'a|b' }] }],
    { probedAt: 't', protocolVersion: 'v' },
  );
  assert.match(md, /⚠️ 写操作/);
  assert.match(md, /a\\\|b/);
});
