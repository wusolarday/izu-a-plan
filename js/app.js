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
const rows = list => `<table class="rows">${list.filter(Boolean).map(([a, b, cls]) => `<tr class="${cls || ''}"><td>${a}</td><td class="num">${b}</td></tr>`).join('')}</table>`;

// 配色：色碼在 css/theme.css，這裡只列名稱。存在這台裝置（不進備份）
const PALETTES = { choco: '巧克力', indigo: '靛紫', pine: '松綠' };
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
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}
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
const SUB = { good: '照這樣走，沒問題。', warn: '還不用緊張，接下來幾個月少花一點就能追上。', bad: '落後比較多，可以先看看是哪裡差了。' };

function home() {
  const last = lastSnap(), hs = E.homeSummary(S, today()), p = E.progress(S).periods.at(-1);
  const h = [`<p class="when">${ymd(last.date)} 結算後的狀況</p>`];
  let lv = hs.level, say, sub = SUB[lv];
  if (!hs.started) { lv = 'none'; say = '已經記下起點了'; sub = `${md(hs.nextDate)} 第一次結算後，就會告訴你有沒有照計畫走。`; }
  else if (hs.even) say = '你剛好照著計畫走';
  else say = `你比計畫${hs.diff > 0 ? '多' : '少'}存了約 <b>${about(hs.diff)}</b>`;
  if (hs.started && hs.event?.gap > 0) sub = `要注意：付完「${esc(hs.event.ev.name)}」後，錢會比至少要留的 ${about(S.settings.reserve)} 還少。`;
  h.push(`<div class="verdict ${lv}"><p class="say">${say}</p><p class="sub">${sub}${hs.started && lv !== 'good' ? ' <a href="#" data-act="why">看原因</a>' : ''}</p></div>`);

  // 1. 要做的事：只在真的需要時出現
  const todo = [], due = hs.daysLeft <= 0;
  if (due) todo.push(`<div class="row"><div class="what"><b>${hs.daysLeft === 0 ? '今天要結算' : '該結算了'}</b><span>打開網銀看總額，大約 3 分鐘</span></div><a class="btn pri small" href="#settle">開始結算</a></div>`);
  const lb = S.lastBackup, ago = lb ? Math.floor((Date.now() - Date.parse(lb)) / 864e5) : null;
  if (ago == null || ago > 35) todo.push(`<div class="row"><div class="what"><b>${lb ? `上次備份是 ${ago} 天前` : '還沒有備份過'}</b><span>資料只在這台手機，備份到 iCloud 雲碟比較安心</span></div><button class="pri small" data-act="backup">備份</button></div>`);
  if (todo.length) h.push(`<section class="card todo"><h3>要做的事</h3>${todo.join('')}</section>`);

  // 2. 生活費：先講接下來可以花多少，再看上一期花了多少
  let last2 = '';
  if (p) {
    const sd = p.actSide - p.planSide, span = `${md(p.from)}～${md(p.to)}${p.periods > 1 ? `，${p.periods} 個月一起算` : ''}`;
    let body;
    if (p.carry) body = `<p class="big-sm">先不判斷</p><p class="muted">這期併入下期，下次結算兩期一起算。</p>`;
    else if (p.unknown) body = `<p class="big-sm">無法判斷</p><p class="muted">有找不到來源的錢，這段不列入生活費統計。</p>`;
    else {
      const over = p.E - p.budget, pct = Math.max(0, Math.min(100, p.E / p.budget * 100));
      body = `<div class="meter ${over > 0 ? 'over' : ''}" role="img" aria-label="花了 ${fmt(p.E)}，預算 ${fmt(p.budget)}"><i style="width:${pct}%"></i></div>
        <div class="meter-legend"><span>花了約 ${about(p.E)}</span><span>預算 ${about(p.budget)}</span></div>
        <p style="margin:6px 0 0">${over > tol() ? `<span class="bad">多花了約 ${about(over)}</span>` : over > 0 ? `<span class="warn">多花一點點（約 ${about(over)}）</span>` : `<span class="good">比預算少花約 ${about(-over)}</span>`}</p>`;
    }
    last2 = `<div class="sub-block"><p class="label">上一期（${span}）</p>${body}
      <p class="muted" style="margin:6px 0 0">兼職收入約 ${about(p.actSide)}${sd < 0 ? `，比目標少 ${about(-sd)}` : '，有達標'}</p></div>`;
  }
  h.push(`<section class="card"><h3>生活費</h3>
    <p class="label">${md(hs.nextDate)} 結算前，可以花</p><p class="big">${about(hs.nextBudget)}</p>
    <p class="muted" style="margin:0">${due ? '' : `還有 ${hs.daysLeft} 天結算　<a href="#settle">提早結算</a>`}</p>${last2}</section>`);

  // 3. 接下來的大筆款項：時程表（日期｜名稱｜金額＋夠不夠）
  const open = S.events.filter(E.isOpen).sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1));
  const show = open.slice(0, 3);
  for (const ev of open) if (ev.selfFund && !show.includes(ev)) show.push(ev);
  if (show.length) {
    const li = show.map(ev => {
      const o = E.eventOutlook(S, ev), left = -E.eventRemaining(S, ev);
      const chip = ev.selfFund && o.gap ? `<span class="chip warn">還差 ${about(o.gap)}</span>` : o.gap ? `<span class="chip bad">差 ${about(o.gap)}</span>` : '<span class="chip good">夠</span>';
      const note = ev.selfFund && o.gap ? `每次結算多存約 ${about(o.perSettle)}` : `${range(ev).slice(5)} 付`;
      return `<li class="sched"><div class="mo"><b>${+ev.dateFrom.slice(5, 7)}月</b><span>${ev.dateFrom.slice(0, 4)}</span></div>
        <div class="nm"><b>${esc(ev.name)}${ev.estimate ? '<span class="tag">暫估</span>' : ''}</b><span>${note}</span></div>
        <div class="amt"><b>${left < 0 ? '＋' : ''}${about(left)}</b>${chip}</div></li>`;
    }).join('');
    h.push(`<section class="card"><h3>接下來的大筆款項</h3><ul class="sched-list">${li}</ul>
      <p class="muted" style="margin:8px 0 0">「夠」＝付完還留得住至少要留的 ${about(S.settings.reserve)}。</p><p style="margin:4px 0 0;text-align:right"><a href="#plan">看全部款項</a></p></section>`);
  }
  h.push(detailHtml(last));
  app.innerHTML = h.join('');
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

