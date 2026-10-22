// 数据层：优先走实时接口（/api/mcd、/api/amap），没配置或失败时回落到示意数据。
// 麦当劳 MCP 返回结构的解析在 mcd-adapter.js（按 2026-10-22 实测采样编写）。
import { DEMO_ITEMS, DEMO_STORE, DEMO_WEATHER } from './demo-data.js';
import { parseNutrition, parseMeals, parseStores, parsePrice } from './mcd-adapter.js';

const TOKEN_KEY = 'qingpan.userToken';
export const userToken = {
  get: () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  // 只存 sessionStorage：关掉标签页即清除，不进 localStorage、不上传到我们的服务器以外的地方
  set: (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {} },
};

let statusCache;
export async function status() {
  if (statusCache) return statusCache;
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    statusCache = r.ok ? await r.json() : { mcd: false, amap: false };
  } catch {
    statusCache = { mcd: false, amap: false };
  }
  return statusCache;
}

/** 把 MCP 的 tools/call 结果拆成 JS 对象：优先 structuredContent，其次 text 里的 JSON */
export function unwrap(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const texts = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  for (const t of texts) { try { return JSON.parse(t); } catch {} }
  return texts.join('\n') || null;
}

async function mcd(tool, args = {}) {
  const headers = { 'content-type': 'application/json' };
  const t = userToken.get();
  if (t) headers['x-user-token'] = t;
  const r = await fetch('/api/mcd', { method: 'POST', headers, body: JSON.stringify({ tool, args }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `请求失败 ${r.status}`), { status: r.status });
  if (data.result?.isError) throw new Error(String(unwrap(data.result) ?? '工具返回错误'));
  const out = unwrap(data.result);
  // 业务外壳 {success, code, message, data}：success=false 时把官方提示透给用户
  if (out && typeof out === 'object' && out.success === false) throw new Error(out.message || '麦当劳接口返回失败');
  return out;
}

async function amap(action, params) {
  const r = await fetch(`/api/amap?${new URLSearchParams({ action, ...params })}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}

// ---- 对外接口 ----
let nutritionCache;
export async function loadMenu(store) {
  const st = await status();
  if (!st.mcd || !store || store.code === 'demo') return { items: DEMO_ITEMS, demo: true };
  nutritionCache ??= mcd('list-nutrition-foods', {}).then(parseNutrition).catch((e) => { nutritionCache = null; throw e; });
  // 到店自取：beType=1 + orderType=1，不传 beCode（官方工具说明）
  const [raw, nut] = await Promise.all([
    mcd('query-meals', { storeCode: store.code, beType: 1, orderType: 1 }),
    nutritionCache.catch(() => []),
  ]);
  const { items } = parseMeals(raw, nut);
  return { items, demo: false };
}

/** 从地址里猜城市：「上海市黄浦区…」→「上海市」；猜不到返回空串 */
export function guessCity(address) {
  const m = String(address ?? '').match(/^(.{2,8}?(?:市|自治州|地区|盟))/);
  return m ? m[1] : '';
}

/** 按位置搜门店：searchType=2 + city + keyword，beType=1 到店自取 */
export async function findStores(keyword, city) {
  const st = await status();
  if (!st.mcd) return { stores: [DEMO_STORE], demo: true };
  const c = city || guessCity(keyword);
  if (!c) throw new Error('请先填写城市，例如「上海市」');
  const kw = String(keyword).replace(c, '').trim() || keyword;
  const stores = parseStores(await mcd('query-nearby-stores', { searchType: 2, city: c, keyword: kw, beType: 1 }));
  // 门店接口不给坐标（实测为 0），用高德按"城市+门店地址"补，供步行路线使用
  if (st.amap) {
    await Promise.all(stores.slice(0, 3).map(async (s) => {
      if (s.location) return;
      const g = await amap('geo', { address: `${c}${s.address}`, city: c }).catch(() => null);
      if (g?.location) s.location = g.location;
    }));
  }
  return { stores: stores.map((s) => ({ ...s, city: c })), demo: false };
}

export async function geocode(address) {
  const st = await status();
  if (!st.amap) return null;
  return amap('geo', { address });
}

export async function reverseGeocode(lng, lat) {
  const st = await status();
  if (!st.amap) return null;
  return amap('regeo', { location: `${lng.toFixed(6)},${lat.toFixed(6)}` });
}

export async function weather(adcode) {
  const st = await status();
  if (!st.amap || !adcode) return { ...DEMO_WEATHER, demo: true };
  return amap('weather', { city: adcode });
}

/** 步行路线；没有高德时用示意路线（一条带弯的线，距离用门店距离） */
export async function walkRoute(origin, dest, fallbackDistance = 650) {
  const st = await status();
  if (st.amap && origin && dest) return amap('walk', { origin, destination: dest });
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(`${(t * 0.006).toFixed(6)},${(Math.sin(t * Math.PI * 1.3) * 0.0015 + t * 0.003).toFixed(6)}`);
  }
  return { distance: fallbackDistance, duration: Math.round(fallbackDistance / 1.2), polyline: pts.join(';'), demo: true };
}

export async function verifyPrice(store, tray) {
  const st = await status();
  if (!st.mcd || store?.code === 'demo') return null;
  try {
    const r = await mcd('calculate-price', {
      storeCode: store.code, beType: 1, orderType: 1,
      items: tray.map((i) => ({ productCode: i.code, quantity: 1 })),
    });
    return parsePrice(r); // 单位：分 → 元
  } catch {
    return null;
  }
}
