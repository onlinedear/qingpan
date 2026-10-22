// GET /api/amap?action=geo|regeo|weather|walk&...  → 腾讯地图 WebService API（+ open-meteo 免费天气）
// 路由名保留 amap 以免动前端；内部已全量切换到腾讯地图。
// Key 只在服务端环境变量里，前端拿不到。只开放这 4 个只读查询。
//   TMAP_WEB_KEY  腾讯地图 WebService Key（必填）
//   TMAP_SK       WebService 签名密钥（可选；控制台开了「签名校验」才需要）
// 腾讯坐标顺序是「纬度,纬度」(lat,lng)，和高德相反——本文件统一「前端传 lng,lat，内部转腾讯 lat,lng」。
import { createHash } from 'node:crypto';
import { guard, json, sameOrigin } from '../../lib/guard.js';

const TMAP = 'https://apis.map.qq.com';
const METEO = 'https://api.open-meteo.com/v1/forecast';
const LNGLAT = /^-?\d{1,3}(\.\d{1,8})?,-?\d{1,2}(\.\d{1,8})?$/;

const cache = new Map();

/** 腾讯 WebService 签名 URL：有 SK 就按字母序拼参数 + path + sk 算 md5，无 SK 走明文 key */
export function signTmap(path, params, key, sk) {
  const all = { ...params, key };
  const keys = Object.keys(all).sort();
  const qs = keys.map((k) => `${k}=${all[k]}`).join('&'); // 逗号/括号保持原样，腾讯要求不编码
  if (!sk) return `${TMAP}${path}?${qs}`;
  const sig = createHash('md5').update(`${path}?${qs}${sk}`).digest('hex');
  return `${TMAP}${path}?${qs}&sig=${sig}`;
}

/** 腾讯步行路线的 polyline 是差分压缩的坐标数组（值均 ×1e6）。
 *  先按 a[i]=a[i-2]+a[i]（i≥2）还原整数序列，输出时整体 /1e6 得到真实经纬度。
 *  腾讯存 lat,lng，前端要 lng,lat。 */
export function decodeTencentPolyline(coors) {
  if (!Array.isArray(coors) || coors.length < 4) return '';
  const a = coors.slice();
  for (let i = 2; i < a.length; i++) a[i] = a[i - 2] + a[i];
  const pts = [];
  for (let i = 0; i + 1 < a.length; i += 2) pts.push(`${(a[i + 1] / 1e6).toFixed(6)},${(a[i] / 1e6).toFixed(6)}`);
  return pts.join(';');
}

/** 把前端参数翻译成腾讯/天气请求；参数不合法返回 { error } */
export function buildRequest(action, q) {
  switch (action) {
    case 'geo': {
      const address = String(q.get('address') ?? '').trim().slice(0, 80);
      if (!address) return { error: '缺少地址' };
      return { kind: 'tmap', path: '/ws/geocoder/v1', params: { address }, ttl: 86400e3 };
    }
    case 'regeo': {
      const location = String(q.get('location') ?? '');
      if (!LNGLAT.test(location)) return { error: '坐标格式应为 经度,纬度' };
      // 坐标粗化到 3 位小数（约百米）再查，够用又不精确暴露用户位置
      const [lng, lat] = location.split(',').map((n) => Number(n).toFixed(3));
      return { kind: 'tmap', path: '/ws/geocoder/v1', params: { location: `${lat},${lng}`, get_poi: '1' }, ttl: 3600e3 };
    }
    case 'weather': {
      const location = String(q.get('location') ?? '');
      if (!LNGLAT.test(location)) return { error: '坐标格式应为 经度,纬度' };
      const [lng, lat] = location.split(',').map((n) => Number(n).toFixed(3));
      return { kind: 'meteo', params: { latitude: lat, longitude: lng }, ttl: 1800e3 };
    }
    case 'walk': {
      const origin = String(q.get('origin') ?? '');
      const destination = String(q.get('destination') ?? '');
      if (!LNGLAT.test(origin) || !LNGLAT.test(destination)) return { error: '坐标格式应为 经度,纬度' };
      const [ox, oy] = origin.split(',');
      const [dx, dy] = destination.split(',');
      return { kind: 'tmap', path: '/ws/direction/v1/walking', params: { from: `${oy},${ox}`, to: `${dy},${dx}` }, ttl: 600e3 };
    }
    default:
      return { error: `不支持的操作：${action}` };
  }
}

