// 麦当劳 MCP 返回结构解析测试。
// 固定用例来自 2026-10-22 实测结构（数值为真实官方营养数据的片段）；
// 如果本机有 probe/samples（被 .gitignore 忽略），额外用完整真实数据跑一遍覆盖率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseTable, parseNutrition, parseMeals, parseStores, parsePrice, matchNutrition, normName, categorize } from '../web/js/mcd-adapter.js';
import { plan } from '../web/js/planner.js';

const NUT = {
  success: true, code: 200,
  data: '[5]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n'
    + '  板烧鸡腿堡,null,1638,391,23,17,35,1041,93\n'
    + '  可乐中杯,null,616,147,0,0,36,0,10\n'
    + '  可乐大杯,null,936,224,0,0,55,0,15\n'
    + '  中薯条,null,1210,289,4,12,38,165,18\n'
    + '  纯牛奶（盒装）,null,280,67,3,4,5,50,100\n',
};
const MEALS = {
  success: true,
  data: {
    categories: [{ name: '鸡肉汉堡\n/卷', meals: [{ code: '1406', tags: ['上新'] }] }, { name: '饮品', meals: [{ code: 'c1' }, { code: 'm1' }] }],
    meals: {
      1406: { name: '板烧鸡腿堡', currentPrice: '23.5' },
      c1: { name: '可乐', currentPrice: '9.5' },
      m1: { name: '纯牛奶(盒装)', currentPrice: '10.5' },
      f1: { name: '薯条', currentPrice: '13.5' },
      x1: { name: '龙焰鸡腿堡', currentPrice: '15.9' },
      b1: { name: '板烧鸡腿堡三件套', currentPrice: '34.5' },
      s1: { name: '北美招牌牧场酱', currentPrice: '3' },
      h1: { name: '麦当劳联名复古棒球帽', currentPrice: '34.9' },
    },
  },
};

test('parseTable 解析表格文本', () => {
  const rows = parseTable(NUT.data);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { productName: '板烧鸡腿堡', nutritionDescription: 'null', energyKj: '1638', energyKcal: '391', protein: '23', fat: '17', carbohydrate: '35', sodium: '1041', calcium: '93' });
  assert.deepEqual(parseTable('乱七八糟'), []);
});

test('parseNutrition 取千卡而不是千焦', () => {
  const n = parseNutrition(NUT);
  assert.equal(n[0].kcal, 391);
  assert.equal(n[0].protein, 23);
});

test('normName：全半角括号、品牌前缀、引号归一', () => {
  assert.equal(normName('纯牛奶(盒装)'), normName('纯牛奶（盒装）'));
  assert.equal(normName('麦咖啡™美式'), '美式');
  assert.equal(normName('【美汁源】“黄金橙橙”'), '黄金橙橙');
});

test('matchNutrition：精确优先，不带规格时取中杯并标估算', () => {
  const n = parseNutrition(NUT);
  assert.deepEqual(matchNutrition('板烧鸡腿堡', n), { rec: n[0], approx: false });
  const cola = matchNutrition('可乐', n);
  assert.equal(cola.rec.name, '可乐中杯');
  assert.equal(cola.approx, true);
  assert.equal(matchNutrition('薯条', n).rec.name, '中薯条');
  assert.equal(matchNutrition('龙焰鸡腿堡', n), null);
});

test('parseMeals：合并营养、剔除套餐/酱料/周边、保留无数据单品', () => {
  const { items, bundles, merch } = parseMeals(MEALS, parseNutrition(NUT));
  assert.equal(bundles, 1);
  assert.equal(merch, 2);
  const by = Object.fromEntries(items.map((i) => [i.code, i]));
  assert.equal(by['1406'].kcal, 391);
  assert.equal(by['1406'].price, 23.5);
  assert.deepEqual(by['1406'].promo, ['上新']);
  assert.equal(by.c1.cat, 'drink');
  assert.equal(by.c1.approx, true);
  assert.equal(by.m1.kcal, 67);
  assert.equal(by.f1.cat, 'side');
  assert.equal(by.x1.kcal, undefined, '没有营养数据就不编');
  assert.ok(!by.b1 && !by.s1 && !by.h1);
});

test('categorize', () => {
  assert.equal(categorize('麦辣鸡翅'), 'side');
  assert.equal(categorize('经典麦旋风'), 'dessert');
  assert.equal(categorize('热美式中杯'), 'drink');
  assert.equal(categorize('巨无霸'), 'main');
});

test('parseStores：坐标为 0 视为没有', () => {
  const s = parseStores({ data: [{ storeCode: '1450713', storeName: '示例餐厅', address: '某路1号', distance: 144, businessStatus: true, businessStartTime: '00:00', businessEndTime: '23:59', longitude: 0, latitude: 0 }] });
  assert.equal(s[0].code, '1450713');
  assert.equal(s[0].location, undefined);
  assert.equal(s[0].hours, '00:00–23:59');
});

test('parsePrice：分转元；区分原价和个人到手价', () => {
  assert.deepEqual(parsePrice({ data: { originalPrice: 2550, price: 1913 } }), { price: 19.13, original: 25.5, personal: true });
  assert.deepEqual(parsePrice({ data: { originalPrice: 2550, publicPrice: true } }), { price: 25.5, original: 25.5, personal: false });
  assert.equal(parsePrice({ data: {} }), null);
});

const SAMPLES = new URL('../probe/samples/', import.meta.url);
const hasSamples = existsSync(new URL('query-meals.raw.json', SAMPLES));
test('真实采样：营养覆盖率与可配餐', { skip: !hasSamples && '本机没有 probe/samples，跳过' }, () => {
  const j = (f) => JSON.parse(readFileSync(new URL(f, SAMPLES), 'utf8'));
  const nut = parseNutrition(j('list-nutrition-foods.raw.json'));
  const { items } = parseMeals(j('query-meals.raw.json'), nut);
  const ok = items.filter((i) => Number.isFinite(i.kcal));
  assert.ok(nut.length >= 100, `营养表应有上百条，实际 ${nut.length}`);
  assert.ok(ok.length / items.length >= 0.5, `单品营养覆盖率 ${ok.length}/${items.length}`);
  const p = plan(items, { kcal: 600, protein: 25 });
  assert.ok(p.length > 0, '600 千卡 / 25g 蛋白质应能配出方案');
  assert.ok(p[0].totals.kcal <= 600 && p[0].totals.protein >= 25);
});
