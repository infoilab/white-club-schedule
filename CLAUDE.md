# White Club Calendar: notes for AI assistants

Read this before changing anything. The staff team maintains this project themselves with AI help, and there's no developer.

## How it works
```
Google Calendar of community@whiteclub.co = the ONLY store of events (single source of truth)
  read:  apps-script/Code.gs doGet?refresh=1 → JSON → index.html (on load, every 30s while visible, on tab focus, after every save)
  write: index.html editor → POST to the same Apps Script URL (doPost, Firebase ID token required)
         → Calendar.Events.insert/patch/remove → Google Calendar
Firebase (project whc-web) = staff login + roster (更表) only. Events are NOT stored in Firebase.
```
Staff can edit either on the website or directly in Google Calendar; both end up in Google Calendar.

## Where things live
| Want to change… | Edit |
|---|---|
| Event types, their Google colours (first colorId is what the website writes), label or website colour | `apps-script/Code.gs` → `CONFIG.TYPES` (the website reads the table from the feed) |
| Title keywords used to guess the type when an event has no colour | `apps-script/Code.gs` → `CONFIG.TITLE_RULES` |
| Titles that always force a type, even over colour (e.g. Skin Consult → 其他) | `apps-script/Code.gs` → `CONFIG.TITLE_OVERRIDES` |
| Course planner (sessions, every N weeks), remarks, delete buttons | `index.html` → `openEventEditor`, `openEventDetails`, `deleteFeedEvent` |
| Venues (1S Mirror Room, 1B Big Room, 2/F), their codes/keywords, default venue | `apps-script/Code.gs` → `CONFIG.VENUES`, `VENUE_GROUPS`, `DEFAULT_VENUE` (the website builds its columns from the feed's `venues`) |
| How far back/ahead events load | `apps-script/Code.gs` → `CONFIG.DAYS_BACK` / `DAYS_AHEAD` |
| Feed URL, refresh interval, "stale" warning time | `index.html` → search `★ 網站設定` |
| Fallback colours (used only before the feed loads) | `index.html` → `EVENT_TYPES` (keep in sync with `CONFIG.TYPES`) |
| Feed logic, list view, details popup, 需處理 list, sync badge | `index.html` → search `Google 日曆資料橋（讀取）` |
| Website edit form (create / update / delete) | `index.html` → `openEventEditor`, `sendCalendarWrite` |
| Server-side write rules, validation, who may edit | `apps-script/Code.gs` → `doPost`, `handleWrite_`, `buildEventResource`, `CONFIG.ALLOWED_EDITORS` |
| Week / month views | `index.html` → `renderTimeline`, `createTimelineFloorColumn`, `renderMonthCalendar` |

## Rules
1. **The website writes events ONLY through the Apps Script `doPost`.** Never call the Google Calendar API from the browser, never re-add browser Google OAuth, and never store events in Firebase or localStorage as data. Google Calendar is the single source of truth. That's what keeps phones and computers in sync. After a write, call `fetchCalendarFeed(true, true)` rather than editing `feedEvents` by hand.
   - `doPost` body (JSON, sent as text/plain) always carries `idToken` + `action`:
     - `get {id}` → `{ok, remark}` (remarks = Google event description; NOT in the public feed, which only has `hasRemark`)
     - `create {title,type,venues,allDay,remark?,sessions:[{date,startTime,endTime}]}` — more than one session → one Google event per session, titles get " (第 N 堂)", linked by `extendedProperties.private.wcSeries`
     - `update {id,expectedUpdated,title,type,venues,date,allDay,startTime,endTime,remark?}` — one session / single event
     - `saveSeries {seriesId,title,type,venues,allDay,remark?,sessions:[{id?,date,startTime,endTime}],deletedIds}` — whole course: shared fields, per-session times, add/remove, renumber
     - `delete {id, scope:'single'|'series', seriesId, expectedUpdated}`
     - Reply: `{ok:true,...}` or `{ok:false, error, conflict}`. Send `remark` only when the user changed it (undefined = keep Google's text).
   - Course grouping (`seriesId` in the feed): Google recurring `recurringEventId` → website `wcSeries` tag (`wc-…`) → legacy titles ending "(第 N 堂)" (`title:<base>`, converted to a `wc-` tag the first time the course is saved).
   - Every write must keep the `verifyEditor_` check (Firebase ID token → email in `CONFIG.ALLOWED_EDITORS`), because the URL is public.
2. Keep the feed JSON shape: `{ok, generatedAt, types[], venues[], defaultVenue, events[{id,title,date,endDate,startTime,endTime,allDay,venues[],venueUnclear,venueDefaulted,type,typeGuessed,colorId,sessionNo,hasRemark,seriesId,location,htmlLink,updated}], holidays{}}`. If you add a field, make it optional on the website.
3. Colours always come from `getTypeStyle(ev)` in `index.html`. Don't colour events any other way.
4. `index.html` is one self-contained file (Tailwind + Lucide from pinned CDN versions, Firebase compat SDK). There's no build step, so keep it that way.
5. Escape every value from the feed with `escapeHtml()` before inserting it into HTML.
6. Don't send event descriptions or guest lists in the feed. The feed URL is public.
7. The original legacy two-way Google sync code is still in `index.html`. It only runs when `CALENDAR_FEED_URL` is empty, so don't rely on it or extend it.

## Test before publishing
- Apps Script logic: `node scripts/test-feed.cjs` (needs Node 18+).
- Website preview with sample data: `npx vite . --port 5180`, then open `http://localhost:5180/?feed=mock-feed.json`. The `?feed=` override works only on localhost. The Firebase login screen can't be completed locally. The calendar renders behind it, and you can hide the overlay in DevTools to look.
- Check the list view at phone width (375px), the 7-day and month views, the details popup, the 需處理 button, and that the sync badge is green.

## Publish
- **Website:** commit and push to `main` on GitHub. Vercel deploys automatically within about 1 minute.
- **Apps Script:** either
  - in the browser: script.google.com → project → paste code → **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** (editing the existing deployment keeps the same URL), or
  - with clasp: `cd apps-script && npx @google/clasp push && npx @google/clasp deploy -i <DEPLOYMENT_ID>`. Copy `.clasp.json.example` to `.clasp.json` and fill in the scriptId first. Log in with community@whiteclub.co: `npx @google/clasp login`.
- After any Apps Script change, open the feed URL with `?refresh=1` and check it shows `"ok": true`.
