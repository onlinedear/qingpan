// 7 天轻盘挑战：数据只存在用户自己浏览器的 localStorage，不上传。
const KEY = 'qingpan.challenge.v1';

export const PATTERNS = [
  { day: 1, id: 'plain', name: '素纸' },
  { day: 2, id: 'grid', name: '方格' },
  { day: 3, id: 'dots', name: '圆点' },
  { day: 4, id: 'stripe', name: '斜纹' },
  { day: 5, id: 'wave', name: '波纹' },
  { day: 6, id: 'check', name: '格纹' },
  { day: 7, id: 'gold', name: '金边' },
];

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免跨时区差一天） */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prevDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
}

export function load(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? 'null');
    return v && Array.isArray(v.days) ? v : { days: [] };
  } catch {
    return { days: [] };
  }
}

function save(state, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(state)); } catch { /* 隐私模式下写不进也不影响使用 */ }
}

/** 连续天数：从今天（今天没打卡就从昨天）往前数 */
export function streak(state, today = dayKey()) {
  const set = new Set(state.days.map((d) => d.date));
  let cur = set.has(today) ? today : prevDay(today);
  let n = 0;
  while (set.has(cur)) { n++; cur = prevDay(cur); }
  return n;
}

/** 打卡：同一天重复打卡只覆盖，不累加 */
export function checkIn(summary, { storage = globalThis.localStorage, today = dayKey() } = {}) {
  const state = load(storage);
  state.days = state.days.filter((d) => d.date !== today);
  state.days.push({ date: today, kcal: summary.kcal, protein: summary.protein });
  state.days = state.days.sort((a, b) => a.date.localeCompare(b.date)).slice(-60);
  save(state, storage);
  return { state, streak: streak(state, today) };
}

export function unlocked(n) {
  return PATTERNS.filter((p) => p.day <= Math.min(n, 7));
}

/** 最近 7 天的格子（给日历条用） */
export function lastWeek(state, today = dayKey()) {
  const set = new Map(state.days.map((d) => [d.date, d]));
  const out = [];
  let cur = today;
  for (let i = 0; i < 7; i++) { out.unshift({ date: cur, rec: set.get(cur) ?? null }); cur = prevDay(cur); }
  return out;
}
