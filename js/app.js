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
const status = (n, good = '超前', bad = '落後') => Math.abs(n) <= tol()
  ? `<span class="good">符合計畫<span class="tag">±${fmt(tol())}內</span></span>`
  : n > 0 ? `<span class="good">${good} ${fmt(n)}</span>` : `<span class="bad">${bad} ${fmt(-n)}</span>`;
const rows = list => `<table class="rows">${list.filter(Boolean).map(([a, b, cls]) => `<tr class="${cls || ''}"><td>${a}</td><td class="num">${b}</td></tr>`).join('')}</table>`;

async function commit(msg) {
  if (msg) S.audit.push({ at: new Date().toISOString(), msg });
  await DB.save(S);
}

// ---------- 路由 ----------
const routes = { home, settle, history, events, settings };
function render() {
  const r = location.hash.slice(1) || 'home';
  document.querySelectorAll('.top nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + r));
  if (!S) return welcome();
  (routes[r] || home)();
  banners();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

function banners() {
  const b = [];
  if (sandbox) b.push('<div class="note info"><b>測試模式中</b>：可以隨意結算、改事件。<div class="actions"><button class="small pri" data-act="sbEnd">結束並還原</button><button class="small" data-act="sbKeep">保留目前結果</button></div></div>');
  const due = E.nextDue(S);
  if (today() >= due) b.push(`<div class="note">${today() === due ? '今天是結算日' : `已過結算日（${md(due)}）`}，<a href="#settle">開始結算</a>。</div>`);
  const lb = S.lastBackup;
  if (!lb || (Date.now() - Date.parse(lb)) / 864e5 > 35) b.push(`<div class="note">${lb ? `上次備份：${lb.slice(0, 10)}` : '還沒有備份'}。<a href="#" data-act="backup">現在備份</a></div>`);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent), standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone) b.push('<div class="note bad">請用 Safari「分享 → 加入主畫面」開啟，否則久未使用時資料可能被系統清除。</div>');
  $('#banner').innerHTML = b.join('') + ($('#banner').dataset.update ? '<div class="note info">有新版本。<a href="#" data-act="update">點此更新</a></div>' : '');
}

// ---------- 歡迎 ----------
function welcome() {
  $('#banner').innerHTML = '';
  app.innerHTML = `<div class="card"><h3>開始使用 A計畫</h3>
  <p>資料只存在這台裝置，不會上傳，也沒有加密。請定期備份到 iCloud 雲碟。</p>
  <div class="actions full"><button class="pri" data-act="import">匯入設定檔或備份</button></div>
  <div class="actions full"><button data-act="demo">試用範例（假資料）</button></div></div>`;
}

// ---------- 首頁 ----------
function home() {
  const last = lastSnap(), r = E.progress(S), p = r.periods.at(-1);
  const h = [];
  h.push(`<div class="card"><div class="muted">現金總額（${ymd(last.date)}）</div><div class="big">${fmt(last.cash)} 元</div>
    <div class="muted">股票市值 ${fmt(last.stock || 0)}（參考，不算現金）・備用金 ${fmt(S.settings.reserve)}</div></div>`);
  if (!p) h.push(`<div class="note info">已建立起點。下次結算日 ${ymd(E.nextDue(S))} 之後，才會有生活費與進度。</div>`);
  const g = [];
  if (p) {
    const over = p.E - p.budget;
    g.push(`<div class="card"><h3>本期生活費</h3><div class="big">${fmt(p.E)}</div>
      <div>${verdict(over)}</div>
      <div class="muted">預算 ${fmt(p.budget)}${p.periods > 1 ? `（跨 ${p.periods} 期）` : ''}・${md(p.from)}→${md(p.to)}・現金流出，含上期刷卡</div></div>`);
    const sd = p.actSide - p.planSide;
    g.push(`<div class="card"><h3>兼職收入</h3><div class="big">${fmt(p.actSide)}</div>
      <div>${sd >= 0 ? `<span class="good">${sd ? '超過目標 ' + fmt(sd) : '達標'}</span>` : `<span class="bad">低於目標 ${fmt(-sd)}</span>`}</div>
      <div class="muted">目標 ${fmt(p.planSide)}</div></div>`);
    g.push(progressCard());
  }
  const ev = E.nextEvent(S);
  if (ev) g.push(eventCard(ev, '下一事件'));
  const sf = S.events.find(e => e.selfFund && E.isOpen(e));
  if (sf && sf !== ev) g.push(gapCard(sf, last));
  h.push(`<div class="grid">${g.join('')}</div>`);
  h.push(`<div class="actions full"><a class="btn pri" href="#settle">開始結算</a></div>`);
  app.innerHTML = h.join('');
}

