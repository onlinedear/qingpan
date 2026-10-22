// 服务端代理的离线测试：假的麦当劳 MCP / 高德，不连网
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle as mcd, _resetForTest as resetMcd } from '../functions/api/mcd.js';
import { handle as amap, buildRequest, pick } from '../functions/api/amap.js';
import { _resetForTest as resetGuard, rateLimit } from '../lib/guard.js';

beforeEach(() => { resetMcd(); resetGuard(); });

const SITE_TOKEN = 'site-token-fake';
const env = { MCD_MCP_TOKEN: SITE_TOKEN };

function fakeMcp() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ auth: init.headers.Authorization, body });
    if (!('id' in body)) return new Response(null, { status: 202 });
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {} }
      : { content: [{ type: 'text', text: JSON.stringify({ ok: body.params?.name }) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const req = (body, headers = {}) => new Request('https://qingpan.example/api/mcd', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers }, body: JSON.stringify(body),
});

test('体验模式：公共工具用站点 Token 放行', async () => {
  const { calls, fetchImpl } = fakeMcp();
  const r = await mcd(req({ tool: 'query-meals', args: { storeCode: 'x' } }), env, { fetchImpl });
  assert.equal(r.status, 200);
  assert.ok(calls.every((c) => c.auth === `Bearer ${SITE_TOKEN}`));
});

test('体验模式：个人工具（查券/积分）被拒，且不发上游请求', async () => {
  const { calls, fetchImpl } = fakeMcp();
  for (const tool of ['query-my-coupons', 'query-my-account', 'query-store-coupons']) {
    const r = await mcd(req({ tool }), env, { fetchImpl });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /自己的 MCP Token/);
  }
  assert.equal(calls.length, 0);
});

