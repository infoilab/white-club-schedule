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
 *   getSeriesNaming { seriesId }                         → { ok, events }（所有日期的公開資料）
 *   create     { title, type, venues, allDay, remark?, sessions:[{date,startTime,endTime,title?,autoTitle?,remark?}] }
 *              （多過一堂 → 用 wcSeries 連成課程；autoTitle:true 用「課程名 Ln」，省略沿用「(第 N 堂)」）
 *   update     { id, expectedUpdated, title, type, venues, date, allDay, startTime, endTime, remark? }（只改這一堂）
 *   saveSeries { seriesId, title, type, venues, allDay, remark?, sessions:[{id?,date,startTime,endTime,title?,autoTitle?,remark?}], deletedIds:[] }
 *              （逐堂 remark 優先於共用 remark；省略保留原有備註，空字串明確清除）
 *   delete     { id, scope:'single'|'series', seriesId, expectedUpdated }
 */
function doPost(e) {
  var out;
  var lock = null;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var email = verifyEditor_(body.idToken);
    // 只串行化此新部署的網站寫入；Google 日曆及舊部署的寫入仍可能同時發生。
    if (body.action !== 'get' && body.action !== 'getSeriesNaming') {
      lock = LockService.getScriptLock();
      lock.waitLock(30000);
    }
    out = handleWrite_(body);
    console.log(email + ' ' + body.action + ' ' + (body.id || body.title));
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), conflict: !!(err && err.conflict) };
  } finally {
    // 同一專案的部署共用 CacheService；新版快取獨立，寫入後兩站都重新讀取。
    CacheService.getScriptCache().remove('ilab_v1_feed_parts');
    CacheService.getScriptCache().remove('feed_parts');
    if (lock && lock.hasLock()) lock.releaseLock();
  }
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

  if (action === 'getSeriesNaming') {
    if (typeof body.seriesId !== 'string' || !body.seriesId.trim()) throw conflictError_('缺少課程 ID，請重新載入');
    var members;
    try { members = listSeries_(body.seriesId); }
    catch (err) {
      if (err.code === 404 || err.code === 410 || /not found|notfound|404|410|gone/i.test(String(err.message || err))) throw conflictError_('此課程已在 Google 日曆被刪除。');
      throw err;
    }
    if (!members.length) throw conflictError_('此課程已在 Google 日曆被刪除。');
    return { ok: true, events: members.map(function (ev) { return mapEvent(ev, CONFIG); }) };
  }

  if (action === 'create') {
    var naming = normalizeCourseNaming_(body.naming);
    var sessions = body.sessions === undefined ? [{ date: body.date, startTime: body.startTime, endTime: body.endTime }] : body.sessions;
    validateSessions_(sessions, false);
    var seriesKey = sessions.length > 1 ? newSeriesKey_() : null;
    var resources = sortSessions_(sessions).map(function (s, i) {
      var res = buildEventResource(mergeSession_(body, s), CONFIG, null, false);
      if (seriesKey) delete res.recurrence;
      var custom = naming === undefined ? sessionTitle_(s) : fixedSessionTitle_(s, null);
      if (seriesKey || custom || s.autoTitle === true || s.lessonIdentity !== undefined) setSessionMetadata_(res, null, body.title, i + 1, custom, seriesKey, !!seriesKey, s.autoTitle === true, naming, normalizeLessonIdentity_(s.lessonIdentity));
      return res;
    });
    if (!seriesKey) {
      var one = Calendar.Events.insert(resources[0], cal);
      return { ok: true, event: mapEvent(one, CONFIG) };
    }
    resources.forEach(function (res) { Calendar.Events.insert(res, cal); });
    return { ok: true, seriesId: seriesKey, count: resources.length };
  }

  if (action === 'saveSeries') return saveSeries_(body);
  if (action === 'convertToSeries') return convertToSeries_(body);

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
  if (body.typeOnly === true) {
    if (typeof body.expectedUpdated !== 'string' || !body.expectedUpdated) throw new Error('缺少活動版本，請重新載入');
    var selectedType = CONFIG.TYPES.filter(function (type) { return type.key === body.type; })[0];
    if (!selectedType) throw new Error('請揀活動類型');
    var typedEvent = Calendar.Events.patch({ colorId: selectedType.colorIds.length ? String(selectedType.colorIds[0]) : null }, cal, body.id);
    return { ok: true, event: mapEvent(typedEvent, CONFIG) };
  }
  var resource = buildEventResource(body, CONFIG, current, false);
  var props = privateProps_(current);
  if (resource.summary !== current.summary && (mapEvent(current, CONFIG).seriesId || props.wcSessionTitle || props.wcSessionAutoTitle === '1')) {
    props.wcSessionTitle = resource.summary;
    if (props.wcSessionAutoTitle !== undefined) props.wcSessionAutoTitle = null;
    if (props.wcSeriesTitle === undefined) props.wcSeriesTitle = stripSessionNo(current.summary);
    if (props.wcSessionNo === undefined) props.wcSessionNo = String(sessionNoOf(current.summary) || 1);
    resource.extendedProperties = { private: props };
  }
  var patched = Calendar.Events.patch(resource, cal, body.id);
  return { ok: true, event: mapEvent(patched, CONFIG) };
}

