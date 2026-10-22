// 麦当劳中国 MCP 返回结构 → 轻盘数据模型
// 依据 2026-10-22 实测采样（scripts/sample-shapes.mjs）：
//   list-nutrition-foods: data 是表格文本 "[160]{productName,...,energyKcal,protein,...}:\n  行,行..."
//   query-meals:          data.meals 是 { 餐品编码: {name,currentPrice,...} }，分类在 data.categories[].meals[].code
//   query-nearby-stores:  data 是门店数组；longitude/latitude 实测为 0（等于没有坐标）
// 纯函数，浏览器 / Node / Skill 共用。

/** 拆出 MCP 业务外壳 {success, code, data} */
export const body = (d) => (d && typeof d === 'object' && 'data' in d ? d.data : d);

const toNum = (v) => {
  if (v == null || v === '' || v === 'null') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 解析 "[N]{a,b,c}:\n  1,2,3" 表格文本；同时兼容已经是对象数组的情况 */
export function parseTable(data) {
  if (Array.isArray(data)) return data;
  const text = String(data ?? '');
  const head = text.match(/^\s*\[\d+\]\{([^}]*)\}:\s*$/m);
  if (!head) return [];
  const keys = head[1].split(',').map((k) => k.trim());
  return text
    .slice(head.index + head[0].length)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const cells = l.split(',');
      // 名称里可能有逗号：多出来的列并回第一列
      while (cells.length > keys.length) cells.splice(0, 2, `${cells[0]},${cells[1]}`);
      return Object.fromEntries(keys.map((k, i) => [k, cells[i]?.trim()]));
    });
}

