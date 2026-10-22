// GET /api/status → 告诉前端哪些能力已配置（只返回 true/false，不透出任何 Key）
// amap 字段现在表示「地图能力」：已切换到腾讯地图，有 TMAP_WEB_KEY 即可定位/找店
import { json } from '../../lib/guard.js';

export const onRequest = ({ env }) => json({ mcd: Boolean(env.MCD_MCP_TOKEN), amap: Boolean(env.TMAP_WEB_KEY) });
