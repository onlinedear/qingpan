// POST /api/mcd  { tool, args }  → 转发到麦当劳中国 MCP
//
// 两种身份：
//   体验模式：用站点主人的 MCD_MCP_TOKEN（环境变量），只放行与个人账户无关的公共工具。
//   个人模式：访客在请求头 X-User-Token 带上自己的 Token，额外放行查自己的券/积分。
// 任何模式下都不放行写操作（下单、领券、兑换、改地址）。
import { McpClient, McpError } from '../../scripts/mcp-client.mjs';
import { guard, json, sameOrigin } from '../../lib/guard.js';

export const PUBLIC_TOOLS = new Set([
  'now-time-info',
  'list-nutrition-foods',
  'query-nearby-stores',
  'query-meals',
  'query-meal-detail',
  'calculate-price',
  'campaign-calendar',
]);
export const PERSONAL_TOOLS = new Set(['query-store-coupons', 'query-my-coupons', 'available-coupons', 'query-my-account']);

// 实例级缓存：复用握手好的会话；公共、无个人信息的结果短时缓存，省限额
const sessions = new Map();
const cache = new Map();
const CACHE_TTL = { 'list-nutrition-foods': 6 * 3600e3, 'campaign-calendar': 3600e3, 'query-meals': 600e3, 'query-meal-detail': 600e3, 'query-nearby-stores': 600e3 };

/** 会话缓存键：完整 Token 的 SHA-256。不能只取尾部字符，否则两位访客的 Token 尾部相同时会串号 */
export async function sessionKey(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 访客 Token 只做格式校验，不落盘、不写日志 */
export const validUserToken = (t) => /^[A-Za-z0-9._~+/=-]{16,256}$/.test(t);

async function client(token, url, fetchImpl) {
  const key = await sessionKey(token);
  const hit = sessions.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return { c: hit.c, key };
  const c = new McpClient({ token, url, fetchImpl });
  await c.initialize({ name: 'qingpan-web', version: '0.1.0' });
  sessions.set(key, { c, at: Date.now() });
  if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
  return { c, key };
}

/**
 * calculate-price 会套用 Token 主人账号的个人权益（实测返回了"员工卡"折扣和权益余额）。
 * 体验模式用的是站点主人的 Token，所以只回传原价和商品小计，个人折扣与余额一律不出服务器。
 */
export function sanitizePublic(tool, result) {
  if (tool !== 'calculate-price' || !result) return result;
  let parsed;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  try { parsed = result.structuredContent ?? JSON.parse(text); } catch { return { content: [{ type: 'text', text: '{}' }] }; }
  const d = parsed?.data ?? {};
  const safe = {
    success: parsed?.success,
    code: parsed?.code,
    data: {
      originalPrice: d.originalPrice ?? d.productOriginalPrice,
      productOriginalPrice: d.productOriginalPrice,
      productList: (d.productList ?? []).map((p) => ({ productCode: p.productCode, productName: p.productName, quantity: p.quantity, originalSubtotal: p.originalSubtotal })),
      publicPrice: true,
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
}

export async function handle(request, env, { fetchImpl } = {}) {
  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405);
  if (!sameOrigin(request)) return json({ error: '不允许跨站调用' }, 403);
  const limited = guard(request, 'mcd', { max: 40 });
  if (limited) return limited;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是 JSON' }, 400); }
  const tool = String(body?.tool ?? '');
  const args = body?.args && typeof body.args === 'object' ? body.args : {};

  const userToken = request.headers.get('x-user-token')?.trim();
  if (userToken && !validUserToken(userToken)) return json({ error: 'Token 格式不对，请从 open.mcd.cn/mcp 控制台重新复制' }, 400);
  const personal = Boolean(userToken);
  const allowed = PUBLIC_TOOLS.has(tool) || (personal && PERSONAL_TOOLS.has(tool));
  if (!allowed) {
    return json({ error: PERSONAL_TOOLS.has(tool) ? '这个功能需要填写你自己的 MCP Token' : `不支持的工具：${tool}` }, 403);
  }

  const token = userToken || env.MCD_MCP_TOKEN;
  if (!token) return json({ error: '站点没有配置 MCP Token，请填写你自己的 Token', demo: true }, 503);

  // 只有站点 Token 的公共结果才缓存；个人 Token 的结果永不缓存
  const cacheKey = !personal && CACHE_TTL[tool] ? `${tool}:${JSON.stringify(args)}` : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL[tool]) return json({ result: hit.result, cached: true });
  }

  try {
    let { c, key } = await client(token, env.MCD_MCP_URL, fetchImpl);
    let result;
    try {
      result = await c.callTool(tool, args);
    } catch (e) {
      // 会话过期时重新握手一次
      if (e instanceof McpError && (e.status === 404 || e.status === 400)) {
        sessions.delete(key);
        ({ c } = await client(token, env.MCD_MCP_URL, fetchImpl));
        result = await c.callTool(tool, args);
      } else throw e;
    }
    if (!personal) result = sanitizePublic(tool, result);
    if (cacheKey && !result?.isError) {
      cache.set(cacheKey, { result, at: Date.now() });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return json({ result });
  } catch (e) {
    const status = e instanceof McpError && e.status ? (e.status === 401 && personal ? 401 : 502) : 502;
    // 错误信息里不带 Token；站点 Token 失效对访客只说"服务暂不可用"
    const msg = personal ? e.message : e?.status === 401 ? '服务暂不可用，请稍后再试' : e.message;
    return json({ error: msg, hint: personal ? e.hint : undefined }, status);
  }
}

export const onRequest = ({ request, env }) => handle(request, env);
export function _resetForTest() { sessions.clear(); cache.clear(); }
