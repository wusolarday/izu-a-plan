// node --test tests/   （只用假資料；真實數字放 private/，不進 repo）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../js/engine.js';

const setup = () => JSON.parse(readFileSync(new URL('../setup.example.json', import.meta.url)));
// 範例：薪資50,000、兼職3,000、生活費35,000、信貸6,000 → 每期計畫結餘12,000
const base = () => E.initFromSetup(setup());
const settle = (s, snap) => { s.snapshots.push({ id: 's' + s.snapshots.length, ...snap }); return s; };

test('T01 照計畫：生活費等於預算、不追問', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 812000, side: [{ amount: 3000 }] });
  const p = E.calcPeriod(s, s.snapshots[0], s.snapshots[1]);
  assert.equal(p.E, 35000); assert.equal(p.budget, 35000);
  assert.equal(E.needsIncomeCheck(s, p), false);
  assert.equal(E.progress(s).status, 0);
});

test('T02/T03 偏差大才問；更正薪資後不算生活費', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 802000, side: [{ amount: 3000 }] });
  let p = E.calcPeriod(s, s.snapshots[0], s.snapshots[1]);
  assert.equal(p.E, 45000); assert.equal(E.needsIncomeCheck(s, p), true);
  s.snapshots[1].salary = 40000;
  p = E.calcPeriod(s, s.snapshots[0], s.snapshots[1]);
  assert.equal(p.E, 35000);
  const r = E.progress(s);
  assert.equal(r.salary, -10000); assert.equal(r.living, 0); assert.equal(r.status, -10000);
});

test('T04 薪資之後都是：計畫從生效月起變更', () => {
  const s = base(); s.plan.salaryChanges.push({ from: '2027-01', amount: 52000 });
  const it = E.regularItems(s.plan, '2026-11-20', '2027-01-21').filter(i => i.type === 'salary');
  assert.deepEqual(it.map(i => i.amount), [50000, 52000]);
});

test('T05/T06 年終：未發為時間差，不算落後；已發計差額', () => {
  const s = base();
  settle(s, { date: '2026-12-21', cash: 812000, side: [{ amount: 3000 }] });
  settle(s, { date: '2027-01-21', cash: 824000, side: [{ amount: 3000 }] });
  settle(s, { date: '2027-02-21', cash: 836000, side: [{ amount: 3000 }] }); // 年終未發
  let r = E.progress(s);
  assert.equal(r.status, 0); assert.equal(r.bonusPending, -70000);
  assert.equal(r.periods[2].E, 35000 + 0); // 未輸入年終 → 不誤算
  s.snapshots[3] = { ...s.snapshots[3], cash: 896000, bonus: [{ year: 2027, amount: 60000 }] };
  r = E.progress(s);
  assert.equal(r.bonusPending, 0); assert.equal(r.bonusDiff, -10000); assert.equal(r.status, -10000);
});

test('T07 工程款未付是時間差；付了只扣一次、不算生活費', () => {
  const s = base();
  settle(s, { date: '2026-12-21', cash: 762000, side: [{ amount: 3000 }], flows: [{ kind: 'event', eventId: 'e1', amount: -50000 }] });
  s.events[0].status = 'paid';
  settle(s, { date: '2027-01-21', cash: 774000, side: [{ amount: 3000 }] });
  settle(s, { date: '2027-02-21', cash: 786000 + 70000, side: [{ amount: 3000 }], bonus: [{ year: 2027, amount: 70000 }] });
  // e2 區間 1/11～1/31 已過且未付
  const r = E.progress(s);
  assert.equal(r.status, 0); assert.equal(r.eventTiming, 300000);
  assert.ok(r.periods.every(p => p.E === 35000));
});

test('T08 部分付款：剩餘金額仍在預測中', () => {
  const s = base();
  settle(s, { date: '2027-01-21', cash: 0, flows: [{ kind: 'event', eventId: 'e2', amount: -100000 }] });
  s.events[1].status = 'partial';
  assert.equal(E.eventRemaining(s, s.events[1]), -200000);
});

test('T09/T10 買賣股票：不影響生活費與進度狀態', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 762000, side: [{ amount: 3000 }], flows: [{ kind: 'stockBuy', amount: -50000 }] });
  const r = E.progress(s);
  assert.equal(r.periods[0].E, 35000); assert.equal(r.status, 0); assert.equal(r.transfer, -50000);
});