/**
 * 保留來源 ID 作指定原堂（舊客戶作首堂）；先新增其他堂，再重讀來源版本，最後才 patch 原堂。
 * Google 多項寫入並非交易；失敗只盡力移除本次已回傳 ID 的新增堂數。
 */
function convertToSeries_(body) {
  var naming = normalizeCourseNaming_(body.naming);
  if (!body.id) throw new Error('缺少活動 ID');
  if (typeof body.expectedUpdated !== 'string' || !body.expectedUpdated) throw new Error('缺少活動版本，請重新載入');
  var cal = CONFIG.CALENDAR_ID;
  var source = liveEvent_(body.id);
  checkConvertible_(source, body.expectedUpdated);
  validateSessions_(body.sessions, false);
  var sessions = sortSessions_(body.sessions), sourceIndex = 0, originalCount = 0, hasOriginal = false;
  sessions.forEach(function (s, i) {
    if (!Object.prototype.hasOwnProperty.call(s, 'original')) return;
    hasOriginal = true;
    if (typeof s.original !== 'boolean') throw new Error('原活動標記格式不正確');
    if (s.original) { sourceIndex = i; originalCount++; }
  });
  if (hasOriginal && originalCount !== 1) throw new Error('必須指定一堂原活動');
  var seriesKey = newSeriesKey_();
  var plans = sessions.map(function (s, i) {
    var input = mergeSession_(body, s);
    var res = buildEventResource(input, CONFIG, source, false);
    delete res.recurrence;
    var custom = sessionTitle_(s);
    if (naming !== undefined) custom = fixedSessionTitle_(s, i === sourceIndex ? source : null);
    else if (s.title === undefined && s.autoTitle === undefined && privateProps_(source).wcSessionAutoTitle === '1') custom = customTitleOf_(source);
    setSessionMetadata_(res, source, body.title, i + 1, custom, seriesKey, true, sessionAutoTitle_(s, source, custom), naming, normalizeLessonIdentity_(s.lessonIdentity) || (i === sourceIndex ? undefined : null));
    return i === sourceIndex ? res : materializeInsert_(res, source);
  });
  var inserted = [];
  try {
    plans.forEach(function (res, i) {
      if (i === sourceIndex) return;
      var child = Calendar.Events.insert(res, cal);
      inserted.push(child.id);
    });
    checkConvertible_(liveEvent_(source.id), source.updated);
    var first = Calendar.Events.patch(plans[sourceIndex], cal, source.id);
    return { ok: true, seriesId: seriesKey, count: plans.length, event: mapEvent(first, CONFIG) };
  } catch (err) {
    var failedCleanup = false;
    inserted.forEach(function (id) {
      try { Calendar.Events.remove(cal, id); }
      catch (cleanupError) { failedCleanup = true; console.warn('未能清理新增堂數 ' + id + ': ' + cleanupError); }
    });
    if (failedCleanup) err.message = String(err.message || err) + '；部分新增堂數未能清理，請在 Google 日曆核對';
    throw err;
  }
}

