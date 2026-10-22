// 营养成分表风格分享卡：浏览器本地 Canvas 绘制，不上传任何数据。
const W = 1080, H = 1620;
const INK = '#1B1915', PAPER = '#F4EFE4', CARD = '#FFFDF8', MUTED = '#6B6458', GOLD = '#F2B33D';
const SERIF = '"Songti SC","Noto Serif SC","Source Han Serif SC",serif';
const SANS = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const MONO = '"SF Mono",Menlo,Consolas,monospace';

function grain(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(27,25,21,.045)';
  for (let y = 0; y < H; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < W; x += 4) ctx.fillRect(x, y, 1, 1);
  ctx.restore();
}

function line(ctx, x1, y, x2, w) {
  ctx.fillStyle = INK;
  ctx.fillRect(x1, y - w / 2, x2 - x1, w);
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/**
 * @param {{tray:{name:string,kcal?:number}[], totals:{kcal:number,protein:number,fat:number,carb:number,sodium:number}, goal:{kcal:number,protein:number}, store?:string, date?:string, streak?:number, walkKcal?:number}} d
 * @returns {HTMLCanvasElement}
 */
export function drawCard(d, canvas = document.createElement('canvas')) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  grain(ctx);

  // 页眉
  ctx.fillStyle = INK; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 30px ${SERIF}`; ctx.fillText('轻 盘', 80, 120);
  ctx.font = `400 24px ${SANS}`; ctx.fillStyle = MUTED; ctx.textAlign = 'right';
  ctx.fillText(d.date ?? '', W - 80, 120); ctx.textAlign = 'left';

  // 标题带金色下划线
  ctx.font = `900 76px ${SERIF}`; ctx.fillStyle = INK;
  const title = '今天的托盘';
  const tw = ctx.measureText(title).width;
  ctx.fillStyle = GOLD; ctx.fillRect(80, 214, tw, 24);
  ctx.fillStyle = INK; ctx.fillText(title, 80, 230);
  ctx.font = `400 28px ${SANS}`; ctx.fillStyle = MUTED;
  ctx.fillText(fitText(ctx, `目标 ${d.goal.kcal} 千卡 · 蛋白质 ≥ ${d.goal.protein}g${d.store ? ' · ' + d.store : ''}`, W - 160), 80, 286);

  // 营养成分表
  const x = 80, r = W - 80, top = 340;
  const BOX = 900;
  ctx.fillStyle = CARD; ctx.fillRect(x, top, r - x, BOX);
  ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.strokeRect(x, top, r - x, BOX);
  const pad = 40, L = x + pad, R = r - pad;
  let y = top + 92;
  ctx.fillStyle = INK; ctx.font = `900 64px ${SANS}`; ctx.fillText('营养成分', L, y);
  y += 28; line(ctx, L, y, R, 18);

  y += 56; ctx.font = `500 30px ${SANS}`;
  ctx.fillText(`本餐 ${d.tray.length} 件`, L, y);
  y += 22; line(ctx, L, y, R, 3);

  y += 86; ctx.font = `900 60px ${SANS}`; ctx.fillText('能量', L, y);
  ctx.textAlign = 'right'; ctx.font = `800 72px ${MONO}`; ctx.fillText(String(d.totals.kcal), R, y); ctx.textAlign = 'left';
  y += 28; line(ctx, L, y, R, 10);

  const rows = [['蛋白质', `${d.totals.protein} g`], ['脂肪', `${d.totals.fat} g`], ['碳水化合物', `${d.totals.carb} g`], ['钠', `${d.totals.sodium} mg`]];
  for (const [k, v] of rows) {
    y += 64; ctx.font = `500 34px ${SANS}`; ctx.fillText(k, L, y);
    ctx.textAlign = 'right'; ctx.font = `700 34px ${MONO}`; ctx.fillText(v, R, y); ctx.textAlign = 'left';
    y += 22; line(ctx, L, y, R, 2);
  }

  // 托盘清单
  y += 58; ctx.font = `700 28px ${SANS}`; ctx.fillStyle = MUTED; ctx.fillText('托盘里有', L, y);
  ctx.fillStyle = INK;
  for (const it of d.tray.slice(0, 3)) {
    y += 52; ctx.font = `500 32px ${SANS}`;
    ctx.fillText(fitText(ctx, it.name, R - L - 180), L, y);
    ctx.textAlign = 'right'; ctx.font = `600 30px ${MONO}`;
    ctx.fillText(Number.isFinite(it.kcal) ? `${it.kcal} kcal` : '—', R, y); ctx.textAlign = 'left';
  }

  // 底部：进度条 + 徽章
  const by = top + BOX + 80;
  const pct = Math.min(d.totals.kcal / d.goal.kcal, 1);
  ctx.fillStyle = '#E6DFD1'; ctx.fillRect(80, by, W - 160, 22);
  ctx.fillStyle = GOLD; ctx.fillRect(80, by, (W - 160) * pct, 22);
  ctx.fillStyle = INK; ctx.font = `500 28px ${SANS}`;
  ctx.fillText(`用掉目标的 ${Math.round(pct * 100)}%`, 80, by + 70);
  if (d.walkKcal) { ctx.textAlign = 'right'; ctx.fillText(`走着去还能抵掉 ${d.walkKcal} 千卡`, W - 80, by + 70); ctx.textAlign = 'left'; }

  if (d.streak) {
    ctx.font = `900 120px ${SERIF}`; ctx.fillText(String(d.streak), 80, by + 220);
    const nw = ctx.measureText(String(d.streak)).width;
    ctx.font = `500 32px ${SANS}`; ctx.fillText('天连续轻盘', 80 + nw + 20, by + 216);
  }

  ctx.font = `400 22px ${SANS}`; ctx.fillStyle = MUTED;
  ctx.fillText('数据来自麦当劳中国 MCP · 仅供饮食参考，不构成营养或医疗建议', 80, H - 70);
  return canvas;
}

export async function cardBlob(d) {
  const c = drawCard(d);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
