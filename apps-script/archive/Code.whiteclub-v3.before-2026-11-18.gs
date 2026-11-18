/**
 * White Club 日曆資料橋（Google Calendar ⇄ 網站）
 *
 * 這個 Apps Script 放在 community@whiteclub.co 的 Google 帳戶內。
 * doGet：讀取 Google 日曆，轉成 JSON 給網站顯示。
 * doPost：網站新增／修改／刪除活動時，經這裏直接寫入 Google 日曆（需要網站登入）。
 * 網站本身不會登入 Google，亦不會自己保存活動 —— Google 日曆是唯一資料來源。
 *
 * ★ 想改活動類型 / 顏色 / 樓層關鍵字 / 日期範圍：只需修改下面的 CONFIG。
 *   修改後：部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署。
 *   （一定要用「編輯」舊部署，網址才會保持不變。）
 */
var CONFIG = {
  // 要讀取的日曆。'primary' = community@whiteclub.co 的主日曆。
  CALENDAR_ID: 'primary',
  TIME_ZONE: 'Asia/Hong_Kong',

  // 讀取範圍：今天之前幾多日、之後幾多日
  DAYS_BACK: 62,
  DAYS_AHEAD: 300,

  // 活動類型：在 Google 日曆揀「活動顏色」就決定類型。
  // colorIds 是 Google 日曆的顏色編號：
  //   1 薰衣草紫  2 鼠尾草綠  3 葡萄紫  4 火鶴紅  5 香蕉黃  6 橘子橙
  //   7 孔雀藍    8 石墨灰    9 藍莓藍  10 羅勒綠  11 番茄紅
  // colorIds 第一個 = 網站新增／修改活動時寫入 Google 的顏色（沿用同事現有習慣）；其餘顏色亦認得。
  // hex 是網站上顯示的顏色（與 Google 同色系，但較深，方便白字閱讀）。
  // 最後一個 Other 是「未分類」：沒有揀顏色、標題又判斷不到的活動都會歸入這裏，並列入「需處理」。
  TYPES: [
    { key: 'Event',  label: '活動',          colorIds: ['4', '9'],  hex: '#D2584F' },  // 火鶴紅（亦認藍莓藍）
    { key: 'Course', label: '課程',          colorIds: ['5', '10'], hex: '#B07D00' },  // 香蕉黃（亦認羅勒綠）
    { key: 'Visit',  label: '參觀／Booking', colorIds: ['1', '6'],  hex: '#5C6BC0' },  // 薰衣草紫（亦認橘子橙）
    { key: 'Notice', label: '通知',          colorIds: ['8'],       hex: '#616161' },  // 石墨灰：大廈／維修通知
    { key: 'Misc',   label: '其他',          colorIds: ['2'],       hex: '#2E7D5B' },  // 鼠尾草綠：例如 Skin Consult
    { key: 'Other',  label: '未分類',        colorIds: [],          hex: '#94A3B8' }
  ],

  // 標題符合以下寫法，一律當作指定類型（優先過顏色）。
  TITLE_OVERRIDES: [
    { type: 'Misc', patterns: ['skin\\s*consult', '皮膚諮詢'] }
  ],

  // 沒有揀顏色時，用標題判斷類型（由上至下，第一個符合就用）。有顏色就一律以顏色為準。
  TITLE_RULES: [
    { type: 'Visit',  patterns: ['booking', '導賞', '參觀', 'site\\s*visit', '預約'] },
    { type: 'Course', patterns: ['第\\s*\\d+\\s*堂', '班', '課程', '課', 'course', 'class'] }
  ],

  // 場地：先看活動的「地點」，再看標題，找到以下任何寫法就認得（不分大小寫）。
  //   code  = 網站新增活動時寫入「地點」的簡寫（同事平時亦用這個寫法）
  //   label = 網站上顯示的名稱
  // 寫了多個場地 → 每個場地都會顯示。
  VENUES: [
    { key: '1S', code: '1S',  label: '1/F 細房', patterns: ['(?<![0-9A-Za-z])1\\s*S(?![A-Za-z])', 'mirror', '鏡房', '細房', '小房'] },
    { key: '1B', code: '1B',  label: '1/F 大房',               patterns: ['(?<![0-9A-Za-z])1\\s*B(?![A-Za-z])', 'big\\s*room', '大房'] },
    { key: '2F', code: '2/F', label: '2/F',                    patterns: ['(?<![0-9])2\\s*/?\\s*F(?![A-Za-z])', '(?<![0-9A-Za-z])2\\s*R(?![A-Za-z])', '2\\s*樓', '二樓'] }
  ],
  // 只寫了「1/F」而沒有寫哪間房（例如舊網站寫入的「White Club 1/F」）：
  //   rooms    = 屬於 1/F 的房間（已寫了其中一間就不用處理）
  //   fallback = 當作哪間房
  //   unclear  = true 會標示「未指明房間」並列入「需處理」；false 就直接當 fallback
  VENUE_GROUPS: [
    { rooms: ['1S', '1B'], fallback: ['1B'], unclear: false, patterns: ['(?<![0-9])1\\s*/?\\s*F(?![A-Za-z])', '1\\s*樓', '一樓'] }
  ],
  // 完全沒有寫場地的活動，一律當作這個場地（同事如果其實在 1/F，再自行修改）。
  DEFAULT_VENUE: '2F',

  // 香港公眾假期（Google 提供的公開日曆）。讀取失敗時網站會用內置假期表。
  HOLIDAY_CALENDAR_ID: 'en.hong_kong#holiday@group.v.calendar.google.com',

  // 快取秒數：多人同時開網站時，避免每次都重新讀 Google。
  CACHE_SECONDS: 60,

  // 可以在網站新增／修改／刪除活動的帳戶（即網站登入用的 Google 帳戶）。可加多個。
  ALLOWED_EDITORS: ['community@whiteclub.co'],

  // Firebase 網頁金鑰（公開資料，與網站 index.html 內 FIREBASE_CONFIG.apiKey 相同），用來驗證網站登入。
  FIREBASE_WEB_API_KEY: 'AIzaSyBLkXOL7SnpaFvrFKlZ1U707Fc1d0EZcwc',

  // 網站新增活動時「地點」的寫法，例如 "White Club 1S"
  LOCATION_PREFIX: 'White Club '
};

