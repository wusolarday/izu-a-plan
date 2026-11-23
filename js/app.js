import * as E from './engine.js';
import * as DB from './db.js';
import { VERSION } from './version.js';

let S = null;          // 全部資料
let D = null;          // 結算草稿
let preview = null;    // 試算結果
let sandbox = false;   // 測試模式：開始前的資料存在 'sandbox'
const $ = sel => document.querySelector(sel);
const app = $('#app');

// ---------- 格式 ----------
const fmt = n => (Math.round(n) || 0).toLocaleString('zh-TW');
const sgn = n => (Math.round(n) > 0 ? '+' : '') + fmt(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
const ymd = d => `${d.slice(0, 4)}/${md(d)}`;
const range = ev => ev.dateFrom === ev.dateTo ? ymd(ev.dateFrom) : `${ymd(ev.dateFrom)}～${md(ev.dateTo)}`;
const lastSnap = () => S.snapshots[S.snapshots.length - 1];
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const num = v => (v === '' || v == null ? null : Math.round(Number(String(v).replace(/,/g, ''))));
const tol = () => S.settings.tolerance;
// 圖示：線條 24×24，跟著文字顏色。只用大家一看就懂的（勾、鉛筆、回復、雲…）
const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M20 11a8 8 0 00-14.3-4.9L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0014.3 4.9L20 16"/><path d="M20 20.5V16h-4.5"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  warn: '<path d="M12 3.5l9 16H3l9-16z"/><path d="M12 10v4"/><path d="M12 17v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  half: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.8 2.8L16 9.5"/>',
  x: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 10.5a3.75 3.75 0 01-.5 7.5"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  restore: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
// 只有圖示的按鈕：一定要有給讀屏用的文字
const iconBtn = (name, label, attrs) => `<button class="icon-btn" aria-label="${label}" title="${label}" ${attrs}>${ic(name)}</button>`;
const rows = list => `<table class="rows">${list.filter(Boolean).map(([a, b, cls]) => `<tr class="${cls || ''}"><td>${a}</td><td class="num">${b}</td></tr>`).join('')}</table>`;

// 配色：色碼在 css/theme.css，這裡只列名稱。存在這台裝置（不進備份）
const PALETTES = { ocean: '霧藍', lavender: '薰衣草', sage: '鼠尾草', coral: '珊瑚', salmon: '鮭魚', oak: '淺橡木', wood: '胡桃木', olive: '灰橡木', graphite: '石墨' };
const MODES = { auto: '跟著手機', light: '淺色', dark: '深色' };
function setMode(m) {
  if (m === 'auto') delete document.documentElement.dataset.mode; else document.documentElement.dataset.mode = m;
  try { localStorage.setItem('mode', m); } catch (e) { /* 無痕模式存不了 */ }
  syncThemeColor();
}
function setPalette(name) {
  document.documentElement.dataset.palette = name;
  try { localStorage.setItem('palette', name); } catch (e) { /* 無痕模式存不了，只影響這次 */ }
  syncThemeColor();
}
const syncThemeColor = () => $('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);
if (!PALETTES[document.documentElement.dataset.palette]) setPalette('ocean'); // 舊的配色已拿掉，改用預設
syncThemeColor();

async function commit(msg) {
  if (msg) S.audit.push({ at: new Date().toISOString(), msg });
  await DB.save(S);
}

// ---------- 路由 ----------
const routes = { home, settle, history, plan, settings, events: plan };
function render() {
  const r = location.hash.slice(1) || 'home';
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.hash === '#' + (r === 'events' ? 'plan' : r)));
  const root = document.documentElement;
  root.toggleAttribute('data-sandbox', sandbox);
  root.toggleAttribute('data-flow', r === 'settle' && !!S); // 結算是全螢幕流程，不顯示分頁列
  $('#sbbar').innerHTML = sandbox ? '<span>測試模式中</span><button data-act="sbAsk">結束</button>' : '';
  if (!S) return welcome();
  (routes[r] || home)();
  banners();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

function banners() {
  const b = [];
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone) b.push('<div class="note bad">請用 Safari「分享 → 加入主畫面」開啟，否則久未使用時資料可能被系統清除。</div>');
  $('#banner').innerHTML = b.join('') + ($('#banner').dataset.update ? '<div class="note info">有新版本。<a href="#" data-act="update">點此更新</a></div>' : '');
}

// 不擋畫面的小提示
let toastT;
function toast(msg, icon) {
  const t = $('#toast'); t.innerHTML = (icon ? ic(icon) : '') + esc(msg); t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}
// ---------- 正向回饋：彩紙爆發 ----------
// 只在真的值得慶祝的時候用；有開「減少動態效果」就只顯示文字。不靠外部套件，自己算重力與拋物線。
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// 紙片的樣子跟著配色：鮭魚＝鮭魚片、淺橡木＝松果、胡桃木／灰橡木＝樹葉、其他＝淺黃到金黃紙片
// drag：空氣阻力係數（越大飄越慢）；sway：左右擺盪幅度
const PIECES = {
  paper: { n: 110, size: [6, 12, 9, 18], drag: [3.2, 4.2], sway: 14, colors: ['#fff6c2', '#ffec99', '#ffe066', '#fcd34d', '#f6c445', '#eab308', '#d4a017'] },
  leaf: { n: 55, size: [10, 16, 16, 24], drag: [4.2, 5.6], sway: 26, colors: ['#7f9a3e', '#9bb04a', '#c3a33a', '#d98c2b', '#b8662a', '#a7b04a', '#6f8a3a'] },
  cone: { n: 38, size: [12, 16, 18, 25], drag: [2.3, 3.0], sway: 7, colors: ['#8b5a2b', '#a0682f', '#7a4b22', '#b07a3e'] },
  salmon: { n: 40, size: [20, 28, 12, 17], drag: [2.6, 3.4], sway: 10, colors: ['#f4895c', '#f79a6e', '#ee7a4f', '#fa9f78'] },
};
const pieceKind = () => { const p = document.documentElement.dataset.palette; return p === 'salmon' ? 'salmon' : p === 'oak' ? 'cone' : ['wood', 'olive'].includes(p) ? 'leaf' : 'paper'; };
function drawPiece(ctx, kind, w, h, c) {
  ctx.fillStyle = c;
  if (kind === 'paper') { ctx.fillRect(-w / 2, -h / 2, w, h); return; }
  if (kind === 'leaf') { // 葉片＋中間葉脈
    ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.quadraticCurveTo(w / 2, -h * 0.05, 0, h / 2); ctx.quadraticCurveTo(-w / 2, -h * 0.05, 0, -h / 2); ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,10,.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -h / 2 + 2); ctx.lineTo(0, h / 2 + 3); ctx.stroke();
    return;
  }
  if (kind === 'cone') { // 松果：橢圓身體＋一排排鱗片＋頂端小梗
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,228,185,.55)'; ctx.lineWidth = 1.1;
    for (let row = -2; row <= 2; row++) {
      const y = row * h * 0.17, half = (w / 2) * Math.sqrt(Math.max(0, 1 - (y / (h / 2)) ** 2)) * 0.92, step = w / 3.2, off = row % 2 ? step / 2 : 0;
      for (let x = -half + off; x < half - 1; x += step) { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + step / 2, y + h * 0.13, x + step, y); ctx.stroke(); }
    }
    ctx.strokeStyle = '#5b3a1a'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.lineTo(0.5, -h / 2 - 3.5); ctx.stroke();
    return;
  }
  // 鮭魚片：圓角的肉塊＋兩條白色彎曲油花
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.42) : ctx.rect(-w / 2, -h / 2, w, h); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.88)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  for (const off of [-0.12, 0.2]) { ctx.beginPath(); ctx.moveTo(w * off - w * 0.08, -h / 2 + 1); ctx.quadraticCurveTo(w * off + w * 0.18, 0, w * off - w * 0.02, h / 2 - 1); ctx.stroke(); }
}
function pop(el) { // 作用物件彈性放大
  el?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: 0.35 }, { transform: 'scale(.985)', offset: 0.7 }, { transform: 'scale(1)' }],
    { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function confetti(el) {
  // 物理：重力 G 往下；空氣阻力跟速度成正比（a = G − k·v），所以噴出後很快減速，
  // 之後以「終端速度」G/k 慢慢飄落，翻面時左右擺盪；最後一段淡出。
  const kind = pieceKind(), K = PIECES[kind], rnd = (a, b) => a + Math.random() * (b - a);
  const cv = document.createElement('canvas'), dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  cv.className = 'confetti'; cv.width = W * dpr; cv.height = H * dpr; cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const r = el?.getBoundingClientRect(), ox = r ? r.left + r.width / 2 : W / 2, oy = r ? Math.min(r.bottom, H - 40) : H * 0.75;
  const G = 900;
  const P = Array.from({ length: K.n }, () => {
    const ang = (-90 + (Math.random() - 0.5) * 70) * Math.PI / 180, v = rnd(1300, 2000);
    return { x: ox + (Math.random() - 0.5) * (r ? r.width * 0.6 : 120), y: oy, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
      k: rnd(K.drag[0], K.drag[1]), w: rnd(K.size[0], K.size[1]), h: rnd(K.size[2], K.size[3]),
      rot: Math.random() * 6.3, vr: rnd(-5, 5), flip: Math.random() * 6.3, vf: rnd(3, 7), ph: Math.random() * 6.3,
      c: K.colors[Math.random() * K.colors.length | 0], life: rnd(3.2, 4.4), t: 0 };
  });
  let last = performance.now();
  const tick = now => {
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    ctx.clearRect(0, 0, W, H); let alive = 0;
    for (const q of P) {
      q.t += dt; if (q.t > q.life || q.y > H + 40) continue; alive++;
      q.vx += -q.k * q.vx * dt; q.vy += (G - q.k * q.vy) * dt; // 重力＋空氣阻力
      q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt; q.flip += q.vf * dt;
      const sway = Math.sin(q.t * 2.2 + q.ph) * K.sway * Math.min(1, q.t / 0.6); // 飄落時左右擺盪
      ctx.save(); ctx.globalAlpha = q.t > q.life - 0.9 ? Math.max(0, (q.life - q.t) / 0.9) : 1;
      ctx.translate(q.x + sway, q.y); ctx.rotate(q.rot); ctx.scale(1, Math.cos(q.flip) * 0.85 + (q.flip % 6.3 < 3.15 ? 0.15 : -0.15));
      drawPiece(ctx, kind, q.w, q.h, q.c); ctx.restore();
    }
    if (alive) requestAnimationFrame(tick); else cv.remove();
  };
  requestAnimationFrame(tick);
}
function celebrate(msg, el) {
  if (msg) toast(msg, 'star');
  if (reducedMotion()) return;
  pop(el); confetti(el);
}
// 每個畫面效果只播一次（記在這台裝置）
const once = (key, val) => { try { if (localStorage.getItem(key) === val) return false; localStorage.setItem(key, val); } catch (e) { /* 存不了就照播 */ } return true; };

// 手動檢查更新：讀線上的版本號（sw.js 不在快取裡，一定從網路拿），再請 Service Worker 下載新版
async function checkUpdate(btn) {
  btn?.classList.add('spin'); if (btn) btn.disabled = true;
  try {
    const txt = await (await fetch('sw.js?t=' + Date.now(), { cache: 'no-store' })).text();
    const latest = (txt.match(/VERSION = '([^']+)'/) || [])[1];
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      // 新版下載需要一點時間：最多等 8 秒到它準備好
      for (let i = 0; i < 40 && reg.installing && !reg.waiting; i++) await new Promise(r => setTimeout(r, 200));
    }
    if (reg?.waiting) {
      if (await ask({ title: `有新版本 ${latest || ''}`, body: `目前是 ${VERSION}。更新後畫面會重新整理，資料不受影響。`, ok: '現在更新' })) reg.waiting.postMessage('skip');
    } else if (latest && latest !== VERSION) {
      info(`線上已經有 ${latest}`, '手機還在下載新版。請把 App 完全關掉再打開，或過一下子再按一次「檢查更新」。');
    } else toast(`已經是最新版本 ${VERSION}`, 'check');
  } catch (e) {
    toast('沒有網路，等一下再試');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spin'); }
  }
}