function liveEvent_(id) {
  var event;
  try { event = Calendar.Events.get(CONFIG.CALENDAR_ID, id); }
  catch (err) {
    if (err.code === 404 || /not found|notfound|404|410|gone/i.test(String(err.message || err))) {
      throw conflictError_('此活動已在 Google 日曆被刪除。');
    }
    throw err;
  }
  if (!event || event.status === 'cancelled') throw conflictError_('此活動已在 Google 日曆被刪除。');
  return event;
}

function checkConvertible_(event, expectedUpdated) {
  if (event.updated !== expectedUpdated) throw conflictError_('此活動剛被其他人修改，請重新載入再試。');
  if (event.recurringEventId || (event.recurrence && event.recurrence.length) || seriesTagOf_(event) || sessionNoOf(event.summary)) {
    throw conflictError_('此活動已屬於課程或重複活動，不能再次轉成課程。');
  }
}

/** 所有欄位、成員 ID 及版本先驗證；不推測刪堂，未提交的堂數仍保留。 */
function saveSeries_(body) {
  var naming = normalizeCourseNaming_(body.naming);
  var cal = CONFIG.CALENDAR_ID;
  if (typeof body.seriesId !== 'string' || !body.seriesId) throw new Error('缺少課程 ID');
  var existing = listSeries_(body.seriesId);
  if (!existing.length) throw conflictError_('此課程已在 Google 日曆被刪除。');
  var members = Object.create(null);
  existing.forEach(function (e) { members[e.id] = e; });
  var deleted = Object.create(null);
  var deletedIds = body.deletedIds === undefined ? [] : body.deletedIds;
  if (!Array.isArray(deletedIds)) throw new Error('刪除堂數格式不正確');
  deletedIds.forEach(function (id) {
    if (typeof id !== 'string' || !members[id]) throw new Error('刪除 ID 不屬於此課程');
    if (deleted[id]) throw new Error('重複的刪除 ID');
    deleted[id] = true;
  });
  var sessions = body.sessions === undefined ? [] : body.sessions;
  validateSessions_(sessions, true, true);
  var submitted = Object.create(null);
  var added = [];
  sessions.forEach(function (s) {
    if (s.id !== undefined) {
      if (typeof s.id !== 'string' || !members[s.id]) throw new Error('堂數 ID 不屬於此課程');
      if (submitted[s.id] || deleted[s.id]) throw new Error('堂數 ID 重複或同時提交及刪除');
      submitted[s.id] = s;
    } else added.push(s);
  });
  var expected = body.expectedUpdates === undefined ? {} : body.expectedUpdates;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('活動版本格式不正確');
  Object.keys(expected).forEach(function (id) {
    if (!members[id]) throw new Error('版本 ID 不屬於此課程');
    if (typeof expected[id] !== 'string' || !expected[id]) throw new Error('活動版本格式不正確');
  });

  // 重複活動以外的課程都用 wcSeries 標記（舊網站用標題分組的課程，第一次儲存時轉用標記）
  var isRecurring = body.seriesId.indexOf('wc-') !== 0 && body.seriesId.indexOf('title:') !== 0;
  var seriesKey = body.seriesId.indexOf('title:') === 0 ? newSeriesKey_() : body.seriesId;

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
  var colorSource = existing.slice().sort(function (a, b) { return eventStartKey_(a).localeCompare(eventStartKey_(b)); })[0];
  var plans = rows.map(function (row, i) {
    var input = row.session ? mergeSession_(body, row.session) : body;
    var base = row.event || (body.preserveTypes === true ? colorSource : null);
    var res = buildEventResource(input, CONFIG, base, !row.session);
    delete res.recurrence;
    // 舊客戶沒有 title 欄位時保留已自訂的堂名；明確傳空字串才恢復自動編號。
    var custom = row.session && Object.prototype.hasOwnProperty.call(row.session, 'title') ? sessionTitle_(row.session) : customTitleOf_(row.event);
    // 新命名契約：未提交／省略堂名的已有堂一律凍結目前 Google summary，編號只作排序 metadata。
    if (naming !== undefined) custom = fixedSessionTitle_(row.session, row.event);
    setSessionMetadata_(res, row.event, body.title, i + 1, custom, isRecurring && row.event ? seriesTagOf_(row.event) : seriesKey, true, sessionAutoTitle_(row.session, row.event, custom), naming, normalizeLessonIdentity_(row.session ? row.session.lessonIdentity : undefined));
    if (!row.event && base) res = materializeInsert_(res, base);
    return { row: row, res: res };
  });

  Object.keys(expected).forEach(function (id) {
    if (liveEvent_(id).updated !== expected[id]) throw conflictError_('此課程剛被其他人修改，請重新載入再試。');
  });
  // 不是跨活動交易：API 中途失敗可能已有部分更新，但至少不先刪除原有堂數。
  plans.forEach(function (p) {
    if (p.row.event) Calendar.Events.patch(p.res, cal, p.row.event.id);
    else Calendar.Events.insert(p.res, cal);
  });
  Object.keys(deleted).forEach(function (id) { Calendar.Events.remove(cal, id); });
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
    do {
      var legacy = Calendar.Events.list(cal, { singleEvents: true, showDeleted: false, maxResults: 2500, timeZone: CONFIG.TIME_ZONE, pageToken: pageToken || undefined });
      (legacy.items || []).forEach(function (e) {
        if (e.status === 'cancelled' || e.recurringEventId || seriesTagOf_(e)) return;
        if (sessionNoOf(e.summary) && stripSessionNo(e.summary) === base) out.push(e);
      });
      pageToken = legacy.nextPageToken;
    } while (pageToken);
    return uniqueEvents_(out);
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
  // 重複 instance 亦可能帶 wcSeries；同一 ID 只處理一次，原生 recurring 分組優先。
  return uniqueEvents_(out.filter(function (e) {
    return e.status !== 'cancelled' && (e.recurringEventId || seriesTagOf_(e)) === seriesId;
  }));
}

