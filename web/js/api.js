// 数据层：只用实时接口（/api/mcd 麦当劳 MCP、/api/amap 腾讯地图 + open-meteo 天气），没有任何示意数据。
// 麦当劳 MCP 返回结构的解析在 mcd-adapter.js（按 2026-10-22 实测采样编写）。
import { parseNutrition, parseMeals, parseStores, parsePrice, parseStoreCoupons, couponsForTray } from './mcd-adapter.js';

const TOKEN_KEY = 'qingpan.userToken';
export const userToken = {
  get: () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  // 只存 sessionStorage：关掉标签页即清除，不进 localStorage
  set: (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {} },
};

/** 能力不可用时抛这个错，界面据此显示对应的引导，而不是假数据 */
export class Unavailable extends Error {
  constructor(what, message) { super(message); this.name = 'Unavailable'; this.what = what; }
}

let statusCache;
/** 站点能力 + 访客自己的 Token：访客填了 Token 就算站点没配，也能查实时数据 */
export async function status() {
  const st = await siteStatus();
  return { ...st, mcd: st.mcd || Boolean(userToken.get()), mine: Boolean(userToken.get()) };
}
async function siteStatus() {
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
  const st = await status();
  if (!st.mcd) throw new Unavailable('mcd', '需要麦当劳 MCP Token 才能查询门店和菜单');
  const headers = { 'content-type': 'application/json' };
  const t = userToken.get();
  if (t) headers['x-user-token'] = t;
  const r = await fetch('/api/mcd', { method: 'POST', headers, body: JSON.stringify({ tool, args }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 访客自己的 Token 失效：清掉并让界面提示重填
    if (t && (r.status === 401 || r.status === 400)) { userToken.set(''); dispatchEvent(new CustomEvent('qingpan:token-invalid', { detail: data.error })); }
    if (r.status === 503 && data.demo) throw new Unavailable('mcd', '需要麦当劳 MCP Token 才能查询门店和菜单');
    throw Object.assign(new Error(data.error || `请求失败 ${r.status}`), { status: r.status });
  }
  if (data.result?.isError) throw new Error(String(unwrap(data.result) ?? '工具返回错误'));
  const out = unwrap(data.result);
  // 业务外壳 {success, code, message, data}：success=false 时把官方提示透给用户
  if (out && typeof out === 'object' && out.success === false) throw new Error(out.message || '麦当劳接口返回失败');
  return out;
}

async function amap(action, params) {
  const st = await status();
  if (!st.amap) throw new Unavailable('amap', '站点还没有配置腾讯地图服务');
  const r = await fetch(`/api/amap?${new URLSearchParams({ action, ...params })}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}

// ---- 对外接口 ----
let nutritionCache;
export async function loadMenu(store) {
  nutritionCache ??= mcd('list-nutrition-foods', {}).then(parseNutrition).catch((e) => { nutritionCache = null; throw e; });
  // 到店自取：beType=1 + orderType=1，不传 beCode（官方工具说明）
  const [raw, nut] = await Promise.all([
    mcd('query-meals', { storeCode: store.code, beType: 1, orderType: 1 }),
    nutritionCache.catch(() => []),
  ]);
  return parseMeals(raw, nut).items;
}

// 省/自治区/直辖市前缀：解析城市前先剥掉，避免把「江苏省」当成城市。
// 自治区按常见简称列（内蒙古/广西/西藏/宁夏/新疆），直辖市也在这里剥前缀。
// 城市解析（parseCity/guessCity）与城市名表现在住在 mcd-adapter.js（纯函数，网页 + Node 脚本共用）。
export { parseCity, guessCity } from './mcd-adapter.js';
import { parseCity } from './mcd-adapter.js';

/**
 * 按位置搜门店：searchType=2 + city + keyword，beType=1 到店自取。
 * keywords 可以给多个候选（如 楼宇名、街道名、区名），依次尝试直到搜到门店。
 */
export async function findStores(keywords, city) {
  const list = [].concat(keywords).map((k) => String(k ?? '').trim()).filter(Boolean);
  const parsed = parseCity(list[0]);
  const c = city || parsed.city;
  if (!c) throw new Error('请写上城市，例如「上海市人民广场」');
  let stores = [];
  for (const k of list) {
    // 每个候选都单独解析一次，剥掉其中的省/市前缀，剩下的才是定位关键词
    const kw = parseCity(k).keyword || k.replace(c, '').trim() || k;
    stores = parseStores(await mcd('query-nearby-stores', { searchType: 2, city: c, keyword: kw, beType: 1 }));
    if (stores.length) break;
  }
  return stores.map((s) => ({ ...s, city: c }));
}

/** 门店接口不给坐标（实测为 0），用腾讯按"城市+门店地址"补，供步行路线使用 */
export async function locateStore(store) {
  if (store.location) return store.location;
  const g = await amap('geo', { address: `${store.city ?? ''}${store.address}` }).catch(() => null);
  if (g?.location) store.location = g.location;
  return store.location;
}

export const geocode = (address) => amap('geo', { address });
export const reverseGeocode = (lng, lat) => amap('regeo', { location: `${lng.toFixed(6)},${lat.toFixed(6)}` });
// 天气按坐标查（腾讯 WebService 无天气接口，服务端走 open-meteo），location 形如「经度,纬度」
export const weather = (location) => amap('weather', { location });
export const walkRoute = (origin, dest) => amap('walk', { origin, destination: dest });

/** 用访客 Token 做一次最轻的查询（当前时间，不含个人信息），确认 Token 可用 */
export async function checkUserToken() {
  await mcd('now-time-info', {});
}

export async function verifyPrice(store, tray) {
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

/**
 * 查当前门店可用券，并挑出这盘里用得上的（纯只读）。
 * 只在个人模式（填了自己 Token）可用；体验模式/未填 Token 直接返回空，不打上游。
 * 到店自取：beType=1 + orderType=1，不传 beCode。
 */
export async function storeCoupons(store, tray) {
  if (!userToken.get()) return { all: [], usable: [] }; // 券是个人数据，没自己的 Token 不查
  try {
    const r = await mcd('query-store-coupons', { storeCode: store.code, beType: 1, orderType: 1 });
    const all = parseStoreCoupons(r);
    return { all, usable: couponsForTray(all, tray.map((i) => i.code)) };
  } catch {
    return { all: [], usable: [] };
  }
}