function settle() {
  D ??= S.draft || newDraft();
  if (D.date <= lastSnap().date) D.date = E.nextDue(S);
  const q = E.questions(S, D.date), last = lastSnap();
  const accNames = S.accounts || [];
  const h = [`<div class="flowbar"><a href="#home">← 回首頁</a><span>這個月的結算</span></div><div class="card" id="c-date"><h3>結算日</h3><input type="date" ${field('date')}><div class="muted">上次結算 ${ymd(last.date)}・預定 ${ymd(E.nextDue(S))}</div></div>`];
  h.push(`<div class="card" id="c-cash"><h3>現金總額</h3>${money('cash', 'placeholder="所有帳戶＋現金＋定存"')}
    <details><summary>錢分在好幾個帳戶？分開填，幫你加總</summary>${accNames.length ? accNames.map((n, i) => `<label>${esc(n)}</label>${money('acc.' + i)}`).join('') + '<div class="actions"><button class="small" data-act="accsum">加總填入</button></div>' : '<p class="muted" style="margin:8px 0 0">先寫下你有哪些帳戶，之後每個月就會一格一格列出來讓你填。</p>'}
      ${accNames.length ? '<details><summary>改帳戶清單</summary>' : ''}<label>你有哪些帳戶</label><input id="accnames" placeholder="例如：玉山，郵局，現金" value="${esc(accNames.join('，'))}"><div class="actions"><button class="small" data-act="accsave">儲存</button></div><p class="muted">寫你自己認得的名字就好，不用帳號。用逗號分開。</p>${accNames.length ? '</details>' : ''}</details>
    <div class="muted">輸入網銀看到的總額即可，已包含本期入帳的薪資、兼職。</div>
    <label>股票市值（選填，不算現金）</label>${money('stock')}</div>`);
  h.push(`<div class="card"><h3>兼職收入</h3><div class="muted">填本期實際收到的金額（沒收到填 0）。這筆已在現金總額裡，工具不會重複加。</div>${S.sideItems.filter(i => i.active).map(i => `<label>${esc(i.name)}${i.kind === 'once' ? '（單次）' : ''}</label>${money('side.' + i.id)}`).join('')}
    <details><summary>新增一筆兼職</summary><label>名稱</label><input ${field('newSide.name')}><label>本期金額</label>${money('newSide.amount')}
    <div class="opts">${radio('newSide.kind', 'once', '單次')}${radio('newSide.kind', 'monthly', '每月固定')}</div></details></div>`);
  for (const ev of q.events) {
    const k = 'ev.' + ev.id; D.ev[ev.id] ??= { mode: '', amount: -E.eventRemaining(S, ev), from: ev.dateFrom, to: ev.dateTo };
    h.push(`<div class="card" id="c-ev-${ev.id}"><h3>${esc(ev.name)}付了嗎？</h3><div class="muted">${range(ev)}・剩 ${fmt(-E.eventRemaining(S, ev))} 元</div>
      <div class="opts">${radio(k + '.mode', 'paid', '已付全額')}${radio(k + '.mode', 'partial', '部分付款')}${radio(k + '.mode', 'no', '還沒付')}${radio(k + '.mode', 'delay', '延期')}</div>
      ${['paid', 'partial'].includes(D.ev[ev.id].mode) ? `<label>付款金額</label>${money(k + '.amount')}` : ''}
      ${D.ev[ev.id].mode === 'delay' ? `<div class="inline"><div><label>新日期（最早）</label><input type="date" ${field(k + '.from')}></div><div><label>最晚</label><input type="date" ${field(k + '.to')}></div></div>` : ''}</div>`);
  }
  for (const b of q.bonus) {
    const k = 'bonus.' + b.year; D.bonus[b.year] ??= { mode: '', amount: b.plan, scope: 'once' };
    h.push(`<div class="card" id="c-bonus-${b.year}"><h3>${b.year} 年終發了嗎？</h3><div class="muted">計畫 ${fmt(b.plan)}</div>
      <div class="opts">${radio(k + '.mode', 'got', '已發')}${radio(k + '.mode', 'no', '還沒發')}</div>
      ${D.bonus[b.year].mode === 'got' ? `<label>實領金額</label>${money(k + '.amount')}
      <div class="opts">${radio(k + '.scope', 'once', '只有今年')}${radio(k + '.scope', 'after', '以後也是這個金額')}</div>` : ''}</div>`);
  }
  const planSal = E.regularItems(S.plan, last.date, D.date).filter(i => i.type === 'salary').reduce((t, i) => t + i.amount, 0);
  h.push(`<details ${D.salary !== '' ? 'open' : ''} id="d-salary"><summary>收入有變動</summary><div class="card"><label>本期薪資實領（空白＝照計畫 ${fmt(planSal)}）</label>${money('salary')}
    <div class="opts">${radio('salaryScope', 'once', '只有這次（請假等）')}${radio('salaryScope', 'after', '之後都是（調薪等）')}</div></div></details>`);
  h.push(`<details ${D.flows.length ? 'open' : ''} id="d-flows"><summary>其他大筆進出</summary><div class="card">${D.flows.map((f, i) => `<div class="inline"><select data-k="flows.${i}.kind">${Object.entries(FLOW).map(([v, [l]]) => `<option value="${v}" ${f.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <input inputmode="numeric" placeholder="金額" ${field(`flows.${i}.amount`)}></div><div class="echo" data-echo="flows.${i}.amount">${echo(`flows.${i}.amount`)}</div><input placeholder="備註" ${field(`flows.${i}.note`)}>`).join('<hr>')}
    <div class="actions"><button class="small" data-act="addflow">新增一筆</button></div></div></details>`);
  h.push(`<div id="preview"></div><div class="actions full"><button data-act="calc">試算</button><button class="pri" data-act="confirm" disabled>確認結算</button></div><div class="hint" id="cf-hint"></div>
    <div class="actions"><button class="small" data-act="discard">清除草稿</button></div>`);
  app.innerHTML = h.join('');
  if (preview) showPreview(); else setConfirm();
}

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
  settle();
  $('#preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const card = e.at && document.getElementById(e.at);
  if (!card) return alert(e.message);
  card.classList.add('err');
  card.insertAdjacentHTML('afterbegin', `<div class="err-msg" role="alert">${esc(e.message)}</div>`);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const verdict = over => Math.round(over) === 0 ? '<span class="good">剛好等於預算</span>' : over < 0
  ? `<span class="good">比預算少花 ${fmt(-over)}</span>`
  : over <= tol() ? `<span class="warn">比預算多花 ${fmt(over)}（容許範圍內）</span>` : `<span class="bad">比預算多花 ${fmt(over)}</span>`;

function showPreview() {
  const { p, check, early, snap } = preview, over = p.E - p.budget, prev = p.startCash;
  const expected = snap.cash + p.E;
  const h = [`<div class="card"><h3>這期的錢怎麼變化</h3>`];
  if (early) h.push(`<div class="note bad">距上次結算只有 ${Math.round((Date.parse(p.to) - Date.parse(p.from)) / 864e5)} 天，不是完整週期（預定 ${ymd(E.nextDue(S))}），生活費無法判斷。若只是想看看，請按「清除草稿」。</div>`);
  h.push(rows([
    [p.merged ? `上上次現金（${md(p.from)}，上期併入）` : `上次現金（${md(p.from)}）`, fmt(prev)],
    [`＋ 薪資（${p.actSalary === p.planSalary ? '照計畫' : '已更正'}）`, fmt(p.actSalary)],
    p.actSide ? ['＋ 兼職', fmt(p.actSide)] : null, p.actBonus ? ['＋ 年終', fmt(p.actBonus)] : null, p.oneOff ? ['＋ 一次性收入', fmt(p.oneOff)] : null,
    ['－ 信貸月付', fmt(p.loanPay)], p.nonLiving ? ['± 事件與其他大筆進出', sgn(p.nonLiving)] : null,
    ['＝ 完全沒花錢的話，應該有', fmt(expected), 'sum'], [`實際現金（${md(p.to)}）`, fmt(snap.cash)]]));
  if (p.carry) {
    h.push(`<div class="big" style="margin-top:10px">本期生活費 併入下期</div><div class="note info">這期先不判斷生活費。下次結算時，兩期合併計算、跟兩期預算比。超前／落後照常計算。
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
    if (p.unknown) h.push(`<div class="big" style="margin-top:10px">本期生活費 無法判斷</div><div class="note info">有找不到來源的錢（金額不明），這段期間的生活費不列入統計。超前／落後照常計算。之後想起來，到「其他大筆進出」改類型就好。</div>`);
    else h.push(`<div class="muted" style="margin-top:10px">應有 − 實際 ＝ ${p.merged ? `這 ${p.merged} 期` : '這期'}花掉的錢</div><div class="big">${p.merged ? '兩期合計' : '本期'}生活費 ${fmt(p.E)}</div><div>預算 ${fmt(p.budget)}・${verdict(over)}</div>`);
    if (check && !D.ack) h.push(over > 0
      ? `<div class="note">多花了 ${fmt(over)}。如果其中有不是生活費的支出（押金、買股、提前還款），請記到「其他大筆進出」；薪資少領請填「收入有變動」。
        <div class="actions"><button class="small" data-act="open" data-id="d-flows">有其他大筆支出</button><button class="small" data-act="open" data-id="d-salary">薪資少領</button><button class="small" data-act="ack">沒有，就是這樣花的</button></div></div>`
      : `<div class="note">比預算少花很多（${fmt(-over)}）。如果有收入沒記（年終、資助、退款），請補上，不然會被當成省下來的錢。
        <div class="actions"><button class="small" data-act="open" data-id="d-flows">有收入沒記</button><button class="small" data-act="ack">沒有，真的省下來了</button></div></div>`);
  }
  $('#preview').innerHTML = h.join('') + '</div>';
  setConfirm();
}

