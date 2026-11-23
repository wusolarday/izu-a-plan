// 計算引擎：純函式，不碰 DOM／儲存。日期一律 'YYYY-MM-DD' 字串（Asia/Taipei 日曆日）。
// 金額：實績為整數元；計畫值可含小數，只在顯示時四捨五入。
export const SCHEMA = 1;

const pad = n => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayIn = (y, m, d) => ymd(y, m, Math.min(d, lastDay(y, m)));
export const addDays = (s, n) => { const t = new Date(s + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const sum = (a, f = x => x) => a.reduce((t, x) => t + (f(x) || 0), 0);

function* months(from, to) {
  let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { yield [y, m]; if (++m > 12) { m = 1; y++; } }
}

/** 依生效月份取值：changes = [{from:'YYYY-MM', amount}] */
export function valueAt(base, changes = [], month) {
  let v = base;
  for (const c of [...changes].sort((a, b) => (a.from < b.from ? -1 : 1))) if (c.from <= month) v = c.amount;
  return v;
}

/** 計畫中的經常性項目，區間 (d0, d1]。收入為正、支出為負。 */
export function regularItems(plan, d0, d1) {
  const out = [];
  for (const [y, m] of months(d0, d1)) {
    const M = ymd(y, m, 1).slice(0, 7);
    const add = (day, type, amount, label) => {
      const date = dayIn(y, m, day);
      if (date > d0 && date <= d1 && amount) out.push({ date, type, amount, label });
    };
    add(plan.salaryDay, 'salary', valueAt(plan.salary, plan.salaryChanges, M), '薪資');
    if (M >= plan.sideStart) add(plan.sideDay, 'side', valueAt(plan.sideTarget, plan.sideChanges, M), '兼職目標');
    if (m === plan.bonusMonth) add(plan.bonusDay, 'bonus', valueAt(plan.bonus, plan.bonusChanges, M), `${y}年終`);
    add(plan.livingDay, 'living', -valueAt(plan.living, plan.livingChanges, M), '生活費');
    for (const l of plan.loans || []) if (!l.closed && M >= l.first && M <= l.last) add(l.day, 'loan', -l.monthly, l.name);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 計畫頁可以直接改的每月數字：base＝原計畫的值，ch＝之後的修改 [{from:'YYYY-MM', amount}] */
export const PLAN_KEYS = {
  salary: { base: 'salary', ch: 'salaryChanges', label: '薪資' },
  side: { base: 'sideTarget', ch: 'sideChanges', label: '兼職目標' },
  living: { base: 'living', ch: 'livingChanges', label: '生活費預算' },
  bonus: { base: 'bonus', ch: 'bonusChanges', label: '年終' },
};
/** 某個月份的計畫值 */
export const planValues = (plan, month) =>
  Object.fromEntries(Object.entries(PLAN_KEYS).map(([k, d]) => [k, valueAt(plan[d.base], plan[d.ch], month)]));
/** 改計畫：從 from 月起改成 amount（同月份的舊修改會被取代）。回傳新的 plan，不改原物件。 */
export function setPlanValue(plan, key, from, amount) {
  const d = PLAN_KEYS[key];
  return { ...plan, [d.ch]: [...(plan[d.ch] || []).filter(c => c.from !== from), { from, amount }].sort((a, b) => (a.from < b.from ? -1 : 1)) };
}
export function removePlanChange(plan, key, from) {
  const d = PLAN_KEYS[key];
  return { ...plan, [d.ch]: (plan[d.ch] || []).filter(c => c.from !== from) };
}
/** 原本的計畫＝拿掉所有修改 */
export const originalPlan = plan => ({ ...plan, ...Object.fromEntries(Object.values(PLAN_KEYS).map(d => [d.ch, []])) });
/** 改計畫最早只能從下一期開始，已結算的月份不能改 */
export const firstEditableMonth = state => nextDue(state).slice(0, 7);
/** 跟原計畫比：到 d 那天，應該要有的錢差多少（正＝現在的計畫多存） */
export function planCompare(state, d) {
  const now = targetCash(state, d), orig = targetCash({ ...state, plan: originalPlan(state.plan) }, d);
  return { date: d, now, orig, diff: now - orig };
}

/** 事件已付金額：唯一來源是結算紀錄裡 kind='event' 的流量 */
export const eventPaid = (state, ev, upTo = '9999-12-31') =>
  sum(state.snapshots.filter(s => s.date <= upTo), s => sum((s.flows || []).filter(f => f.eventId === ev.id), f => f.amount));
export const isOpen = ev => ev.status !== 'paid' && ev.status !== 'cancelled';
export const eventRemaining = (state, ev) => (isOpen(ev) ? ev.amount - eventPaid(state, ev) : 0);

/** 年終：計畫日期 ≤ d 的年份，與已收紀錄比對 */
export function bonusStatus(state, d) {
  const received = {};
  for (const s of state.snapshots) for (const b of s.bonus || []) if (s.date <= d) received[b.year] = (received[b.year] || 0) + b.amount;
  const due = regularItems(state.plan, state.snapshots[0].date, d).filter(i => i.type === 'bonus')
    .map(i => ({ year: +i.date.slice(0, 4), plan: i.amount, date: i.date }));
  return due.map(b => ({ ...b, received: received[b.year] ?? null }));
}

/** 單一結算期：prev → snap。回傳生活費 E 與各項差額。 */
export function calcPeriod(state, prev, snap) {
  const items = regularItems(state.plan, prev.date, snap.date);
  const by = t => sum(items.filter(i => i.type === t), i => i.amount);
  const planSalary = by('salary'), planSide = by('side'), loanPay = -by('loan'), budget = -by('living');
  const actSalary = snap.salary ?? planSalary;
  const actSide = sum(snap.side || [], x => x.amount);
  const actBonus = sum(snap.bonus || [], b => b.amount);
  const flows = snap.flows || [];
  const oneOff = sum(flows.filter(f => f.kind === 'income'), f => f.amount);
  const nonLiving = sum(flows.filter(f => f.kind !== 'income'), f => f.amount);
  const income = actSalary + actSide + actBonus + oneOff;
  const E = prev.cash + income - loanPay + nonLiving - snap.cash;
  const n = items.filter(i => i.type === 'living').length;
  // 找不到來源的錢：併入下期後仍對不起來時記這個，該期生活費無法判斷
  const unknown = sum(flows.filter(f => f.kind === 'unknownIn'), f => f.amount);
  return {
    from: prev.date, to: snap.date, startCash: prev.cash, periods: n, budget, E, loanPay,
    planSalary, actSalary, planSide, actSide, actBonus, oneOff, nonLiving, unknown,
    salaryDiff: actSalary - planSalary, sideDiff: actSide - planSide, livingDiff: budget - E,
    flows,
  };
}

const MERGE_KEYS = ['periods', 'budget', 'E', 'loanPay', 'planSalary', 'actSalary', 'planSide', 'actSide', 'actBonus', 'oneOff', 'nonLiving', 'salaryDiff', 'sideDiff', 'livingDiff', 'unknown'];
/** 兩個相連結算期合成一期（生活費可加總：E₁＋E₂＝起點現金＋收入−支出−終點現金）。 */
export function mergePeriods(a, b) {
  const m = { ...b, from: a.from, startCash: a.startCash, flows: [...a.flows, ...b.flows], merged: (a.merged || 1) + 1 };
  for (const k of MERGE_KEYS) m[k] = a[k] + b[k];
  return m;
}

/**
 * 各結算期。結算標了 carry（卡費晚扣、想不起來）時，該期生活費不判斷，與下一期合併計算。
 * 最後一筆若是 carry，回傳的最後一期會帶 carry:true（還在等下一期）。
 */
export function settledPeriods(state, snaps = state.snapshots) {
  const out = [];
  let acc = null;
  for (let i = 1; i < snaps.length; i++) {
    let p = calcPeriod(state, snaps[i - 1], snaps[i]);
    if (acc) p = mergePeriods(acc, p);
    if (snaps[i].carry) { acc = p; continue; }
    acc = null; out.push(p);
  }
  if (acc) out.push({ ...acc, carry: true });
  return out;
}

/** 截至最新結算的累積進度與原因拆解（相對目前計畫）。 */
export function progress(state, upTo) {
  const snaps = state.snapshots.filter(s => s.date <= (upTo || '9999-12-31'));
  const last = snaps[snaps.length - 1];
  const r = { salary: 0, side: 0, living: 0, carry: 0, unknown: 0, oneOff: 0, bonusDiff: 0, bonusPending: 0, eventAmount: 0, eventTiming: 0, transfer: 0, periods: [] };
  for (const p of settledPeriods(state, snaps)) {
    r.periods.push(p);
    r.salary += p.salaryDiff; r.side += p.sideDiff; r.oneOff += p.oneOff;
    if (p.carry) r.carry += p.livingDiff;
    else if (p.unknown) r.unknown += p.livingDiff + p.unknown; // 生活費無法判斷，不算少花
    else r.living += p.livingDiff;
    r.transfer += sum(p.flows.filter(f => !['income', 'event', 'unknownIn'].includes(f.kind)), f => f.amount);
  }
  for (const b of bonusStatus(state, last.date)) {
    if (b.received === null) r.bonusPending -= b.plan; else r.bonusDiff += b.received - b.plan;
  }
  for (const ev of state.events) {
    const paid = eventPaid(state, ev, last.date);
    if (ev.status === 'paid') r.eventAmount += paid - ev.amount;
    else if (ev.status === 'cancelled') continue;
    else if (ev.dateTo <= last.date) r.eventTiming += paid - ev.amount;
    else r.eventTiming += paid;
  }
  // 狀態用：排除時間差與資產轉換
  r.status = r.salary + r.side + r.bonusDiff + r.living + r.unknown + r.oneOff + r.eventAmount;
  r.total = r.status + r.bonusPending + r.eventTiming + r.transfer + r.carry;
  r.vsOriginal = r.total + (state.snapshots[0].cash - state.original.planCashAtStart);
  r.last = last;
  return r;
}

/** 從最新實績往後預測。支出事件放最早日、收入事件放最晚日（保守）。 */
export function forecast(state, toDate) {
  const last = state.snapshots[state.snapshots.length - 1];
  const tl = regularItems(state.plan, last.date, toDate).map(i => ({ ...i, kind: 'regular' }));
  for (const b of bonusStatus(state, last.date)) if (b.received === null) tl.push({ date: addDays(last.date, 1), type: 'bonus', amount: b.plan, label: `${b.year}年終（未發）`, kind: 'regular' });
  for (const ev of state.events) {
    const rem = eventRemaining(state, ev);
    if (!rem) continue;
    let date = rem < 0 ? ev.dateFrom : ev.dateTo;
    if (date <= last.date) date = addDays(last.date, 1);
    if (date <= toDate) tl.push({ date, type: 'event', amount: rem, label: ev.name, kind: 'event', eventId: ev.id });
  }
  tl.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === 'event' ? 1 : -1));
  let cash = last.cash;
  for (const t of tl) t.cash = cash += t.amount;
  return { start: last, timeline: tl };
}

/** 目標現金：起點＋計畫收支＋已到期（或已付清）事件。超前／落後＝實際−目標，不排除任何項目。 */
export function targetCash(state, d) {
  const s0 = state.snapshots[0];
  let t = s0.cash + sum(regularItems(state.plan, s0.date, d), i => i.amount);
  for (const ev of state.events) {
    if (ev.status === 'cancelled') continue;
    t += ev.dateTo <= d || ev.status === 'paid' ? ev.amount : eventPaid(state, ev, d);
  }
  return t;
}

const FLOW_LABEL = { income: '一次性收入', gift: '家人資助', stockSell: '賣股入帳', loanIn: '借款入帳', stockBuy: '買股', prepay: '提前還款', otherOut: '其他支出', otherIn: '其他入帳', unknownIn: '找不到來源的錢' };

/** 首頁用：本期目標 vs 實際、差在哪裡、下一期目標 */
export function standing(state) {
  const last = state.snapshots[state.snapshots.length - 1], d = last.date;
  const target = targetCash(state, d), diff = last.cash - target;
  const r = progress(state), parts = [];
  const add = (label, v) => { if (Math.round(v)) parts.push([label, v]); };
  add('薪資', r.salary); add('兼職', r.side); add('生活費', r.living);
  add('併入下期的生活費（還沒判斷）', r.carry);
  add('找不到來源的錢（該期生活費無法判斷）', r.unknown);
  for (const b of bonusStatus(state, d)) add(`${b.year}年終${b.received === null ? '（尚未入帳）' : ''}`, (b.received ?? 0) - b.plan);
  const byKind = {};
  for (const p of r.periods) for (const f of p.flows) if (f.kind !== 'event' && f.kind !== 'unknownIn') byKind[f.kind] = (byKind[f.kind] || 0) + f.amount;
  for (const [k, v] of Object.entries(byKind)) add(FLOW_LABEL[k] || k, v);
  for (const ev of state.events) {
    if (ev.status === 'cancelled') continue;
    const counted = ev.dateTo <= d || ev.status === 'paid' ? ev.amount : eventPaid(state, ev, d);
    add(ev.name + (ev.status === 'paid' ? '' : ev.dateTo <= d ? '（尚未付清）' : ''), eventPaid(state, ev, d) - counted);
  }
  const nextDate = nextDue(state);
  const pending = state.events.filter(ev => isOpen(ev) && ev.dateFrom <= nextDate && ev.dateTo > nextDate)
    .map(ev => ({ name: ev.name, amount: eventRemaining(state, ev), dateTo: ev.dateTo }));
  return { date: d, actual: last.cash, target, diff, parts, nextDate, nextTarget: targetCash(state, nextDate), pending,
    vsOriginal: diff + (state.snapshots[0].cash - state.original.planCashAtStart) };
}

/**
 * 首頁一句話用：燈號、差額、下次結算、下個月生活費上限、下一筆大筆款項。
 * 燈號：差額在容許內或超前＝good；落後但不到一個月生活費＝warn；
 * 落後超過一個月生活費，或下一筆款項付完會低於備用金＝bad。
 */
export function homeSummary(state, today) {
  const last = state.snapshots[state.snapshots.length - 1];
  const t = standing(state), tol = state.settings.tolerance;
  const nextDate = nextDue(state);
  const nextBudget = -sum(regularItems(state.plan, last.date, nextDate).filter(i => i.type === 'living'), i => i.amount);
  const ev = nextEvent(state), o = ev ? eventOutlook(state, ev) : null;
  const level = t.diff < -nextBudget || o?.gap > 0 ? 'bad' : t.diff < -tol ? 'warn' : 'good';
  const daysLeft = Math.round((Date.parse(nextDate) - Date.parse(today)) / 864e5);
  return { level, diff: t.diff, even: Math.abs(t.diff) <= tol, started: state.snapshots.length > 1,
    nextDate, daysLeft, nextBudget, event: ev ? { ev, remaining: -eventRemaining(state, ev), ...o } : null };
}

export const nextEvent = state => state.events.filter(isOpen).sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : 1))[0] || null;