// 確認：用 App 自己的下方面板，回傳 Promise。input 有值時，回傳輸入的文字
let askRes = null;
function ask({ title, body = '', ok = '確定', danger = false, input = '' }) {
  if (askRes) askRes(false);
  return new Promise(res => {
    askRes = res;
    sheet(`<h3>${title}</h3>${body ? `<p>${body}</p>` : ''}${input ? `<input id="ask-in" placeholder="${input}" autocomplete="off">` : ''}
      <div class="actions full col"><button class="${danger ? 'danger' : 'pri'}" data-act="askYes">${ok}</button><button class="plain" data-act="askNo">先不要</button></div>`);
    $('#ask-in')?.focus();
  });
}
function settleAsk(v) { const r = askRes; askRes = null; sheet(''); r?.(v); }
const info = (title, body) => sheet(`<h3>${title}</h3><p>${body}</p><div class="actions full col"><button class="pri" data-act="sheetClose">知道了</button></div>`);
// 從下方滑出的選擇面板
function sheet(html) {
  const el = $('#sheet');
  if (html) { el.classList.remove('out'); el.innerHTML = `<div class="sheet-bg" data-act="sheetClose"></div><div class="sheet-box" role="dialog" aria-modal="true">${html}</div>`; return; }
  if (!el.innerHTML) return;
  el.classList.add('out'); // 從哪裡來就從哪裡退：往下滑出
  setTimeout(() => { el.innerHTML = ''; el.classList.remove('out'); }, 220);
}

// ---------- 歡迎 ----------
function welcome() {
  $('#banner').innerHTML = '';
  app.innerHTML = `<div class="card"><h3>開始使用 A計畫</h3>
  <p>資料只存在這台裝置，不會上傳，也沒有加密。請定期備份到 iCloud 雲碟。</p>
  <div class="actions full"><button class="pri" data-act="import">匯入設定檔或備份</button></div>
  <div class="actions full"><button data-act="demo">試用範例（假資料）</button></div></div>`;
}

// ---------- 首頁：先講結論，數字往後放 ----------
// 首頁金額一律「約 X 萬」；精確數字收在「看詳細數字」
const about = n => { const a = Math.abs(Math.round(n)); return a >= 1e4 ? `${(a / 1e4).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 萬` : `${fmt(a)} 元`; };
const SUB = { good: '照這樣走，沒問題', warn: '少花一點就能追上', bad: '落後比較多' };

function home() {
  const last = lastSnap(), hs = E.homeSummary(S, today()), p = E.progress(S).periods.at(-1);
  const h = [];
  // 結論卡：主色漸層底、全頁最大的數字；狀態用卡片上的小標籤（綠紅字放在主色上會很醜）
  let lv = hs.level, lead = '', amt = '', tag = SUB[lv];
  if (!hs.started) { lv = 'none'; lead = '已經記下起點了'; tag = `${md(hs.nextDate)} 第一次結算後，就會告訴你進度`; }
  else if (hs.even) { lead = '你跟計畫比'; amt = '剛好照著走'; }
  else { lead = `你比計畫${hs.diff > 0 ? '多' : '少'}存了`; amt = `約 ${about(hs.diff)}`; }
  if (hs.started && hs.event?.gap > 0) { lv = 'bad'; tag = `付完「${esc(hs.event.ev.name)}」後會低於至少要留的錢`; }
  const tagIcon = { good: 'check', warn: 'warn', bad: 'warn', none: 'clock' }[lv], streakN = hs.started ? E.streak(S) : 0;
  h.push(`<section class="hero ${lv}"><div class="hero-card">
    <p class="when">${ymd(last.date)} 結算後</p><p class="lead-t">${lead}</p>${amt ? `<p class="hero-amt num-r">${amt}</p>` : ''}
    <p class="hero-tag"><span class="pill">${ic(tagIcon)}${tag}</span>${streakN >= 3 ? `<span class="pill">${ic('star')}連續 ${streakN} 個月照計畫</span>` : ''}${hs.started && lv !== 'good' ? '<a href="#" data-act="why">看原因</a>' : ''}</p></div></section>`);

  // 1. 要做的事：只在真的需要時出現
  const todo = [], due = hs.daysLeft <= 0;
  if (due) todo.push(`<div class="row"><div class="what"><b>${hs.daysLeft === 0 ? '今天要結算' : '該結算了'}</b><span>打開網銀看總額，大約 3 分鐘</span></div><a class="btn pri small" href="#settle">開始結算${ic('right')}</a></div>`);
  const lb = S.lastBackup, ago = lb ? Math.floor((Date.now() - Date.parse(lb)) / 864e5) : null;
  if (ago == null || ago > 35) todo.push(`<div class="row"><div class="what"><b>${lb ? `上次備份是 ${ago} 天前` : '還沒有備份過'}</b><span>資料只在這台手機，備份到 iCloud 雲碟比較安心</span></div><button class="pri small" data-act="backup">${ic('cloud')}備份</button></div>`);
  if (todo.length) h.push(`<section class="card todo"><h3>要做的事</h3>${todo.join('')}</section>`);

  // 2. 生活費：主＝接下來可以花多少；次＝上個月花了多少（圓環＋一行＋標籤）
  const last2 = p ? `<div class="sub-block">${spendRing(p, '上個月')}</div>` : '';
  h.push(`<section class="card"><h3>生活費</h3>
    <div class="lead"><p class="label">${md(hs.nextDate)} 前可以花</p>${due ? '' : `<span class="muted">還有 ${hs.daysLeft} 天</span>`}</div>
    <p class="big num-r">${about(hs.nextBudget)}</p>${last2}</section>`);

  // 3. 接下來的大筆款項：時程表（日期｜名稱｜金額＋夠不夠）
  const open = S.events.filter(E.isOpen).sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1));
  const show = open.slice(0, 3);
  for (const ev of open) if (ev.selfFund && !show.includes(ev)) show.push(ev);
  if (show.length) {
    const li = show.map(ev => {
      const o = E.eventOutlook(S, ev), left = -E.eventRemaining(S, ev);
      const chip = ev.selfFund && o.gap ? `<span class="chip warn">${ic('warn')}還差 ${about(o.gap)}</span>` : o.gap ? `<span class="chip bad">${ic('warn')}差 ${about(o.gap)}</span>` : `<span class="chip good only" role="img" aria-label="夠" title="夠">${ic('check')}</span>`;
      const note = ev.selfFund && o.gap ? `每次結算多存約 ${about(o.perSettle)}` : `${range(ev).slice(5)} 付`;
      const node = ev.selfFund && o.gap ? 'warn' : o.gap ? 'bad' : 'good';
      return `<li class="sched" data-ev="${ev.id}"><div class="mo"><b class="num-r">${+ev.dateFrom.slice(5, 7)}月</b><span>${ev.dateFrom.slice(0, 4)}</span></div>
        <div class="rail ${node}" aria-hidden="true"><i></i></div><div class="nm"><b>${esc(ev.name)}${ev.estimate ? '<span class="tag">暫估</span>' : ''}</b><span>${note}</span></div>
        <div class="amt"><b class="num-r">${left < 0 ? '＋' : ''}${about(left)}</b>${chip}</div></li>`;
    }).join('');
    h.push(`<section class="card"><h3>接下來的大筆款項</h3><ul class="sched-list">${li}</ul>
      <p class="muted" style="margin:8px 0 0"><span class="chip good only in-text">${ic('check')}</span> 付完還留得住至少要留的 ${about(S.settings.reserve)}</p><p style="margin:4px 0 0;text-align:right"><a href="#plan">看全部款項</a></p></section>`);
  }
  h.push(detailHtml(last));
  if (!due) h.push('<p class="foot-link"><a href="#settle">提早結算</a></p>');
  app.innerHTML = h.join('');
  homeEffects(last);
}