function mergeSession_(body, session) {
  if (body.allDay !== undefined && typeof body.allDay !== 'boolean') throw new Error('全日活動格式不正確');
  validateRemark_(body.remark);
  return {
    title: body.title, type: body.type, venues: body.venues, allDay: !!body.allDay, remark: session.remark !== undefined ? session.remark : body.remark,
    date: session.date, startTime: session.startTime, endTime: session.endTime,
    preserveTypes: body.preserveTypes === true, repeatWeeks: body.repeatWeeks
  };
}

function newSeriesKey_() { return 'wc-' + Utilities.getUuid(); }

function uniqueEvents_(items) {
  var seen = Object.create(null);
  return items.filter(function (e) {
    if (!e || !e.id || seen[e.id]) return false;
    seen[e.id] = true;
    return true;
  });
}

function validateSessions_(sessions, allowIds, allowEmpty) {
  if (!Array.isArray(sessions) || (!allowEmpty && !sessions.length)) throw new Error('課程最少要有一堂');
  if (sessions.length > 60) throw new Error('堂數最多 60 堂');
  sessions.forEach(function (s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('堂數格式不正確');
    if (!allowIds && s.id !== undefined) throw new Error('新增堂數不能指定已有 ID');
    sessionTitle_(s);
    if (s.autoTitle !== undefined && typeof s.autoTitle !== 'boolean') throw new Error('堂數自動標題格式不正確');
    normalizeLessonIdentity_(s.lessonIdentity);
    validateRemark_(s.remark);
  });
}

