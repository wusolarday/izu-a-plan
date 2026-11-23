# izu-a-plan 開發指南（給 AI 與自己）

個人財務追蹤 PWA。每月結算日輸入現金總額 → 推算生活費、累積進度、事件付款後餘額。
規格：`private/A計畫_工具專案規格書_v1.1.md`、`private/A計畫_工具需求書_v1.1.md`（不進 repo，改需求先改規格）。

## 鐵則

1. **個人數字不進 repo**。真實設定在 `private/aplan-setup.json`；`setup.example.json` 與測試只用假數字。`private/sensitive.txt` 列出禁用字串，pre-commit 會擋。
2. **零依賴、零建置**：原生 ES modules，GitHub Pages 直接服務。不加框架、CDN、API、分析或遙測。
3. **計算只寫在 `js/engine.js`**（純函式），UI 不做計算。改計算必須同步改 `tests/engine.test.js`。
4. **改任何前端檔都要把版本加一**：`js/version.js` 與 `sw.js` 的 `VERSION` 必須相同（有測試）。新檔案要加進 `sw.js` 的 `ASSETS`。
5. **資料結構改變**：`engine.js` 的 `SCHEMA` 加一，並在 `migrate()` 寫升級步驟；舊備份必須能匯入。

## 檔案

| 檔案 | 內容 |
|---|---|
| `js/engine.js` | 計畫展開 `regularItems`、單期 `calcPeriod`、累積 `progress`、預測 `forecast`/`eventOutlook`、提問 `questions`/`needsIncomeCheck`、`initFromSetup`、`migrate`、`validateState`、`makeIcs` |
| `js/app.js` | hash 路由（home/settle/history/events/settings）、結算草稿 `D`、`data-act` 事件委派、`data-k` 表單綁定、備份匯入、SW 更新提示 |
| `js/db.js` | IndexedDB，整份 state 存一個 key |
| `sw.js` | cache-first；新版等待使用者點「更新」才 `skipWaiting` |

## 資料模型重點

- `snapshots[0]` 是起點（`start:true`），之後每筆是一次結算：`cash, stock, side[], bonus[{year,amount}], salary?, flows[{kind,amount,eventId?,note}], applied`。
- 事件已付金額**只**由 `flows(kind='event')` 推導，不另存。
- `flows.kind`：`event`（事件付款）、`income`（一次性收入，算進度）、`gift`/`loanIn`/`stockSell`（流入，不算進度）、`stockBuy`/`prepay`/`otherOut`（流出，不算生活費）。
- 計畫參數變更用 `plan.*Changes = [{from:'YYYY-MM', amount}]`。
- **首頁進度用 `standing()`**：超前／落後＝實際現金−`targetCash(d)`，不排除任何項目（使用者要求）。目標含計畫收支，以及「最晚日已過或已付清」的事件；「差在哪裡」各項加總必等於差額。`progress()` 只提供分項給 `standing` 與紀錄頁。

## 指令

```sh
node --test tests/*.test.js          # 測試（CI 也跑）
node private/check-real.mjs          # 用真實設定看預測（本機）
python3 -m http.server 8765          # 本機預覽
```

## 在 Claude Code 工作

- 這台 Mac 已登入 GitHub，可直接 `git commit` / `git push`（GitHub Desktop 也可）。
- 專案 skill：`.claude/skills/new-feature`（做功能）、`.claude/skills/release`（發布）。
- 背景與決策紀錄：`private/HANDOFF.md`（不進 repo）。

## 省 token 的做法

- 先讀本檔與相關函式，不要整包讀檔；engine 函式名稱即說明。
- 修改用精準替換，不重寫整檔。
- 未完成：M2 事件區間細節／差額拆解頁、M3 季度檢視＋計畫版本＋改善試算＋報告、M4 貸款模組（第二筆試算、大額還款、房貸）與長期預測。