// WMO 天气代码 → 中文 + 是否降水（open-meteo 用 WMO code 表示天气）
const WMO = [
  [[0], '晴'], [[1, 2], '多云'], [[3], '阴'],
  [[45, 48], '雾'],
  [[51, 53, 55, 56, 57], '小雨'], [[61, 63, 65, 66, 67, 80, 81, 82], '雨'],
  [[71, 73, 75, 77, 85, 86], '雪'],
  [[95, 96, 99], '雷雨'],
];
function wmoText(code) {
  for (const [codes, text] of WMO) if (codes.includes(code)) return text;
  return '多云';
}

/** 只挑前端需要的字段返回，不把上游原始响应整个透出去 */
export function pick(action, data) {
  // 天气走 open-meteo：没有 status 字段，直接看 current
  if (action === 'weather') {
    const c = data?.current;
    if (!c || !Number.isFinite(Number(c.temperature_2m))) return { error: '暂无天气数据' };
    const code = Number(c.weather_code);
    return { city: '', text: wmoText(code), temp: Math.round(Number(c.temperature_2m)), humidity: Number(c.relative_humidity_2m) || undefined };
  }
  // 腾讯：status===0 成功，非 0 为错误（status 可能是数字 0）
  if (Number(data?.status) !== 0) return { error: data?.message || '腾讯地图接口返回失败' };
  switch (action) {
    case 'geo': {
      const r = data.result ?? {};
      const loc = r.location ?? {};
      const ac = r.address_components ?? {};
      if (!Number.isFinite(Number(loc.lng))) return { error: '没找到这个地址' };
      return {
        location: `${loc.lng},${loc.lat}`,
        adcode: ac.adcode ?? r.ad_info?.adcode ?? '',
        city: ac.city || ac.province || '',
        formatted: r.title || r.address || '',
      };
    }
    case 'regeo': {
      const r = data.result ?? {};
      const ac = r.address_component ?? {};
      const str = (v) => (typeof v === 'string' && v ? v : undefined);
      const city = str(ac.city) ?? str(ac.province);
      // 门店搜索关键词候选：最近 POI/商圈 → 街道 → 区
      const keywords = [
        str(r.pois?.[0]?.title),
        str(r.formatted_addresses?.recommend),
        str(ac.street),
        str(ac.district),
      ].filter((v, i, a) => v && a.indexOf(v) === i);
      return {
        adcode: str(r.ad_info?.adcode),
        city,
        district: str(ac.district),
        keywords,
        formatted: str(r.formatted_addresses?.recommend) ?? str(r.address),
      };
    }
    case 'walk': {
      const route = data.result?.routes?.[0];
      if (!route) return { error: '没规划出步行路线' };
      return { distance: Number(route.distance), duration: Number(route.duration) * 60, polyline: decodeTencentPolyline(route.polyline) };
    }
  }
  return { error: '未知操作' };
}

export async function handle(request, env, { fetchImpl = fetch } = {}) {
  if (request.method !== 'GET') return json({ error: '只支持 GET' }, 405);
  if (!sameOrigin(request)) return json({ error: '不允许跨站调用' }, 403);
  const limited = guard(request, 'amap', { max: 30 });
  if (limited) return limited;

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? '';
  const req = buildRequest(action, url.searchParams);
  if (req.error) return json({ error: req.error }, 400);

  // 腾讯接口需要 Key；天气走 open-meteo 不需要
  if (req.kind === 'tmap' && !env.TMAP_WEB_KEY) return json({ error: '站点还没有配置腾讯地图 Key', demo: true }, 503);

  const cacheKey = `${action}:${JSON.stringify(req.params)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < req.ttl) return json({ ...hit.data, cached: true });

  let upstreamUrl;
  if (req.kind === 'meteo') {
    const qs = new URLSearchParams({ ...req.params, current: 'temperature_2m,relative_humidity_2m,weather_code', timezone: 'auto' });
    upstreamUrl = `${METEO}?${qs}`;
  } else {
    upstreamUrl = signTmap(req.path, { ...req.params, output: 'json' }, env.TMAP_WEB_KEY, env.TMAP_SK);
  }

  let data;
  try {
    const res = await fetchImpl(upstreamUrl, { signal: AbortSignal.timeout(8000) });
    data = await res.json();
  } catch {
    return json({ error: '地图服务暂时连不上' }, 502);
  }
  const out = pick(action, data);
  if (out.error) return json(out, 502);
  cache.set(cacheKey, { data: out, at: Date.now() });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return json(out);
}

export const onRequest = ({ request, env }) => handle(request, env);