/* ======================= 以下一般不需要修改 ======================= */

function doGet(e) {
  var refresh = e && e.parameter && e.parameter.refresh === '1';
  var json = refresh ? null : readCache_();
  if (!json) {
    var payload;
    try {
      payload = buildFeed_();
    } catch (err) {
      payload = { ok: false, error: String(err && err.message || err), generatedAt: new Date().toISOString() };
    }
    json = JSON.stringify(payload);
    if (payload.ok) writeCache_(json);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 網站寫入（讀備註／新增／修改／刪除）。必須附上網站登入憑證 idToken，
 * 並且是 CONFIG.ALLOWED_EDITORS 內的帳戶，否則拒絕。
 * 格式：{ action, idToken, ... }
 *   get        { id }                                   → { ok, remark }
 *   create     { title, type, venues, allDay, remark, sessions:[{date,startTime,endTime}] }
 *              （多過一堂 → 每堂一個 Google 活動，標題加「(第 N 堂)」，用 wcSeries 連成一個課程）
 *   update     { id, expectedUpdated, title, type, venues, date, allDay, startTime, endTime, remark? }（只改這一堂）
 *   saveSeries { seriesId, title, type, venues, allDay, remark?, sessions:[{id?,date,startTime,endTime}], deletedIds:[] }
 *   delete     { id, scope:'single'|'series', seriesId, expectedUpdated }
 */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var email = verifyEditor_(body.idToken);
    out = handleWrite_(body);
    console.log(email + ' ' + body.action + ' ' + (body.id || body.title));
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), conflict: !!(err && err.conflict) };
  }
  CacheService.getScriptCache().remove('feed_parts'); // 下次讀取一定是最新
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handleWrite_(body) {
  var cal = CONFIG.CALENDAR_ID;
  var action = body.action;

  if (action === 'get') {
    if (!body.id) throw new Error('缺少活動 ID');
    var ev = Calendar.Events.get(cal, body.id);
    return { ok: true, remark: ev.description || '' };
  }

  if (action === 'create') {
    var sessions = Array.isArray(body.sessions) && body.sessions.length ? body.sessions : [body];
    if (sessions.length > 60) throw new Error('堂數最多 60 堂');
    if (sessions.length === 1) {
      var one = Calendar.Events.insert(buildEventResource(mergeSession_(body, sessions[0]), CONFIG, null, false), cal);
      return { ok: true, event: mapEvent(one, CONFIG) };
    }
    // 多堂課程：先檢查全部，再逐堂建立
    var seriesKey = 'wc-' + Utilities.getUuid().slice(0, 13);
    var resources = sortSessions_(sessions).map(function (s, i) {
      var res = buildEventResource(mergeSession_(body, s), CONFIG, null, false);
      delete res.recurrence;
      res.summary = withSessionNo(body.title, i + 1);
      res.extendedProperties = { private: { wcSeries: seriesKey } };
      return res;
    });
    resources.forEach(function (res) { Calendar.Events.insert(res, cal); });
    return { ok: true, seriesId: seriesKey, count: resources.length };
  }

  if (action === 'saveSeries') return saveSeries_(body);

  if (action !== 'update' && action !== 'delete') throw new Error('未知的動作：' + action);
  var scope = body.scope === 'series' && body.seriesId ? 'series' : 'single';

  if (action === 'delete' && scope === 'series') {
    var all = listSeries_(body.seriesId);
    if (!all.length) throw conflictError_('此課程已在 Google 日曆被刪除。');
    if (body.seriesId.indexOf('wc-') !== 0 && body.seriesId.indexOf('title:') !== 0) {
      // Google 重複活動：刪除主活動即刪除全部，再刪除額外加入的堂數
      try { Calendar.Events.remove(cal, body.seriesId); } catch (err) {}
      all = all.filter(function (e) { return e.recurringEventId !== body.seriesId; });
    }
    all.forEach(function (e) { Calendar.Events.remove(cal, e.id); });
    return { ok: true, deleted: body.seriesId };
  }

  if (!body.id) throw new Error('缺少活動 ID');
  var current = Calendar.Events.get(cal, body.id);
  if (!current || current.status === 'cancelled') throw conflictError_('此活動已在 Google 日曆被刪除。');
  if (body.expectedUpdated && current.updated !== body.expectedUpdated) {
    throw conflictError_('此活動剛被其他人修改，已重新載入，請再試一次。');
  }
  if (action === 'delete') {
    Calendar.Events.remove(cal, body.id);
    return { ok: true, deleted: body.id };
  }
  var patched = Calendar.Events.patch(buildEventResource(body, CONFIG, current, false), cal, body.id);
  return { ok: true, event: mapEvent(patched, CONFIG) };
}

