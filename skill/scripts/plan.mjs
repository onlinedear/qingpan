#!/usr/bin/env node
// 轻盘 Skill · 命令行配餐
// 只读：查门店 → 查菜单 → 查营养 → 配餐 →（可选）门店算价。不下单、不领券、不读券和积分。
//
// 用法（在仓库根目录运行）：
//   export MCD_MCP_TOKEN='你的 Token'
//   node skill/scripts/plan.mjs --where 江苏南京徐庄软件园 --kcal 600 --protein 25 [--budget 40] [--json]
//   （或分开给：--city 上海市 --keyword 人民广场）

import { McpClient, DEFAULT_URL } from '../../scripts/mcp-client.mjs';
import { parseNutrition, parseMeals, parseStores, parsePrice, parseCity } from '../../web/js/mcd-adapter.js';
import { plan, hasNutrition, SLOT_LABEL } from '../../web/js/planner.js';

export function parseArgs(argv) {
  const out = { kcal: 600, protein: 25, limit: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--json') out.json = true;
    else if (k === '--where') { out.where = v; i++; }
    else if (k === '--city') { out.city = v; i++; }
    else if (k === '--keyword') { out.keyword = v; i++; }
    else if (k === '--kcal') { out.kcal = Number(v); i++; }
    else if (k === '--protein') { out.protein = Number(v); i++; }
    else if (k === '--budget') { out.budget = Number(v); i++; }
    else if (k === '--limit') { out.limit = Number(v); i++; }
  }
  return out;
}

const unwrap = (r) => {
  const t = r?.content?.find((c) => c.type === 'text')?.text;
  try { return r?.structuredContent ?? JSON.parse(t); } catch { return t; }
};

export async function run(opts, { token = process.env.MCD_MCP_TOKEN, fetchImpl } = {}) {
  // 一句话地点（--where 江苏南京徐庄软件园）优先：自动拆成城市 + 关键词；
  // 没给 --where 时用显式的 --city/--keyword。
  let { city, keyword } = opts;
  if (opts.where && (!city || !keyword)) {
    const p = parseCity(opts.where);
    city = city || p.city;
    keyword = keyword || p.keyword;
  }
  if (!city || !keyword) throw new Error('需要 --where 一句话地点（如 --where 江苏南京徐庄软件园），或 --city 上海市 --keyword 人民广场');
  if (!(opts.kcal > 0) || !(opts.protein >= 0)) throw new Error('--kcal 和 --protein 需要是正数');
  const c = new McpClient({ token, url: process.env.MCD_MCP_URL || DEFAULT_URL, fetchImpl });
  await c.initialize({ name: 'qingpan-skill', version: '0.1.0' });

  const stores = parseStores(unwrap(await c.callTool('query-nearby-stores', { searchType: 2, city, keyword, beType: 1 })));
  const store = stores.find((s) => s.open) ?? stores[0];
  if (!store) throw new Error(`「${city}${keyword}」附近没找到可到店的门店`);

  const [mealsRaw, nutRaw] = await Promise.all([
    c.callTool('query-meals', { storeCode: store.code, beType: 1, orderType: 1 }).then(unwrap),
    c.callTool('list-nutrition-foods', {}).then(unwrap),
  ]);
  const { items } = parseMeals(mealsRaw, parseNutrition(nutRaw));
  const goal = { kcal: opts.kcal, protein: opts.protein, ...(opts.budget ? { budget: opts.budget } : {}) };
  const plans = plan(items, goal, { limit: opts.limit });

  // 第一名用门店算价确认（只是试算，不会生成订单）
  if (plans[0]) {
    try {
      const r = await c.callTool('calculate-price', {
        storeCode: store.code, beType: 1, orderType: 1,
        items: plans[0].tray.map((i) => ({ productCode: i.code, quantity: 1 })),
      });
      plans[0].priced = parsePrice(unwrap(r));
    } catch {
      plans[0].priced = null; // 算价失败不影响配餐结果，回落到菜单标价
    }
  }

  return {
    store: { name: store.name, address: store.address, distance: store.distance, hours: store.hours },
    goal,
    coverage: { items: items.length, withNutrition: items.filter(hasNutrition).length },
    plans: plans.map((p) => ({
      tray: p.tray.map((i) => ({ code: i.code, name: i.name, slot: SLOT_LABEL[i.cat === 'dessert' ? 'side' : i.cat], kcal: i.kcal, protein: i.protein, price: i.price, approx: Boolean(i.approx), nutritionName: i.approx ? i.nutritionName : undefined })),
      totals: p.totals,
      priced: p.priced ?? null,
    })),
  };
}

export function format(r) {
  const lines = [`📍 ${r.store.name}${r.store.distance != null ? `（约 ${r.store.distance} 米）` : ''} ${r.store.hours ?? ''}`.trim(),
    `🎯 目标：≤ ${r.goal.kcal} 千卡，蛋白质 ≥ ${r.goal.protein} g${r.goal.budget ? `，预算 ≤ ¥${r.goal.budget}` : ''}`,
    `📊 这家店 ${r.coverage.items} 款单品中 ${r.coverage.withNutrition} 款有官方营养数据`, ''];
  if (!r.plans.length) lines.push('在这个目标下配不出方案，试试放宽热量或蛋白质。');
  r.plans.forEach((p, i) => {
    lines.push(`方案 ${i + 1}：${p.totals.kcal} 千卡 · 蛋白质 ${p.totals.protein} g · 脂肪 ${p.totals.fat} g · 钠 ${p.totals.sodium} mg`);
    for (const it of p.tray) lines.push(`  · [${it.slot}] ${it.name}  ${it.approx ? '≈' : ''}${it.kcal} 千卡${it.price != null ? `  ¥${it.price}` : ''}${it.approx ? `（按「${it.nutritionName}」估算）` : ''}`);
    if (p.priced) lines.push(`  门店算价：¥${p.priced.price}${p.priced.personal ? `（原价 ¥${p.priced.original}，已含你账号的权益）` : ''}`);
    else if (p.totals.price != null) lines.push(`  菜单标价合计：¥${p.totals.price}`);
    lines.push('');
  });
  lines.push('仅供饮食参考，不构成营养或医疗建议；餐品、价格与供应以门店实时为准。');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.MCD_MCP_TOKEN) {
    console.error("✗ 没有找到环境变量 MCD_MCP_TOKEN。先执行 export MCD_MCP_TOKEN='你的 Token'，不要把 Token 贴进对话。");
    process.exit(2);
  }
  try {
    const r = await run(opts);
    console.log(opts.json ? JSON.stringify(r, null, 2) : format(r));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    if (e.hint) console.error(`  建议：${e.hint}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