test('T13 生活費為負要追問', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 900000, side: [{ amount: 3000 }] });
  assert.equal(E.needsIncomeCheck(s, E.calcPeriod(s, s.snapshots[0], s.snapshots[1])), true);
});

test('T14 一次性收入算進度改善', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 820000, side: [{ amount: 3000 }], flows: [{ kind: 'income', amount: 8000 }] });
  const r = E.progress(s);
  assert.equal(r.periods[0].E, 35000); assert.equal(r.status, 8000);
});

test('T15 相對原計畫含起始差額', () => {
  const s = base(); s.original.planCashAtStart = 830000;
  settle(s, { date: '2026-12-21', cash: 812000, side: [{ amount: 3000 }] });
  assert.equal(E.progress(s).vsOriginal, -30000);
});

test('T16 事件付款後預測與缺口（支出放最早日）', () => {
  const s = base(); const ev = s.events.find(e => e.selfFund);
  const o = E.eventOutlook(s, ev);
  // 800,000 −50,000 −300,000×2 ＋ 18期×12,000 ＋ 2027、2028 年終70,000×2 −300,000
  assert.equal(o.after, 800000 - 50000 - 600000 + 18 * 12000 + 140000 - 300000);
  assert.equal(o.gap, Math.max(0, 100000 - o.after));
  assert.equal(o.settlesLeft, 18);
});

test('T22 跨兩期：預算加倍', () => {
  const s = settle(base(), { date: '2027-01-21', cash: 824000, side: [{ amount: 6000 }] });
  const p = E.calcPeriod(s, s.snapshots[0], s.snapshots[1]);
  assert.equal(p.periods, 2); assert.equal(p.budget, 70000); assert.equal(p.E, 70000);
});

test('結算日計算與 .ics', () => {
  assert.equal(E.nextSettleDate(21, '2026-11-20'), '2026-11-21');
  assert.equal(E.nextSettleDate(21, '2026-11-21'), '2026-12-21');
  assert.equal(E.nextSettleDate(31, '2027-02-01'), '2027-02-28');
  assert.match(E.makeIcs(21, '2026-11-20'), /RRULE:FREQ=MONTHLY;BYMONTHDAY=21/);
});

test('T26/T32 匯入驗證與遷移', () => {
  assert.throws(() => E.migrate({}));
  assert.throws(() => E.migrate({ schemaVersion: E.SCHEMA + 1 }));
  const s = base(); settle(s, { date: '2026-11-01', cash: 1 });
  assert.ok(E.validateState(s).length > 0);
  assert.deepEqual(E.validateState(base()), []);
});

test('sw.js 與 app 版本一致', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8').match(/VERSION = '(.+?)'/)[1];
  const app = readFileSync(new URL('../js/version.js', import.meta.url), 'utf8').match(/VERSION = '(.+?)'/)[1];
  assert.equal(sw, app);
});

test('下次應結算日：起點 11/20 → 12/21', () => {
  assert.equal(E.nextDue(base()), '2026-12-21');
});

test('standing：實際−目標，差在哪裡加總等於差額', () => {
  const s = base();
  settle(s, { date: '2026-12-21', cash: 1100000, side: [{ amount: 0 }], flows: [{ kind: 'gift', amount: 300000 }] }); // e1 未付但區間未過
  let t = E.standing(s);
  assert.equal(t.target, 812000 - 3000 + 3000); // 起點＋12,000
  assert.equal(t.diff, 1100000 - 812000);
  assert.equal(Math.round(t.parts.reduce((a, x) => a + x[1], 0)), t.diff);
  // 1/21：e1（12/31 到期）未付 → 目標已扣，實際未扣 → 顯示尚未付清
  settle(s, { date: '2027-01-21', cash: 1112000, side: [{ amount: 3000 }] });
  t = E.standing(s);
  assert.equal(Math.round(t.parts.reduce((a, x) => a + x[1], 0)), t.diff);
  assert.ok(t.parts.some(([l]) => l.includes('尚未付清')));
  assert.equal(t.nextDate, '2027-02-21');
});