function validateRemark_(remark) {
  if (remark !== undefined && typeof remark !== 'string') throw new Error('備註格式不正確');
  if (typeof remark === 'string' && remark.length > 8000) throw new Error('備註太長（最多 8000 字）');
}

function sessionTitle_(session) {
  if (!Object.prototype.hasOwnProperty.call(session, 'title')) return '';
  if (typeof session.title !== 'string' || session.title.length > 1024) throw new Error('堂數標題格式不正確或太長（最多 1024 字）');
  return session.title.trim() ? session.title : ''; // 自訂堂名不 trim、不加編號
}

function normalizeCourseNaming_(naming) {
  if (naming === undefined) return undefined;
  if (!naming || Object.prototype.toString.call(naming) !== '[object Object]') throw new Error('課程命名設定格式不正確');
  if (!Object.prototype.hasOwnProperty.call(naming, 'mode') || (naming.mode !== 'general' && naming.mode !== 'classical')) throw new Error('課程命名模式不正確');
  var limits = { startNo: 9999, term: 999, parts: 12 };
  Object.keys(limits).forEach(function (key) {
    var value = naming[key];
    if (!Object.prototype.hasOwnProperty.call(naming, key) || typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 1 || value > limits[key]) throw new Error('課程命名設定須為有效整數：' + key);
  });
  // 新場次模式才加每期堂數；舊四欄 payload 保持原格式，不暗中改舊堂名。
  var normalized = { mode: naming.mode, startNo: naming.startNo, term: naming.mode === 'general' ? 1 : naming.term, parts: naming.mode === 'general' ? 1 : naming.parts };
  if (Object.prototype.hasOwnProperty.call(naming, 'lessonsPerTerm')) {
    var perTerm = naming.lessonsPerTerm;
    if (typeof perTerm !== 'number' || !isFinite(perTerm) || Math.floor(perTerm) !== perTerm || perTerm < 1 || perTerm > 60) throw new Error('每期堂數須為 1 至 60 的整數');
    if (naming.mode === 'classical') normalized.lessonsPerTerm = perTerm;
  }
  return normalized;
}

function normalizeLessonIdentity_(identity) {
  if (identity === undefined) return undefined;
  if (!identity || Object.prototype.toString.call(identity) !== '[object Object]') throw new Error('課堂場次身份格式不正確');
  var limits = { lessonNo: 9999, term: 999, offering: 12 };
  Object.keys(limits).forEach(function (key) {
    var value = identity[key];
    if (!Object.prototype.hasOwnProperty.call(identity, key) || typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < 1 || value > limits[key]) throw new Error('課堂場次身份須為有效整數：' + key);
  });
  return { lessonNo: identity.lessonNo, term: identity.term, offering: identity.offering };
}

function fixedSessionTitle_(session, existing) {
  var title = session && Object.prototype.hasOwnProperty.call(session, 'title') ? sessionTitle_(session) : existing && existing.summary;
  if (typeof title !== 'string' || !title.trim()) throw new Error('請填寫堂數標題');
  if (title.length > 1024) throw new Error('堂數標題太長（最多 1024 字）');
  return title; // 精確堂名由前端提供，不按日期／共同名稱／命名設定重新產生。
}

function privateProps_(event) {
  var old = event && event.extendedProperties && event.extendedProperties.private;
  var copy = Object.create(null);
  Object.keys(old || {}).forEach(function (key) { copy[key] = old[key]; });
  return copy;
}

function customTitleOf_(event) {
  if (!event) return '';
  var p = privateProps_(event);
  if (p.wcSessionTitle && String(p.wcSessionTitle).trim()) return event.summary || p.wcSessionTitle;
  if (event.recurringEventId && !p.wcSeriesTitle && p.wcSessionAutoTitle !== '1') return event.summary || '';
  // 同事直接在 Google 改了已標記課程的堂名，也不要在舊客戶儲存時抹掉。
  var n = Number(p.wcSessionNo) || sessionNoOf(event.summary);
  var expected = p.wcSessionAutoTitle === '1' ? String(p.wcSeriesTitle || '').trim() + ' L' + n : withSessionNo(p.wcSeriesTitle, n);
  if (p.wcSeriesTitle && n && event.summary !== expected) return event.summary || '';
  return '';
}

