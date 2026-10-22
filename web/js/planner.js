// 轻盘 · 配餐引擎（纯函数，浏览器 / Node / Skill 共用）
//
// 输入：餐品列表 + 目标；输出：按得分排序的托盘方案。
// 原则：没有可靠营养数据的餐品不参与配餐（不编造数值），单独列出。

/** @typedef {{code:string,name:string,cat:'main'|'side'|'drink'|'dessert',kcal?:number,protein?:number,fat?:number,carb?:number,sodium?:number,price?:number,tags?:string[]}} Item */
/** @typedef {{kcal:number, protein:number, budget?:number}} Goal */

export const SLOTS = ['main', 'side', 'drink'];
export const SLOT_LABEL = { main: '主食', side: '配餐', drink: '饮品', dessert: '甜品' };

export const hasNutrition = (it) =>
  Number.isFinite(it?.kcal) && Number.isFinite(it?.protein);

/** 可复现的伪随机（盲盒用），同一个 seed 结果相同，方便测试 */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function totals(items) {
  const sum = (k) => items.reduce((a, it) => a + (Number(it?.[k]) || 0), 0);
  const priced = items.every((it) => Number.isFinite(it?.price));
  return {
    kcal: Math.round(sum('kcal')),
    protein: Math.round(sum('protein') * 10) / 10,
    fat: Math.round(sum('fat') * 10) / 10,
    carb: Math.round(sum('carb') * 10) / 10,
    sodium: Math.round(sum('sodium')),
    price: priced ? Math.round(sum('price') * 100) / 100 : null,
  };
}

/** 天气对餐品的偏好加成：下雨/降温偏热饮，高温偏清爽 */
export function weatherBonus(item, weather) {
  if (!weather || !item?.tags) return 0;
  const t = item.tags;
  if (weather.mood === 'cold' || weather.mood === 'rain') return t.includes('hot') ? 1.2 : t.includes('iced') ? -0.6 : 0;
  if (weather.mood === 'hot') return t.includes('iced') || t.includes('light') ? 1.2 : t.includes('hot') ? -0.6 : 0;
  return 0;
}

/** 由气温和天气文字判断"气氛"，给菜单和文案用 */
export function weatherMood(w) {
  if (!w) return null;
  const text = String(w.text ?? '');
  const temp = Number(w.temp);
  if (/雨|雪|雷/.test(text)) return 'rain';
  if (Number.isFinite(temp) && temp <= 12) return 'cold';
  if (Number.isFinite(temp) && temp >= 28) return 'hot';
  return 'mild';
}

/** 给一盘打分，越高越好；超热量或超预算返回 -Infinity */
export function score(tray, goal, { weather, jitter = 0 } = {}) {
  const t = totals(tray);
  if (t.kcal > goal.kcal) return -Infinity;
  if (goal.budget && t.price != null && t.price > goal.budget) return -Infinity;

  const fill = t.kcal / goal.kcal; // 吃够但不超：0.8~1 最好
  const fillScore = fill >= 0.8 ? 1 : fill / 0.8;
  const proteinScore = Math.min(t.protein / Math.max(goal.protein, 1), 1.15);
  const proteinMiss = t.protein < goal.protein ? (goal.protein - t.protein) / goal.protein : 0;
  const sodiumPenalty = t.sodium > 1500 ? (t.sodium - 1500) / 1000 : 0;
  const variety = new Set(tray.map((i) => i.cat)).size / 3;
  const wb = tray.reduce((a, i) => a + weatherBonus(i, weather), 0) / 3;

  return proteinScore * 3 - proteinMiss * 2 + fillScore * 2 + variety - sodiumPenalty + wb + jitter;
}

function groupBySlot(items) {
  const g = { main: [], side: [], drink: [] };
  for (const it of items) {
    if (!hasNutrition(it)) continue;
    const slot = it.cat === 'dessert' ? 'side' : it.cat;
    if (g[slot]) g[slot].push(it);
  }
  return g;
}

/**
 * 生成方案。每盘 = 1 主食 + 0~1 配餐 + 0~1 饮品。
 * @returns {{tray:Item[], totals:ReturnType<typeof totals>, score:number}[]}
 */
export function plan(items, goal, { weather, limit = 5, seed } = {}) {
  const g = groupBySlot(items);
  const rand = seed != null ? rng(seed) : null;
  const sides = [null, ...g.side];
  const drinks = [null, ...g.drink];
  const out = [];
  for (const m of g.main) {
    for (const s of sides) {
      for (const d of drinks) {
        const tray = [m, s, d].filter(Boolean);
        const sc = score(tray, goal, { weather, jitter: rand ? rand() * 2.5 : 0 });
        if (sc > -Infinity) out.push({ tray, totals: totals(tray), score: sc });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);

  // 去重：主食不同的方案优先，避免前几名都是同一个汉堡
  const picked = [];
  const seenMain = new Map();
  for (const p of out) {
    const k = p.tray[0].code;
    const n = seenMain.get(k) ?? 0;
    if (n >= 1 && picked.length < limit && out.length > limit * 2) continue;
    seenMain.set(k, n + 1);
    picked.push(p);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 盲盒：在达标的方案里带随机地抽一盘 */
export function blindBox(items, goal, { weather, seed = Date.now() } = {}) {
  return plan(items, goal, { weather, seed, limit: 1 })[0] ?? null;
}

/**
 * 换一件：保持其余不变，把某个位置换成下一个合格的候选。
 * dir = 1 下一个，-1 上一个。返回新托盘；没有可换的返回 null。
 */
export function swap(tray, slot, items, goal, dir = 1, { weather } = {}) {
  const g = groupBySlot(items);
  const pool = g[slot] ?? [];
  if (!pool.length) return null;
  const others = tray.filter((i) => (i.cat === 'dessert' ? 'side' : i.cat) !== slot);
  const cur = tray.find((i) => (i.cat === 'dessert' ? 'side' : i.cat) === slot);
  const candidates = slot === 'main' ? pool : [null, ...pool];
  const start = Math.max(0, candidates.findIndex((c) => (c?.code ?? null) === (cur?.code ?? null)));
  for (let step = 1; step <= candidates.length; step++) {
    const c = candidates[(start + dir * step + candidates.length * 4) % candidates.length];
    const next = [...others, c].filter(Boolean).sort((a, b) => SLOTS.indexOf(norm(a)) - SLOTS.indexOf(norm(b)));
    if (score(next, goal, { weather }) > -Infinity) return next;
  }
  return null;
}
const norm = (i) => (i.cat === 'dessert' ? 'side' : i.cat);

/** 步行消耗估算：约 0.5 千卡 / 公斤体重 / 公里（中速步行的常用近似值） */
export function walkKcal(distanceM, weightKg = 60) {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  return Math.round((distanceM / 1000) * weightKg * 0.5);
}
