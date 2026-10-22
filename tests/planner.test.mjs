import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, blindBox, swap, totals, score, walkKcal, weatherMood, hasNutrition } from '../web/js/planner.js';
import { DEMO_ITEMS } from '../web/js/demo-data.js';
import * as ch from '../web/js/challenge.js';

const goal = { kcal: 600, protein: 25 };

test('plan：所有方案不超热量，按得分降序，且只用有营养数据的餐品', () => {
  const ps = plan(DEMO_ITEMS, goal, { limit: 6 });
  assert.ok(ps.length > 0);
  for (const p of ps) {
    assert.ok(p.totals.kcal <= goal.kcal);
    assert.ok(p.tray.every(hasNutrition));
    assert.equal(p.tray.filter((i) => i.cat === 'main').length, 1);
  }
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i - 1].score >= ps[i].score);
});

test('plan：第一名蛋白质达标', () => {
  assert.ok(plan(DEMO_ITEMS, goal)[0].totals.protein >= goal.protein);
});

test('plan：目标不可能达成时返回空，不硬凑', () => {
  assert.deepEqual(plan(DEMO_ITEMS, { kcal: 100, protein: 50 }), []);
});

test('plan：预算约束生效', () => {
  for (const p of plan(DEMO_ITEMS, { ...goal, budget: 25 })) assert.ok(p.totals.price <= 25);
});

test('天气：下雨天热饮得分更高', () => {
  const hot = DEMO_ITEMS.find((i) => i.code === 'd2');
  const iced = DEMO_ITEMS.find((i) => i.code === 'd1');
  const main = DEMO_ITEMS.find((i) => i.code === 'm1');
  const w = { mood: 'rain' };
  assert.ok(score([main, hot], goal, { weather: w }) > score([main, iced], goal, { weather: w }));
});

test('weatherMood 分类', () => {
  assert.equal(weatherMood({ text: '小雨', temp: 20 }), 'rain');
  assert.equal(weatherMood({ text: '晴', temp: 8 }), 'cold');
  assert.equal(weatherMood({ text: '晴', temp: 33 }), 'hot');
  assert.equal(weatherMood({ text: '多云', temp: 22 }), 'mild');
  assert.equal(weatherMood(null), null);
});

test('盲盒：同 seed 结果相同，不同 seed 能抽到不同的盘', () => {
  const a = blindBox(DEMO_ITEMS, goal, { seed: 42 });
  assert.deepEqual(a, blindBox(DEMO_ITEMS, goal, { seed: 42 }));
  const seen = new Set();
  for (let s = 1; s < 40; s++) seen.add(blindBox(DEMO_ITEMS, goal, { seed: s }).tray.map((i) => i.code).join());
  assert.ok(seen.size >= 3, `盲盒应有多样性，实际只有 ${seen.size} 种`);
});

test('swap：只换指定位置，结果仍达标', () => {
  const tray = plan(DEMO_ITEMS, goal)[0].tray;
  const next = swap(tray, 'drink', DEMO_ITEMS, goal, 1);
  assert.ok(next);
  assert.equal(next.find((i) => i.cat === 'main').code, tray.find((i) => i.cat === 'main').code);
  assert.ok(totals(next).kcal <= goal.kcal);
});

test('totals：缺价格时 price 为 null', () => {
  assert.equal(totals([{ kcal: 1, protein: 1 }]).price, null);
  assert.equal(totals([{ kcal: 1, protein: 1, price: 1.1 }, { kcal: 1, protein: 1, price: 2.2 }]).price, 3.3);
});

test('walkKcal 估算', () => {
  assert.equal(walkKcal(2000, 60), 60);
  assert.equal(walkKcal(0), 0);
  assert.equal(walkKcal(NaN), 0);
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

test('挑战：连续打卡计数、同日不重复、断签重算', () => {
  const s = memStorage();
  assert.equal(ch.checkIn({ kcal: 500, protein: 30 }, { storage: s, today: '2026-10-20' }).streak, 1);
  assert.equal(ch.checkIn({ kcal: 520, protein: 30 }, { storage: s, today: '2026-10-21' }).streak, 2);
  assert.equal(ch.checkIn({ kcal: 480, protein: 30 }, { storage: s, today: '2026-10-21' }).streak, 2);
  assert.equal(ch.load(s).days.length, 2);
  // 今天还没打卡时，昨天之前的连续记录仍算
  assert.equal(ch.streak(ch.load(s), '2026-10-22'), 2);
  // 断了一天就从头算
  assert.equal(ch.streak(ch.load(s), '2026-10-24'), 0);
  // 跨月
  const s2 = memStorage();
  ch.checkIn({ kcal: 1, protein: 1 }, { storage: s2, today: '2026-09-30' });
  assert.equal(ch.checkIn({ kcal: 1, protein: 1 }, { storage: s2, today: '2026-10-01' }).streak, 2);
});

test('挑战：解锁花纹与 7 天格子', () => {
  assert.equal(ch.unlocked(0).length, 0);
  assert.equal(ch.unlocked(3).length, 3);
  assert.equal(ch.unlocked(30).length, 7);
  const w = ch.lastWeek({ days: [{ date: '2026-10-22', kcal: 1 }] }, '2026-10-22');
  assert.equal(w.length, 7);
  assert.equal(w.at(-1).date, '2026-10-22');
  assert.ok(w.at(-1).rec);
  assert.equal(w[0].date, '2026-10-16');
});

test('挑战：存储损坏时不崩', () => {
  assert.deepEqual(ch.load({ getItem: () => '{oops' }), { days: [] });
});
