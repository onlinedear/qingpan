// 轻盘 · 界面主程序
import { plan, blindBox, swap, totals, walkKcal, weatherMood, SLOTS, SLOT_LABEL, hasNutrition } from './planner.js';
import * as api from './api.js';
import * as ch from './challenge.js';
import { drawCard } from './share-card.js';

const $ = (s, r = document) => r.querySelector(s);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  goal: { kcal: 600, protein: 25 },
  items: [],
  live: false, // 已加载到真实门店菜单
  stores: [],
  store: null,
  origin: null, // 用户位置 "lng,lat"，只在内存里，不保存
  weather: null,
  plans: [],
  idx: 0,
  tray: [],
  walk: { distance: 0, kcal: 0, on: true },
};

// ---------- 主题 ----------
const THEME_KEY = 'qingpan.theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#171511' : '#F4EFE4');
}
applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const go = () => { applyTheme(t); localStorage.setItem(THEME_KEY, t); };
  document.startViewTransition && !reduced ? document.startViewTransition(go) : go();
});

// ---------- 小工具 ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

/** 翻牌数字：每位数字一列，靠 translateY 滚到目标值 */
function odo(el, value, decimals = 0) {
  const str = Number(value || 0).toFixed(decimals);
  const cur = el.dataset.v;
  el.setAttribute('aria-label', str);
  if (cur === str) return;
  el.dataset.v = str;
  // 位数变化时重建结构，让新增的位从 0 滚上来
  if (el.childElementCount !== str.length || reduced) {
    el.innerHTML = [...str].map((c) =>
      /\d/.test(c)
        ? `<span class="d" aria-hidden="true"><i>${'0123456789'.split('').map((n) => `<span>${n}</span>`).join('')}</i></span>`
        : `<span class="sep" aria-hidden="true">${c}</span>`).join('');
    if (reduced) {
      [...el.querySelectorAll('.d i')].forEach((col, k) => { col.style.transform = `translateY(${-Number(str.replace(/\D/g, '')[k]) * 1.15}em)`; });
      return;
    }
    el.getBoundingClientRect(); // 先落在 0，再滚
  }
  const digits = str.replace(/[^\d]/g, '');
  [...el.querySelectorAll('.d i')].forEach((col, k) => {
    col.style.transitionDelay = `${(digits.length - 1 - k) * 40}ms`;
    col.style.transform = `translateY(${-Number(digits[k]) * 1.15}em)`;
  });
}

const vt = (fn, dir = 1) => {
  if (!document.startViewTransition || reduced) return fn();
  document.documentElement.style.setProperty('--dir', String(dir));
  return document.startViewTransition(fn);
};

// ---------- 目标控件 ----------
const kcalIn = $('#kcal');
function syncRange() {
  const p = ((kcalIn.value - kcalIn.min) / (kcalIn.max - kcalIn.min)) * 100;
  kcalIn.style.setProperty('--fill', `${p}%`);
  $('#kcalOut').textContent = kcalIn.value;
}
let replanTimer;
kcalIn.addEventListener('input', () => {
  syncRange();
  state.goal.kcal = Number(kcalIn.value);
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => replan('swap'), 160);
});
syncRange();

const seg = $('#protein');
function setProtein(btn, focus) {
  const btns = [...seg.querySelectorAll('button')];
  btns.forEach((b) => { b.setAttribute('aria-checked', String(b === btn)); b.tabIndex = b === btn ? 0 : -1; });
  seg.style.setProperty('--i', String(btns.indexOf(btn)));
  seg.querySelector('.seg-thumb').style.transform = `translateX(${btns.indexOf(btn) * 100}%)`;
  state.goal.protein = Number(btn.dataset.v);
  if (focus) btn.focus();
}
seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { setProtein(b); replan('swap'); }
});
seg.addEventListener('keydown', (e) => {
  const btns = [...seg.querySelectorAll('button')];
  const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  setProtein(btns[(i + d + btns.length) % btns.length], true);
  replan('swap');
});
setProtein(seg.querySelector('[aria-checked=true]'));

// ---------- 托盘渲染 ----------
const ICON = { main: '主', side: '配', drink: '饮', dessert: '甜' };
const chevron = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d > 0 ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'}"/></svg>`;

