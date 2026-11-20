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