/** 事件付款後預測現金與備用金缺口 */
export function eventOutlook(state, ev) {
  const f = forecast(state, ev.dateTo);
  const hit = f.timeline.find(t => t.eventId === ev.id);
  const after = hit ? hit.cash : f.start.cash;
  const reserve = state.settings.reserve;
  const settlesLeft = countSettles(state.settings.settleDay, addDays(f.start.date, 15), ev.dateFrom);
  const gap = Math.max(0, reserve - after);
  return { after, gap, settlesLeft, perSettle: settlesLeft ? gap / settlesLeft : gap };
}

export function countSettles(day, from, to) {
  let n = 0;
  for (const [y, m] of months(from, to)) { const d = dayIn(y, m, day); if (d > from && d < to) n++; }
  return n;
}

/** 下次應結算日：距上次結算至少半個月，避免 11/20 起點後隔天又要結算 */
export const nextDue = state => nextSettleDate(state.settings.settleDay, addDays(state.snapshots[state.snapshots.length - 1].date, 15));

export function nextSettleDate(day, after) {
  const [y, m] = after.split('-').map(Number);
  const cand = dayIn(y, m, day);
  if (cand > after) return cand;
  return m === 12 ? dayIn(y + 1, 1, day) : dayIn(y, m + 1, day);
}