function slotHtml(slot, item, i) {
  if (!item) {
    return `<li class="slot empty" data-slot="${slot}" style="--n:${i}">
      <div class="slot-ic">${ICON[slot]}</div>
      <div><div class="slot-name">不加${SLOT_LABEL[slot]}</div><div class="slot-meta">留点热量余量</div></div>
      <div class="slot-k"><div class="slot-nav"><button type="button" data-dir="-1" aria-label="上一个${SLOT_LABEL[slot]}">${chevron(-1)}</button><button type="button" data-dir="1" aria-label="下一个${SLOT_LABEL[slot]}">${chevron(1)}</button></div></div>
    </li>`;
  }
  const mood = state.weather?.mood;
  const fits = (mood === 'rain' || mood === 'cold') ? item.tags?.includes('hot') : mood === 'hot' ? item.tags?.includes('iced') || item.tags?.includes('light') : false;
  const chips = [
    item.protein >= 15 ? '<span class="chip">高蛋白</span>' : '',
    item.tags?.includes('light') ? '<span class="chip">清爽</span>' : '',
    fits ? `<span class="chip w">${mood === 'hot' ? '适合热天' : '暖一暖'}</span>` : '',
  ].join('');
  return `<li class="slot" data-slot="${slot}" style="--n:${i}">
    <div class="slot-ic">${ICON[item.cat] ?? ICON[slot]}</div>
    <div>
      <div class="slot-name">${esc(item.name)}</div>
      <div class="slot-meta"><span>${SLOT_LABEL[slot]}</span><span>蛋白质 ${item.protein}g</span>${chips}</div>${item.approx ? `<div class="slot-note">营养按「${esc(item.nutritionName)}」估算</div>` : ''}
    </div>
    <div class="slot-k">${item.approx ? '≈' : ''}${item.kcal}<small>千卡${Number.isFinite(item.price) ? ` · ¥${item.price}` : ''}</small>
      <div class="slot-nav"><button type="button" data-dir="-1" aria-label="上一个${SLOT_LABEL[slot]}">${chevron(-1)}</button><button type="button" data-dir="1" aria-label="下一个${SLOT_LABEL[slot]}">${chevron(1)}</button></div>
    </div>
  </li>`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slotOf = (it) => (it.cat === 'dessert' ? 'side' : it.cat);

function renderTray(mode, changedSlot) {
  const ol = $('#slots');
  if (!state.live) return renderWaiting();
  const bySlot = Object.fromEntries(SLOTS.map((s) => [s, state.tray.find((i) => slotOf(i) === s) ?? null]));
  ol.innerHTML = SLOTS.map((s, i) => slotHtml(s, bySlot[s], i)).join('');
  for (const li of ol.children) {
    if (mode === 'flip') li.classList.add('flip');
    li.style.viewTransitionName = changedSlot === li.dataset.slot ? 'slot-swap' : `slot-${li.dataset.slot}`;
  }
  renderLabel();
  setTimeout(() => ol.querySelectorAll('.flip').forEach((li) => li.classList.remove('flip')), 1400);
}

/** 还没有门店菜单时的托盘：骨架占位 + 一句引导，不放任何假餐品 */
let waitingMsg = '正在定位，查找你附近的麦当劳…';
let waitingAction = null; // { label, run }
function renderWaiting(msg, action) {
  if (msg !== undefined) { waitingMsg = msg; waitingAction = action ?? null; }
  $('#slots').innerHTML = SLOTS.map((s, i) => `<li class="slot skeleton" style="--n:${i}" aria-hidden="true">
      <div class="slot-ic">${ICON[s]}</div><div><div class="sk sk-a"></div><div class="sk sk-b"></div></div><div class="sk sk-c"></div></li>`).join('')
    + `<li class="waiting" role="status"><p>${esc(waitingMsg)}</p>${waitingAction ? `<button class="solid" type="button" id="waitingBtn">${esc(waitingAction.label)}</button>` : ''}</li>`;
  if (waitingAction) $('#waitingBtn').addEventListener('click', waitingAction.run);
  $('#tray').classList.toggle('busy', !waitingAction);
  renderLabel();
}

function renderLabel() {
  const t = totals(state.tray);
  const walk = state.walk.on ? state.walk.kcal : 0;
  $('#itemCount').textContent = `本餐 ${state.tray.length} 件`;
  $('#dataTag').textContent = state.live ? '官方营养数据' : '等待门店菜单';
  odo($('#kcalTotal'), t.kcal);
  const dp = (v) => (Number.isInteger(v) ? 0 : 1);
  odo($('#proteinTotal'), t.protein, dp(t.protein));
  odo($('#fatTotal'), t.fat, dp(t.fat));
  odo($('#carbTotal'), t.carb, dp(t.carb));
  odo($('#sodiumTotal'), t.sodium);

  const pct = Math.min(Math.round((t.kcal / state.goal.kcal) * 100), 100);
  const walkPct = Math.min(Math.round((walk / state.goal.kcal) * 100), pct);
  const ring = $('#ring');
  ring.style.setProperty('--p', String(pct));
  ring.style.setProperty('--w', String(walkPct));
  ring.setAttribute('aria-label', `已用目标热量 ${pct}%`);
  $('#ringPct').textContent = String(pct);
  const left = state.goal.kcal - t.kcal;
  $('#ringTxt').innerHTML = !state.live
    ? '找到门店后<br>从实时菜单里配餐'
    : !state.tray.length
    ? '在这个目标下配不出来，<br>试试放宽热量或蛋白质'
    : `还剩 <b>${left}</b> 千卡余量${walk ? `<br>走着去再抵掉 ${walk} 千卡` : ''}<br>${t.protein >= state.goal.protein ? '蛋白质达标 ✓' : `蛋白质还差 ${(state.goal.protein - t.protein).toFixed(1)}g`}`;
  $('#priceLine').innerHTML = t.price != null ? `菜单价合计 <b>¥${t.price}</b>` : '';
}

function replan(mode = 'flip', seed) {
  if (!state.live) return;
  state.plans = plan(state.items, state.goal, { weather: state.weather, seed, limit: 6 });
  state.idx = 0;
  const next = state.plans[0]?.tray ?? [];
  const same = next.map((i) => i.code).join() === state.tray.map((i) => i.code).join();
  state.tray = next;
  if (mode === 'swap' && same) return renderLabel();
  mode === 'swap' ? vt(() => renderTray()) : renderTray(mode);
  verifyPrice();
}

let priceTimer;
function verifyPrice() {
  clearTimeout(priceTimer);
  if (!state.live || !state.store || !state.tray.length) return;
  priceTimer = setTimeout(async () => {
    const tray = state.tray;
    const p = await api.verifyPrice(state.store, tray);
    if (!p || tray !== state.tray) return;
    $('#priceLine').innerHTML = p.personal
      ? `你的到手价 <b>¥${p.price}</b> · 原价 ¥${p.original}`
      : `门店算价 <b>¥${p.original}</b>`;
    loadCoupons(tray);
  }, 600);
}

// 当前门店可用券（个人模式才有）：展示这盘里用得上几张券，引导到 App 用券下单。
// 纯展示，不替用户领券/下单。
async function loadCoupons(tray) {
  const line = $('#couponLine');
  if (!line) return;
  const { usable } = await api.storeCoupons(state.store, tray).catch(() => ({ usable: [] }));
  if (tray !== state.tray) return; // 盘已经变了，丢弃过期结果
  if (!usable.length) { line.hidden = true; line.textContent = ''; return; }
  const names = usable.slice(0, 2).map((c) => c.title).join('、');
  const more = usable.length > 2 ? ` 等 ${usable.length} 张` : '';
  line.textContent = `🎟 这家店你有可用券：${names}${more}，到 麦当劳 App 下单时记得用上。`;
  line.hidden = false;
}

// ---------- 换一件：按钮 + 左右滑动 ----------
function doSwap(slot, dir) {
  const next = swap(state.tray, slot, state.items, state.goal, dir, { weather: state.weather });
  if (!next) return toast(`在目标内没有别的${SLOT_LABEL[slot]}可换了`);
  state.tray = next;
  vt(() => renderTray(null, slot), dir);
  verifyPrice();
  navigator.vibrate?.(8);
}

const slotsEl = $('#slots');
slotsEl.addEventListener('click', (e) => {
  const b = e.target.closest('.slot-nav button');
  if (b) doSwap(b.closest('.slot').dataset.slot, Number(b.dataset.dir));
});

let drag = null;
slotsEl.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('.slot');
  if (!li || e.target.closest('button')) return;
  drag = { li, x: e.clientX, y: e.clientY, dx: 0, id: e.pointerId, moved: false };
  li.classList.add('pressed');
});
slotsEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(drag.dx) > 8 && Math.abs(drag.dx) > Math.abs(dy)) {
    drag.moved = true;
    drag.li.setPointerCapture(e.pointerId);
    drag.li.classList.add('dragging');
    drag.li.classList.remove('pressed');
  }
  if (drag.moved) {
    // 橡皮筋阻尼：拖得越远越难拖
    const r = Math.sign(drag.dx) * Math.min(Math.abs(drag.dx), 220) ** 0.85;
    drag.li.style.transform = `translateX(${r}px) rotate(${r / 40}deg)`;
  }
});
function endDrag() {
  if (!drag) return;
  const { li, dx, moved } = drag;
  drag = null;
  li.classList.remove('pressed', 'dragging');
  li.style.transform = '';
  if (moved && Math.abs(dx) > 60) doSwap(li.dataset.slot, dx < 0 ? 1 : -1);
}
slotsEl.addEventListener('pointerup', endDrag);
slotsEl.addEventListener('pointercancel', endDrag);
slotsEl.addEventListener('pointerleave', (e) => { if (drag && !drag.moved) endDrag(e); });

