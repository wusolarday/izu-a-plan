---
name: new-feature
description: 在 izu-a-plan 新增或修改功能時使用（M2～M4、使用者回饋的 UX 調整）。
---

# 做功能的順序

1. 讀 `CLAUDE.md`、`private/HANDOFF.md`；規格只讀相關章節（`private/A計畫_工具專案規格書_v1.1.md`）。
2. 計算先寫在 `js/engine.js`（純函式）＋ `tests/engine.test.js`，測試用 `setup.example.json` 的假數字。
3. UI 在 `js/app.js`：頁面函式回傳字串、`data-act` 綁按鈕、`data-k` 綁結算草稿欄位。用精準替換，不重寫整檔。
4. 本機檢查：`python3 -m http.server 8765`，瀏覽器開 http://localhost:8765/ ，設定 →「開始測試模式」或「試用範例」，手機寬度（390px）走一次流程。
5. 用使用者看得懂的白話：金額加千分位、「比預算少花／多花」、不出現公式變數。
6. 完成後走 `release` skill。