/** 結算時需要問的問題 */
export function questions(state, date) {
  const last = state.snapshots[state.snapshots.length - 1];
  return {
    events: state.events.filter(ev => isOpen(ev) && ev.dateFrom <= date),
    bonus: bonusStatus(state, date).filter(b => b.received === null),
    since: last.date,
  };
}

/** 試算後是否需要追問收入（E 偏離預算或為負） */
export function needsIncomeCheck(state, p) {
  return p.E < 0 || Math.abs(p.E - p.budget) > state.settings.askThreshold;
}

export function initFromSetup(setup) {
  if (!setup || setup.schemaVersion !== SCHEMA || !setup.start || !setup.plan) throw new Error('設定檔格式不符');
  return {
    schemaVersion: SCHEMA,
    settings: { settleDay: 21, tolerance: 2000, askThreshold: 5000, stockHaircut: 0.8, reserve: 100000, ...setup.settings },
    plan: { salaryChanges: [], sideChanges: [], bonusChanges: [], livingChanges: [], loans: [], ...setup.plan },
    original: setup.original || { planCashAtStart: setup.start.cash, breakdown: [] },
    events: (setup.events || []).map(e => ({ status: 'planned', ...e })),
    sideItems: setup.sideItems || [],
    snapshots: [{ id: 's0', date: setup.start.date, cash: setup.start.cash, stock: setup.start.stock || 0, start: true }],
    audit: [], lastBackup: null,
  };
}

