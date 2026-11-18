# White Club Schedule — iLab 正式版

正式網址：<https://infoilab.github.io/white-club-schedule/>

本版依使用者於 2026-11-18 確認的方案 A，使用 **community@whiteclub.co** 登入，沿用原 White Club Google Calendar 與 Firebase `whc-web` 員工更表。GitHub `infoilab` 是程式託管帳戶，不代表 Google 主帳戶已改成其他 Gmail。

**這不是獨立測試資料庫。正式啟用後，在 iLab 儲存或刪除活動／更表會修改兩個網站共用的正式資料。** 原 <https://whiteclub-calendar.vercel.app/> 的 HTML、Vercel 專案與第 3 版資料橋保持不變；沒有搬資料、更換日曆、重新合併或初始化正式資料庫。

## 登入與同步

頁首只有「登入與同步」入口。使用已驗證的 community 帳戶一次 Google 登入；活動日曆與員工更表分開顯示狀態，不需要第二次 Google Calendar OAuth 授權。

- 活動唯一主資料是原 Google `primary` 日曆。iLab 使用同一 Apps Script 專案的獨立新版部署；Google Calendar 修改後網站重新整理即可取得，網站儲存後也重新讀取。
- Firebase Auth 負責登入及修改權限，Firestore 只用於既有員工更表／更表時間設定。
- 活動 Feed 每 30 秒讀取（頁面可見時）；資料橋快取 60 秒，手動重新整理或儲存後使用強制重新讀取。
- 備註不出現在公開 Feed。登入後以 Firebase ID token 經驗證的 `get` 讀取，完整顯示在活動卡及編輯表單，只存記憶體；登出／切換身份後清除。
- Firebase 保留 `Auth.Persistence.LOCAL`；同一裝置、瀏覽器及網站 origin 通常保持登入。ID token 約一小時有效，但自動續期，不等於每小時需要人工登入。登出、清除網站儲存、換裝置／瀏覽器／網域、無痕視窗結束或會話被撤銷可能需要再登入。

[Firebase 登入持久化](https://firebase.google.com/docs/auth/web/auth-state-persistence)／[會話期限](https://firebase.google.com/docs/auth/admin/manage-sessions)／[getIdToken](https://firebase.google.com/docs/reference/js/auth.user)，查證日期 2026-11-18。

## 正式資料保護

`ILAB_TEST_MODE = false`、`FORMAL_FEED = true`。原示範資料的 `ilab_test_v1:` localStorage 不讀入、不清除、不上傳；正式命名空間是 `ilab_live_v1:`，正式更表亦不以舊本機快取初始化。

正式登入首次只從伺服器載入既有更表，不 seed／merge／migrate。缺失根文件、格式錯誤、離線快取、權限問題或正在遷移時停用寫入並顯示錯誤；不建立共用資料庫。

原 Firestore schema 為 records，保留既有 `rosterDays`、`settings` 的 `{record: ...}` 格式、根 metadata 及未知欄位。iLab 不讀寫或刪除 `events`、`igPosts`、`migrationBackups` 等集合，也不改 `counts.events`。只在使用者實際修改更表後，以確認過的基準與 transaction 提交更表差異。偵測到其他裝置修改或登入失效時停止寫入並保留草稿；「重新載入更表」是唯讀重載，不合併。

Firebase 已授權 `infoilab.github.io`，原 White Club 網域仍保留；此次沒有新增網域、發布安全規則或放寬權限。

## BOOK 堂及時間表

新增與編輯使用同款表單；單堂日期、星期 chip、開始／結束時間按用戶參考圖排列，手機完整換行。沒有「活動類型 (Type)」或自選主題色彩欄，既有活動各自的類型／Google 顏色保留；新活動沿用 Event 預設。場地顯示 1S、1B、2/F，支援多選。

點擊時間表、月曆、列表或全日活動直接進入編輯，不經中間詳情頁。單堂可切換「多堂系列課程（批次）」；帶入原活動，以自動每週排堂、假期／停課日略過、逐堂名稱／日期時間及加刪堂設定系列。取消不更改資料。正式轉換由資料橋 `convertToSeries` 保留排序首堂的原 ID，其餘堂建立新 ID，不複製原 Event。

堂數列表桌面為藍色編號、選填堂名、日期／星期、開始／結束時間及刪除；手機自適應。每堂名稱留空時採用共用系列名稱加「第 N 堂」，自訂名稱以 `wcSessionTitle` 保存，共用名稱另存 `wcSeriesTitle`。Google 直接改名後，Feed 採用目前 summary，避免課程儲存覆蓋回舊 private 標記。

同時活動按數量加闊場地欄，每條 lane 至少 220px；活動名稱、全部場地及多行備註完整顯示，時間格按內容加高。所有日期與場地共用同一分鐘位置映射，真實日期時間不改。相鄰活動不遮蓋，同時活動分欄。頂部活動類型／本機同步停用圖例整行已移除。

## 資料橋部署與回退

現有 Apps Script 專案保留。原 White Club 第 3 版部署及原 URL 不更新；iLab 使用獨立部署：

<https://script.google.com/macros/s/AKfycbz71B1TpoHOZXEqw55g_cL9pwiBi68fi4cUpl1jR_gUwV37pp1-8iG8FDzmbpq8B7Sm/exec>

功能版本 `2026-11-18-ilab-v1`，回報 `sessionTitles`、`convertToSeries`、`saveSeries`、`privateRemarks` 能力。新舊部署快取分開，避免舊 Feed 覆寫新能力欄位；新版操作後清除兩站快取索引，資料仍共用原日曆。原 `CONFIG` 類型／場地／時間範圍、登入驗證及允許帳戶完整保留。

Google Calendar 多項 insert／patch／remove 並非原子 transaction；系列寫入預先驗證及遇到失敗盡力回復，但不能保證跨 Google 日曆直接修改或舊站同時寫入時完全原子。出現未能回復的錯誤請檢查 Google 日曆，不要反覆盲目提交。

啟用前最後測試版 commit 是 `51c48f96f4eca9f0e0c3ffc67ef7b2c30c737062`，Git 歷史保留。回退應以新 commit 還原該版，不 force-push；還原程式不會撤銷已發生的正式資料編輯。原線上第 3 版源碼另存 `apps-script/archive/Code.whiteclub-v3.before-2026-11-18.gs`，不是先前較舊救回版。

## 程式與檢查

`index.html` 是單檔 HTML／CSS／JavaScript，無建置步驟，不另建 test.html；需 Tailwind、Lucide、Firebase compat SDK 網上靜態程式庫。`apps-script/Code.gs` 為實際新版資料橋。`CLAUDE.md`、舊使用指南保留供維護，正式安全分支以本文件與最新版源碼為準。`mock-feed.json` 不是正式資料備份。

完全離線的檢查，不會呼叫真實 Google／Firebase：

```bash
node scripts/test-production-bridge.cjs
node scripts/test-production-frontend.cjs
node scripts/test-production-contract.cjs
```

測試涵蓋現有 API 相容、驗證拒絕、原 ID、類型／場地／備註保留、堂名、前後端轉換 payload、快取隔離、純載入零寫入、更表-only 寫入、未知欄位保留、其他裝置衝突及登出期間回應失效。另有攔截網路的 Chromium 功能／排版回歸。離線 mock 測試不等於真正 Google 多項寫入已端到端驗證；此次不使用正式業務資料做增刪測試。