function sessionAutoTitle_(session, existing, custom) {
  if (session && session.autoTitle !== undefined) return session.autoTitle;
  return (!session || !Object.prototype.hasOwnProperty.call(session, 'title')) && privateProps_(existing).wcSessionAutoTitle === '1' && !custom;
}

function setSessionMetadata_(res, existing, title, n, custom, seriesKey, numbered, autoTitle, naming, identity) {
  var props = privateProps_(existing);
  var common = String(title || '').trim();
  if (naming !== undefined) { props.wcSeriesNaming = JSON.stringify(naming); autoTitle = false; }
  if (identity === null) { if (props.wcLessonIdentity !== undefined) props.wcLessonIdentity = null; }
  else if (identity !== undefined) props.wcLessonIdentity = JSON.stringify(identity);
  props.wcSeriesTitle = common;
  props.wcSessionNo = String(n);
  if (seriesKey) props.wcSeries = seriesKey;
  if (autoTitle) { props.wcSessionAutoTitle = '1'; custom = ''; }
  else if (props.wcSessionAutoTitle !== undefined) props.wcSessionAutoTitle = null;
  if (custom) props.wcSessionTitle = custom;
  else if (props.wcSessionTitle !== undefined) props.wcSessionTitle = null; // Calendar PATCH: null 刪除舊屬性
  res.summary = custom || (autoTitle ? common + ' L' + n : (numbered ? withSessionNo(common, n) : common));
  if (res.summary.length > 1024) throw new Error('標題太長（最多 1024 字，連堂數編號）');
  res.extendedProperties = { private: props };
}

