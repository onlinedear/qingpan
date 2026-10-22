// 服务端公共守卫：IP 限流 + 统一 JSON 响应。
// 说明：这是每个 Worker 实例内存里的限流，挡得住普通刷接口，挡不住分布式攻击。
// 正式上线建议在 Cloudflare 后台为 /api/* 再配一条 Rate Limiting 规则作为第二道防线。

const buckets = new Map();

/** 固定窗口限流：每个 key 每 windowMs 最多 max 次 */
export function rateLimit(key, { max = 30, windowMs = 60_000, now = Date.now() } = {}) {
  const b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
    return { ok: true, remaining: max - 1 };
  }
  b.count++;
  return { ok: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: Math.ceil((b.start + windowMs - now) / 1000) };
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export function guard(request, scope, opts) {
  const r = rateLimit(`${scope}:${clientIp(request)}`, opts);
  if (!r.ok) return json({ error: '请求太频繁，请稍后再试' }, 429, { 'retry-after': String(r.retryAfter) });
  return null;
}

/** 只接受同源请求，减少别的网站直接拿我们的接口当免费代理 */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // 非浏览器或同源 GET 可能不带 Origin
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

export function _resetForTest() { buckets.clear(); }
