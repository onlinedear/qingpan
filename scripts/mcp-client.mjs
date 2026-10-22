// 轻盘 · 麦当劳中国 MCP 最小客户端（Streamable HTTP，零依赖）
// 只依赖标准 fetch，Node 18+ 与 Cloudflare Pages Functions 都能直接用。
// 安全约定：Token 只从调用方传入，绝不写日志、绝不出现在错误信息里。

export const DEFAULT_URL = 'https://mcp.mcd.cn';
export const PROTOCOL_VERSION = '2025-06-18'; // 官方说明：仅支持 2025-06-18 及之前

// 只读白名单：文档明确为查询类、不改账户状态的工具。
// 不在白名单里的一律视为写操作（下单/领券/兑换/改地址等），未经用户确认不调用。
// 用白名单而不是黑名单：线上工具可能比文档多（有人实测 35 个），新增工具默认被拦住更安全。
export const READ_TOOLS = new Set([
  'now-time-info',
  'list-nutrition-foods',
  'query-nearby-stores',
  'delivery-query-addresses',
  'delivery-query-stores',
  'query-meal-assistance',
  'query-store-coupons',
  'query-meals',
  'query-meal-detail',
  'calculate-price',
  'query-order',
  'campaign-calendar',
  'available-coupons',
  'query-my-coupons',
  'query-my-account',
  'mall-points-products',
  'mall-product-detail',
]);

export const isReadTool = (name) => READ_TOOLS.has(name);

export class McpError extends Error {
  constructor(message, { status, code, hint } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const HTTP_HINTS = {
  401: 'Token 无效、已过期或未提供：检查环境变量 MCD_MCP_TOKEN，必要时去 open.mcd.cn/mcp 控制台重新生成',
  403: '无权访问该能力：确认账号已在控制台激活 MCP',
  404: '接入地址不对：应为 https://mcp.mcd.cn',
  429: '触发限流（每个 Token 每分钟 600 次）：降低调用频率',
};

/** 解析 SSE 文本，返回其中所有 JSON-RPC 消息 */
export function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* 忽略非 JSON 事件（如心跳） */
    }
  }
  return out;
}

export class McpClient {
  constructor({ url = DEFAULT_URL, token, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    if (!token) throw new McpError('缺少 MCP Token', { hint: HTTP_HINTS[401] });
    this.url = url;
    this.#token = token;
    // 不能直接存 globalThis.fetch 再用 this.fetch() 调：Cloudflare Workers 会报 Illegal invocation
    this.fetch = (...args) => fetchImpl(...args);
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.negotiated = null;
    this.nextId = 1;
  }

  #token;

  async #post(body) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.#token}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.negotiated) headers['MCP-Protocol-Version'] = this.negotiated;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new McpError(
        e?.name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : `网络错误：${e?.message ?? e}`,
        { hint: '检查网络、代理、DNS 或 TLS' },
      );
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok && res.status !== 202) {
      throw new McpError(`HTTP ${res.status}`, { status: res.status, hint: HTTP_HINTS[res.status] });
    }
    return res;
  }

  /** 发送 JSON-RPC 请求并等待对应 id 的响应 */
  async request(method, params) {
    const id = this.nextId++;
    const res = await this.#post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    const messages = type.includes('text/event-stream') ? parseSse(text) : text ? [JSON.parse(text)] : [];
    const msg = messages.find((m) => m && m.id === id);
    if (!msg) throw new McpError(`没有收到 ${method} 的响应`);
    if (msg.error) {
      throw new McpError(`JSON-RPC 错误 ${msg.error.code}：${msg.error.message}`, { code: msg.error.code });
    }
    return msg.result;
  }

  /** 发送通知（无 id，不等待结果） */
  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async initialize(clientInfo = { name: 'qingpan', version: '0.1.0' }) {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    this.negotiated = result?.protocolVersion || PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return result;
  }

  /** 拉取完整工具清单（自动翻页） */
  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : undefined);
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** 调用工具。写工具必须显式传 { allowWrite: true }，由上层在用户确认后才传。 */
  async callTool(name, args = {}, { allowWrite = false } = {}) {
    if (!isReadTool(name) && !allowWrite) {
      throw new McpError(`${name} 不在只读白名单，可能改动账户或产生消费，未经用户确认不允许调用`);
    }
    return this.request('tools/call', { name, arguments: args });
  }
}