async function confirmSettle() {
  if (preview?.early && !confirm('這次不是完整週期，確定要結算嗎？')) return;
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
  location.hash = '#home';
  if (confirm('結算完成。現在備份到 iCloud 雲碟嗎？')) backup();
}

async function undoLast() {
  const s = lastSnap();
  if (s.start) return alert('起點不能撤回。');
  if (!confirm(`撤回 ${ymd(s.date)} 的結算？資料會回到結算前，可重新填寫。`)) return;
  for (const e of s.applied?.events || []) Object.assign(S.events.find(x => x.id === e.id), e.prev);
  for (const c of s.applied?.plan || []) S.plan[c.key] = S.plan[c.key].filter(x => x !== c.entry && JSON.stringify(x) !== JSON.stringify(c.entry));
  S.sideItems = S.sideItems.filter(i => !(s.applied?.sideItems || []).includes(i.id));
  S.snapshots.pop();
  await commit(`撤回結算 ${s.date}`);
  render();
}

// ---------- 紀錄 ----------
function history() {
  const r = E.progress(S);
  app.innerHTML = `<h2>結算紀錄</h2>${r.periods.slice().reverse().map(p => `<div class="card"><h3>${ymd(p.to)}<span class="muted">（${md(p.from)}→${md(p.to)}）</span></h3>
    ${rows([['生活費', livingText(p) + ' / ' + fmt(p.budget)], p.merged ? ['合併計算', `${p.merged} 次結算`] : null, ['兼職', fmt(p.actSide) + ' / ' + fmt(p.planSide)], p.salaryDiff ? ['薪資差異', sgn(p.salaryDiff)] : null,
      p.actBonus ? ['年終', fmt(p.actBonus)] : null, ...p.flows.map(f => f.kind === 'unknownIn' ? ['找不到來源的錢', '金額不明'] : [f.kind === 'event' ? esc(S.events.find(e => e.id === f.eventId)?.name) : (FLOW[f.kind]?.[0] || f.kind) + (f.note ? '・' + esc(f.note) : ''), sgn(f.amount)])])}</div>`).join('')}
    <div class="card muted">起點 ${ymd(S.snapshots[0].date)}・現金 ${fmt(S.snapshots[0].cash)}</div>
    ${S.snapshots.length > 1 ? '<div class="actions"><button class="danger" data-act="undo">撤回最近一次結算</button></div>' : ''}`;
}