$('#nextBtn').addEventListener('click', () => {
  if (!state.live) return toast('先找到附近门店');
  if (state.plans.length < 2) return toast('在这个目标下只有这一种配法');
  state.idx = (state.idx + 1) % state.plans.length;
  state.tray = state.plans[state.idx].tray;
  vt(() => renderTray(), 1);
  verifyPrice();
});

// ---------- 摇一摇盲盒 ----------
const shakeBtn = $('#shakeBtn');
function openBlindBox() {
  if (!state.live) return toast('先找到附近门店，才能开盲盒');
  const p = blindBox(state.items, state.goal, { weather: state.weather, seed: (Math.random() * 2 ** 31) | 0 });
  if (!p) return toast('目标太紧了，盲盒里抽不出来');
  shakeBtn.classList.add('shaking');
  navigator.vibrate?.([12, 40, 12]);
  setTimeout(() => {
    shakeBtn.classList.remove('shaking');
    state.tray = p.tray;
    renderTray('flip');
    verifyPrice();
  }, reduced ? 0 : 420);
}

let motionOn = false;
async function enableShake() {
  if (motionOn || typeof DeviceMotionEvent === 'undefined') return;
  try {
    // iOS 13+ 需要用户点击后申请权限
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return;
    }
  } catch { return; }
  motionOn = true;
  let last = 0;
  let prev = null;
  addEventListener('devicemotion', (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    if (prev) {
      const delta = Math.abs(a.x - prev.x) + Math.abs(a.y - prev.y) + Math.abs(a.z - prev.z);
      const now = Date.now();
      if (delta > 32 && now - last > 1500) { last = now; openBlindBox(); }
    }
    prev = { x: a.x, y: a.y, z: a.z };
  });
  toast('摇一摇已开启，晃动手机开盲盒');
}
shakeBtn.addEventListener('click', () => { enableShake(); openBlindBox(); });