// 首頁動態：結算後的慶祝、大數字跳動（每次結算只播一次）
function homeEffects(last) {
  const card = $('.hero-card'), ach = pendingAch; pendingAch = null;
  if (ach) {
    if (ach.some(a => a.key === 'recovered') && !reducedMotion()) card?.classList.add('recover'); // 從暗色轉成主色
    for (const a of ach.filter(a => a.key === 'selfFund')) $(`.sched[data-ev="${a.id}"] .chip`)?.classList.add('flash');
    const msg = ach.slice(0, 2).map(a => ACH[a.key](a)).join('，') + '！';
    setTimeout(() => celebrate(msg, card), 250);
  }
  const amt = $('.hero-amt');
  if (amt && !reducedMotion() && once('countup', last.date)) countUp(amt);
}
function countUp(el) { // 數字從 0 跳到實際金額
  const m = el.textContent.match(/[\d,]+(\.\d+)?/); if (!m) return;
  const target = Number(m[0].replace(/,/g, '')), dec = (m[1] || '').length - (m[1] ? 1 : 0), pre = el.textContent.slice(0, m.index), post = el.textContent.slice(m.index + m[0].length);
  const t0 = performance.now(), D = 900;
  const step = now => {
    const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
    el.textContent = pre + (target * e).toLocaleString('zh-TW', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + post;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 生活費圓環：首頁與紀錄頁共用
function spendRing(p, label) {
  if (p.carry) return `<p class="ink-line">${label}先不判斷，下次兩期一起算</p>`;
  if (p.unknown) return `<p class="ink-line">${label}有找不到來源的錢，不列入</p>`;
  const over = p.E - p.budget, pct = Math.max(0, Math.round(p.E / p.budget * 100)), lvl = over > tol() ? 'bad' : over > 0 ? 'warn' : 'good';
  return `<div class="ringrow"><div class="ring-wrap sm" role="img" aria-label="花了預算的 ${pct}%"><svg class="ring ${lvl}" viewBox="0 0 40 40" aria-hidden="true">
      <circle class="track" cx="20" cy="20" r="16"/><circle class="val" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="${Math.min(100, pct)} 100"/></svg>
      <span class="ring-pct num-r">${pct}<small>%</small></span></div>
    <div class="ring-txt"><span class="ink">${label}花了 <b class="num-r">${about(p.E)}</b></span><span class="chip ${lvl}">${Math.round(over) === 0 ? '剛好用完預算' : over > 0 ? `多花 ${about(over)}` : `少花 ${about(-over)}`}</span></div></div>`;
}

// 看詳細數字：精確金額、為什麼多存／少存、相對原計畫
function detailHtml(last) {
  const t = E.standing(S), sum = t.parts.reduce((a, x) => a + x[1], 0);
  return `<details class="more" id="more"><summary>看詳細數字</summary><div class="card">
    ${rows([['現在有的錢（現金總額）', fmt(last.cash)], ['這時候應該要有的錢', fmt(t.target)], ['差多少', sgn(t.diff), 'sum'],
      ['股票（參考，不算現金）', fmt(last.stock || 0)], ['至少要留的錢（備用金）', fmt(S.settings.reserve)]])}
    ${t.parts.length ? `<details id="why"><summary>為什麼${t.diff >= 0 ? '多存' : '少存'}</summary>${rows([...t.parts.map(([l, v]) => [esc(l), sgn(v)]), ['合計', sgn(sum), 'sum']])}<p class="muted">正數是幫你多存的，負數是讓你少存的。</p></details>` : ''}
    <p style="margin:12px 0 0">下次結算（${ymd(t.nextDate)}）時，應該要有 <b class="num">${fmt(t.nextTarget)}</b></p>
    ${t.pending.map(x => `<p class="muted" style="margin:4px 0 0">${esc(x.name)} 最晚 ${md(x.dateTo)} 付，付了之後這個數字會再少 ${fmt(-x.amount)}</p>`).join('')}
    <details><summary>跟最早的 A計畫比：${sgn(t.vsOriginal)}</summary>${rows([...(S.original.breakdown || []).map(b => [esc(b.label) + '（起點）', sgn(b.amount)]), ['起點以來', sgn(t.diff)], ['合計', sgn(t.vsOriginal), 'sum']])}</details>
  </div></details>`;
}

// ---------- 結算 ----------
function newDraft() {
  const last = lastSnap(), due = E.nextDue(S), t = today();
  return { date: t > due ? t : due, cash: '', stock: last.stock || 0, acc: {}, side: Object.fromEntries(S.sideItems.filter(i => i.active).map(i => [i.id, i.kind === 'monthly' ? i.amount : 0])),
    newSide: { name: '', amount: '' }, ev: {}, bonus: {}, salary: '', salaryScope: 'once', flows: [], ack: false };
}
const setPath = (o, path, v) => { const k = path.split('.'); const last = k.pop(); k.reduce((a, x) => (a[x] ??= {}), o)[last] = v; };
const getPath = (o, path) => path.split('.').reduce((a, x) => a?.[x], o);
const field = (k, attrs = '') => `data-k="${k}" value="${esc(getPath(D, k) ?? '')}" ${attrs}`;
// 金額欄：下方即時顯示千分位與「約幾萬」，現金總額另外跟上次比
const wan = v => Math.abs(v) >= 1e4 ? `（約 ${(v / 1e4).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 萬）` : '';
function echo(k) {
  const raw = getPath(D, k);
  if (raw === '' || raw == null) return '';
  const v = num(raw);
  if (!Number.isFinite(v)) return '<span class="bad">請只填數字</span>';
  let s = `${fmt(v)} 元${wan(v)}`;
  if (k === 'cash') {
    const prev = lastSnap().cash, r = prev ? v / prev : 1;
    s += `・比上次 ${sgn(v - prev)}`;
    if (r > 2.5 || r < 0.4) s += '<br><span class="bad">跟上次差很多，請確認位數</span>';
  }
  return s;
}
const money = (k, attrs = '') => `<input inputmode="numeric" ${field(k, attrs)}><div class="echo" data-echo="${k}">${echo(k)}</div>`;
const radio = (k, v, label) => `<label><input type="radio" name="${k}" data-k="${k}" value="${v}" ${getPath(D, k) === v ? 'checked' : ''}> ${label}</label>`;
const FLOW = { income: ['一次性收入（中獎、獎金等）', 1], gift: ['家人資助', 1], stockSell: ['賣股入帳', 1], loanIn: ['借款入帳', 1], stockBuy: ['買股', -1], prepay: ['提前還款', -1], otherOut: ['其他非生活支出（押金等）', -1], otherIn: ['其他入帳（退款、押金返還等）', 1], unknownIn: ['找不到來源的錢', 1] };
const livingText = p => p.carry ? '併入下期' : p.unknown ? '無法判斷' : fmt(p.E);
const FIX_KINDS = ['otherIn', 'gift', 'income', 'stockSell', 'loanIn'];
function fixEcho() {
  const gap = -preview.p.E, v = num(D.fix?.amount);
  if (v == null) return `實際進來多少就填多少。填好會算出這期花了多少。`;
  if (!Number.isFinite(v)) return '<span class="bad">請只填數字</span>';
  if (v <= gap) return `${fmt(v)} 元。<span class="bad">算起來還是一毛都沒花</span>，可能還有別筆沒記，或總額打錯。`;
  const spent = v - gap, b = preview.p.budget;
  return `${fmt(v)} 元。加入後，這期花了 <b>${fmt(spent)}</b> 元（預算 ${fmt(b)}，${spent > b ? `多花 ${fmt(spent - b)}` : `少花 ${fmt(b - spent)}`}）`;
}

// ---------- 結算：一頁一題 ----------
// 每一步：ids＝這一步包含的區塊（錯誤訊息用來找是哪一步），html＝內容
function settleSteps() {
  const q = E.questions(S, D.date), last = lastSnap(), accNames = S.accounts || [], steps = [];
  const ask = (title, help) => `<h2 class="q">${title}</h2>${help ? `<p class="q-help">${help}</p>` : ''}`;
  steps.push({ ids: ['c-cash', 'c-date'], html: `${ask('現在所有帳戶加起來，有多少錢？', '打開網銀，看所有帳戶、現金、定存的總額。這個月的薪水和兼職已經在裡面了，不用另外加。')}
    <div class="card" id="c-cash">${money('cash', 'placeholder="例如 820000" autofocus')}
    <details><summary>錢分在好幾個帳戶？分開填，幫你加總</summary>${accNames.length ? accNames.map((n, i) => `<label>${esc(n)}</label>${money('acc.' + i)}`).join('') + '<div class="actions"><button class="small" data-act="accsum">加總填入</button></div>' : '<p class="muted" style="margin:8px 0 0">先寫下你有哪些帳戶，之後每個月就會一格一格列出來讓你填。</p>'}
      ${accNames.length ? '<details><summary>改帳戶清單</summary>' : ''}<label>你有哪些帳戶</label><input id="accnames" placeholder="例如：玉山，郵局，現金" value="${esc(accNames.join('，'))}"><div class="actions"><button class="small" data-act="accsave">儲存</button></div><p class="muted">寫你自己認得的名字就好，不用帳號。用逗號分開。</p>${accNames.length ? '</details>' : ''}</details></div>
    <details class="more" id="c-date"><summary>結算日 ${ymd(D.date)}、股票（選填）</summary><div class="card">
      <label>結算日</label><input type="date" ${field('date')}><p class="muted" style="margin:4px 0 0">上次結算是 ${ymd(last.date)}</p>
      <label>股票現在值多少（選填，不算進現金）</label>${money('stock')}</div></details>` });
  const sides = S.sideItems.filter(i => i.active);
  steps.push({ ids: ['c-side'], html: `${ask('這個月兼職有收到嗎？', '填這個月實際收到多少，沒收到填 0。這筆已經在剛剛的總額裡，不會重複算。')}
    <div class="card" id="c-side">${sides.map(i => `<label>${esc(i.name)}${i.kind === 'once' ? '（單次）' : ''}</label>${money('side.' + i.id)}`).join('') || '<p class="muted" style="margin:0">目前沒有兼職項目。</p>'}
    <details><summary>有新的兼職收入</summary><label>名稱</label><input ${field('newSide.name')}><label>這個月收到多少</label>${money('newSide.amount')}
    <div class="opts">${radio('newSide.kind', 'once', '只有這一次')}${radio('newSide.kind', 'monthly', '以後每個月都有')}</div></details></div>` });
  for (const ev of q.events) {
    const k = 'ev.' + ev.id, left = -E.eventRemaining(S, ev); D.ev[ev.id] ??= { mode: '', amount: left, from: ev.dateFrom, to: ev.dateTo };
    const m = D.ev[ev.id].mode;
    steps.push({ ids: ['c-ev-' + ev.id], html: `${ask(`「${esc(ev.name)}」付了嗎？`, `${range(ev)} 要付，還剩 ${about(left)}。`)}
      <div class="card" id="c-ev-${ev.id}"><div class="opts choices">${radio(k + '.mode', 'paid', '付清了')}${radio(k + '.mode', 'partial', '付了一部分')}${radio(k + '.mode', 'no', '還沒付')}${radio(k + '.mode', 'delay', '改期了')}</div>
      ${['paid', 'partial'].includes(m) ? `<label>付了多少</label>${money(k + '.amount')}` : ''}
      ${m === 'delay' ? `<div class="inline"><div><label>新的日期（最早）</label><input type="date" ${field(k + '.from')}></div><div><label>最晚</label><input type="date" ${field(k + '.to')}></div></div>` : ''}</div>` });
  }
  for (const b of q.bonus) {
    const k = 'bonus.' + b.year; D.bonus[b.year] ??= { mode: '', amount: b.plan, scope: 'once' };
    steps.push({ ids: ['c-bonus-' + b.year], html: `${ask(`${b.year} 年終發了嗎？`, `計畫是 ${about(b.plan)}。`)}
      <div class="card" id="c-bonus-${b.year}"><div class="opts choices">${radio(k + '.mode', 'got', '發了')}${radio(k + '.mode', 'no', '還沒發')}</div>
      ${D.bonus[b.year].mode === 'got' ? `<label>實際拿到多少</label>${money(k + '.amount')}
      <div class="opts">${radio(k + '.scope', 'once', '只有今年這樣')}${radio(k + '.scope', 'after', '以後也是這個金額')}</div>` : ''}</div>` });
  }
  const planSal = E.regularItems(S.plan, last.date, D.date).filter(i => i.type === 'salary').reduce((t, i) => t + i.amount, 0);
  steps.push({ ids: ['c-other', 'd-salary', 'd-flows'], html: `${ask('這個月還有其他不一樣的嗎？', '沒有的話，直接按「看結果」。')}
    <div class="card" id="c-other"><details ${D.salary !== '' ? 'open' : ''} id="d-salary"><summary>薪水跟平常不一樣</summary><label>這個月實際領到多少（平常是 ${fmt(planSal)}）</label>${money('salary')}
      <div class="opts">${radio('salaryScope', 'once', '只有這次（請假等）')}${radio('salaryScope', 'after', '以後都是（調薪等）')}</div></details>
    <details ${D.flows.length ? 'open' : ''} id="d-flows"><summary>有大筆的錢進來或出去</summary><p class="muted" style="margin:0">例如家人給的錢、退款、買股票、押金。平常的生活花費不用寫。</p>${D.flows.map((f, i) => `<div class="flowrow"><div class="flowhead"><b>第 ${i + 1} 筆</b>${iconBtn('trash', '刪除這一筆', `data-act="flowdel" data-i="${i}"`)}</div>
      <label>是什麼錢</label><select data-k="flows.${i}.kind">${Object.entries(FLOW).filter(([v]) => v !== 'unknownIn' || f.kind === v).map(([v, [l]]) => `<option value="${v}" ${f.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label>金額</label><input inputmode="numeric" ${field(`flows.${i}.amount`)}><div class="echo" data-echo="flows.${i}.amount">${echo(`flows.${i}.amount`)}</div>
      <label>備註（選填）</label><input ${field(`flows.${i}.note`)}></div>`).join('')}
      <div class="actions"><button class="small" data-act="addflow">${ic('plus')}新增一筆</button></div></details></div>` });
  steps.push({ ids: ['result'], html: `${ask('這個月的結果')}<div id="preview"></div><div class="hint" id="cf-hint"></div>` });
  return steps;
}
const stepOf = (steps, id) => steps.findIndex(st => st.ids.includes(id));

function settle() {
  D ??= S.draft || newDraft();
  D.step ??= 0;
  if (D.date <= lastSnap().date) D.date = E.nextDue(S);
  const steps = settleSteps(), n = steps.length;
  D.step = Math.max(0, Math.min(D.step, n - 1));
  const i = D.step, isResult = i === n - 1, beforeResult = i === n - 2;
  app.innerHTML = `<div class="flowbar"><a href="#home">${ic('left')}首頁</a><span>第 ${i + 1} 步，共 ${n} 步</span></div>
    <div class="steps" aria-hidden="true">${steps.map((_, j) => `<i class="${j <= i ? 'on' : ''}"></i>`).join('')}</div>
    ${steps[i].html}
    ${i === 0 ? '<p style="text-align:center"><button class="plain small" data-act="discard">清除這次填的內容</button></p>' : ''}
    <div class="stepnav">${i > 0 ? `<button data-act="back">${ic('left')}上一步</button>` : '<span></span>'}
      ${isResult ? '<button class="pri" data-act="confirm" disabled>確認結算</button>' : `<button class="pri" data-act="next">${beforeResult ? '看結果' : '下一步'}${ic('right')}</button>`}</div>`;
  if (isResult) { if (!preview) { try { calc(); return; } catch (e) { return showError(e); } } showPreview(); }
}

// 下一步：只檢查到目前這一步為止的問題
function nextStep() {
  const steps = settleSteps();
  try { buildSnap(); } catch (e) {
    const at = stepOf(steps, e.at);
    if (at !== -1 && at <= D.step) return showError(e);
  }
  if (D.step === steps.length - 2) { try { calc(); } catch (e) { showError(e); } return; }
  D.step++; settle(); window.scrollTo(0, 0);
}
function goStep(id) { const k = stepOf(settleSteps(), id); if (k !== -1) { D.step = k; settle(); window.scrollTo(0, 0); } }

const fail = (msg, at) => { throw Object.assign(new Error(msg), { at }); };
function buildSnap() {
  const last = lastSnap(), cash = num(D.cash);
  if (cash == null) fail('請輸入現金總額', 'c-cash');
  if (!Number.isFinite(cash)) fail('現金總額請只填數字', 'c-cash');
  if (!D.date || D.date <= last.date) fail(`結算日要晚於上次結算（${ymd(last.date)}）`, 'c-date');
  const q = E.questions(S, D.date);
  const snap = { id: uid('s'), date: D.date, cash, stock: num(D.stock) ?? 0, side: [], bonus: [], flows: [] };
  for (const [id, v] of Object.entries(D.side)) if (num(v)) snap.side.push({ itemId: id, amount: num(v) });
  if (num(D.newSide.amount) && D.newSide.name) snap.side.push({ itemId: 'new', amount: num(D.newSide.amount) });
  for (const ev of q.events) {
    const a = D.ev[ev.id];
    if (!a?.mode) fail(`請回答「${ev.name}」付了沒`, 'c-ev-' + ev.id);
    if (['paid', 'partial'].includes(a.mode)) snap.flows.push({ kind: 'event', eventId: ev.id, amount: -Math.abs(num(a.amount)) * Math.sign(-ev.amount || 1) });
  }
  for (const b of q.bonus) {
    const a = D.bonus[b.year];
    if (!a?.mode) fail(`請回答 ${b.year} 年終發了沒`, 'c-bonus-' + b.year);
    if (a.mode === 'got') snap.bonus.push({ year: b.year, amount: num(a.amount) || 0 });
  }
  if (D.salary !== '' && num(D.salary) != null) snap.salary = num(D.salary);
  if (D.carry) snap.carry = true;
  for (const f of D.flows) if (num(f.amount)) snap.flows.push({ kind: f.kind, amount: Math.abs(num(f.amount)) * FLOW[f.kind][1], note: f.note || '' });
  return snap;
}

function calc() {
  const snap = buildSnap();
  const tmp = structuredClone(S); tmp.snapshots.push(snap);
  const p = E.progress(tmp).periods.at(-1);
  const early = snap.date < E.addDays(E.nextDue(S), -5);
  preview = { snap, p, early, check: !early && !p.carry && !p.unknown && E.needsIncomeCheck(S, p) };
  D.step = settleSteps().length - 1; settle(); window.scrollTo(0, 0);
}

// 確認鈕：不能按時寫出原因
function setConfirm() {
  const b = $('[data-act=confirm]'), h = $('#cf-hint');
  if (!b) return;
  const p = preview?.p;
  const why = !preview ? '填好後先按「試算」，確認數字再結算'
    : p.E < 0 && !p.carry ? '先在紅框裡選一個處理方式，才能結算'
    : preview.check && !D.ack ? '先回答上面黃色框的問題，才能結算' : '';
  b.disabled = !!why; h.textContent = why;
}

function showError(e) {
  document.querySelectorAll('.card.err').forEach(c => c.classList.remove('err'));
  document.querySelectorAll('.err-msg').forEach(x => x.remove());
  let card = e.at && document.getElementById(e.at);
  if (!card && e.at && D) { goStep(e.at); card = document.getElementById(e.at); }
  if (!card) return toast(e.message);
  card.classList.add('err');
  card.insertAdjacentHTML('afterbegin', `<div class="err-msg" role="alert">${esc(e.message)}</div>`);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


const resultHero = (lvl, lead, amt, icon, tag) => `<section class="hero ${lvl}"><div class="hero-card"><p class="lead-t">${lead}</p><p class="hero-amt num-r">${amt}</p><p class="hero-tag"><span class="pill">${ic(icon)}${tag}</span></p></div></section>`;
function showPreview() {
  const { p, check, early, snap } = preview, over = p.E - p.budget, prev = p.startCash;
  const expected = snap.cash + p.E;
  const h = [];
  if (early) h.push(`<div class="note bad">距上次結算只有 ${Math.round((Date.parse(p.to) - Date.parse(p.from)) / 864e5)} 天，不是完整週期（預定 ${ymd(E.nextDue(S))}），生活費無法判斷。若只是想看看，請按「清除草稿」。</div>`);
  const table = rows([
    [p.merged ? `上上次現金（${md(p.from)}，上期併入）` : `上次現金（${md(p.from)}）`, fmt(prev)],
    [`＋ 薪資（${p.actSalary === p.planSalary ? '照計畫' : '已更正'}）`, fmt(p.actSalary)],
    p.actSide ? ['＋ 兼職', fmt(p.actSide)] : null, p.actBonus ? ['＋ 年終', fmt(p.actBonus)] : null, p.oneOff ? ['＋ 一次性收入', fmt(p.oneOff)] : null,
    ['－ 信貸月付', fmt(p.loanPay)], p.nonLiving ? ['± 事件與其他大筆進出', sgn(p.nonLiving)] : null,
    ['＝ 完全沒花錢的話，應該有', fmt(expected), 'sum'], [`實際現金（${md(p.to)}）`, fmt(snap.cash)]]);
  if (p.carry) {
    h.push(`${resultHero('none', '這個月生活費', '先不判斷', 'clock', '併入下期，下次兩期一起算')}<div class="note info">這期先不判斷生活費。下次結算時，兩期合併計算、跟兩期預算比。超前／落後照常計算。
      <div class="actions"><button class="small" data-act="uncarry">取消併入</button></div></div>`);
  } else if (p.E < 0) {
    const gap = -p.E, again = p.merged > 1;
    h.push(`<div class="note bad"><b>算起來，這${again ? '兩' : ''}期你好像一毛錢都沒花</b>
      ${again ? `<div>上期已經併進來一起算，還是對不起來，所以<b>不是卡費晚扣</b>，而是真的有錢進來沒記到，大約 ${fmt(gap + p.budget)} 元（假設照預算花了 ${fmt(p.budget)}）。</div>
      <div style="margin-top:6px">想得起來就補記；想不起來就放棄追查，記為「找不到來源的錢」：這段期間的生活費不列入統計，超前／落後照常計算，以後的月份也不受影響。</div>`
      : `<div>這不太可能，所以應該有一筆錢進來沒記到。<b>這筆錢大約 ${fmt(gap + p.budget)} 元</b>（假設你這期照預算花了 ${fmt(p.budget)}）。</div>
      <div style="margin-top:6px">最常見：<b>信用卡費這期還沒扣款</b>，選「併入下期」就好，下次結算兩期一起算。其他：退款、押金返還、家人給的錢、兼職填少了、總額多打一位。</div>`}
      <details><summary>為什麼會這樣算</summary><div class="muted">完全沒花錢的話應有 ${fmt(snap.cash - gap)}，實際卻有 ${fmt(snap.cash)}，多了 ${fmt(gap)}。你這期真的花掉的錢，也是靠這筆沒記到的錢補上的，所以沒記到的錢 ≈ 多出來的 ${fmt(gap)} ＋ 這期花掉的錢。</div></details>
      <div class="actions">${again ? '' : '<button class="small pri" data-act="fixcarry">卡費還沒扣／想不起來：併入下期</button>'}<button class="small" data-act="fixknown">我知道是哪筆錢</button><button class="small" data-act="fixcash">總額打錯了</button>${again ? '<button class="small" data-act="fixgiveup">放棄追查</button>' : ''}</div>
      ${D.fix ? `<div class="fixbox"><label>是什麼錢</label><select data-k="fix.kind">${FIX_KINDS.map(v => `<option value="${v}" ${D.fix.kind === v ? 'selected' : ''}>${FLOW[v][0]}</option>`).join('')}</select>
        <label>實際入帳金額</label><input inputmode="numeric" data-k="fix.amount" value="${esc(D.fix.amount)}" placeholder="例如 ${fmt(gap + p.budget)}">
        <div class="echo" id="fix-echo">${fixEcho()}</div>
        <div class="actions full"><button class="pri" data-act="fixadd">加入並重新試算</button></div></div>` : ''}</div>`);
  } else {
    if (p.unknown) h.push(`${resultHero('none', '這個月生活費', '無法判斷', 'clock', '不列入生活費統計')}<div class="note info">有找不到來源的錢（金額不明），這段期間的生活費不列入統計。超前／落後照常計算。之後想起來，到「其他大筆進出」改類型就好。</div>`);
    else { const lvl = over > tol() ? 'bad' : over > 0 ? 'warn' : 'good';
      h.push(resultHero(lvl, `${p.merged ? `這 ${p.merged} 期合計` : '這個月'}生活費`, `約 ${about(p.E)}`, lvl === 'good' ? 'check' : 'warn', `預算 ${about(p.budget)}，${over > 0 ? `多花 ${about(over)}` : `少花 ${about(-over)}`}`)); }
    if (check && !D.ack) h.push(over > 0
      ? `<div class="note">多花了 ${fmt(over)}。如果其中有不是生活費的支出（押金、買股、提前還款），請記到「其他大筆進出」；薪資少領請填「收入有變動」。
        <div class="actions"><button class="small" data-act="open" data-id="d-flows">有其他大筆支出</button><button class="small" data-act="open" data-id="d-salary">薪資少領</button><button class="small" data-act="ack">沒有，就是這樣花的</button></div></div>`
      : `<div class="note">比預算少花很多（${fmt(-over)}）。如果有收入沒記（年終、資助、退款），請補上，不然會被當成省下來的錢。
        <div class="actions"><button class="small" data-act="open" data-id="d-flows">有收入沒記</button><button class="small" data-act="ack">沒有，真的省下來了</button></div></div>`);
  }
  $('#preview').innerHTML = h.join('') + `<details class="more"><summary>這期的錢怎麼變化</summary><div class="card">${table}<p class="muted" style="margin:8px 0 0">完全沒花錢的話應該有的錢，減掉實際的錢，就是這期花掉的錢。</p></div></details>`;
  setConfirm();
}

const ACH = { recovered: () => '追上計畫了', streak: a => `連續 ${a.n} 個月照計畫`, first: () => '第一次結算完成',
  selfFund: a => `${a.name}預估夠了`, paid: a => `「${a.name}」付清了`, onTrack: () => '這個月照計畫存到了' };
let pendingAch = null; // 回到首頁後播放
async function confirmSettle() {
  const before = structuredClone(S);
  if (preview?.early && !(await ask({ title: '這次不是完整的一個月', body: '距離上次結算不到一個月，這期的生活費會不準。確定要結算嗎？', ok: '還是要結算' }))) return;
  const snap = buildSnap(), applied = { events: [], plan: [], sideItems: [] };
  const q = E.questions(S, snap.date);
  for (const ev of q.events) {
    const a = D.ev[ev.id]; applied.events.push({ id: ev.id, prev: { status: ev.status, dateFrom: ev.dateFrom, dateTo: ev.dateTo } });
    if (a.mode === 'paid') ev.status = 'paid';
    else if (a.mode === 'partial') ev.status = 'partial';
    else if (a.mode === 'delay') { ev.dateFrom = a.from; ev.dateTo = a.to < a.from ? a.from : a.to; }
  }
  const nextMonth = E.addDays(snap.date, 20).slice(0, 7);
  const addChange = (key, entry) => { S.plan[key].push(entry); applied.plan.push({ key, entry }); };
  if (snap.salary != null && D.salaryScope === 'after') addChange('salaryChanges', { from: nextMonth, amount: snap.salary });
  for (const b of snap.bonus) if (D.bonus[b.year]?.scope === 'after') addChange('bonusChanges', { from: `${b.year + 1}-01`, amount: b.amount });
  const ns = snap.side.find(x => x.itemId === 'new');
  if (ns) { const id = uid('i'); S.sideItems.push({ id, name: D.newSide.name, kind: D.newSide.kind || 'once', amount: ns.amount, active: true }); ns.itemId = id; applied.sideItems.push(id); }
  for (const it of S.sideItems) if (it.kind === 'once' && snap.side.some(x => x.itemId === it.id)) it.active = false;
  snap.applied = applied;
  S.snapshots.push(snap); S.draft = null; D = null; preview = null;
  await commit(`結算 ${snap.date}`);
  const ach = E.achievements(before, S, today());
  pendingAch = ach.length ? ach : null;
  if (location.hash === '#home') render(); else location.hash = '#home';
  if (ach.length) await new Promise(r => setTimeout(r, reducedMotion() ? 600 : 2600)); // 先讓慶祝播得差不多再問備份
  if (await ask({ title: '結算完成', body: '要現在備份到 iCloud 雲碟嗎？資料只在這台手機，備份比較安心。', ok: `${ic('cloud')}現在備份` })) backup();
}

async function undoLast() {
  const s = lastSnap();
  if (s.start) return toast('還沒有結算可以撤回');
  if (!(await ask({ title: `撤回 ${ymd(s.date)} 的結算？`, body: '資料會回到這次結算之前，那次回答的付款、計畫變更也會一起還原。之後可以重新結算。', ok: `${ic('undo')}撤回這次結算`, danger: true }))) return;
  for (const e of s.applied?.events || []) { const ev = S.events.find(x => x.id === e.id); if (ev) Object.assign(ev, e.prev); }
  for (const c of s.applied?.plan || []) S.plan[c.key] = S.plan[c.key].filter(x => x !== c.entry && JSON.stringify(x) !== JSON.stringify(c.entry));
  S.sideItems = S.sideItems.filter(i => !(s.applied?.sideItems || []).includes(i.id));
  S.snapshots.pop();
  await commit(`撤回結算 ${s.date}`);
  render(); toast(`已撤回 ${ymd(s.date)} 的結算`);
}

// ---------- 紀錄 ----------
function history() {
  const r = E.progress(S);
  const card = p => {
    const more = [['兼職', `${fmt(p.actSide)}（目標 ${fmt(p.planSide)}）`], p.salaryDiff ? ['薪資跟計畫差', sgn(p.salaryDiff)] : null, p.actBonus ? ['年終', fmt(p.actBonus)] : null,
      ...p.flows.map(f => f.kind === 'unknownIn' ? ['找不到來源的錢', '金額不明'] : [f.kind === 'event' ? esc(S.events.find(e => e.id === f.eventId)?.name || '（已刪除的款項）') : (FLOW[f.kind]?.[0] || f.kind) + (f.note ? '，' + esc(f.note) : ''), sgn(f.amount)])].filter(Boolean);
    return `<section class="card"><div class="hist-head"><b class="num-r">${ymd(p.to)}</b><span>${md(p.from)}～${md(p.to)}${p.merged ? `，${p.merged} 次一起算` : ''}</span></div>
      ${spendRing(p, '生活費')}<details><summary>明細</summary>${rows([['生活費預算', fmt(p.budget)], ...more])}</details></section>`;
  };
  app.innerHTML = `<h2>紀錄</h2>${r.periods.slice().reverse().map(card).join('') || '<p class="muted">還沒有結算過。</p>'}
    <p class="muted" style="text-align:center">起點 ${ymd(S.snapshots[0].date)}，現金 ${fmt(S.snapshots[0].cash)}</p>
    ${S.snapshots.length > 1 ? `<div class="actions" style="justify-content:center"><button class="danger" data-act="undo">${ic('undo')}撤回最近一次結算</button></div>` : ''}`;
}

// ---------- 計畫：我的計畫一頁看完 ----------
// 款項狀況：自動判斷，一律「圖示＋文字」
const EV_ST = { todo: ['clock', '還沒付'], partial: ['half', '付了一部分'], done: ['done', '付清了'], off: ['x', '不用付了'] };
function evCard(ev) {
  const st = E.eventState(S, ev), [icn, lbl] = EV_ST[st.key], verb = st.income ? '會收到' : '要付';
  const bar = st.paid && st.key !== 'done' ? `<div class="meter thin"><i style="width:${Math.min(100, st.paid / st.total * 100)}%"></i></div>
    <p class="muted" style="margin:0">已付 ${about(st.paid)}${st.key === 'off' ? '，剩下的不用付了' : `，還剩 ${about(st.left)}`}</p>`
    : st.key === 'done' && st.paid && st.paid !== st.total ? `<p class="muted" style="margin:10px 0 0">實際付了 ${about(st.paid)}（原本預估 ${about(st.total)}）</p>` : '';
  const action = st.key === 'todo' ? `<button class="danger" data-act="evdel">${ic('trash')}刪除這筆</button>`
    : st.key === 'partial' ? `<button class="danger" data-act="evdel">${ic('x')}剩下的不用付了</button>`
    : st.key === 'off' ? `<button data-act="evrestore">${ic('undo')}恢復成還要付</button>` : '';
  return `<div class="card evcard ${st.key === 'off' ? 'dim' : ''}" id="evc-${ev.id}"><details><summary><div class="evsum"><b>${esc(ev.name)}${ev.estimate ? '<span class="tag">暫估</span>' : ''}</b>
      <span>${range(ev)}，${verb} ${about(st.total)}</span></div><span class="st st-${st.key}">${ic(icn)}${lbl}</span></summary>
    ${bar}
    <form data-ev="${ev.id}"><label>名稱</label><input name="name" value="${esc(ev.name)}">
    <label>金額</label><div class="seg" style="margin-bottom:8px">${[['out', '要付出去'], ['in', '會收到']].map(([v, l]) => `<label class="segopt"><input type="radio" name="dir" value="${v}" ${(v === 'in') === st.income ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <input name="amount" inputmode="numeric" value="${st.total || ''}" placeholder="例如 50000">
    <div class="inline"><div><label>最早</label><input type="date" name="dateFrom" value="${ev.dateFrom}"></div><div><label>最晚</label><input type="date" name="dateTo" value="${ev.dateTo}"></div></div>
    <label class="opts"><input type="checkbox" name="estimate" ${ev.estimate ? 'checked' : ''}> 金額還是暫估的</label>
    <div class="actions"><button class="pri" data-act="evsave">儲存</button>${action}</div></form></details></div>`;
}
let planEdit = null; // 計畫頁正在修改哪一項
const ym = m => `${m.slice(0, 4)}/${+m.slice(5)}`;
function plan() {
  const fm = E.firstEditableMonth(S), cur = E.planValues(S.plan, fm), orig = E.planValues(E.originalPlan(S.plan), fm), P = S.plan;
  const when = { salary: `每月 ${P.salaryDay} 日入帳`, side: `每月 ${P.sideDay} 日，${P.sideStart ? ym(P.sideStart) + ' 起' : ''}`, living: '每個月', bonus: `每年 ${P.bonusMonth} 月` };
  const prow = k => {
    const d = E.PLAN_KEYS[k], changed = cur[k] !== orig[k];
    const head = `<div class="prow"><div class="pl"><b>${d.label}</b><span>${when[k]}</span></div><div class="pv"><b class="num">${fmt(cur[k])}</b>${changed ? `<span>原本 ${fmt(orig[k])}</span>` : ''}</div>
      ${planEdit === k ? '' : iconBtn('pencil', '改' + d.label, `data-act="pedit" data-key="${k}"`)}</div>`;
    if (planEdit !== k) return head;
    return head + `<div class="pedit"><label>改成多少</label><input id="pe-amt" inputmode="numeric" value="${cur[k]}">
      <label>從哪個月開始</label><input id="pe-from" type="month" min="${fm}" value="${fm}">
      <p class="muted" style="margin:6px 0 0">已經結算過的月份不會被改到。</p>
      <div class="actions"><button class="pri" data-act="pesave">儲存</button><button data-act="pecancel">取消</button></div></div>`;
  };
  const loans = (P.loans || []).filter(l => !l.closed).map(l => `<div class="prow"><div class="pl"><b>${esc(l.name)}</b><span>每月 ${l.day} 日，到 ${ym(l.last)}</span></div><div class="pv"><b class="num">${fmt(l.monthly)}</b></div></div>`).join('');
  const hist = Object.entries(E.PLAN_KEYS).flatMap(([k, d]) => (P[d.ch] || []).map(c => ({ k, d, c }))).sort((a, b) => (a.c.from < b.c.from ? -1 : 1));
  const evEnd = S.events.filter(e => e.status !== 'cancelled').map(e => e.dateTo).sort().at(-1);
  const cmp = hist.length && evEnd ? E.planCompare(S, evEnd) : null;
  const list = [...S.events].sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1));
  app.innerHTML = `<h2>我的計畫</h2>
  <section class="card"><h3>每個月的收入</h3>${prow('salary')}${prow('side')}${prow('bonus')}</section>
  <section class="card"><h3>每個月的支出</h3>${prow('living')}${loans}</section>
  ${cmp ? `<section class="hero ${cmp.diff >= 0 ? 'good' : 'bad'}"><div class="hero-card"><p class="when">跟原本的計畫比</p><p class="lead-t">到 ${ymd(cmp.date)}，會比原本</p><p class="hero-amt mid num-r">${cmp.diff >= 0 ? '多' : '少'}存約 ${about(cmp.diff)}</p>
    <details><summary>改過哪些地方</summary><ul class="plain-list">${hist.map(({ k, d, c }) => `<li><span>${ym(c.from)} 起，${d.label}改成 <b class="num">${fmt(c.amount)}</b></span>${c.from >= fm ? iconBtn('undo', '撤回這個修改', `data-act="pundo" data-key="${k}" data-from="${c.from}"`) : '<span class="muted">已生效</span>'}</li>`).join('')}</ul></details></div></section>` : ''}
  <div class="card"><h3>兼職項目</h3><div class="list">${S.sideItems.map(i => `<div class="item"><span>${esc(i.name)}<span class="muted">　${i.kind === 'monthly' ? `每月 ${fmt(i.amount)}` : '單次'}${i.active ? '' : '，已停用'}</span></span>
      <button class="switch ${i.active ? 'on' : ''}" role="switch" aria-checked="${i.active}" aria-label="${esc(i.name)}" data-act="sidetoggle" data-id="${i.id}"><i></i></button></div>`).join('')}</div>
    <details><summary>新增每月兼職</summary><div class="inline"><input id="sn" placeholder="名稱"><input id="sa" inputmode="numeric" placeholder="每月金額"></div>
    <div class="actions"><button class="small" data-act="sideadd">新增</button></div><p class="muted">單次收入在結算時新增就好。</p></details></div>
  <h2>大筆款項</h2><p class="muted" style="margin:-6px 0 4px">付了沒，每個月結算時回答就好，這裡會自動更新。</p>${list.map(evCard).join('')}
    <div class="actions"><button data-act="evadd">${ic('plus')}新增款項</button></div>
  <h2>至少要留的錢</h2><form class="card" id="resf"><p class="muted" style="margin:0">付完大筆款項後，帳戶裡至少要剩多少才安心（備用金）。</p>
    <input name="reserve" inputmode="numeric" value="${S.settings.reserve}"><div class="actions"><button class="pri" data-act="ressave">儲存</button></div></form>`;
  // 上一次結算付清的款項：狀態圖示跳一下（每筆只一次）
  for (const f of (lastSnap().flows || []).filter(f => f.kind === 'event')) {
    const ev = S.events.find(e => e.id === f.eventId);
    if (ev?.status === 'paid' && !reducedMotion() && once('paidpop-' + ev.id, '1')) $(`#evc-${ev.id} .st`)?.classList.add('pop');
  }
}

// ---------- 設定：外觀、提醒、備份、測試、進階 ----------
function settings() {
  const st = S.settings, pal = document.documentElement.dataset.palette;
  app.innerHTML = `<h2>設定</h2>
    <div class="card"><h3>外觀</h3><div class="swatches">${Object.entries(PALETTES).map(([k, n]) => `<button class="swatch ${pal === k ? 'on' : ''}" data-act="palette" data-p="${k}" data-palette="${k}" aria-pressed="${pal === k}"><i></i>${n}</button>`).join('')}</div>
      <label>深色／淺色</label><div class="seg">${Object.entries(MODES).map(([k, n]) => `<button class="${(document.documentElement.dataset.mode || 'auto') === k ? 'on' : ''}" data-act="mode" data-m="${k}" aria-pressed="${(document.documentElement.dataset.mode || 'auto') === k}">${n}</button>`).join('')}</div></div>
    <form class="card" id="dayf"><h3>提醒</h3><label>每個月幾號結算</label><input name="settleDay" inputmode="numeric" value="${st.settleDay}">
      <div class="actions"><button class="pri" data-act="daysave">儲存</button><button data-act="ics">${ic('calendar')}加到手機行事曆</button></div>
      <p class="muted">改了日期之後，要重新加一次行事曆，並刪掉舊的。</p></form>
    <div class="card"><h3>備份與資料</h3><p style="margin:0">上次備份：${S.lastBackup ? S.lastBackup.slice(0, 10) : '還沒有'}</p>
      <div class="actions"><button class="pri" data-act="backup">${ic('cloud')}備份到 iCloud 雲碟</button><button data-act="import">${ic('restore')}從備份還原</button></div>
      <p class="muted">資料只在這台手機，不會上傳。<span id="pst"></span></p></div>
    <div class="card"><h3>測試模式</h3>${sandbox
      ? '<p style="margin:0">現在<b>正在測試</b>。整個 App 都有斜紋外框時，就是在測試。</p><div class="actions"><button class="pri" data-act="sbAsk">結束測試</button></div>'
      : '<p style="margin:0">想試試看結算或改計畫，又不想弄亂資料時用。開始後整個 App 都會進入測試，結束時可以全部丟掉。</p><div class="actions"><button data-act="sbStart">開始測試模式</button></div>'}</div>
    <details class="more"><summary>進階規則</summary><form class="card" id="rulef">
      <label>差多少以內，算「照著計畫走」（元）</label><input name="tolerance" inputmode="numeric" value="${st.tolerance}">
      <label>生活費跟預算差多少，結算時要問我（元）</label><input name="askThreshold" inputmode="numeric" value="${st.askThreshold}">
      <label>股票賣掉，大概能拿回幾成（0～1，例如 0.8＝八成）</label><input name="stockHaircut" inputmode="decimal" value="${st.stockHaircut}">
      <div class="actions"><button class="pri" data-act="rulesave">儲存</button></div></form></details>
    <div class="card danger-zone"><h3>清除資料</h3><p class="muted" style="margin:0">刪掉這台手機上的全部 A計畫 資料。建議先備份。</p><div class="actions"><button class="danger" data-act="reset">${ic('trash')}清除全部資料</button></div></div>
    <div class="ver"><span class="muted">版本 ${VERSION}</span>${iconBtn('refresh', '檢查更新', 'data-act="checkUpdate"')}</div>`;
  navigator.storage?.persisted?.().then(v => { const e = $('#pst'); if (e) e.textContent = v ? '' : '（手機可能會在空間不足時清掉資料，記得備份）'; });
}

// ---------- 檔案 ----------
async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; } }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return true;
}
async function backup() {
  const ok = await shareFile(`izu-a-plan-backup-${today().replaceAll('-', '')}.json`, JSON.stringify(S, null, 1), 'application/json');
  if (ok) { S.lastBackup = new Date().toISOString(); await commit('備份'); render(); toast('已備份到 iCloud 雲碟', 'check'); }
}
async function importFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    let next;
    if (Array.isArray(obj.snapshots)) {
      next = E.migrate(obj);
      const errs = E.validateState(next);
      if (errs.length) throw new Error(errs.join('、'));
      if (!(await ask({ title: '從備份還原？', body: `備份裡有 ${next.snapshots.length - 1} 次結算、${next.events.length} 筆款項，最後一次結算是 ${ymd(next.snapshots.at(-1).date)}。${S ? '<b>會取代這台手機上目前的資料。</b>' : ''}`, ok: '還原', danger: !!S }))) return;
    } else {
      next = E.initFromSetup(obj);
      if (!(await ask({ title: `匯入「${esc(obj.name || '設定檔')}」？`, body: `從 ${ymd(obj.start.date)} 開始，起點現金 ${fmt(obj.start.cash)}。${S ? '<b>會取代這台手機上目前的所有資料。</b>' : ''}`, ok: '匯入', danger: !!S }))) return;
    }
    S = next; await commit('匯入'); location.hash = '#home'; render(); toast('已匯入');
  } catch (e) { info('沒有匯入', `檔案有問題，原本的資料沒有改變。<br><span class="muted">${esc(e.message)}</span>`); }
}