/**
 * 修改整個課程：統一標題、類型、場地（及備註），逐堂更新日期時間，加堂、刪堂，並重新編號「第 N 堂」。
 * 不在網站讀取範圍內的舊堂數：時間不變，只會跟住重新編號及統一標題。
 */
function saveSeries_(body) {
  var cal = CONFIG.CALENDAR_ID;
  if (!body.seriesId) throw new Error('缺少課程 ID');
  var existing = listSeries_(body.seriesId);
  if (!existing.length) throw conflictError_('此課程已在 Google 日曆被刪除。');
  var deleted = {};
  (body.deletedIds || []).forEach(function (id) { deleted[id] = true; });
  var submitted = {};
  var added = [];
  (body.sessions || []).forEach(function (s) { if (s.id) submitted[s.id] = s; else added.push(s); });

  // 重複活動以外的課程都用 wcSeries 標記（舊網站用標題分組的課程，第一次儲存時轉用標記）
  var isRecurring = body.seriesId.indexOf('wc-') !== 0 && body.seriesId.indexOf('title:') !== 0;
  var seriesKey = body.seriesId.indexOf('title:') === 0 ? 'wc-' + Utilities.getUuid().slice(0, 13) : body.seriesId;

  var rows = [];
  existing.forEach(function (e) {
    if (deleted[e.id]) return;
    var s = submitted[e.id];
    rows.push({ event: e, session: s || null, sortKey: s ? s.date + 'T' + (body.allDay ? '00:00' : s.startTime) : eventStartKey_(e) });
  });
  added.forEach(function (s) { rows.push({ event: null, session: s, sortKey: s.date + 'T' + (body.allDay ? '00:00' : s.startTime) }); });
  if (!rows.length) throw new Error('課程最少要保留一堂；想刪除整個課程請用「刪除整個課程」');
  if (rows.length > 60) throw new Error('堂數最多 60 堂');
  rows.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; });

  // 先檢查所有輸入，避免改到一半出錯
  var plans = rows.map(function (row, i) {
    var input = row.session ? mergeSession_(body, row.session) : body;
    var res = buildEventResource(input, CONFIG, row.event, !row.session);
    delete res.recurrence;
    res.summary = withSessionNo(body.title, i + 1);
    if (!isRecurring || !row.event) res.extendedProperties = { private: { wcSeries: isRecurring ? body.seriesId : seriesKey } };
    return { row: row, res: res };
  });

  Object.keys(deleted).forEach(function (id) {
    if (existing.some(function (e) { return e.id === id; })) Calendar.Events.remove(cal, id);
  });
  plans.forEach(function (p) {
    if (p.row.event) Calendar.Events.patch(p.res, cal, p.row.event.id);
    else Calendar.Events.insert(p.res, cal);
  });
  return { ok: true, seriesId: isRecurring ? body.seriesId : seriesKey, count: plans.length };
}