// ---------- 計畫：我的計畫一頁看完 ----------
const STATUS = { planned: '未付', partial: '部分付款', paid: '已付', cancelled: '取消' };
let planEdit = null; // 計畫頁正在修改哪一項
const ym = m => `${m.slice(0, 4)}/${+m.slice(5)}`;
function plan() {
  const fm = E.firstEditableMonth(S), cur = E.planValues(S.plan, fm), orig = E.planValues(E.originalPlan(S.plan), fm), P = S.plan;
  const when = { salary: `每月 ${P.salaryDay} 日入帳`, side: `每月 ${P.sideDay} 日，${P.sideStart ? ym(P.sideStart) + ' 起' : ''}`, living: '每個月', bonus: `每年 ${P.bonusMonth} 月` };
  const prow = k => {
    const d = E.PLAN_KEYS[k], changed = cur[k] !== orig[k];
    const head = `<div class="prow"><div class="pl"><b>${d.label}</b><span>${when[k]}</span></div><div class="pv"><b class="num">${fmt(cur[k])}</b>${changed ? `<span>原本 ${fmt(orig[k])}</span>` : ''}</div>
      ${planEdit === k ? '' : `<button class="small" data-act="pedit" data-key="${k}">改</button>`}</div>`;
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
  ${cmp ? `<section class="card"><h3>跟原本的計畫比</h3><p style="margin:0">照現在的計畫，到 ${ymd(cmp.date)} 會比原本<b class="${cmp.diff >= 0 ? 'good' : 'bad'}">${cmp.diff >= 0 ? '多' : '少'}存約 ${about(cmp.diff)}</b>。</p>
    <details><summary>改過哪些地方</summary><ul class="plain-list">${hist.map(({ k, d, c }) => `<li><span>${ym(c.from)} 起，${d.label}改成 <b class="num">${fmt(c.amount)}</b></span>${c.from >= fm ? `<button class="small" data-act="pundo" data-key="${k}" data-from="${c.from}">撤回</button>` : '<span class="muted">已生效</span>'}</li>`).join('')}</ul></details></section>` : ''}
  <div class="card"><h3>兼職項目</h3><div class="list">${S.sideItems.map(i => `<div class="item"><span>${esc(i.name)}<span class="muted">　${i.kind === 'monthly' ? `每月 ${fmt(i.amount)}` : '單次'}${i.active ? '' : '，已停用'}</span></span>
      <button class="small" data-act="sidetoggle" data-id="${i.id}">${i.active ? '停用' : '啟用'}</button></div>`).join('')}</div>
    <details><summary>新增每月兼職</summary><div class="inline"><input id="sn" placeholder="名稱"><input id="sa" inputmode="numeric" placeholder="每月金額"></div>
    <div class="actions"><button class="small" data-act="sideadd">新增</button></div><p class="muted">單次收入在結算時新增就好。</p></details></div>
  <h2>大筆款項</h2>${list.map(ev => `<div class="card"><details><summary><b>${esc(ev.name)}</b>　<span class="num">${range(ev)}，${sgn(ev.amount)}</span><span class="tag">${STATUS[ev.status]}</span>${ev.estimate ? '<span class="tag">暫估</span>' : ''}</summary>
    <form data-ev="${ev.id}"><label>名稱</label><input name="name" value="${esc(ev.name)}">
    <label>金額（要付的寫負數，會收到的寫正數）</label><input name="amount" inputmode="numeric" value="${ev.amount}">
    <div class="inline"><div><label>最早</label><input type="date" name="dateFrom" value="${ev.dateFrom}"></div><div><label>最晚</label><input type="date" name="dateTo" value="${ev.dateTo}"></div></div>
    <label>狀態</label><select name="status">${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${ev.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label class="opts"><input type="checkbox" name="estimate" ${ev.estimate ? 'checked' : ''}> 金額還是暫估的</label>
    <div class="muted">已付 ${fmt(-E.eventPaid(S, ev))}（從結算紀錄算出來）</div>
    <div class="actions"><button class="pri" data-act="evsave">儲存</button></div></form></details></div>`).join('')}
    <div class="actions"><button data-act="evadd">新增款項</button></div>
  <h2>至少要留的錢</h2><form class="card" id="resf"><p class="muted" style="margin:0">付完大筆款項後，帳戶裡至少要剩多少才安心（備用金）。</p>
    <input name="reserve" inputmode="numeric" value="${S.settings.reserve}"><div class="actions"><button class="pri" data-act="ressave">儲存</button></div></form>`;
}

// ---------- 設定：外觀、提醒、備份、測試、進階 ----------
function settings() {
  const st = S.settings, pal = document.documentElement.dataset.palette;
  app.innerHTML = `<h2>設定</h2>
    <div class="card"><h3>外觀</h3><div class="swatches">${Object.entries(PALETTES).map(([k, n]) => `<button class="swatch ${pal === k ? 'on' : ''}" data-act="palette" data-p="${k}" data-palette="${k}" aria-pressed="${pal === k}"><i></i>${n}</button>`).join('')}</div>
      <label>深色／淺色</label><div class="seg">${Object.entries(MODES).map(([k, n]) => `<button class="${(document.documentElement.dataset.mode || 'auto') === k ? 'on' : ''}" data-act="mode" data-m="${k}" aria-pressed="${(document.documentElement.dataset.mode || 'auto') === k}">${n}</button>`).join('')}</div></div>
    <form class="card" id="dayf"><h3>提醒</h3><label>每個月幾號結算</label><input name="settleDay" inputmode="numeric" value="${st.settleDay}">
      <div class="actions"><button class="pri" data-act="daysave">儲存</button><button data-act="ics">加到手機行事曆</button></div>
      <p class="muted">改了日期之後，要重新加一次行事曆，並刪掉舊的。</p></form>
    <div class="card"><h3>備份與資料</h3><p style="margin:0">上次備份：${S.lastBackup ? S.lastBackup.slice(0, 10) : '還沒有'}</p>
      <div class="actions"><button class="pri" data-act="backup">備份到 iCloud 雲碟</button><button data-act="import">從備份還原</button></div>
      <p class="muted">資料只在這台手機，不會上傳。<span id="pst"></span></p></div>
    <div class="card"><h3>測試模式</h3>${sandbox
      ? '<p style="margin:0">現在<b>正在測試</b>。整個 App 都有斜紋外框時，就是在測試。</p><div class="actions"><button class="pri" data-act="sbAsk">結束測試</button></div>'
      : '<p style="margin:0">想試試看結算或改計畫，又不想弄亂資料時用。開始後整個 App 都會進入測試，結束時可以全部丟掉。</p><div class="actions"><button data-act="sbStart">開始測試模式</button></div>'}</div>
    <details class="more"><summary>進階規則</summary><form class="card" id="rulef">
      <label>差多少以內，算「照著計畫走」（元）</label><input name="tolerance" inputmode="numeric" value="${st.tolerance}">
      <label>生活費跟預算差多少，結算時要問我（元）</label><input name="askThreshold" inputmode="numeric" value="${st.askThreshold}">
      <label>股票賣掉，大概能拿回幾成（0～1，例如 0.8＝八成）</label><input name="stockHaircut" inputmode="decimal" value="${st.stockHaircut}">
      <div class="actions"><button class="pri" data-act="rulesave">儲存</button></div></form></details>
    <div class="card danger-zone"><h3>清除資料</h3><p class="muted" style="margin:0">刪掉這台手機上的全部 A計畫 資料。建議先備份。</p><div class="actions"><button class="danger" data-act="reset">清除全部資料</button></div></div>
    <p class="muted" style="text-align:center">版本 ${VERSION}</p>`;
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
  if (ok) { S.lastBackup = new Date().toISOString(); await commit('備份'); render(); }
}
async function importFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    let next;
    if (Array.isArray(obj.snapshots)) {
      next = E.migrate(obj);
      const errs = E.validateState(next);
      if (errs.length) throw new Error(errs.join('、'));
      if (!confirm(`還原備份：${next.snapshots.length - 1} 次結算、${next.events.length} 個事件，最後結算 ${next.snapshots.at(-1).date}。${S ? '會取代目前資料。' : ''}確定？`)) return;
    } else {
      next = E.initFromSetup(obj);
      if (!confirm(`匯入設定「${obj.name || ''}」：起點 ${obj.start.date}，現金 ${fmt(obj.start.cash)}。${S ? '會取代目前所有資料。' : ''}確定？`)) return;
    }
    S = next; await commit('匯入'); location.hash = '#home'; render();
  } catch (e) { alert('匯入失敗，原資料未變更：' + e.message); }
}

// ---------- 事件委派 ----------
const acts = {
  import: () => { $('#file').value = ''; $('#file').click(); },
  demo: async () => { S = E.initFromSetup(await (await fetch('setup.example.json')).json()); await commit('試用範例'); render(); },
  backup, undo: undoLast,
  sbStart: async () => {
    if (!confirm('開始測試模式？\n\n接下來整個 App 都在測試中：結算、改計畫都可以隨意試。\n結束時可以選擇全部丟掉，回到現在的樣子。')) return;
    await DB.save(S, 'sandbox'); sandbox = true; location.hash = '#home'; render(); toast('已進入測試模式');
  },
  sbAsk: () => sheet(`<h3>結束測試模式</h3><p>測試期間做的結算和修改，要怎麼處理？</p>
    <div class="actions full col"><button class="pri" data-act="sbEnd">全部丟掉，回到測試前</button><button data-act="sbKeep">保留，當成正式資料</button><button class="plain" data-act="sheetClose">繼續測試</button></div>`),
  sheetClose: () => sheet(''),
  sbEnd: async () => { S = await DB.load('sandbox'); D = null; preview = null; await DB.save(S); await DB.clear('sandbox'); sandbox = false; sheet(''); location.hash = '#home'; render(); toast('已回到測試前的資料'); },
  sbKeep: async () => { await DB.clear('sandbox'); sandbox = false; sheet(''); render(); toast('測試結果已保留'); },
  update: () => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage('skip')),
  calc: () => { try { calc(); } catch (e) { showError(e); } },
  confirm: () => confirmSettle().catch(showError),
  ack: () => { D.ack = true; showPreview(); },
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
  fixcash: () => { preview = null; D.fix = null; D.carry = false; settle(); const c = $('[data-k=cash]'); c.focus(); c.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
  palette: el => { setPalette(el.dataset.p); render(); },
  mode: el => { setMode(el.dataset.m); render(); },
  why: () => { const m = $('#more'), w = $('#why'); m.open = true; if (w) w.open = true; (w || m).scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  open: el => { const d = document.getElementById(el.dataset.id); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); },
  addflow: () => { D.flows.push({ kind: 'income', amount: '', note: '' }); preview = null; settle(); },
  discard: async () => { if (confirm('清除這次的結算草稿？')) { D = null; preview = null; S.draft = null; await commit(); settle(); } },
  accsum: () => { D.cash = String(Object.values(D.acc).reduce((t, v) => t + (num(v) || 0), 0)); preview = null; settle(); },
  ics: () => shareFile('izu-a-plan-reminder.ics', E.makeIcs(S.settings.settleDay, today()), 'text/calendar'),
  reset: async () => { if (prompt('輸入「清除」以刪除這台裝置上的全部 A計畫 資料（建議先備份）') === '清除') { await DB.clear(); S = null; render(); } },
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
  evsave: async el => {
    const form = el.closest('form'), f = new FormData(form), ev = S.events.find(x => x.id === form.dataset.ev);
    const before = JSON.stringify(ev);
    Object.assign(ev, { name: f.get('name'), amount: num(f.get('amount')) || 0, dateFrom: f.get('dateFrom'), dateTo: f.get('dateTo') < f.get('dateFrom') ? f.get('dateFrom') : f.get('dateTo'), status: f.get('status'), estimate: !!f.get('estimate') });
    await commit(`修改事件 ${ev.name}：${before} → ${JSON.stringify(ev)}`); render();
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
  else if (preview) { preview = null; $('#preview').innerHTML = ''; setConfirm(); }
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
(async () => {
  try { const raw = await DB.load(); S = raw ? E.migrate(raw) : null; sandbox = !!(await DB.load('sandbox')); } catch (e) { alert('讀取資料失敗：' + e.message); }
  DB.persist();
  render();
})();