function materializeInsert_(res, source) {
  // 新活動不能靠省略欄位「保留」來源內容；只複製地點／說明／顏色及已合併的標記。
  if (res.location === undefined) res.location = source.location || '';
  if (res.description === undefined) res.description = source.description || '';
  var props = res.extendedProperties && res.extendedProperties.private;
  Object.keys(props || {}).forEach(function (key) { if (props[key] === null) delete props[key]; });
  return res;
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
  if (typeof input.title !== 'string' || input.title.length > 1024) throw new Error('標題格式不正確或太長（最多 1024 字）');
  var title = String(input.title || '').trim();
  if (!title) throw new Error('請填寫標題');
  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') throw new Error('全日活動格式不正確');
  var type = config.TYPES.filter(function (t) { return t.key === input.type; })[0];
  var preserveColor = input.preserveTypes === true && !!existing;
  if (!preserveColor && !type) throw new Error('請揀活動類型');
  var validKeys = config.VENUES.map(function (v) { return v.key; });
  if (!Array.isArray(input.venues) || input.venues.some(function (k) { return validKeys.indexOf(k) === -1; })) throw new Error('請揀有效場地');
  var venues = (Array.isArray(input.venues) ? input.venues : []).filter(function (k) { return validKeys.indexOf(k) !== -1; });
  if (!venues.length) throw new Error('請揀場地');
  venues = validKeys.filter(function (k) { return venues.indexOf(k) !== -1; });

  var res = { summary: input.preserveTypes === true ? input.title : title };
  if (preserveColor) {
    if (existing.colorId !== undefined && existing.colorId !== null && existing.colorId !== '') res.colorId = String(existing.colorId);
  } else if (type.colorIds.length) res.colorId = String(type.colorIds[0]);
  else res.colorId = null; // 未分類：清除 Google Calendar 顏色，讓 Feed 正確歸入 Other
  // 場地沒有改變就保留原本的地點文字
  var before = existing ? detectVenues(existing.location, existing.summary, config) : null;
  var unchangedVenue = before && before.venues.join() === venues.join();
  if (!unchangedVenue || (input.preserveTypes !== true && (before.unclear || before.defaulted))) {
    res.location = venueLocation_(venues, config);
  }
  // 備註（Google 日曆的「說明」）：只在網站有修改時才傳入，否則保留原有內容
  validateRemark_(input.remark);
  if (typeof input.remark === 'string') res.description = input.remark;
  if (seriesOnly) return res;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('日期格式不正確');
  var actualDate = new Date(input.date + 'T00:00:00Z');
  if (isNaN(actualDate.getTime()) || actualDate.toISOString().slice(0, 10) !== input.date) throw new Error('日期不存在');
  if (input.allDay) {
    res.start = { date: input.date, dateTime: null, timeZone: null };
    res.end = { date: addDays_(input.date, 1), dateTime: null, timeZone: null };
  } else {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.startTime || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.endTime || '')) throw new Error('時間格式不正確');
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
    bridgeVersion: '2026-11-18-ilab-v1',
    capabilities: { sessionTitles: true, convertToSeries: true, saveSeries: true, privateRemarks: true, typeOnly: true, sessionRemarks: true, courseNaming: true, courseOfferings: true },
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
  var props = privateProps_(item);
  var seriesId = item.recurringEventId || tag || (sessionNoOf(item.summary) ? 'title:' + stripSessionNo(item.summary) : null);
  var mapped = {
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
    sessionNo: /^\d+$/.test(props.wcSessionNo || '') && Number(props.wcSessionNo) > 0 ? Number(props.wcSessionNo) : sessionNoOf(item.summary),
    hasRemark: !!String(item.description || '').trim(), // 備註內容不放入公開資料，網站登入後另外讀取
    location: item.location || '',
    htmlLink: item.htmlLink || '',
    updated: item.updated || null
  };
  if (typeof props.wcSeriesTitle === 'string' && props.wcSeriesTitle) mapped.seriesTitle = props.wcSeriesTitle;
  var custom = customTitleOf_(item);
  if (custom) mapped.sessionTitle = custom;
  else if (props.wcSessionAutoTitle === '1') mapped.sessionAutoTitle = true;
  if (typeof props.wcSeriesNaming === 'string') {
    try { mapped.naming = normalizeCourseNaming_(JSON.parse(props.wcSeriesNaming)); }
    catch (_) {} // 損壞／手改 metadata 不阻止 Feed，也不洩漏原始私密欄位。
  }
  if (typeof props.wcLessonIdentity === 'string') {
    try { mapped.lessonIdentity = normalizeLessonIdentity_(JSON.parse(props.wcLessonIdentity)); }
    catch (_) {} // 只公開有效小型場次身份，不傳原始私密欄位。
  }
  return mapped;
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
  var count = Number(cache.get('ilab_v1_feed_parts') || 0);
  if (!count) return null;
  var keys = [];
  for (var i = 0; i < count; i++) keys.push('ilab_v1_feed_' + i);
  var parts = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < count; j++) {
    if (parts['ilab_v1_feed_' + j] == null) return null;
    out += parts['ilab_v1_feed_' + j];
  }
  return out;
}

function writeCache_(json) {
  var cache = CacheService.getScriptCache();
  var size = 90000;
  var values = {};
  var count = Math.ceil(json.length / size);
  for (var i = 0; i < count; i++) values['ilab_v1_feed_' + i] = json.slice(i * size, (i + 1) * size);
  values.ilab_v1_feed_parts = String(count);
  try { cache.putAll(values, CONFIG.CACHE_SECONDS); } catch (err) { console.warn('快取失敗：' + err); }
}

if (typeof module !== 'undefined') {
  module.exports = { CONFIG: CONFIG, mapEvent: mapEvent, detectVenues: detectVenues, detectType: detectType, buildEventResource: buildEventResource, checkEditor: checkEditor, stripSessionNo: stripSessionNo, sessionNoOf: sessionNoOf, withSessionNo: withSessionNo, saveSeries_: saveSeries_, handleWrite_: handleWrite_ };
}
