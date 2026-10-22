// 测试夹具：只给配餐引擎的单元测试用，网页里不会加载。数值为虚构的近似值，不是官方营养数据。
export const DEMO = true;

export const DEMO_STORE = { code: 'demo', name: '示意门店 · 人民广场店', address: '示意地址', distance: 650 };

export const DEMO_ITEMS = [
  { code: 'm1', name: '示意·烤鸡腿堡', cat: 'main', kcal: 360, protein: 26, fat: 12, carb: 38, sodium: 820, price: 19, tags: ['protein'] },
  { code: 'm2', name: '示意·鸡肉卷', cat: 'main', kcal: 410, protein: 22, fat: 17, carb: 42, sodium: 900, price: 17, tags: [] },
  { code: 'm3', name: '示意·双层牛肉堡', cat: 'main', kcal: 520, protein: 30, fat: 26, carb: 40, sodium: 1050, price: 23, tags: ['protein'] },
  { code: 'm4', name: '示意·鱼肉堡', cat: 'main', kcal: 330, protein: 15, fat: 13, carb: 38, sodium: 600, price: 16, tags: [] },
  { code: 'm5', name: '示意·嫩鸡块 6 块', cat: 'main', kcal: 270, protein: 15, fat: 16, carb: 15, sodium: 540, price: 15, tags: ['protein'] },
  { code: 'm6', name: '示意·早餐蛋堡', cat: 'main', kcal: 290, protein: 17, fat: 12, carb: 28, sodium: 700, price: 12, tags: ['hot'] },
  { code: 's1', name: '示意·玉米杯', cat: 'side', kcal: 90, protein: 3, fat: 2, carb: 16, sodium: 30, price: 9, tags: ['light'] },
  { code: 's2', name: '示意·田园沙拉', cat: 'side', kcal: 60, protein: 3, fat: 2, carb: 8, sodium: 120, price: 12, tags: ['light'] },
  { code: 's3', name: '示意·小份薯条', cat: 'side', kcal: 230, protein: 3, fat: 11, carb: 30, sodium: 160, price: 9, tags: [] },
  { code: 's4', name: '示意·苹果片', cat: 'side', kcal: 35, protein: 0, fat: 0, carb: 9, sodium: 0, price: 6, tags: ['light'] },
  { code: 's5', name: '示意·热粥', cat: 'side', kcal: 150, protein: 5, fat: 2, carb: 28, sodium: 450, price: 8, tags: ['hot'] },
  { code: 'd1', name: '示意·无糖可乐', cat: 'drink', kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 20, price: 8, tags: ['iced'] },
  { code: 'd2', name: '示意·热美式', cat: 'drink', kcal: 10, protein: 0.5, fat: 0, carb: 1, sodium: 5, price: 12, tags: ['hot'] },
  { code: 'd3', name: '示意·牛奶', cat: 'drink', kcal: 130, protein: 7, fat: 7, carb: 10, sodium: 100, price: 8, tags: ['protein'] },
  { code: 'd4', name: '示意·冰红茶', cat: 'drink', kcal: 120, protein: 0, fat: 0, carb: 30, sodium: 15, price: 8, tags: ['iced'] },
  { code: 'd5', name: '示意·热豆浆', cat: 'drink', kcal: 90, protein: 6, fat: 3, carb: 9, sodium: 30, price: 7, tags: ['hot', 'protein'] },
  // 没有营养数据的餐品：真实接口里大量存在，界面要诚实展示"暂无可靠数据"
  { code: 'x1', name: '示意·季节限定饮品', cat: 'drink', price: 15, tags: [] },
  { code: 'x2', name: '示意·限定甜品', cat: 'dessert', price: 10, tags: [] },
];

export const DEMO_WEATHER = { city: '示意城市', text: '小雨', temp: 14 };
