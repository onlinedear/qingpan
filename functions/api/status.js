// GET /api/status → 告诉前端哪些能力已配置（只返回 true/false，不透出任何 Key）
import { json } from '../../lib/guard.js';

export const onRequest = ({ env }) => json({ mcd: Boolean(env.MCD_MCP_TOKEN), amap: Boolean(env.AMAP_KEY) });