function progressCard() {
  const t = E.standing(S), sum = t.parts.reduce((a, x) => a + x[1], 0);
  return `<div class="card"><h3>累積進度</h3><div class="big">${status(t.diff)}</div>
  ${rows([[`目標（${md(t.date)}）`, fmt(t.target)], ['實際', fmt(t.actual)]])}
  ${t.parts.length ? `<details><summary>差在哪裡</summary>${rows([...t.parts.map(([l, v]) => [esc(l), sgn(v)]), ['合計', sgn(sum), 'sum']])}</details>` : ''}
  <div style="margin-top:10px"><b>下一期目標（${ymd(t.nextDate)}）：${fmt(t.nextTarget)}</b></div>
  ${t.pending.map(p => `<div class="muted">${esc(p.name)} 最晚 ${md(p.dateTo)} 付，付款後目標會再減 ${fmt(-p.amount)}</div>`).join('')}
  <details><summary>相對原A計畫 ${sgn(t.vsOriginal)}</summary>${rows([...(S.original.breakdown || []).map(b => [esc(b.label) + '（起點）', sgn(b.amount)]), ['起點以來', sgn(t.diff)], ['合計', sgn(t.vsOriginal), 'sum']])}</details></div>`;
}

function eventCard(ev, title) {
  const o = E.eventOutlook(S, ev), paid = E.eventPaid(S, ev);
  return `<div class="card"><h3>${title}</h3><div><b>${esc(ev.name)}</b>${ev.estimate ? '<span class="tag">暫估</span>' : ''}</div>
  <div class="num">${range(ev)}・${fmt(Math.abs(ev.amount))} 元${paid ? `（已付 ${fmt(-paid)}）` : ''}</div>
  <div>付款後預計剩 <b class="num">${fmt(o.after)}</b></div>
  <div>${o.gap ? `<span class="bad">距備用金少 ${fmt(o.gap)}</span>` : '<span class="good">備用金足夠</span>'}</div>
  <div class="muted">以最早付款日估算</div></div>`;
}