test('任何模式：写操作一律拒绝', async () => {
  const { calls, fetchImpl } = fakeMcp();
  for (const tool of ['create-order', 'auto-bind-coupons', 'mall-create-order', 'delivery-create-address']) {
    assert.equal((await mcd(req({ tool }, { 'x-user-token': 'u' }), env, { fetchImpl })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('个人模式：用访客自己的 Token，结果不进缓存', async () => {
  const { calls, fetchImpl } = fakeMcp();
  const h = { 'x-user-token': 'user-token-fake' };
  assert.equal((await mcd(req({ tool: 'query-my-coupons' }, h), env, { fetchImpl })).status, 200);
  assert.ok(calls.every((c) => c.auth === 'Bearer user-token-fake'));
  const before = calls.length;
  await mcd(req({ tool: 'query-meals', args: {} }, h), env, { fetchImpl });
  await mcd(req({ tool: 'query-meals', args: {} }, h), env, { fetchImpl });
  assert.equal(calls.filter((c) => c.body.method === 'tools/call').length - calls.slice(0, before).filter((c) => c.body.method === 'tools/call').length, 2);
});

test('公共结果缓存：同参数第二次不打上游', async () => {
  const { calls, fetchImpl } = fakeMcp();
  await mcd(req({ tool: 'list-nutrition-foods' }), env, { fetchImpl });
  const r = await mcd(req({ tool: 'list-nutrition-foods' }), env, { fetchImpl });
  assert.equal((await r.json()).cached, true);
  assert.equal(calls.filter((c) => c.body.method === 'tools/call').length, 1);
});

test('体验模式：算价结果剔除站点主人的个人折扣和权益余额', async () => {
  const priced = { success: true, code: 200, data: { originalPrice: 2550, price: 1913, discount: 637, enjoyed: { promotionName: '员工卡', realDiscount: 7.5 }, enjoyable: { balance: 1350 }, productList: [{ productCode: '1100', productName: '巨无霸', quantity: 1, originalSubtotal: 2550, subtotal: 1913 }] } };
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    if (!('id' in b)) return new Response(null, { status: 202 });
    const result = b.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: JSON.stringify(priced) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  const pub = await (await mcd(req({ tool: 'calculate-price', args: {} }), env, { fetchImpl })).text();
  for (const leak of ['员工卡', '1913', '1350', 'discount', 'enjoy']) assert.ok(!pub.includes(leak), `体验模式不应返回 ${leak}`);
  assert.ok(pub.includes('2550'));
  // 个人模式：访客自己的权益，原样返回
  const own = await (await mcd(req({ tool: 'calculate-price', args: {} }, { 'x-user-token': 'u' }), env, { fetchImpl })).text();
  assert.ok(own.includes('1913'));
});

test('跨站请求被拒', async () => {
  const r = await mcd(req({ tool: 'query-meals' }, { origin: 'https://evil.example' }), env, fakeMcp());
  assert.equal(r.status, 403);
});

test('没配 Token 时返回 503 + demo 标记', async () => {
  const r = await mcd(req({ tool: 'query-meals' }), {}, fakeMcp());
  assert.equal(r.status, 503);
  assert.equal((await r.json()).demo, true);
});

test('响应里不出现站点 Token', async () => {
  const fetchImpl = async () => new Response('no', { status: 401 });
  const r = await mcd(req({ tool: 'query-meals' }), env, { fetchImpl });
  assert.ok(!(await r.text()).includes(SITE_TOKEN));
});

test('IP 限流', () => {
  for (let i = 0; i < 3; i++) assert.ok(rateLimit('k', { max: 3, now: 1000 }).ok);
  assert.equal(rateLimit('k', { max: 3, now: 1000 }).ok, false);
  assert.ok(rateLimit('k', { max: 3, now: 62_000 }).ok, '窗口过后恢复');
});

test('高德：参数校验', () => {
  const q = (o) => new URLSearchParams(o);
  assert.ok(buildRequest('walk', q({ origin: '121.47,31.23', destination: '121.48,31.24' })).path);
  assert.ok(buildRequest('walk', q({ origin: 'x', destination: '1,2' })).error);
  assert.ok(buildRequest('weather', q({ city: '31000' })).error);
  assert.ok(buildRequest('weather', q({ city: '310000' })).path);
  assert.ok(buildRequest('geo', q({})).error);
  assert.ok(buildRequest('drop-table', q({})).error);
  // 逆地理编码把坐标粗化到 3 位小数
  assert.equal(buildRequest('regeo', q({ location: '121.473701,31.230416' })).params.location, '121.474,31.230');
});

test('高德：只挑需要的字段', () => {
  const w = pick('weather', { status: '1', lives: [{ city: '上海', weather: '小雨', temperature: '14', humidity: '80', reporttime: 't' }] });
  assert.deepEqual(w, { city: '上海', text: '小雨', temp: 14, humidity: 80, reportTime: 't' });
  const walk = pick('walk', { status: '1', route: { paths: [{ distance: '800', duration: '600', steps: [{ polyline: '1,2;3,4' }, { polyline: '5,6' }] }] } });
  assert.deepEqual(walk, { distance: 800, duration: 600, polyline: '1,2;3,4;5,6' });
  assert.ok(pick('geo', { status: '0', info: 'INVALID_USER_KEY' }).error);
});

test('高德：Key 不出现在响应里，没配 Key 返回 503', async () => {
  const r0 = await amap(new Request('https://q.example/api/amap?action=weather&city=310000'), {});
  assert.equal(r0.status, 503);
  let upstream;
  const fetchImpl = async (u) => { upstream = u; return new Response(JSON.stringify({ status: '1', lives: [{ city: '上海', weather: '晴', temperature: '20' }] })); };
  const r = await amap(new Request('https://q.example/api/amap?action=weather&city=310000'), { AMAP_KEY: 'amap-secret' }, { fetchImpl });
  assert.equal(r.status, 200);
  assert.match(upstream, /key=amap-secret/);
  assert.ok(!(await r.text()).includes('amap-secret'));
});
