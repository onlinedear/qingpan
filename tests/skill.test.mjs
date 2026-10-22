import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run, format } from '../skill/scripts/plan.mjs';

const NUT = '[3]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  板烧鸡腿堡,null,1638,391,23,17,35,1041,93\n  苹果片,null,134,32,0,0,8,0,4\n  纯牛奶（盒装）,null,280,67,3,4,5,50,100\n';
const RESP = {
  'query-nearby-stores': { success: true, data: [{ storeCode: '100', storeName: '示例餐厅', address: 'x', distance: 120, businessStatus: true, longitude: 0, latitude: 0 }] },
  'query-meals': { success: true, data: { categories: [], meals: { a: { name: '板烧鸡腿堡', currentPrice: '23.5' }, b: { name: '苹果片', currentPrice: '7' }, c: { name: '纯牛奶(盒装)', currentPrice: '10.5' } } } },
  'list-nutrition-foods': { success: true, data: NUT },
  'calculate-price': { success: true, data: { originalPrice: 4100, price: 4100 } },
};

function fake() {
  const tools = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    if (!('id' in b)) return new Response(null, { status: 202 });
    if (b.method === 'tools/call') tools.push(b.params);
    const result = b.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: JSON.stringify(RESP[b.params.name]) }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { tools, fetchImpl };
}

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--city', '上海市', '--keyword', '人民广场', '--kcal', '500', '--json']), { kcal: 500, protein: 25, limit: 3, json: true, city: '上海市', keyword: '人民广场' });
});

test('Skill 端到端：只调用只读工具，参数符合官方要求，输出达标方案', async () => {
  const { tools, fetchImpl } = fake();
  const r = await run({ city: '上海市', keyword: '人民广场', kcal: 600, protein: 25, limit: 3 }, { token: 't', fetchImpl });
  assert.deepEqual(tools.map((t) => t.name).sort(), ['calculate-price', 'list-nutrition-foods', 'query-meals', 'query-nearby-stores']);
  assert.deepEqual(tools.find((t) => t.name === 'query-nearby-stores').arguments, { searchType: 2, city: '上海市', keyword: '人民广场', beType: 1 });
  assert.ok(!('beCode' in tools.find((t) => t.name === 'query-meals').arguments));
  assert.equal(r.plans[0].totals.kcal, 490);
  assert.equal(r.plans[0].totals.protein, 26);
  assert.equal(r.plans[0].priced.price, 41);
  const text = format(r);
  assert.match(text, /示例餐厅/);
  assert.match(text, /不构成营养或医疗建议/);
});

test('parseArgs 支持 --where 一句话地点', () => {
  assert.equal(parseArgs(['--where', '江苏南京徐庄软件园']).where, '江苏南京徐庄软件园');
});

test('--where 一句话地点自动拆成城市 + 关键词', async () => {
  const { tools, fetchImpl } = fake();
  await run({ where: '江苏南京徐庄软件园', kcal: 600, protein: 25, limit: 3 }, { token: 't', fetchImpl });
  const q = tools.find((t) => t.name === 'query-nearby-stores').arguments;
  assert.equal(q.city, '南京市');
  assert.equal(q.keyword, '徐庄软件园');
});

test('缺地点时给出明确提示', async () => {
  await assert.rejects(run({ kcal: 600, protein: 25 }, { token: 't', fetchImpl: fake().fetchImpl }), /--where|--city/);
});