// 列出同一課程的所有堂數（不限日期範圍）
function listSeries_(seriesId) {
  var cal = CONFIG.CALENDAR_ID;
  var out = [];
  var pageToken = null;
  if (seriesId.indexOf('title:') === 0) {
    // 舊網站建立的課程：各堂是獨立活動，以標題（去掉「第 N 堂」）分組
    var base = seriesId.slice(6);
    var now = Date.now();
    listAll_(cal, new Date(now - 400 * 86400000), new Date(now + 400 * 86400000)).forEach(function (e) {
      if (e.status === 'cancelled' || e.recurringEventId || seriesTagOf_(e)) return;
      if (sessionNoOf(e.summary) && stripSessionNo(e.summary) === base) out.push(e);
    });
    return out;
  }
  if (seriesId.indexOf('wc-') !== 0) {
    do {
      var inst = Calendar.Events.instances(cal, seriesId, { maxResults: 2500, timeZone: CONFIG.TIME_ZONE, pageToken: pageToken || undefined });
      out = out.concat((inst.items || []).filter(function (e) { return e.status !== 'cancelled'; }));
      pageToken = inst.nextPageToken;
    } while (pageToken);
  }
  pageToken = null;
  do {
    var tagged = Calendar.Events.list(cal, { privateExtendedProperty: 'wcSeries=' + seriesId, singleEvents: true, showDeleted: false, maxResults: 2500, timeZone: CONFIG.TIME_ZONE, pageToken: pageToken || undefined });
    out = out.concat(tagged.items || []);
    pageToken = tagged.nextPageToken;
  } while (pageToken);
  return out;
}

function mergeSession_(body, session) {
  return {
    title: body.title, type: body.type, venues: body.venues, allDay: !!body.allDay, remark: body.remark,
    date: session.date, startTime: session.startTime, endTime: session.endTime
  };
}