// ---------- 天气 ----------
const MOOD_COPY = {
  rain: { line: (w) => `${w.city} · ${w.text} ${w.temp}°`, lede: '下雨天，托盘里会优先放一杯热的。' },
  cold: { line: (w) => `${w.city} · ${w.text} ${w.temp}°`, lede: '有点凉，给你配点暖胃的。' },
  hot: { line: (w) => `${w.city} · ${w.text} ${w.temp}°`, lede: '天热，优先清爽和无糖的选择。' },
  mild: { line: (w) => `${w.city} · ${w.text} ${w.temp}°`, lede: '天气不错，适合走着去门店。' },
};
async function loadWeather(location, cityName) {
  const line = $('#weatherLine');
  if (!location) { line.hidden = true; return; }
  try {
    const w = await api.weather(location);
    if (!w.city && cityName) w.city = cityName; // 天气源不返回城市名，用定位/地理编码拿到的城市补
    w.mood = weatherMood(w);
    state.weather = w;
    const copy = MOOD_COPY[w.mood] ?? MOOD_COPY.mild;
    $('#weatherText').textContent = copy.line(w);
    $('#lede').textContent = copy.lede;
    line.hidden = false;
    if (state.live) replan('swap'); // 天气会影响推荐，到了就重排一次
  } catch {
    line.hidden = true; // 拿不到就不显示，不编天气
  }
}