test('併入下期：卡費晚扣，兩期合計生活費正確，差在哪裡加總等於差額', () => {
  // 每期計畫：應有 = 上次＋50,000＋3,000－6,000。第一期卡費 38,000 晚扣 → 只少了 0，現金比應有多 3,000
  const s = settle(base(), { date: '2026-12-21', cash: 850000, side: [{ amount: 3000 }], carry: true });
  let r = E.progress(s);
  assert.equal(r.periods.length, 1); assert.equal(r.periods[0].carry, true);
  assert.equal(r.periods[0].E, -3000); assert.equal(r.living, 0);
  let t = E.standing(s);
  assert.equal(t.parts.reduce((a, x) => a + x[1], 0), t.diff);
  assert.deepEqual(t.parts, [['併入下期的生活費（還沒判斷）', 38000]]);
  // 第二期卡費扣了：這期現金流出 73,000（35,000＋晚扣的 38,000）
  settle(s, { date: '2027-01-21', cash: 850000 + 47000 - 73000, side: [{ amount: 3000 }] });
  r = E.progress(s);
  assert.equal(r.periods.length, 1);
  const p = r.periods[0];
  assert.equal(p.merged, 2); assert.equal(p.periods, 2);
  assert.equal(p.from, '2026-11-20'); assert.equal(p.startCash, 800000);
  assert.equal(p.E, 70000); assert.equal(p.budget, 70000); assert.equal(r.living, 0); assert.equal(r.carry, 0);
  t = E.standing(s);
  assert.equal(t.parts.reduce((a, x) => a + x[1], 0), t.diff);
  assert.ok(!t.parts.some(([l]) => l.startsWith('生活費') || l.startsWith('併入')));
});

test('併入下期後仍對不起來 → 記為找不到來源的錢，生活費不算少花', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 850000, side: [{ amount: 3000 }], carry: true });
  settle(s, { date: '2027-01-21', cash: 900000, side: [{ amount: 3000 }] });
  let p = E.progress(s).periods[0];
  assert.equal(p.merged, 2); assert.equal(p.E, -6000); // 兩期合併還是像一毛都沒花
  s.snapshots[2].flows = [{ kind: 'unknownIn', amount: 6000, note: '' }];
  const r = E.progress(s);
  p = r.periods[0];
  assert.equal(p.E, 0); assert.equal(p.unknown, 6000);
  assert.equal(r.living, 0); assert.equal(r.unknown, 76000);
  const t = E.standing(s);
  assert.equal(t.parts.reduce((a, x) => a + x[1], 0), t.diff);
  assert.ok(t.parts.some(([l, v]) => l.startsWith('找不到來源的錢') && v === 76000));
  assert.ok(!t.parts.some(([l]) => l.startsWith('生活費')));
});

test('首頁燈號：照計畫綠、小落後黃、落後超過一個月生活費紅', () => {
  const at = cash => E.homeSummary(settle(base(), { date: '2026-12-21', cash, side: [{ amount: 3000 }] }), '2026-12-22');
  let h = at(812000);
  assert.equal(h.level, 'good'); assert.equal(h.even, true); assert.equal(h.started, true);
  assert.equal(h.nextDate, '2027-01-21'); assert.equal(h.daysLeft, 30); assert.equal(h.nextBudget, 35000);
  assert.equal(h.event.ev.id, 'e1'); assert.equal(h.event.remaining, 50000);
  h = at(802000); assert.equal(h.level, 'warn'); assert.equal(h.diff, -10000);
  h = at(760000); assert.equal(h.level, 'bad'); assert.equal(h.diff, -52000);
  assert.equal(E.homeSummary(base(), '2026-11-21').started, false);
});

test('計畫頁直接改：從下一期起生效，可撤回，可跟原計畫比', () => {
  const s = settle(base(), { date: '2026-12-21', cash: 812000, side: [{ amount: 3000 }] });
  assert.equal(E.firstEditableMonth(s), '2027-01');
  const before = E.calcPeriod(s, s.snapshots[0], s.snapshots[1]).budget;
  s.plan = E.setPlanValue(s.plan, 'living', '2027-01', 33000);
  // 已結算的期不受影響
  assert.equal(E.calcPeriod(s, s.snapshots[0], s.snapshots[1]).budget, before);
  assert.equal(E.planValues(s.plan, '2026-12').living, 35000);
  assert.equal(E.planValues(s.plan, '2027-01').living, 33000);
  // 同月份再改一次是取代，不是疊加
  s.plan = E.setPlanValue(s.plan, 'living', '2027-01', 32000);
  assert.equal(s.plan.livingChanges.length, 1);
  // 1～6 月每月少花 3,000 → 到 6/30 應該多存 18,000
  const c = E.planCompare(s, '2027-06-30');
  assert.equal(c.diff, 18000);
  assert.equal(E.originalPlan(s.plan).livingChanges.length, 0);
  s.plan = E.removePlanChange(s.plan, 'living', '2027-01');
  assert.equal(E.planCompare(s, '2027-06-30').diff, 0);
});

