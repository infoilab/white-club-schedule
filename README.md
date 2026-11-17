# White Club Schedule

White Club 活動日程與員工更表網站。

## 本次還原

2026 年 11 月 17 日，將 2026 年 11 月 6 日從 `https://whiteclub-calendar.vercel.app/` 救回的程式檔案，原樣還原到 `infoilab/white-club-schedule`。

原有 `index.html` 仍保留在 Git 歷史，更新前版本為 `f791cf1f6a4ba671d5e95b963e416dfd05318f67`。本次沒有重設或刪除 repository 歷史。

這是固定時間點的程式碼還原，不會自動追蹤舊 Vercel 網站的後續變更。

## 主要檔案

- `index.html`：主要介面、CSS 及前端 JavaScript；沒有建置步驟。
- `white club 深 pink@1200x.png`：Logo。
- `user-guide.html`、`使用及維護指南.md`：原專案使用與維護指南。
- `CLAUDE.md`：原專案 AI 開發說明及架構規則。
- `apps-script/Code.gs`、`apps-script/appsscript.json`：日曆資料橋原始碼與 manifest。
- `scripts/test-feed.cjs`、`mock-feed.json`：本機測試程式與示範資料，並非正式日曆匯出資料。
- `.nojekyll`：讓 GitHub Pages 直接提供靜態檔案。

## 帳戶與資料來源

GitHub repository 現在由 `infoilab` 帳戶維護。這與網站內的 Google／Firebase 登入帳戶是分開的。

本次沒有更改 `index.html` 內的 Firebase 專案、Google Apps Script URL 或 `community@whiteclub.co` 登入設定。也沒有更新 Google Apps Script 的實際線上部署。

根據原專案架構，活動以 Google Calendar 為主要資料來源，Firebase 用於登入及更表。這些雲端服務的帳戶、存取規則及實際資料沒有隨 GitHub 帳戶遷移，也沒有包含在本 repository 還原中。

若希望網站改為其他 Gmail 登入，需另行核對並修改前端登入限制、Firebase 規則、Apps Script 編輯權限及日曆存取；不能只更改 GitHub 帳戶。

## 檢查與預覽

本機純邏輯測試：

```bash
node scripts/test-feed.cjs
```

本機靜態預覽：

```bash
python3 -m http.server 8000
```

瀏覽 `http://localhost:8000/`。這不保證本機 Firebase 登入可用；不要為了測試而修改正式日曆或更表資料。

HTML 使用網上的 Tailwind、Lucide 及 Firebase SDK，並非完整離線版網站。

## 發佈範圍

本 repository 原已啟用 GitHub Pages，來源為 `main` 分支根目錄；更新 `main` 會觸發 GitHub Pages 自動部署：

https://infoilab.github.io/white-club-schedule/

本次沒有修改舊 Vercel 專案或把舊 Vercel 網址重新連接至此 repository。若頁面登入失敗，需由原服務擁有者核對 Firebase Authorized domains 是否允許 `infoilab.github.io`。

原公開網站保留的 `Code.gs` 不保證與實際 Google Apps Script 線上版本完全相同；維護前需核對。
