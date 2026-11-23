---
name: release
description: 發布 izu-a-plan 新版本。改完程式後要上線、commit、push 時使用。
---

# 發布流程

1. `node --check js/app.js && node --test tests/*.test.js` 全部通過才繼續。
2. 版本加一（修 bug 改第三碼、新功能改第二碼、第二階段改第一碼）：同時改 `js/version.js` 與 `sw.js` 的 `VERSION`；新增的前端檔要加進 `sw.js` 的 `ASSETS`。
3. 個資檢查：`grep -rlF -f private/sensitive.txt --exclude-dir=private --exclude-dir=.git . || echo clean`，必須是 clean。
4. 若改了資料結構：`engine.js` 的 `SCHEMA` 加一，`migrate()` 寫升級步驟，並加測試。
5. commit 訊息用繁體中文：第一行 `vX.Y.Z 摘要`，下面列變更點。
6. `git push`。GitHub Pages 約 1～2 分鐘更新；使用者在 App 點「有新版本」即可。
7. 若影響規格，同步更新 `private/` 內的規格書與需求書。