// ---------- 门店与位置 ----------
function setMode(st) {
  const m = $('#mode');
  const live = state.live;
  m.textContent = live ? (st?.mine ? '我的 Token · 实时' : '实时数据') : (st?.mine ? '我的 Token' : '未连接');
  m.classList.toggle('live', live && !st?.mine);
  m.classList.toggle('mine', Boolean(st?.mine));
  $('#keyBtn').classList.toggle('on', Boolean(st?.mine));
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`);
const askToken = { label: '填写我的 MCP Token', run: () => $('#keyBtn').click() };

/** 处理"能力不可用"：给出对应引导，不回落假数据 */
function handleUnavailable(e) {
  if (e instanceof api.Unavailable && e.what === 'mcd') {
    $('#storeLine').textContent = '需要麦当劳 MCP Token 才能查询门店和菜单';
    renderWaiting('填写你在麦当劳开放平台申请的 MCP Token，就能看到附近门店的实时菜单。', askToken);
    return true;
  }
  return false;
}

function renderStores() {
  const ul = $('#stores');
  if (state.stores.length < 2) { ul.hidden = true; ul.innerHTML = ''; return; }
  ul.hidden = false;
  ul.innerHTML = state.stores.map((s, i) => `<li><button type="button" class="store-chip" data-i="${i}" aria-pressed="${s === state.store}" ${s.open ? '' : 'data-closed'}>
      <b>${esc(s.name.replace(/^麦当劳/, ''))}</b>
      <span>${Number.isFinite(s.distance) ? fmtDist(s.distance) : ''}${s.hours ? ` · ${esc(s.hours)}` : ''}${s.open ? '' : ' · 暂停营业'}</span>
    </button></li>`).join('');
}
$('#stores').addEventListener('click', (e) => {
  const b = e.target.closest('.store-chip');
  if (b) selectStore(state.stores[Number(b.dataset.i)]);
});

/** 搜附近门店并列出来，默认选最近一家营业中的 */
async function findStores(keywords, city) {
  state.lastQuery = { keywords, city };
  const line = $('#storeLine');
  line.textContent = '正在找附近的门店…';
  renderWaiting('正在找附近的门店…');
  try {
    state.stores = await api.findStores(keywords, city);
    if (!state.stores.length) {
      line.textContent = '附近没找到可到店的门店';
      renderWaiting('附近没找到门店，换个更具体的地点试试，比如商场或地铁站名。');
      return;
    }
    await selectStore(state.stores.find((s) => s.open) ?? state.stores[0]);
  } catch (e) {
    if (handleUnavailable(e)) return;
    line.textContent = `门店查询失败：${e.message}`;
    renderWaiting('门店暂时查不到，稍后再试，或换个地点。');
  }
}

async function selectStore(store) {
  state.store = store;
  renderStores();
  const line = $('#storeLine');
  const dist = Number.isFinite(store.distance) ? ` · 约 ${fmtDist(store.distance)}` : '';
  const hours = store.hours ? ` · ${store.hours}` : '';
  const closed = store.open === false ? ' · <b>暂停营业</b>' : '';
  line.innerHTML = `<b>${esc(store.name)}</b>${dist}${hours}${closed}`;
  renderWaiting(`正在读取${store.name.replace(/^麦当劳/, '')}的菜单…`);
  try {
    state.items = await api.loadMenu(store);
    state.live = true;
    $('#tray').classList.remove('busy');
    setMode(await api.status());
    renderNodata();
    replan('flip');
    const ok = state.items.filter(hasNutrition).length;
    toast(`${store.name.replace(/^麦当劳/, '')}：${state.items.length} 款单品，${ok} 款有官方营养数据`);
    loadWalk();
  } catch (e) {
    state.live = false;
    if (handleUnavailable(e)) return;
    renderWaiting(`菜单暂时读不到：${e.message}`);
  }
}

$('#addrForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = $('#addr').value.trim();
  if (!address) return toast('先输入一个地点，例如「上海市人民广场」');
  const geo = await api.geocode(address).catch(() => null);
  if (geo) { state.origin = geo.location; loadWeather(geo.location, geo.city); }
  findStores([address], geo?.city);
});

/** 定位 → 逆地理编码得到城市和附近地标 → 搜门店。坐标只在内存里用，不保存 */
function locate({ auto = false } = {}) {
  if (!navigator.geolocation) {
    $('#storeLine').textContent = '这个浏览器不支持定位，请输入地点';
    renderWaiting('输入「城市 + 地点」，例如「上海市人民广场」，就能找到附近门店。');
    return;
  }
  const btn = $('#locBtn');
  btn.classList.add('busy');
  $('#storeLine').textContent = '正在定位…';
  renderWaiting('正在定位，查找你附近的麦当劳…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    btn.classList.remove('busy');
    const { longitude: lng, latitude: lat } = pos.coords;
    state.origin = `${lng.toFixed(6)},${lat.toFixed(6)}`;
    let re;
    try {
      re = await api.reverseGeocode(lng, lat);
    } catch (e) {
      $('#storeLine').textContent = e instanceof api.Unavailable ? '站点暂不支持按定位找店，请输入地点' : `定位后识别地点失败：${e.message}`;
      renderWaiting('输入「城市 + 地点」，例如「上海市人民广场」，就能找到附近门店。');
      return;
    }
    if (re?.formatted) $('#addr').value = re.formatted.replace(/^.{2,6}?(省|自治区)/, '');
    loadWeather(state.origin, re?.city);
    findStores(re?.keywords?.length ? re.keywords : [re?.formatted], re?.city);
  }, (err) => {
    btn.classList.remove('busy');
    const denied = err.code === 1;
    $('#storeLine').textContent = denied ? '没有获得定位权限' : '定位失败';
    renderWaiting(
      denied ? '没关系，在上面输入「城市 + 地点」也能找到附近门店；或在浏览器设置里允许定位后重试。' : '定位超时了，可以重试，或直接输入地点。',
      { label: '重新定位', run: () => locate() },
    );
    if (!auto) toast(denied ? '没有获得定位权限，可以手动输入地点' : '定位失败，请手动输入地点');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}
$('#locBtn').addEventListener('click', () => locate());

// ---------- 走着去 ----------
function project(polyline, w = 320, h = 180, pad = 22) {
  const pts = polyline.split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 2) return [];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((w - pad * 2) / (x1 - x0 || 1e-6), (h - pad * 2) / (y1 - y0 || 1e-6));
  const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  return pts.map(([x, y]) => [ox + (x - x0) * s, h - (oy + (y - y0) * s)]); // 纬度向上
}

let walkerAnim;
async function loadWalk() {
  const svg = $('#route');
  const sec = $('#walk');
  state.walk.kcal = 0;
  // 只有真实的出发点和门店坐标都在时才显示，没有就整块隐藏，不画示意路线
  if (!state.origin || !state.store) { sec.hidden = true; renderLabel(); return; }
  try {
    const dest = await api.locateStore(state.store);
    if (!dest) { sec.hidden = true; renderLabel(); return; }
    const r = await api.walkRoute(state.origin, dest);
    const round = r.distance * 2;
    state.walk.distance = round;
    state.walk.kcal = walkKcal(round);
    sec.hidden = false;
    odo($('#walkKcal'), state.walk.kcal);
    $('#walkDesc').textContent = `往返约 ${fmtDist(round)}，步行 ${Math.round((r.duration * 2) / 60)} 分钟。按 60 公斤体重估算，仅供参考。`;

    const pts = project(r.polyline);
    if (!pts.length) return;
    const d = 'M' + pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join(' L');
    svg.classList.remove('drawn');
    svg.querySelector('.route-bg').setAttribute('d', d);
    const line = svg.querySelector('.route-line');
    line.setAttribute('d', d);
    const len = line.getTotalLength();
    line.style.setProperty('--len', String(len));
    const [a, b] = [pts[0], pts.at(-1)];
    svg.querySelector('.route-a').setAttribute('cx', a[0]); svg.querySelector('.route-a').setAttribute('cy', a[1]);
    svg.querySelector('.route-b').setAttribute('cx', b[0]); svg.querySelector('.route-b').setAttribute('cy', b[1]);
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add('drawn')));

    // 小人沿路线走一趟
    cancelAnimationFrame(walkerAnim);
    const walker = svg.querySelector('.route-walker');
    if (reduced) { const p = line.getPointAtLength(len); walker.setAttribute('cx', p.x); walker.setAttribute('cy', p.y); }
    else {
      const t0 = performance.now() + 1600;
      const step = (now) => {
        const t = ((now - t0) / 3600) % 2;
        const k = t < 0 ? 0 : t <= 1 ? t : 2 - t; // 去了再回来
        const p = line.getPointAtLength(len * (0.5 - Math.cos(k * Math.PI) / 2));
        walker.setAttribute('cx', p.x); walker.setAttribute('cy', p.y);
        walkerAnim = requestAnimationFrame(step);
      };
      walkerAnim = requestAnimationFrame(step);
    }
    renderLabel();
  } catch {
    sec.hidden = true; // 路线算不出来就不显示，不画假路线
    renderLabel();
  }
}
$('#walkToggle').addEventListener('change', (e) => { state.walk.on = e.target.checked; renderLabel(); });

// ---------- 7 天挑战 ----------
function applyPattern(id) {
  $('#tray').dataset.pattern = id;
  localStorage.setItem('qingpan.pattern', id);
  document.querySelectorAll('.pat').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === id)));
}
function renderChallenge(popToday = false) {
  const s = ch.load();
  const n = ch.streak(s);
  const today = ch.dayKey();
  $('#week').innerHTML = ch.lastWeek(s).map(({ date, rec }) => {
    const d = new Date(date.replace(/-/g, '/'));
    const wd = '日一二三四五六'[d.getDay()];
    return `<li class="${rec ? 'done' : ''} ${date === today ? 'today' : ''} ${popToday && date === today ? 'pop' : ''}" aria-label="${date}${rec ? ` 已打卡 ${rec.kcal} 千卡` : ' 未打卡'}">
      <span>周${wd}</span><b>${d.getDate()}</b><span>${rec ? `${rec.kcal}` : '·'}</span></li>`;
  }).join('');
  $('#chTxt').textContent = n
    ? `已连续 ${n} 天${n >= 7 ? '，全部花纹已解锁 🎉' : `，再坚持 ${7 - Math.min(n, 7)} 天解锁全部花纹`}。记录只存在这台设备的浏览器里。`
    : '连续打卡解锁新的托盘纸花纹。记录只存在这台设备的浏览器里。';
  const open = new Set(ch.unlocked(n).map((p) => p.id));
  open.add('plain');
  const cur = localStorage.getItem('qingpan.pattern') || 'plain';
  $('#patterns').innerHTML = ch.PATTERNS.map((p) =>
    `<button type="button" class="pat" role="radio" data-id="${p.id}" aria-checked="${p.id === cur}" ${open.has(p.id) ? '' : 'disabled'} aria-label="${p.name}${open.has(p.id) ? '' : `，连续 ${p.day} 天解锁`}">
      <i class="tray" data-pattern="${p.id}" style="padding:0;box-shadow:none"></i><span>${open.has(p.id) ? p.name : `${p.day}天`}</span></button>`).join('');
  applyPattern(open.has(cur) ? cur : 'plain');
  return n;
}
$('#patterns').addEventListener('click', (e) => { const b = e.target.closest('.pat:not(:disabled)'); if (b) applyPattern(b.dataset.id); });
$('#checkBtn').addEventListener('click', () => {
  if (!state.tray.length) return toast('托盘还是空的');
  const before = ch.streak(ch.load());
  const { streak } = ch.checkIn(totals(state.tray));
  renderChallenge(true);
  navigator.vibrate?.([10, 30, 10]);
  const newly = ch.PATTERNS.find((p) => p.day === streak && streak > before);
  toast(newly && streak > 1 ? `连续 ${streak} 天！解锁「${newly.name}」托盘纸` : `今天的托盘记下了 · 连续 ${streak} 天`);
});

// ---------- 分享卡 ----------
let shareBlob;
$('#shareBtn').addEventListener('click', () => {
  if (!state.tray.length) return toast('托盘还是空的');
  const canvas = drawCard({
    tray: state.tray,
    totals: totals(state.tray),
    goal: state.goal,
    store: state.store?.name,
    date: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
    streak: ch.streak(ch.load()),
    walkKcal: state.walk.on ? state.walk.kcal : 0,
  });
  canvas.toBlob((b) => {
    shareBlob = b;
    const img = $('#shareImg');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(b);
    $('#shareSheet').showModal();
  }, 'image/png');
});
$('#saveBtn').addEventListener('click', async () => {
  if (!shareBlob) return;
  const file = new File([shareBlob], `轻盘-${ch.dayKey()}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '今天的轻盘' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('#shareSheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- 用我自己的 Token ----------
const keySheet = $('#keySheet');
const keyInput = $('#keyInput');
const keyErr = $('#keyErr');
$('#keyBtn').addEventListener('click', () => {
  keyInput.value = '';
  keyInput.type = 'password';
  $('#keyShow').textContent = '显示';
  keyErr.textContent = '';
  const has = Boolean(api.userToken.get());
  $('#keyClear').hidden = !has;
  // 已填写的 Token 不回显，只能替换或清除
  keyInput.placeholder = has ? '已填写（不回显），粘贴新的可替换' : '粘贴你的 Token';
  keySheet.showModal();
  keyInput.focus();
});
$('#keyShow').addEventListener('click', (e) => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? '隐藏' : '显示';
  e.currentTarget.setAttribute('aria-pressed', String(show));
});
$('#keyForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return; // 取消按钮走默认关闭
  e.preventDefault();
  const t = keyInput.value.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9._~+/=-]{16,256}$/.test(t)) {
    keyErr.textContent = 'Token 格式不对，请从控制台重新复制（不要带空格）';
    return;
  }
  const btn = $('#keySave');
  btn.disabled = true;
  btn.textContent = '验证中…';
  keyErr.textContent = '';
  const prev = api.userToken.get();
  api.userToken.set(t);
  try {
    await api.checkUserToken();
    keyInput.value = '';
    keySheet.close();
    setMode(await api.status());
    toast('Token 可用，已切换到你自己的账号查询');
    const q = state.lastQuery;
    if (q?.keywords) findStores(q.keywords, q.city);
    else if ((await api.status()).amap) locate();
    else $('#storeLine').textContent = '输入「城市 + 地点」，查看你附近门店的实时菜单';
  } catch (err) {
    api.userToken.set(prev);
    keyErr.textContent = [400, 401, 502].includes(err.status) ? 'Token 无效或已过期，请去控制台重新生成' : `验证失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并刷新菜单';
  }
});
$('#keyClear').addEventListener('click', async () => {
  api.userToken.set('');
  keySheet.close();
  setMode(await api.status());
  toast('已清除你的 Token');
});
keySheet.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
addEventListener('qingpan:token-invalid', async () => {
  setMode(await api.status());
  toast('你的 Token 已失效，已清除，请重新填写');
});

// ---------- 暂无数据 ----------
function renderNodata() {
  const miss = state.items.filter((i) => !hasNutrition(i));
  $('#nodataSec').hidden = !miss.length;
  $('#nodataList').innerHTML = miss.slice(0, 24).map((i) => `<li>${esc(i.name)}</li>`).join('');
}

// ---------- 启动 ----------
(async function boot() {
  renderChallenge();
  $('#weatherLine').hidden = true;
  $('#walk').hidden = true;
  renderWaiting('正在连接…');
  const st = await api.status();
  setMode(st);
  // 没有任何可用的麦当劳 Token：引导访客填自己的，不显示假数据
  if (!st.mcd) {
    $('#storeLine').textContent = '需要麦当劳 MCP Token 才能查询门店和菜单';
    renderWaiting('填写你在麦当劳开放平台申请的 MCP Token，就能看到附近门店的实时菜单。', askToken);
    return;
  }
  // 能按坐标识别地点时，一打开就定位找附近门店；否则请用户输入地点
  if (st.amap) locate({ auto: true });
  else {
    $('#storeLine').textContent = '输入「城市 + 地点」，查看你附近门店的实时菜单';
    renderWaiting('在上面输入「城市 + 地点」，例如「上海市人民广场」，就能找到附近门店。');
    $('#locBtn').hidden = true; // 站点没接腾讯地图时定位无法换算成地点
  }
})();

export { state }; // 便于在控制台调试