/** 名称归一：去掉品牌前缀、括号注释、引号和空白，统一全半角 */
export function normName(s) {
  return String(s ?? '')
    .replace(/麦咖啡™?|【[^】]*】/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s"“”'‘’·™]/g, '')
    .replace(/％/g, '%')
    .toLowerCase();
}

export function parseNutrition(raw) {
  const rows = parseTable(body(raw));
  const list = [];
  for (const r of rows) {
    const name = r.productName ?? r.name;
    if (!name) continue;
    list.push({
      name,
      key: normName(name),
      kcal: toNum(r.energyKcal ?? r.energy),
      protein: toNum(r.protein),
      fat: toNum(r.fat),
      carb: toNum(r.carbohydrate),
      sodium: toNum(r.sodium),
      calcium: toNum(r.calcium),
    });
  }
  return list;
}

// 不带规格的菜单名默认对应哪个规格（与门店默认出餐一致的常见规格）
const SIZE_PREF = [/中杯$/, /^中/, /^热.*中杯$/, /5块$/, /2块$/, /^小杯/];

/**
 * 给菜单名找营养记录。
 * 返回 { rec, approx }：approx=true 表示按默认规格估算（界面会标"≈"），找不到返回 null。
 */
export function matchNutrition(menuName, nutrition) {
  const k = normName(menuName);
  if (!k) return null;
  const exact = nutrition.find((n) => n.key === k);
  if (exact) return { rec: exact, approx: false };
  // 菜单名是营养名的一部分：可乐 → 可乐中杯、薯条 → 中薯条、麦乐鸡 → 麦乐鸡5块
  const cands = nutrition.filter((n) => n.key.includes(k) && n.key.length - k.length <= 4);
  if (cands.length === 1) return { rec: cands[0], approx: true };
  for (const re of SIZE_PREF) {
    const hit = cands.filter((n) => re.test(n.key));
    if (hit.length === 1) return { rec: hit[0], approx: true };
  }
  return null;
}

// 非餐品（周边、酱料）和套餐不进配餐，也不出现在"暂无数据"里
const MERCH = /帽|丝巾|挠|星愿贴|周边|玩具|徽章|水手帽/;
const SAUCE = /酱$/;
const BUNDLE = /套餐|件套|双人|多人|分享餐|随心配|随心拼|随心选|开心乐园|四宫格|十翅|单品精选|任选/;

const CAT_BY_NAME = [
  ['drink', /可乐|雪碧|芬达|咖啡|美式|拿铁|奶铁|卡布奇诺|浓缩|阿芙佳朵|茶|牛奶|奶昔|豆浆|果汁|苹果汁|橙|柠|纯悦|怡泉|黑巧|燕麦奶|饮/],
  ['dessert', /圣代|新地|甜筒|圆筒|麦旋风|派$|冰淇淋|拉明顿/],
  ['side', /薯条|薯饼|扭扭薯|玉米杯|苹果片|沙拉|粥|鸡翅|V翅|芝士条|鸡球|油条|麦乐鸡/],
];
const CAT_BY_SECTION = [['drink', /饮品|麦咖啡/], ['dessert', /甜品/], ['side', /小食/]];

export function categorize(name, section = '') {
  for (const [c, re] of CAT_BY_NAME) if (re.test(name)) return c;
  for (const [c, re] of CAT_BY_SECTION) if (re.test(section)) return c;
  return 'main';
}

export function tagsOf(name, cat) {
  const t = [];
  if (/冰/.test(name) && !/热/.test(name)) t.push('iced');
  if (/热|粥|豆浆|美式|奶铁|卡布奇诺|黑巧/.test(name) && !/冰/.test(name) && cat === 'drink') t.push('hot');
  if (/可乐|雪碧|芬达|怡泉|纯悦|柠檬红茶|果汁/.test(name)) t.push('iced');
  if (/沙拉|玉米|苹果|无糖|纯悦/.test(name)) t.push('light');
  return [...new Set(t)];
}

/**
 * query-meals → { items, bundles, merch }
 * items 已合并营养数据；没有营养的保留但不带 kcal（配餐引擎会自动跳过）。
 */
export function parseMeals(raw, nutrition = []) {
  const d = body(raw) ?? {};
  const map = d.meals && typeof d.meals === 'object' ? d.meals : {};
  const section = new Map();
  const extraTags = new Map();
  for (const c of d.categories ?? []) {
    const sec = String(c.name ?? '').replace(/\s+/g, '');
    for (const m of c.meals ?? []) {
      if (!section.has(m.code)) section.set(m.code, sec);
      if (m.tags?.length) extraTags.set(m.code, m.tags);
    }
  }

  const items = [];
  let bundles = 0, merch = 0;
  for (const [code, m] of Object.entries(map)) {
    const name = String(m?.name ?? '').trim();
    if (!name) continue;
    if (MERCH.test(name) || SAUCE.test(name)) { merch++; continue; }
    if (BUNDLE.test(name)) { bundles++; continue; }
    const sec = section.get(code) ?? '';
    const cat = categorize(name, sec);
    const match = matchNutrition(name, nutrition);
    const n = match?.rec;
    items.push({
      code: String(code),
      name,
      cat,
      price: toNum(m.currentPrice),
      image: typeof m.image === 'string' && m.image.startsWith('https://') ? m.image : undefined,
      section: sec,
      promo: extraTags.get(code) ?? [],
      tags: tagsOf(name, cat),
      ...(n ? { kcal: n.kcal, protein: n.protein, fat: n.fat, carb: n.carb, sodium: n.sodium, nutritionName: n.name, approx: match.approx } : {}),
    });
  }
  return { items, bundles, merch };
}

/** query-nearby-stores → 门店列表；坐标为 0 视为没有 */
export function parseStores(raw) {
  const list = body(raw);
  return (Array.isArray(list) ? list : []).map((s) => {
    const lng = toNum(s.longitude), lat = toNum(s.latitude);
    return {
      code: String(s.storeCode ?? ''),
      name: s.storeName ?? '麦当劳餐厅',
      address: s.address ?? '',
      distance: toNum(s.distance),
      open: s.businessStatus !== false,
      hours: s.businessStartTime && s.businessEndTime ? `${s.businessStartTime}–${s.businessEndTime}` : '',
      location: lng && lat ? `${lng},${lat}` : undefined,
    };
  }).filter((s) => s.code);
}

/**
 * calculate-price 返回单位是"分"。
 * - originalPrice：菜单原价（体验模式只有这个）
 * - price：套用当前 Token 账号权益后的到手价（只在个人模式下出现）
 * 返回 { price, original, personal }，都是元。
 */
export function parsePrice(raw) {
  const d = body(raw) ?? {};
  const yuan = (v) => (toNum(v) != null ? Math.round(toNum(v)) / 100 : null);
  const original = yuan(d.originalPrice ?? d.productOriginalPrice);
  const personal = d.publicPrice ? null : yuan(d.price ?? d.productPrice);
  if (original == null && personal == null) return null;
  return { price: personal ?? original, original, personal: personal != null && personal !== original };
}