/** 資料遷移：之後新版 schema 在此依序升級 */
export function migrate(state) {
  if (!state || typeof state.schemaVersion !== 'number') throw new Error('不是有效的 A計畫 資料');
  if (state.schemaVersion > SCHEMA) throw new Error('此備份來自較新版本，請先更新 App');
  // 範例：if (state.schemaVersion === 1) { ...; state.schemaVersion = 2; }
  return state;
}

export function validateState(s) {
  const errs = [];
  if (!Array.isArray(s.snapshots) || !s.snapshots.length) errs.push('缺少結算紀錄');
  if (!Array.isArray(s.events)) errs.push('缺少事件');
  const ids = new Set();
  for (const x of [...(s.snapshots || []), ...(s.events || [])]) { if (ids.has(x.id)) errs.push('重複ID ' + x.id); ids.add(x.id); }
  for (let i = 1; i < (s.snapshots || []).length; i++) if (s.snapshots[i].date <= s.snapshots[i - 1].date) errs.push('結算日期順序錯誤');
  for (const sn of s.snapshots || []) if (!Number.isFinite(sn.cash)) errs.push('現金金額錯誤 ' + sn.date);
  return errs;
}

export function makeIcs(day, fromDate) {
  const d = nextSettleDate(day, addDays(fromDate, -1)).replaceAll('-', '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//izu-a-plan//ZH', 'BEGIN:VEVENT',
    `UID:izu-a-plan-settle-${day}@local`, `DTSTAMP:${d}T000000Z`, `DTSTART:${d}T090000`, `DTEND:${d}T091500`,
    `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`, 'SUMMARY:A計畫 每月結算', 'DESCRIPTION:打開網銀看總額，輸入 A計畫。',
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:A計畫 每月結算', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