function sortSessions_(sessions) {
  return sessions.slice().sort(function (a, b) {
    var ka = a.date + 'T' + (a.startTime || ''), kb = b.date + 'T' + (b.startTime || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function eventStartKey_(e) {
  var s = (e.start && (e.start.dateTime || e.start.date)) || '';
  return s.slice(0, 10) + 'T' + (s.length > 10 ? s.slice(11, 16) : '00:00');
}

function seriesTagOf_(e) {
  return (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.wcSeries) || null;
}

// 「[White Club] 古文班 (第 3 堂)」→「[White Club] 古文班」
function stripSessionNo(title) {
  return String(title || '').replace(/\s*[（(]\s*第\s*\d+\s*堂\s*[)）]\s*$/, '').trim();
}

function sessionNoOf(title) {
  var m = String(title || '').match(/[（(]\s*第\s*(\d+)\s*堂\s*[)）]\s*$/);
  return m ? Number(m[1]) : null;
}

function withSessionNo(title, n) {
  return stripSessionNo(title) + ' (第 ' + n + ' 堂)';
}

function conflictError_(message) {
  var err = new Error(message);
  err.conflict = true;
  return err;
}

/**
 * 把網站表單轉成 Google Calendar 活動內容。沒有副作用，方便測試。
 * existing = 修改時的原有活動（新增時為 null）；seriesOnly = 不改日期時間（只改標題、類型、場地、備註）。
 */
function buildEventResource(input, config, existing, seriesOnly) {
  var title = String(input.title || '').trim();
  if (!title) throw new Error('請填寫標題');
  var type = config.TYPES.filter(function (t) { return t.key === input.type; })[0];
  if (!type || !type.colorIds.length) throw new Error('請揀活動類型');
  var validKeys = config.VENUES.map(function (v) { return v.key; });
  var venues = (Array.isArray(input.venues) ? input.venues : []).filter(function (k) { return validKeys.indexOf(k) !== -1; });
  if (!venues.length) throw new Error('請揀場地');
  venues = validKeys.filter(function (k) { return venues.indexOf(k) !== -1; });

  var res = { summary: title, colorId: String(type.colorIds[0]) };
  // 場地沒有改變就保留原本的地點文字
  var before = existing ? detectVenues(existing.location, existing.summary, config) : null;
  if (!before || before.unclear || before.defaulted || before.venues.join() !== venues.join()) {
    res.location = venueLocation_(venues, config);
  }
  // 備註（Google 日曆的「說明」）：只在網站有修改時才傳入，否則保留原有內容
  if (typeof input.remark === 'string') {
    if (input.remark.length > 8000) throw new Error('備註太長（最多 8000 字）');
    res.description = input.remark;
  }
  if (seriesOnly) return res;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('日期格式不正確');
  if (input.allDay) {
    res.start = { date: input.date, dateTime: null, timeZone: null };
    res.end = { date: addDays_(input.date, 1), dateTime: null, timeZone: null };
  } else {
    if (!/^\d{2}:\d{2}$/.test(input.startTime || '') || !/^\d{2}:\d{2}$/.test(input.endTime || '')) throw new Error('時間格式不正確');
    if (input.endTime <= input.startTime) throw new Error('結束時間要遲過開始時間');
    res.start = { dateTime: input.date + 'T' + input.startTime + ':00', timeZone: config.TIME_ZONE, date: null };
    res.end = { dateTime: input.date + 'T' + input.endTime + ':00', timeZone: config.TIME_ZONE, date: null };
  }
  var repeat = Math.floor(Number(input.repeatWeeks || 1));
  if (!existing && repeat > 1) {
    if (repeat > 52) throw new Error('重複次數最多 52 次');
    res.recurrence = ['RRULE:FREQ=WEEKLY;COUNT=' + repeat];
  }
  return res;
}

function verifyEditor_(idToken) {
  if (!idToken) throw new Error('請先登入網站');
  var res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(CONFIG.FIREBASE_WEB_API_KEY), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true
  });
  var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (_) {}
  return checkEditor(res.getResponseCode(), data, CONFIG);
}

// 檢查登入驗證結果。沒有副作用，方便測試。
function checkEditor(code, data, config) {
  if (code !== 200) {
    var msg = (data && data.error && data.error.message) || ('HTTP ' + code);
    if (/INVALID_ID_TOKEN|TOKEN_EXPIRED|USER_NOT_FOUND/.test(msg)) throw new Error('登入已過期，請重新整理網頁再試');
    if (/referer|API_KEY/i.test(msg)) throw new Error('Firebase 金鑰設定限制了來源，請見指南「出問題點算」：' + msg);
    throw new Error('未能驗證登入：' + msg);
  }
  var user = data && data.users && data.users[0];
  var email = String((user && user.email) || '').toLowerCase();
  var allowed = config.ALLOWED_EDITORS.map(function (x) { return String(x).toLowerCase(); });
  if (!email || allowed.indexOf(email) === -1 || user.emailVerified === false) {
    throw new Error('此帳戶沒有修改權限：' + (email || '未知帳戶'));
  }
  return email;
}

// 在編輯器按「執行」這個函式，可以檢查設定是否正確（結果看「執行記錄」）。
function testFeed() {
  var feed = buildFeed_();
  Logger.log('共 %s 項活動，%s 項需處理，%s 個假期', feed.events.length,
    feed.events.filter(function (ev) { return ev.type === 'Other' || ev.venueUnclear; }).length,
    Object.keys(feed.holidays).length);
  Logger.log(JSON.stringify(feed.events.slice(0, 5), null, 2));
}

function buildFeed_() {
  var now = new Date();
  var timeMin = new Date(now.getTime() - CONFIG.DAYS_BACK * 86400000);
  var timeMax = new Date(now.getTime() + CONFIG.DAYS_AHEAD * 86400000);
  var items = listAll_(CONFIG.CALENDAR_ID, timeMin, timeMax);
  var events = [];
  items.forEach(function (item) {
    var ev = mapEvent(item, CONFIG);
    if (ev) events.push(ev);
  });
  return {
    ok: true,
    generatedAt: now.toISOString(),
    timeZone: CONFIG.TIME_ZONE,
    types: CONFIG.TYPES.map(function (t) { return { key: t.key, label: t.label, hex: t.hex, colorIds: t.colorIds }; }),
    venues: CONFIG.VENUES.map(function (v) { return { key: v.key, code: v.code, label: v.label }; }),
    defaultVenue: CONFIG.DEFAULT_VENUE,
    events: events,
    holidays: readHolidays_(timeMin, timeMax)
  };
}

function listAll_(calendarId, timeMin, timeMax) {
  var all = [];
  var pageToken = null;
  do {
    var res = Calendar.Events.list(calendarId, {
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: CONFIG.TIME_ZONE,
      maxResults: 2500,
      pageToken: pageToken || undefined
    });
    all = all.concat(res.items || []);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return all;
}

function readHolidays_(timeMin, timeMax) {
  var out = {};
  if (!CONFIG.HOLIDAY_CALENDAR_ID) return out;
  try {
    listAll_(CONFIG.HOLIDAY_CALENDAR_ID, timeMin, timeMax).forEach(function (item) {
      // 只保留公眾假期，略過「紀念日 / Observance」
      if (/observance/i.test(item.description || '')) return;
      var date = item.start && item.start.date;
      if (date && item.summary) out[date] = item.summary;
    });
  } catch (err) {
    console.warn('讀取假期日曆失敗：' + err);
  }
  return out;
}

/**
 * 把一項 Google Calendar 活動轉成網站格式。沒有副作用，方便測試。
 * 回傳 null = 不顯示（已取消）。
 */
function mapEvent(item, config) {
  if (!item || item.status === 'cancelled' || !item.start) return null;
  var allDay = !!item.start.date && !item.start.dateTime;
  var startStr = item.start.dateTime || item.start.date;
  var endStr = (item.end && (item.end.dateTime || item.end.date)) || startStr;
  var date = startStr.slice(0, 10);
  var endDate = endStr.slice(0, 10);
  if (allDay && endDate > date) endDate = addDays_(endDate, -1); // Google 全日活動的結束日不包括在內
  var startTime = allDay ? '' : startStr.slice(11, 16);
  var endTime = allDay ? '' : endStr.slice(11, 16);
  // 跨到深夜 00:00 結束的活動，當作同一天結束
  if (!allDay && endDate > date && endTime === '00:00') { endDate = addDays_(endDate, -1); endTime = '23:59'; }

  var venue = detectVenues(item.location, item.summary, config);
  var type = detectType(item.colorId, item.summary, config);
  // 課程分組：Google 重複活動 → 網站建立的多堂課程（wcSeries）→ 舊網站的「(第 N 堂)」標題
  var tag = seriesTagOf_(item);
  var seriesId = item.recurringEventId || tag || (sessionNoOf(item.summary) ? 'title:' + stripSessionNo(item.summary) : null);
  return {
    id: item.id,
    title: item.summary || '(無標題)',
    date: date,
    endDate: endDate,
    startTime: startTime,
    endTime: endTime,
    allDay: allDay,
    venues: venue.venues,
    venueUnclear: venue.unclear,
    venueDefaulted: venue.defaulted,
    type: type.key,
    typeGuessed: type.guessed,
    colorId: item.colorId || null,
    seriesId: seriesId,
    sessionNo: sessionNoOf(item.summary),
    hasRemark: !!String(item.description || '').trim(), // 備註內容不放入公開資料，網站登入後另外讀取
    location: item.location || '',
    htmlLink: item.htmlLink || '',
    updated: item.updated || null
  };
}

/**
 * 活動類型：先看 TITLE_OVERRIDES；再看 Google 顏色；顏色認不到就用標題判斷（TITLE_RULES）；都不行就是「未分類」。
 * 回傳 { key, guessed }，guessed = 由標題判斷。
 */
function detectType(colorId, title, config) {
  var types = config.TYPES;
  var overrides = config.TITLE_OVERRIDES || [];
  for (var o = 0; o < overrides.length; o++) {
    if (overrides[o].patterns.some(function (p) { return new RegExp(p, 'i').test(title || ''); })) return { key: overrides[o].type, guessed: false };
  }
  for (var i = 0; i < types.length; i++) {
    if (colorId && types[i].colorIds.indexOf(String(colorId)) !== -1) return { key: types[i].key, guessed: false };
  }
  var text = title || '';
  for (var r = 0; r < config.TITLE_RULES.length; r++) {
    var rule = config.TITLE_RULES[r];
    if (rule.patterns.some(function (p) { return new RegExp(p, 'i').test(text); })) return { key: rule.type, guessed: true };
  }
  return { key: types[types.length - 1].key, guessed: false };
}

/**
 * 認出活動在哪個場地。回傳 { venues: ['1S', ...], unclear, defaulted }。
 * unclear = 只寫了「1/F」沒寫房間；defaulted = 完全沒寫，用了預設場地。
 */
function detectVenues(location, title, config) {
  var matches = function (patterns, text) {
    return patterns.some(function (p) { return new RegExp(p, 'i').test(text); });
  };
  var sources = [location || '', title || ''];
  for (var s = 0; s < sources.length; s++) {
    var text = sources[s];
    var unclear = false;
    var found = config.VENUES.filter(function (v) { return matches(v.patterns, text); }).map(function (v) { return v.key; });
    // 「1/F 細房」這類寫法：已認出房間，就不用再當成「未指明房間」
    config.VENUE_GROUPS.forEach(function (group) {
      var hasRoomInGroup = group.rooms.some(function (k) { return found.indexOf(k) !== -1; });
      if (!hasRoomInGroup && matches(group.patterns, text)) {
        group.fallback.forEach(function (k) { if (found.indexOf(k) === -1) found.push(k); });
        if (group.unclear) unclear = true;
      }
    });
    if (found.length) {
      var ordered = config.VENUES.map(function (v) { return v.key; }).filter(function (k) { return found.indexOf(k) !== -1; });
      return { venues: ordered, unclear: unclear, defaulted: false };
    }
  }
  return { venues: [config.DEFAULT_VENUE], unclear: false, defaulted: true };
}

function venueLocation_(keys, config) {
  return config.LOCATION_PREFIX + config.VENUES
    .filter(function (v) { return keys.indexOf(v.key) !== -1; })
    .map(function (v) { return v.code; }).join(' + ');
}

function addDays_(ymd, days) {
  var parts = ymd.split('-').map(Number);
  var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return d.toISOString().slice(0, 10);
}

// CacheService 每個值上限 100KB，所以分段儲存。
function readCache_() {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get('feed_parts') || 0);
  if (!count) return null;
  var keys = [];
  for (var i = 0; i < count; i++) keys.push('feed_' + i);
  var parts = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < count; j++) {
    if (parts['feed_' + j] == null) return null;
    out += parts['feed_' + j];
  }
  return out;
}

function writeCache_(json) {
  var cache = CacheService.getScriptCache();
  var size = 90000;
  var values = {};
  var count = Math.ceil(json.length / size);
  for (var i = 0; i < count; i++) values['feed_' + i] = json.slice(i * size, (i + 1) * size);
  values.feed_parts = String(count);
  try { cache.putAll(values, CONFIG.CACHE_SECONDS); } catch (err) { console.warn('快取失敗：' + err); }
}

if (typeof module !== 'undefined') {
  module.exports = { CONFIG: CONFIG, mapEvent: mapEvent, detectVenues: detectVenues, detectType: detectType, buildEventResource: buildEventResource, checkEditor: checkEditor, stripSessionNo: stripSessionNo, sessionNoOf: sessionNoOf, withSessionNo: withSessionNo, saveSeries_: saveSeries_, handleWrite_: handleWrite_ };
}
