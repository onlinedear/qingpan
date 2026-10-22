// 服务端代理的离线测试：假的麦当劳 MCP / 高德，不连网
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle as mcd, _resetForTest as resetMcd } from '../functions/api/mcd.js';
import { handle as amap, buildRequest, pick, signTmap, decodeTencentPolyline } from '../functions/api/amap.js';
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
    assert.equal((await mcd(req({ tool }, { 'x-user-token': 'user-token-fake-1234' }), env, { fetchImpl })).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('个人模式：用访客自己的 Token，结果不进缓存', async () => {
  const { calls, fetchImpl } = fakeMcp();
  const h = { 'x-user-token': 'user-token-fake-1234' };
  assert.equal((await mcd(req({ tool: 'query-my-coupons' }, h), env, { fetchImpl })).status, 200);
  assert.ok(calls.every((c) => c.auth === 'Bearer user-token-fake-1234'));
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
  const own = await (await mcd(req({ tool: 'calculate-price', args: {} }, { 'x-user-token': 'user-token-fake-1234' }), env, { fetchImpl })).text();
  assert.ok(own.includes('1913'));
});

test('两位访客的 Token 尾部相同也不会串用会话', async () => {
  const { calls, fetchImpl } = fakeMcp();
  const a = 'AAAAAAAA-same-tail-123456789012', b = 'BBBBBBBB-same-tail-123456789012';
  await mcd(req({ tool: 'query-meals', args: {} }, { 'x-user-token': a }), env, { fetchImpl });
  await mcd(req({ tool: 'query-meals', args: {} }, { 'x-user-token': b }), env, { fetchImpl });
  const callAuths = calls.filter((c) => c.body.method === 'tools/call').map((c) => c.auth);
  assert.deepEqual(callAuths, [`Bearer ${a}`, `Bearer ${b}`]);
});

test('访客 Token 格式不对直接拒绝，不发上游', async () => {
  const { calls, fetchImpl } = fakeMcp();
  for (const t of ['short', 'has space inside token here', 'x'.repeat(300)]) {
    assert.equal((await mcd(req({ tool: 'query-meals' }, { 'x-user-token': t }), env, { fetchImpl })).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('站点没配 Token 时，访客用自己的 Token 也能用全部公共功能', async () => {
  const { calls, fetchImpl } = fakeMcp();
  const r = await mcd(req({ tool: 'query-meals', args: {} }, { 'x-user-token': 'user-token-fake-1234' }), {}, { fetchImpl });
  assert.equal(r.status, 200);
  assert.ok(calls.every((c) => c.auth === 'Bearer user-token-fake-1234'));
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

test('腾讯：参数校验', () => {
  const q = (o) => new URLSearchParams(o);
  assert.ok(buildRequest('walk', q({ origin: '121.47,31.23', destination: '121.48,31.24' })).path);
  assert.ok(buildRequest('walk', q({ origin: 'x', destination: '1,2' })).error);
  assert.ok(buildRequest('weather', q({ location: 'x' })).error);
  assert.ok(buildRequest('weather', q({ location: '121.47,31.23' })).kind === 'meteo');
  assert.ok(buildRequest('geo', q({})).error);
  assert.ok(buildRequest('drop-table', q({})).error);
  // 逆地理编码把坐标粗化到 3 位小数，且转成腾讯的「纬度,经度」顺序
  assert.equal(buildRequest('regeo', q({ location: '121.473701,31.230416' })).params.location, '31.230,121.474');
  // 步行路线：前端 lng,lat → 腾讯 from/to 用 lat,lng
  const w = buildRequest('walk', q({ origin: '121.47,31.23', destination: '121.48,31.24' }));
  assert.equal(w.params.from, '31.23,121.47');
  assert.equal(w.params.to, '31.24,121.48');
});

test('腾讯：签名 URL —— 有 SK 算 md5 sig，无 SK 走明文', () => {
  const plain = signTmap('/ws/geocoder/v1', { location: '31.23,121.47' }, 'KEY123');
  assert.match(plain, /^https:\/\/apis\.map\.qq\.com\/ws\/geocoder\/v1\?/);
  assert.match(plain, /key=KEY123/);
  assert.ok(!plain.includes('sig='));
  const signed = signTmap('/ws/geocoder/v1', { location: '31.23,121.47' }, 'KEY123', 'SK456');
  assert.match(signed, /&sig=[a-f0-9]{32}$/);
});

test('腾讯：步行 polyline 差分解码成 lng,lat;…', () => {
  // 腾讯差分数组：从第 3 个起 a[i] = a[i-2] + a[i]/1e6；腾讯存 lat,lng，解出要转成 lng,lat
  const coors = [31230000, 121470000, 1000, 2000]; // 第二点 = (31.231, 121.472)
  const poly = decodeTencentPolyline(coors);
  assert.equal(poly, '121.470000,31.230000;121.472000,31.231000');
  assert.equal(decodeTencentPolyline([]), '');
  assert.equal(decodeTencentPolyline([1, 2]), '');
});

test('腾讯：逆地理编码给出城市和门店搜索关键词候选，空值不混进来', () => {
  const r = pick('regeo', { status: 0, result: {
    address: '江苏省南京市玄武区徐庄软件园',
    formatted_addresses: { recommend: '玄武区徐庄软件园' },
    address_component: { province: '江苏省', city: '南京市', district: '玄武区', street: '文澜路' },
    ad_info: { adcode: '320102' },
    pois: [{ title: '徐庄软件园' }, { title: '其他' }],
  } });
  assert.equal(r.city, '南京市');
  assert.equal(r.adcode, '320102');
  assert.equal(r.district, '玄武区');
  assert.deepEqual(r.keywords, ['徐庄软件园', '玄武区徐庄软件园', '文澜路', '玄武区']);
});

test('腾讯：geo 地理编码返回坐标与城市', () => {
  const g = pick('geo', { status: 0, result: {
    title: '人民广场', address: '上海市黄浦区人民广场',
    location: { lng: 121.4737, lat: 31.2304 },
    address_components: { city: '上海市', adcode: '310101' },
  } });
  assert.equal(g.location, '121.4737,31.2304');
  assert.equal(g.city, '上海市');
  assert.equal(g.adcode, '310101');
  assert.equal(g.formatted, '人民广场');
  assert.ok(pick('geo', { status: 311, message: 'KEY非法' }).error);
});

test('天气：open-meteo 的 WMO 码翻成中文，温度取整', () => {
  const w = pick('weather', { current: { temperature_2m: 14.3, relative_humidity_2m: 80, weather_code: 61 } });
  assert.deepEqual(w, { city: '', text: '雨', temp: 14, humidity: 80 });
  assert.equal(pick('weather', { current: { temperature_2m: 20, weather_code: 0 } }).text, '晴');
  assert.ok(pick('weather', { current: {} }).error);
  // walk：腾讯 duration 是分钟，转成秒给前端
  const walk = pick('walk', { status: 0, result: { routes: [{ distance: 800, duration: 10, polyline: [31230000, 121470000, 1000, 2000] }] } });
  assert.equal(walk.distance, 800);
  assert.equal(walk.duration, 600);
  assert.equal(walk.polyline, '121.470000,31.230000;121.472000,31.231000');
});

test('腾讯：Key 不出现在响应里，没配 Key 返回 503', async () => {
  const r0 = await amap(new Request('https://q.example/api/amap?action=geo&address=上海'), {});
  assert.equal(r0.status, 503);
  let upstream;
  const fetchImpl = async (u) => { upstream = u; return new Response(JSON.stringify({ status: 0, result: { title: '上海', location: { lng: 121.4, lat: 31.2 }, address_components: { city: '上海市', adcode: '310000' } } })); };
  const r = await amap(new Request('https://q.example/api/amap?action=geo&address=上海'), { TMAP_WEB_KEY: 'tmap-secret', TMAP_SK: 'sk-secret' }, { fetchImpl });
  assert.equal(r.status, 200);
  assert.match(upstream, /key=tmap-secret/);
  const body = await r.text();
  assert.ok(!body.includes('tmap-secret'));
  assert.ok(!body.includes('sk-secret'));
});

test('天气走 open-meteo 不需要腾讯 Key', async () => {
  let upstream;
  const fetchImpl = async (u) => { upstream = u; return new Response(JSON.stringify({ current: { temperature_2m: 18, relative_humidity_2m: 60, weather_code: 3 } })); };
  const r = await amap(new Request('https://q.example/api/amap?action=weather&location=121.47,31.23'), {}, { fetchImpl });
  assert.equal(r.status, 200);
  assert.match(upstream, /open-meteo\.com/);
  assert.equal((await r.json()).text, '阴');
});