// ---------- 事件委派 ----------
const acts = {
  import: () => { $('#file').value = ''; $('#file').click(); },
  demo: async () => { S = E.initFromSetup(await (await fetch('setup.example.json')).json()); await commit('試用範例'); render(); },
  backup, undo: undoLast,
  sbStart: async () => {
    if (!(await ask({ title: '開始測試模式？', body: '接下來整個 App 都在測試中，結算、改計畫都可以隨意試。結束時可以選擇全部丟掉，回到現在的樣子。', ok: '開始測試' }))) return;
    await DB.save(S, 'sandbox'); sandbox = true; location.hash = '#home'; render(); toast('已進入測試模式');
  },
  sbAsk: () => sheet(`<h3>結束測試模式</h3><p>測試期間做的結算和修改，要怎麼處理？</p>
    <div class="actions full col"><button class="pri" data-act="sbEnd">全部丟掉，回到測試前</button><button data-act="sbKeep">保留，當成正式資料</button><button class="plain" data-act="sheetClose">繼續測試</button></div>`),
  sheetClose: () => { if (askRes) settleAsk(false); else sheet(''); },
  askYes: () => settleAsk($('#ask-in') ? $('#ask-in').value.trim() : true),
  askNo: () => settleAsk(false),
  sbEnd: async () => { S = await DB.load('sandbox'); D = null; preview = null; await DB.save(S); await DB.clear('sandbox'); sandbox = false; sheet(''); location.hash = '#home'; render(); toast('已回到測試前的資料'); },
  sbKeep: async () => { await DB.clear('sandbox'); sandbox = false; sheet(''); render(); toast('測試結果已保留'); },
  update: () => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage('skip')),
  checkUpdate: el => checkUpdate(el),
  calc: () => { try { calc(); } catch (e) { showError(e); } },
  confirm: () => confirmSettle().catch(showError),
  ack: () => {
    D.ack = true; showPreview();
    const saved = preview.p.budget - preview.p.E;
    if (saved > 0) celebrate(`省下約 ${about(saved)}，做得好！`, $('#preview .hero-card'));
  },
  fixknown: () => { D.carry = false; D.fix ??= { kind: 'otherIn', amount: '' }; showPreview(); $('[data-k="fix.amount"]').focus(); },
  fixadd: () => {
    const v = num(D.fix?.amount);
    if (!v || !Number.isFinite(v)) { $('#fix-echo').innerHTML = '<span class="bad">請填實際入帳金額</span>'; return; }
    D.flows.push({ kind: D.fix.kind, amount: String(v), note: '' }); D.fix = null;
    try { calc(); } catch (e) { showError(e); }
  },
  fixcarry: () => { D.carry = true; D.fix = null; try { calc(); } catch (e) { showError(e); } },
  uncarry: () => { D.carry = false; try { calc(); } catch (e) { showError(e); } },
  fixgiveup: () => {
    D.flows.push({ kind: 'unknownIn', amount: String(-preview.p.E), note: '' }); D.fix = null;
    try { calc(); } catch (e) { showError(e); }
  },
  fixcash: () => { preview = null; D.fix = null; D.carry = false; goStep('c-cash'); $('[data-k=cash]')?.focus(); },
  next: () => nextStep(),
  back: () => { D.step--; settle(); window.scrollTo(0, 0); },
  palette: el => { setPalette(el.dataset.p); render(); },
  mode: el => { setMode(el.dataset.m); render(); },
  why: () => { const m = $('#more'), w = $('#why'); m.open = true; if (w) w.open = true; (w || m).scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  open: el => { if (!document.getElementById(el.dataset.id)) goStep(el.dataset.id); const d = document.getElementById(el.dataset.id); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); },
  addflow: () => { D.flows.push({ kind: 'income', amount: '', note: '' }); preview = null; settle(); },
  discard: async () => { if (await ask({ title: '清除這次填的內容？', body: '這次結算填到一半的內容會清掉，從第一題重新開始。', ok: '清除，重新開始', danger: true })) { D = null; preview = null; S.draft = null; await commit(); settle(); } },
  accsum: () => { D.cash = String(Object.values(D.acc).reduce((t, v) => t + (num(v) || 0), 0)); preview = null; settle(); },
  ics: () => shareFile('izu-a-plan-reminder.ics', E.makeIcs(S.settings.settleDay, today()), 'text/calendar'),
  reset: async () => {
    const v = await ask({ title: '清除全部資料？', body: '會刪掉這台手機上的全部 A計畫 資料，<b>不能復原</b>。建議先備份。確定的話，請輸入「清除」。', ok: `${ic('trash')}清除全部資料`, danger: true, input: '輸入：清除' });
    if (v === false) return;
    if (v !== '清除') return toast('沒有清除：要輸入「清除」才會刪除');
    await DB.clear(); S = null; render(); toast('已清除全部資料');
  },
  daysave: async () => {
    const day = num(new FormData($('#dayf')).get('settleDay'));
    if (!(day >= 1 && day <= 28)) return toast('結算日請填 1～28');
    S.settings.settleDay = day; await commit('修改結算日'); render(); toast('已儲存');
  },
  rulesave: async () => {
    const f = new FormData($('#rulef')), n = k => Number(f.get(k));
    Object.assign(S.settings, { tolerance: n('tolerance'), askThreshold: n('askThreshold'), stockHaircut: Math.min(1, Math.max(0, n('stockHaircut'))) });
    await commit('修改進階規則'); render(); toast('已儲存');
  },
  pedit: el => { planEdit = el.dataset.key; render(); $('#pe-amt')?.focus(); },
  pecancel: () => { planEdit = null; render(); },
  pesave: async () => {
    const k = planEdit, v = num($('#pe-amt').value), from = $('#pe-from').value, fm = E.firstEditableMonth(S);
    if (!Number.isFinite(v) || v < 0) return toast('金額請只填數字');
    if (!from || from < fm) return toast(`最早只能從 ${ym(fm)} 開始`);
    S.plan = E.setPlanValue(S.plan, k, from, v); planEdit = null;
    await commit(`計畫：${ym(from)} 起 ${E.PLAN_KEYS[k].label} ${v}`); render(); toast('已更新計畫');
  },
  pundo: async el => { S.plan = E.removePlanChange(S.plan, el.dataset.key, el.dataset.from); await commit(`撤回計畫修改 ${el.dataset.key} ${el.dataset.from}`); render(); toast('已撤回'); },
  ressave: async () => { const v = num(new FormData($('#resf')).get('reserve')); if (!Number.isFinite(v)) return toast('請只填數字'); S.settings.reserve = v; await commit('修改備用金'); render(); toast('已儲存'); },
  accsave: async () => { S.accounts = $('#accnames').value.split(/[,，、]/).map(x => x.trim()).filter(Boolean); await commit('修改帳戶清單'); D.acc = {}; settle(); toast('已儲存帳戶清單'); },
  sideadd: async () => { const name = $('#sn').value.trim(), amount = num($('#sa').value) || 0; if (!name) return; S.sideItems.push({ id: uid('i'), name, kind: 'monthly', amount, active: true }); await commit('新增兼職 ' + name); render(); },
  sidetoggle: async el => { const i = S.sideItems.find(x => x.id === el.dataset.id); i.active = !i.active; await commit('切換兼職 ' + i.name); render(); },
  evadd: async () => { const t = today(); S.events.push({ id: uid('e'), name: '新款項', type: 'other', amount: 0, dateFrom: t, dateTo: t, status: 'planned' }); await commit('新增事件'); render(); },
  flowdel: el => { D.flows.splice(+el.dataset.i, 1); preview = null; settle(); }, // 草稿而已，直接拿掉
  evdel: el => {
    const ev = S.events.find(x => x.id === el.closest('form').dataset.ev), name = esc(ev.name);
    const paid = -E.eventPaid(S, ev), left = -E.eventRemaining(S, ev);
    if (ev.status === 'paid') return sheet(`<h3>「${name}」已經付清了</h3><p>付清的款項會留在紀錄裡，不需要刪除，也不用取消。</p>
      <div class="actions full col"><button class="pri" data-act="sheetClose">知道了</button></div>`);
    if (!E.canDeleteEvent(S, ev)) return sheet(`<h3>「${name}」剩下的不用付了？</h3><ul class="sheet-list"><li>已經付的 ${about(paid)} 是真的花掉了，<b>不會加回來</b></li><li>剩下的 ${about(left)} 不用再付，也不用再為它存錢</li><li>之後結算不會再問你付了沒，之後也可以恢復</li></ul>
      <p class="muted">如果對方退錢給你，下次結算時記在「有大筆的錢進來或出去」→「其他入帳（退款）」。</p>
      <div class="actions full col"><button class="pri" data-act="evcancel" data-id="${ev.id}">對，剩下的不用付了</button><button class="plain" data-act="sheetClose">先不要</button></div>`);
    sheet(`<h3>刪除「${name}」？</h3><p>這筆還沒付過錢，刪掉就是從計畫裡拿掉，之後「應該要有的錢」和首頁的預估都會重新計算。適合填錯了、或根本不需要這筆的時候。</p>
      <div class="actions full col"><button class="danger" data-act="evdelok" data-id="${ev.id}">${ic('trash')}刪除</button><button class="plain" data-act="sheetClose">先不要</button></div>`);
  },
  evdelok: async el => { const ev = S.events.find(x => x.id === el.dataset.id); S.events = S.events.filter(x => x !== ev); sheet(''); await commit(`刪除款項 ${ev.name}`); render(); toast('已刪除'); },
  evrestore: async el => { const ev = S.events.find(x => x.id === el.closest('form').dataset.ev); ev.status = E.eventPaid(S, ev) ? 'partial' : 'planned'; await commit(`恢復款項 ${ev.name}`); render(); toast('已恢復成還要付'); },
  evcancel: async el => { const ev = S.events.find(x => x.id === el.dataset.id); ev.status = 'cancelled'; sheet(''); await commit(`取消款項 ${ev.name}`); render(); toast('剩下的不用付了'); },
  evsave: async el => {
    const form = el.closest('form'), f = new FormData(form), ev = S.events.find(x => x.id === form.dataset.ev);
    const before = JSON.stringify(ev);
    const total = Math.abs(num(f.get('amount')) || 0), amt = total * (f.get('dir') === 'in' ? 1 : -1);
    // 金額有改：不能比已付少；狀態跟著變（剛好付完＝付清了）
    if (!(total > 0) || total !== Math.abs(ev.amount)) {
      const r = E.statusAfterAmount(S, ev, total), paid = Math.abs(E.eventPaid(S, ev));
      if (!r.ok) return showError(Object.assign(new Error(paid ? `已經付了 ${about(paid)}，金額不能比這個少。如果剩下的不用付了，請按下面的「剩下的不用付了」。` : '請填金額'), { at: 'evc-' + ev.id }));
      ev.status = r.status;
    }
    Object.assign(ev, { name: f.get('name'), amount: amt, dateFrom: f.get('dateFrom'), dateTo: f.get('dateTo') < f.get('dateFrom') ? f.get('dateFrom') : f.get('dateTo'), estimate: !!f.get('estimate') });
    await commit(`修改款項 ${ev.name}：${before} → ${JSON.stringify(ev)}`); render(); toast('已儲存');
  },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  acts[el.dataset.act]?.(el);
});
let saveT;
const onInput = e => {
  const k = e.target.dataset.k;
  if (!k || !D) return;
  if (k.startsWith('fix.')) { setPath(D, k, e.target.value); const fe = $('#fix-echo'); if (fe) fe.innerHTML = fixEcho(); return; }
  const v = e.target.type === 'radio' ? (e.target.checked ? e.target.value : getPath(D, k)) : e.target.value;
  setPath(D, k, v);
  const ec = document.querySelector(`[data-echo="${k}"]`);
  if (ec) ec.innerHTML = echo(k);
  const ce = e.target.closest('.card.err');
  if (ce) { ce.classList.remove('err'); ce.querySelector('.err-msg')?.remove(); }
  if (e.type === 'change' && (e.target.type === 'radio' || k === 'date')) { preview = null; settle(); }
  else if (preview) { preview = null; const pv = $('#preview'); if (pv) pv.innerHTML = ''; setConfirm(); } // 一頁一題：結果頁不在畫面上時也不能出錯
  clearTimeout(saveT); saveT = setTimeout(() => { S.draft = D; DB.save(S); }, 400);
};
document.addEventListener('submit', e => e.preventDefault()); // 按 Enter 不要重新整理頁面
document.addEventListener('input', onInput);
document.addEventListener('change', onInput);
$('#file').addEventListener('change', e => e.target.files[0] && importFile(e.target.files[0]));

// ---------- Service Worker（更新需使用者點擊） ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const flag = () => { $('#banner').dataset.update = '1'; if (S) banners(); };
    if (reg.waiting && navigator.serviceWorker.controller) flag();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', ev => {
      if (ev.target.state === 'installed' && navigator.serviceWorker.controller) flag();
    }));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update());
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

// ---------- 啟動 ----------
let loadErr = null;
(async () => {
  try { const raw = await DB.load(); S = raw ? E.migrate(raw) : null; sandbox = !!(await DB.load('sandbox')); } catch (e) { loadErr = e.message; }
  DB.persist();
  render();
  if (loadErr) info('讀不到資料', `請先不要新增資料，用「從備份還原」把最近的備份匯入。<br><span class="muted">${esc(loadErr)}</span>`);
})();
