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

/**
 * query-store-coupons：当前门店+订单类型下可用的券。
 * 权威字段（2026-10-22 outputSchema）：data[] 每项 { couponId, couponCode, title 券名,
 *   promotionId 促销规则, products[]{productCode,productName} 适用商品, tradeDateTime 有效期 }。
 * products 为空视为「通用券」（不限商品）。返回去重、保留顺序的券列表。
 */
export function parseStoreCoupons(raw) {
  const d = body(raw);
  const list = Array.isArray(d) ? d : Array.isArray(d?.coupons) ? d.coupons : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.couponId ?? c.id ?? c.couponCode ?? '').trim();
    const title = String(c.title ?? c.couponName ?? c.name ?? '').trim();
    if (!title) continue; // 没名字的不展示
    const key = id || title;
    if (seen.has(key)) continue;
    seen.add(key);
    const products = (Array.isArray(c.products) ? c.products : [])
      .map((p) => String(p?.productCode ?? '').trim())
      .filter(Boolean);
    out.push({ id, code: String(c.couponCode ?? '').trim(), title, products, validTill: String(c.tradeDateTime ?? '').trim() || null });
  }
  return out;
}

/** 从券列表里挑「这盘里用得上」的：适用商品与托盘有交集，或通用券（products 为空） */
export function couponsForTray(coupons, trayCodes) {
  const codes = new Set((trayCodes ?? []).map(String));
  return (coupons ?? []).filter((c) => c.products.length === 0 || c.products.some((p) => codes.has(p)));
}

// ---- 地址 → 城市/关键词解析（网页与 Skill 脚本共用的纯函数）----

// 省/自治区/直辖市前缀：解析城市前先剥掉，避免把「江苏省」当成城市。
const PROVINCE_PREFIXES = [
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建',
  '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州',
  '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门',
];

// 地级市名表（不含「市」后缀），麦当劳门店覆盖的城市为主。
// 直辖市也列入，让「上海」「北京徐汇」这类无「市」写法也能解析。
const CITY_NAMES = [
  '北京', '天津', '上海', '重庆',
  '石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水',
  '太原', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁',
  '沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '盘锦',
  '长春', '吉林', '四平', '松原',
  '哈尔滨', '齐齐哈尔', '大庆', '牡丹江',
  '南京', '无锡', '徐州', '常州', '苏州', '南通', '连云港', '淮安', '盐城', '扬州', '镇江', '泰州', '宿迁',
  '杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水',
  '合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '安庆', '滁州', '阜阳', '宿州', '六安',
  '福州', '厦门', '莆田', '泉州', '漳州', '龙岩', '宁德',
  '南昌', '景德镇', '九江', '赣州', '宜春', '上饶',
  '济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '临沂', '德州', '聊城', '滨州', '菏泽',
  '郑州', '开封', '洛阳', '平顶山', '安阳', '新乡', '焦作', '许昌', '漯河', '南阳', '商丘', '信阳', '周口', '驻马店',
  '武汉', '黄石', '十堰', '宜昌', '襄阳', '荆州', '黄冈', '孝感',
  '长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '益阳', '郴州',
  '广州', '韶关', '深圳', '珠海', '汕头', '佛山', '江门', '湛江', '茂名', '肇庆', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山', '潮州', '揭阳', '云浮',
  '海口', '三亚',
  '成都', '自贡', '攀枝花', '泸州', '德阳', '绵阳', '广元', '遂宁', '内江', '乐山', '南充', '眉山', '宜宾', '广安', '达州', '雅安', '资阳',
  '贵阳', '遵义', '安顺', '六盘水',
  '昆明', '曲靖', '玉溪', '大理',
  '西安', '铜川', '宝鸡', '咸阳', '渭南', '汉中', '榆林', '安康',
  '兰州', '金昌', '白银', '天水', '酒泉', '庆阳',
  '西宁',
  '呼和浩特', '包头', '乌海', '赤峰', '通辽', '鄂尔多斯', '呼伦贝尔',
  '南宁', '柳州', '桂林', '梧州', '北海', '玉林',
  '拉萨',
  '银川', '石嘴山', '吴忠',
  '乌鲁木齐', '克拉玛依',
  '香港', '澳门',
];
// 长名在前，避免「南」先于「南京」匹配导致截断（JS 正则交替取最左最先，故按长度排序）。
const CITY_RE = new RegExp(
  '^(' + [...CITY_NAMES].sort((a, b) => b.length - a.length).join('|') + ')',
);

/**
 * 解析地址里的城市与剩余关键词。
 * - 「江苏南京徐庄软件园」→ { city:'南京市', keyword:'徐庄软件园' }
 * - 「江苏省南京市建邺区…」→ 先剥「江苏省」，再认「南京市」
 * - 「江苏南京」只写到城市 → { city:'南京市', keyword:'南京' }（拿城市名本身当关键词）
 * - 既认城市名表，也兼容直接写「上海市/延边自治州」等带后缀的旧写法
 * 解析不出城市时返回 { city:'', keyword:原地址 }。
 */
export function parseCity(address) {
  let s = String(address ?? '').trim();
  // 1) 剥掉省/自治区/直辖市前缀（「江苏省」「江苏」「内蒙古自治区」「内蒙古」都剥）
  for (const p of PROVINCE_PREFIXES) {
    if (s.startsWith(p)) {
      const rest = s.slice(p.length).replace(/^(省|自治区|特别行政区)/, '');
      // 前缀后面还接着城市名表里的城市，才认定它是省前缀（否则「上海市」别被当省剥空）
      if (CITY_RE.test(rest)) { s = rest; }
      break;
    }
  }
  // 2) 认城市名表：「南京…」「南京市…」都从城市名开始匹配
  const m = s.match(CITY_RE);
  if (m) {
    const base = m[1];
    let keyword = s.slice(base.length).replace(/^市/, '').trim();
    if (!keyword) keyword = base; // 只写到城市：用城市名本身当关键词
    return { city: base + '市', keyword };
  }
  // 3) 兜底：旧写法里带「市/自治州/地区/盟」后缀的城市
  const legacy = s.match(/^(.{2,8}?(?:市|自治州|地区|盟))/);
  if (legacy) {
    const city = legacy[1];
    const keyword = s.slice(city.length).trim() || city.replace(/(市|自治州|地区|盟)$/, '');
    return { city, keyword };
  }
  return { city: '', keyword: s };
}

/** 从地址里猜城市：「江苏南京徐庄软件园」→「南京市」；猜不到返回空串 */
export function guessCity(address) {
  return parseCity(address).city;
}