function gapCard(ev, last) {
  const o = E.eventOutlook(S, ev), stock = (last.stock || 0) * S.settings.stockHaircut;
  return `<div class="card"><h3>${ev.dateFrom.slice(0, 4)}年${+ev.dateFrom.slice(5, 7)}月 ${esc(ev.name)}</h3>
  ${o.gap ? `<div class="big bad">缺 ${fmt(o.gap)}</div>${rows([
    ['付款前剩餘結算次數', o.settlesLeft], ['平均每次需多存', fmt(o.perSettle)], [`賣股約可補（市值×${S.settings.stockHaircut}）`, fmt(stock)]])}
    <div class="muted">可多存、賣股或借款補足，工具不預設任何一種。</div>` : '<div class="big good">目前預估不缺</div>'}</div>`;
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
const FLOW = { income: ['一次性收入（中獎、獎金等）', 1], gift: ['家人資助', 1], stockSell: ['賣股入帳', 1], loanIn: ['借款入帳', 1], stockBuy: ['買股', -1], prepay: ['提前還款', -1], otherOut: ['其他非生活支出（押金等）', -1], otherIn: ['其他入帳（退款、押金返還等）', 1] };

function settle() {
  D ??= S.draft || newDraft();
  if (D.date <= lastSnap().date) D.date = E.nextDue(S);
  const q = E.questions(S, D.date), last = lastSnap();
  const accNames = S.accounts || [];
  const h = [`<div class="card" id="c-date"><h3>結算日</h3><input type="date" ${field('date')}><div class="muted">上次結算 ${ymd(last.date)}・預定 ${ymd(E.nextDue(S))}</div></div>`];
  h.push(`<div class="card" id="c-cash"><h3>現金總額</h3>${money('cash', 'placeholder="所有帳戶＋現金＋定存"')}
    <details><summary>帳戶計算機</summary>${accNames.length ? accNames.map((n, i) => `<label>${esc(n)}</label>${money('acc.' + i)}`).join('') + '<div class="actions"><button class="small" data-act="accsum">加總填入</button></div>' : '<p class="muted">到「設定」新增帳戶暱稱即可使用。</p>'}</details>
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
  for (const f of D.flows) if (num(f.amount)) snap.flows.push({ kind: f.kind, amount: Math.abs(num(f.amount)) * FLOW[f.kind][1], note: f.note || '' });
  return snap;
}

function calc() {
  const snap = buildSnap();
  const tmp = structuredClone(S); tmp.snapshots.push(snap);
  const p = E.calcPeriod(tmp, lastSnap(), snap);
  const early = snap.date < E.addDays(E.nextDue(S), -5);
  preview = { snap, p, early, check: !early && E.needsIncomeCheck(S, p) };
  settle();
  $('#preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 確認鈕：不能按時寫出原因
function setConfirm() {
  const b = $('[data-act=confirm]'), h = $('#cf-hint');
  if (!b) return;
  const p = preview?.p;
  const why = !preview ? '填好後先按「試算」，確認數字再結算'
    : p.E < 0 ? '先補記入帳或更正總額，才能結算'
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
  const { p, check, early, snap } = preview, over = p.E - p.budget, prev = lastSnap().cash;
  const expected = snap.cash + p.E;
  const h = [`<div class="card"><h3>這期的錢怎麼變化</h3>`];
  if (early) h.push(`<div class="note bad">距上次結算只有 ${Math.round((Date.parse(p.to) - Date.parse(p.from)) / 864e5)} 天，不是完整週期（預定 ${ymd(E.nextDue(S))}），生活費無法判斷。若只是想看看，請按「清除草稿」。</div>`);
  h.push(rows([
    [`上次現金（${md(p.from)}）`, fmt(prev)],
    [`＋ 薪資（${p.actSalary === p.planSalary ? '照計畫' : '已更正'}）`, fmt(p.actSalary)],
    p.actSide ? ['＋ 兼職', fmt(p.actSide)] : null, p.actBonus ? ['＋ 年終', fmt(p.actBonus)] : null, p.oneOff ? ['＋ 一次性收入', fmt(p.oneOff)] : null,
    ['－ 信貸月付', fmt(p.loanPay)], p.nonLiving ? ['± 事件與其他大筆進出', sgn(p.nonLiving)] : null,
    ['＝ 完全沒花錢的話，應該有', fmt(expected), 'sum'], [`實際現金（${md(p.to)}）`, fmt(snap.cash)]]));
  if (p.E < 0) {
    h.push(`<div class="note bad"><b>實際現金比「完全沒花錢」還多 ${fmt(-p.E)} 元。</b><br>代表有錢進來但還沒記，例如年終、家人資助、退款、押金返還、賣股；也請確認總額沒有打錯。選一個類型，再填那筆錢<b>實際入帳的金額</b>（不是上面的差額）：
      <div class="actions"><button class="small" data-act="quick" data-kind="income">一次性收入（算進度）</button><button class="small" data-act="quick" data-kind="gift">家人資助</button><button class="small" data-act="quick" data-kind="otherIn">退款等其他入帳</button><button class="small" data-act="fixcash">總額打錯了</button></div></div>`);
  } else {
    h.push(`<div class="muted" style="margin-top:10px">應有 − 實際 ＝ 這期花掉的錢</div><div class="big">本期生活費 ${fmt(p.E)}</div><div>預算 ${fmt(p.budget)}・${verdict(over)}</div>`);
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
    ${rows([['生活費', fmt(p.E) + ' / ' + fmt(p.budget)], ['兼職', fmt(p.actSide) + ' / ' + fmt(p.planSide)], p.salaryDiff ? ['薪資差異', sgn(p.salaryDiff)] : null,
      p.actBonus ? ['年終', fmt(p.actBonus)] : null, ...p.flows.map(f => [f.kind === 'event' ? esc(S.events.find(e => e.id === f.eventId)?.name) : (FLOW[f.kind]?.[0] || f.kind) + (f.note ? '・' + esc(f.note) : ''), sgn(f.amount)])])}</div>`).join('')}
    <div class="card muted">起點 ${ymd(S.snapshots[0].date)}・現金 ${fmt(S.snapshots[0].cash)}</div>
    ${S.snapshots.length > 1 ? '<div class="actions"><button class="danger" data-act="undo">撤回最近一次結算</button></div>' : ''}`;
}

// ---------- 事件 ----------
const STATUS = { planned: '未付', partial: '部分付款', paid: '已付', cancelled: '取消' };
function events() {
  const list = [...S.events].sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1));
  app.innerHTML = `<h2>事件</h2>${list.map(ev => `<div class="card"><details><summary><b>${esc(ev.name)}</b>　<span class="num">${range(ev)}・${sgn(ev.amount)}</span>　<span class="tag">${STATUS[ev.status]}</span>${ev.estimate ? '<span class="tag">暫估</span>' : ''}</summary>
    <form data-ev="${ev.id}"><label>名稱</label><input name="name" value="${esc(ev.name)}">
    <label>金額（支出為負，收入為正）</label><input name="amount" inputmode="numeric" value="${ev.amount}">
    <div class="inline"><div><label>最早</label><input type="date" name="dateFrom" value="${ev.dateFrom}"></div><div><label>最晚</label><input type="date" name="dateTo" value="${ev.dateTo}"></div></div>
    <label>狀態</label><select name="status">${Object.entries(STATUS).map(([v, l]) => `<option value="${v}" ${ev.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label class="opts"><input type="checkbox" name="estimate" ${ev.estimate ? 'checked' : ''}> 暫估金額</label>
    <div class="muted">已付 ${fmt(-E.eventPaid(S, ev))}（由結算紀錄計算）</div>
    <div class="actions"><button class="pri" data-act="evsave">儲存</button></div></form></details></div>`).join('')}
    <div class="actions"><button data-act="evadd">新增事件</button></div>`;
}

// ---------- 設定 ----------
function settings() {
  const st = S.settings;
  app.innerHTML = `<h2>設定</h2><form class="card" id="setf">
    <label>每月結算日</label><input name="settleDay" inputmode="numeric" value="${st.settleDay}">
    <label>進度容許誤差（元）</label><input name="tolerance" inputmode="numeric" value="${st.tolerance}">
    <label>生活費偏離多少就追問收入（元）</label><input name="askThreshold" inputmode="numeric" value="${st.askThreshold}">
    <label>備用金（元）</label><input name="reserve" inputmode="numeric" value="${st.reserve}">
    <label>賣股估算折扣（0～1）</label><input name="stockHaircut" inputmode="decimal" value="${st.stockHaircut}">
    <label>帳戶暱稱（用逗號分隔，只存暱稱）</label><input name="accounts" value="${esc((S.accounts || []).join('，'))}">
    <div class="actions"><button class="pri" data-act="setsave">儲存設定</button></div></form>
    <div class="card"><h3>兼職項目</h3><div class="list">${S.sideItems.map(i => `<div class="item"><span>${esc(i.name)}・${i.kind === 'monthly' ? '每月' : '單次'}・${fmt(i.amount)}</span>
      <button class="small" data-act="sidetoggle" data-id="${i.id}">${i.active ? '停用' : '啟用'}</button></div>`).join('')}</div>
      <div class="inline"><input id="sn" placeholder="名稱"><input id="sa" inputmode="numeric" placeholder="每月預設金額"></div>
      <div class="actions"><button class="small" data-act="sideadd">新增每月項目</button></div><p class="muted">單次收入在結算時新增即可。</p></div>
    <div class="card"><h3>測試模式</h3><p class="muted">先把目前資料存一份，之後怎麼試都能一鍵還原到開始前。</p><div class="actions">${sandbox ? '<button class="pri" data-act="sbEnd">結束並還原</button>' : '<button data-act="sbStart">開始測試模式</button>'}</div></div>
    <div class="card"><h3>提醒與資料</h3><div class="actions">
      <button data-act="ics">下載行事曆提醒</button><button data-act="backup">備份</button><button data-act="import">匯入備份</button></div>
      <p class="muted">上次備份：${S.lastBackup ? S.lastBackup.slice(0, 10) : '無'}・版本 ${VERSION}・<span id="pst"></span></p>
      <div class="actions"><button class="danger" data-act="reset">清除全部資料</button></div></div>`;
  navigator.storage?.persisted?.().then(v => { const e = $('#pst'); if (e) e.textContent = v ? '已設為持久儲存' : '未設為持久儲存'; });
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
  sbStart: async () => { await DB.save(S, 'sandbox'); sandbox = true; render(); },
  sbEnd: async () => { if (!confirm('還原到開始測試前的資料？測試期間的變更會全部丟掉。')) return; S = await DB.load('sandbox'); D = null; preview = null; await DB.save(S); await DB.clear('sandbox'); sandbox = false; location.hash = '#home'; render(); },
  sbKeep: async () => { if (!confirm('保留測試期間的變更，並結束測試模式？')) return; await DB.clear('sandbox'); sandbox = false; render(); },
  update: () => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage('skip')),
  calc: () => { try { calc(); } catch (e) { showError(e); } },
  confirm: () => confirmSettle().catch(showError),
  ack: () => { D.ack = true; showPreview(); },
  quick: el => {
    D.flows.push({ kind: el.dataset.kind, amount: '', note: '' }); preview = null; settle();
    $('#d-flows').open = true; const inp = [...document.querySelectorAll('[data-k$=".amount"][data-k^="flows."]')].at(-1);
    inp.placeholder = '填實際入帳金額'; inp.focus(); inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  fixcash: () => { preview = null; settle(); const c = $('[data-k=cash]'); c.focus(); c.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
  open: el => { const d = document.getElementById(el.dataset.id); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); },
  addflow: () => { D.flows.push({ kind: 'income', amount: '', note: '' }); preview = null; settle(); },
  discard: async () => { if (confirm('清除這次的結算草稿？')) { D = null; preview = null; S.draft = null; await commit(); settle(); } },
  accsum: () => { D.cash = String(Object.values(D.acc).reduce((t, v) => t + (num(v) || 0), 0)); preview = null; settle(); },
  ics: () => shareFile('izu-a-plan-reminder.ics', E.makeIcs(S.settings.settleDay, today()), 'text/calendar'),
  reset: async () => { if (prompt('輸入「清除」以刪除這台裝置上的全部 A計畫 資料（建議先備份）') === '清除') { await DB.clear(); S = null; render(); } },
  setsave: async () => {
    const f = new FormData($('#setf')), n = k => Number(f.get(k));
    const day = n('settleDay');
    if (!(day >= 1 && day <= 28)) return alert('結算日請填 1～28');
    Object.assign(S.settings, { settleDay: day, tolerance: n('tolerance'), askThreshold: n('askThreshold'), reserve: n('reserve'), stockHaircut: Math.min(1, Math.max(0, n('stockHaircut'))) });
    S.accounts = String(f.get('accounts')).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    await commit('修改設定'); alert('已儲存'); render();
  },
  sideadd: async () => { const name = $('#sn').value.trim(), amount = num($('#sa').value) || 0; if (!name) return; S.sideItems.push({ id: uid('i'), name, kind: 'monthly', amount, active: true }); await commit('新增兼職 ' + name); render(); },
  sidetoggle: async el => { const i = S.sideItems.find(x => x.id === el.dataset.id); i.active = !i.active; await commit('切換兼職 ' + i.name); render(); },
  evadd: async () => { const t = today(); S.events.push({ id: uid('e'), name: '新事件', type: 'other', amount: 0, dateFrom: t, dateTo: t, status: 'planned' }); await commit('新增事件'); render(); },
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
