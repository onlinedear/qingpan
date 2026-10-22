// GET /api/amap?action=geo|regeo|weather|walk&...  → 高德 Web 服务 API
// Key 只在服务端环境变量 AMAP_KEY 里，前端拿不到。只开放 4 个只读查询。
import { guard, json, sameOrigin } from '../../lib/guard.js';

const BASE = 'https://restapi.amap.com/v3';
const LNGLAT = /^-?\d{1,3}(\.\d{1,8})?,-?\d{1,2}(\.\d{1,8})?$/;
const ADCODE = /^\d{6}$/;

const cache = new Map();

/** 把前端参数翻译成高德请求；参数不合法返回 { error } */
export function buildRequest(action, q) {
  switch (action) {
    case 'geo': {
      const address = String(q.get('address') ?? '').trim().slice(0, 80);
      if (!address) return { error: '缺少地址' };
      const city = String(q.get('city') ?? '').trim().slice(0, 20);
      return { path: '/geocode/geo', params: { address, ...(city ? { city } : {}) }, ttl: 86400e3 };
    }
    case 'regeo': {
      const location = String(q.get('location') ?? '');
      if (!LNGLAT.test(location)) return { error: '坐标格式应为 经度,纬度' };
      // 坐标保留 3 位小数（约百米）再查，既够用又不精确定位用户
      const coarse = location.split(',').map((n) => Number(n).toFixed(3)).join(',');
      return { path: '/geocode/regeo', params: { location: coarse }, ttl: 3600e3 };
    }
    case 'weather': {
      const city = String(q.get('city') ?? '');
      if (!ADCODE.test(city)) return { error: '城市应为 6 位行政区编码' };
      return { path: '/weather/weatherInfo', params: { city, extensions: 'base' }, ttl: 1800e3 };
    }
    case 'walk': {
      const origin = String(q.get('origin') ?? '');
      const destination = String(q.get('destination') ?? '');
      if (!LNGLAT.test(origin) || !LNGLAT.test(destination)) return { error: '坐标格式应为 经度,纬度' };
      return { path: '/direction/walking', params: { origin, destination }, ttl: 600e3 };
    }
    default:
      return { error: `不支持的操作：${action}` };
  }
}

/** 只挑前端需要的字段返回，不把高德原始响应整个透出去 */
export function pick(action, data) {
  if (String(data?.status) !== '1') return { error: data?.info || '高德接口返回失败' };
  switch (action) {
    case 'geo': {
      const g = data.geocodes?.[0];
      return g ? { location: g.location, adcode: g.adcode, city: [].concat(g.city || g.province)[0], formatted: g.formatted_address } : { error: '没找到这个地址' };
    }
    case 'regeo': {
      const c = data.regeocode?.addressComponent ?? {};
      return { adcode: c.adcode, city: [].concat(c.city || c.province)[0], district: c.district, formatted: data.regeocode?.formatted_address };
    }
    case 'weather': {
      const w = data.lives?.[0];
      return w ? { city: w.city, text: w.weather, temp: Number(w.temperature), humidity: Number(w.humidity), reportTime: w.reporttime } : { error: '暂无天气数据' };
    }
    case 'walk': {
      const p = data.route?.paths?.[0];
      if (!p) return { error: '没规划出步行路线' };
      const polyline = (p.steps ?? []).map((s) => s.polyline).filter(Boolean).join(';');
      return { distance: Number(p.distance), duration: Number(p.duration), polyline };
    }
  }
  return { error: '未知操作' };
}

export async function handle(request, env, { fetchImpl = fetch } = {}) {
  if (request.method !== 'GET') return json({ error: '只支持 GET' }, 405);
  if (!sameOrigin(request)) return json({ error: '不允许跨站调用' }, 403);
  const limited = guard(request, 'amap', { max: 30 });
  if (limited) return limited;
  if (!env.AMAP_KEY) return json({ error: '站点还没有配置高德 Key', demo: true }, 503);

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? '';
  const req = buildRequest(action, url.searchParams);
  if (req.error) return json({ error: req.error }, 400);

  const qs = new URLSearchParams({ ...req.params, output: 'JSON' });
  const cacheKey = `${req.path}?${qs}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < req.ttl) return json({ ...hit.data, cached: true });

  qs.set('key', env.AMAP_KEY);
  let data;
  try {
    const res = await fetchImpl(`${BASE}${req.path}?${qs}`, { signal: AbortSignal.timeout(8000) });
    data = await res.json();
  } catch {
    return json({ error: '高德服务暂时连不上' }, 502);
  }
  const out = pick(action, data);
  if (out.error) return json(out, 502);
  cache.set(cacheKey, { data: out, at: Date.now() });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return json(out);
}

export const onRequest = ({ request, env }) => handle(request, env);
