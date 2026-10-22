#!/usr/bin/env node
// 轻盘 · 返回结构采样脚本（只读）
//
// 依次调用 5 个只读工具，把返回结构存到 probe/samples/，用于对接网页数据层：
//   list-nutrition-foods → query-nearby-stores → query-meals → query-meal-detail → calculate-price
// 全部是查询，不下单、不领券、不读你的券和积分。calculate-price 只是试算价格，不会生成订单。
//
// 用法：
//   export MCD_MCP_TOKEN='你的 Token'
//   node scripts/sample-shapes.mjs 上海市 人民广场

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpClient, McpError, DEFAULT_URL } from './mcp-client.mjs';

/** 拆出 tools/call 结果里的数据 */
export function unwrap(result) {
  if (result?.structuredContent) return result.structuredContent;
  const texts = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  for (const t of texts) { try { return JSON.parse(t); } catch {} }
  return texts.join('\n');
}

/** 结构摘要：键名 + 类型 + 一个截断的样例值；数组只展开第一个元素并记录长度 */
export function shape(v, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [`<array ×${v.length}>`, shape(v[0], depth + 1)] : ['<empty array>'];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return v;
}

/** 在任意嵌套结构里找第一个"对象数组"，用来定位门店/餐品列表 */
export function findList(v, test = () => true, depth = 0) {
  if (depth > 6 || !v) return null;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && test(v[0])) return v;
    for (const x of v) { const r = findList(x, test, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof v === 'object') for (const x of Object.values(v)) { const r = findList(x, test, depth + 1); if (r) return r; }
  return null;
}
const pickKey = (o, re) => Object.keys(o ?? {}).find((k) => re.test(k));

async function main() {
  const [city = '上海市', keyword = '人民广场'] = process.argv.slice(2);
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) { console.error('✗ 没有找到环境变量 MCD_MCP_TOKEN'); process.exit(2); }

  const outDir = resolve('probe/samples');
  await mkdir(outDir, { recursive: true });
  const c = new McpClient({ token, url: process.env.MCD_MCP_URL || DEFAULT_URL });
  await c.initialize({ name: 'qingpan-sampler', version: '0.1.0' });

  const save = async (name, data) => {
    await writeFile(join(outDir, `${name}.shape.json`), JSON.stringify(shape(data), null, 2) + '\n');
    await writeFile(join(outDir, `${name}.raw.json`), JSON.stringify(data, null, 2).slice(0, 200_000) + '\n');
  };
  const call = async (tool, args) => {
    const t = Date.now();
    const r = await c.callTool(tool, args);
    const data = unwrap(r);
    console.log(`${r?.isError ? '✗' : '✓'} ${tool}  ${Date.now() - t}ms`);
    await save(tool, data);
    if (r?.isError) throw new McpError(`${tool} 返回错误：${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200)}`);
    return data;
  };

  try {
    await call('list-nutrition-foods', {});

    const stores = await call('query-nearby-stores', { searchType: 2, city, keyword, beType: 1 });
    const storeList = findList(stores, (o) => pickKey(o, /storeCode|code/i));
    const store = storeList?.[0];
    const storeCode = store?.[pickKey(store, /^storeCode$/i) ?? pickKey(store, /code/i)];
    if (!storeCode) throw new McpError(`没找到「${city} ${keyword}」附近的门店，换个关键词再试`);
    console.log(`  门店：${store[pickKey(store, /name/i)] ?? ''}（${storeCode}）`);

    const meals = await call('query-meals', { storeCode: String(storeCode), beType: 1, orderType: 1 });
    // 实测：data.meals 是 { 餐品编码: {name, currentPrice, ...} }
    const mealMap = meals?.data?.meals ?? {};
    const [mealCode, meal] = Object.entries(mealMap).find(([, m]) => !/套餐|件套/.test(m?.name ?? '')) ?? [];
    if (!mealCode) throw new McpError('菜单里没解析到餐品编码，请把 probe/samples/query-meals.shape.json 发给开发者');
    console.log(`  餐品样例：${meal?.name ?? ''}（${mealCode}）`);

    await call('query-meal-detail', { storeCode: String(storeCode), beType: 1, orderType: 1, code: String(mealCode) });
    await call('calculate-price', { storeCode: String(storeCode), beType: 1, orderType: 1, items: [{ productCode: String(mealCode), quantity: 1 }] });

    console.log(`✓ 已写入 ${outDir}（门店、菜单、营养、试算价格，不含你的券和积分）`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    if (e.hint) console.error(`  建议：${e.hint}`);
    console.error(`  已采到的部分仍保存在 ${outDir}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