test('款項：沒付過可以刪，有付款紀錄就不能刪', () => {
  const s = base(), e1 = s.events.find(e => e.id === 'e1'), e2 = s.events.find(e => e.id === 'e2');
  settle(s, { date: '2026-12-21', cash: 762000, side: [{ amount: 3000 }], flows: [{ kind: 'event', eventId: 'e1', amount: -50000 }] });
  assert.equal(E.canDeleteEvent(s, e1), false);
  assert.equal(E.canDeleteEvent(s, e2), true);
});

test('取消款項：已付的部分仍算，只有沒付的部分不用再存', () => {
  const s = base(), e1 = s.events.find(e => e.id === 'e1');
  // 12/21 先付了 2 萬（範例款項A 共 5 萬）
  settle(s, { date: '2026-12-21', cash: 792000, side: [{ amount: 3000 }], flows: [{ kind: 'event', eventId: 'e1', amount: -20000 }] });
  e1.status = 'partial';
  const before = E.targetCash(s, '2026-12-21'), later = E.targetCash(s, '2027-01-21');
  e1.status = 'cancelled';
  assert.equal(E.targetCash(s, '2026-12-21'), before);          // 已付的 2 萬不會加回來
  assert.equal(E.targetCash(s, '2027-01-21'), later + 30000);   // 剩下的 3 萬不用再存
  const t = E.standing(s);
  assert.equal(t.parts.reduce((a, x) => a + x[1], 0), t.diff);  // 差在哪裡仍然加得起來
  assert.equal(t.diff, 0);
});

test('款項狀況：從結算紀錄自動判斷，不用手動設定', () => {
  const s = base(), e1 = s.events.find(e => e.id === 'e1');
  assert.deepEqual(E.eventState(s, e1), { key: 'todo', total: 50000, paid: 0, left: 50000, income: false });
  settle(s, { date: '2026-12-21', cash: 792000, side: [{ amount: 3000 }], flows: [{ kind: 'event', eventId: 'e1', amount: -20000 }] });
  assert.equal(E.eventState(s, e1).key, 'partial'); assert.equal(E.eventState(s, e1).left, 30000);
  e1.status = 'cancelled'; assert.equal(E.eventState(s, e1).key, 'off'); assert.equal(E.eventState(s, e1).left, 0);
  e1.status = 'paid'; assert.equal(E.eventState(s, e1).key, 'done');
});

test('改款項金額：不能比已付少；剛好等於已付就算付清', () => {
  const s = base(), e1 = s.events.find(e => e.id === 'e1');
  settle(s, { date: '2026-12-21', cash: 792000, side: [{ amount: 3000 }], flows: [{ kind: 'event', eventId: 'e1', amount: -20000 }] });
  e1.status = 'partial';
  assert.deepEqual(E.statusAfterAmount(s, e1, 0), { ok: false, minimum: 20000 });
  assert.deepEqual(E.statusAfterAmount(s, e1, 10000), { ok: false, minimum: 20000 });
  assert.deepEqual(E.statusAfterAmount(s, e1, 20000), { ok: true, status: 'paid' });
  assert.deepEqual(E.statusAfterAmount(s, e1, 60000), { ok: true, status: 'partial' });
  // 就算資料裡已經是不合理的 0，畫面也不會顯示成「付了一部分 100%」
  e1.amount = 0; assert.equal(E.eventState(s, e1).key, 'done');
  const e2 = s.events.find(e => e.id === 'e2');
  assert.deepEqual(E.statusAfterAmount(s, e2, 0), { ok: false, minimum: 1 });
  assert.deepEqual(E.statusAfterAmount(s, e2, 250000), { ok: true, status: 'planned' });
});
