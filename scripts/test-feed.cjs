// Tests the pure logic in apps-script/Code.gs. Run: node scripts/test-feed.cjs
const path = process.argv[2] || require('path').join(__dirname, '..', 'apps-script', 'Code.gs');
const fs = require('fs'); const vm = require('vm');
const src = fs.readFileSync(path, 'utf8');
const ctx = { module: { exports: {} }, console }; vm.createContext(ctx); vm.runInContext(src, ctx);
const { CONFIG, mapEvent, detectVenues, detectType, buildEventResource, checkEditor } = ctx.module.exports;
const assert = require('assert');
const plain = v => JSON.parse(JSON.stringify(v));
const throws = (fn, re) => assert.throws(fn, err => re.test(err.message));
const timed = (extra) => ({ start: { dateTime: '2026-10-22T10:00:00+08:00' }, end: { dateTime: '2026-10-22T11:00:00+08:00' }, ...extra });

// ---- 場地顯示名稱：短標籤不影響原有代碼及識別寫法 ----
const smallRoom = CONFIG.VENUES.find(v => v.key === '1S');
assert.strictEqual(smallRoom.label, '1/F 細房');
assert.strictEqual(smallRoom.code, '1S');
for (const location of ['1S', 'Mirror Room', '鏡房', '細房', '小房']) {
  assert.deepStrictEqual(plain(detectVenues(location, '', CONFIG)).venues, ['1S']);
}
console.log('場地名稱及識別檢查通過');

// ---- 讀取：Google 活動 → 網站格式 ----
const cases = [
  [{ id: 'a', status: 'confirmed', summary: '人類圖 (第 1 堂)', colorId: '5', location: 'White Club 1S', start: { dateTime: '2026-10-21T19:00:00+08:00' }, end: { dateTime: '2026-10-21T20:30:00+08:00' }, recurringEventId: 'r1', htmlLink: 'https://g/a' },
   { type: 'Course', typeGuessed: false, venues: ['1S'], venueUnclear: false, venueDefaulted: false, date: '2026-10-21', startTime: '19:00', endTime: '20:30', seriesId: 'r1', allDay: false }],
  [timed({ id: 'b', summary: '學校參觀 1B', colorId: '1' }), { type: 'Visit', venues: ['1B'] }],
  [timed({ id: 'b2', summary: 'x', colorId: '6' }), { type: 'Visit' }],
  [timed({ id: 'b3', summary: '停水', colorId: '8' }), { type: 'Notice', typeGuessed: false }],
  [timed({ id: 'c', summary: 'Workshop', colorId: '4', location: '2/F' }), { type: 'Event', venues: ['2F'] }],
  [timed({ id: 'c2', summary: '2R| 徐緣 - 腦拉提之夜', colorId: '9' }), { type: 'Event', venues: ['2F'], venueDefaulted: false }],
  [timed({ id: 'd', summary: 'Untagged' }), { type: 'Other', typeGuessed: false, venues: ['2F'], venueDefaulted: true, venueUnclear: false }],
  [timed({ id: 'd2', summary: '[White Club] 破解古埃及文聖書體興趣課 (第 7 堂)', location: 'White Club 1/F' }), { type: 'Course', typeGuessed: true, venues: ['1B'], venueUnclear: false }],
  [timed({ id: 'd3', summary: 'Booking | Ingrid + Vincent x 2' }), { type: 'Visit', typeGuessed: true }],
  [timed({ id: 'd4', summary: '肥仔輝 八字ABC，一堂學識揾自己五行最合拍伴侶' }), { type: 'Other' }],
  [timed({ id: 'e', summary: 'Other colour', colorId: '11', location: '11/F office' }), { type: 'Other', venues: ['2F'], venueDefaulted: true }],
  [timed({ id: 'e2', summary: 'SC S5 班', colorId: '11' }), { type: 'Course', typeGuessed: true }],
  [timed({ id: 'f', summary: 'Plain 1/F', colorId: '9', location: '1/F' }), { venues: ['1B'], venueUnclear: false }],
  [timed({ id: 'f2', summary: 'x', location: 'White Club 1/F 細房' }), { venues: ['1S'] }],
  [timed({ id: 'g', summary: 'Mirror room yoga', colorId: '9' }), { venues: ['1S'] }],
  [timed({ id: 'h', summary: 'x', colorId: '9', location: '1/F 大房' }), { venues: ['1B'], venueUnclear: false }],
  [timed({ id: 'i', summary: 'x', colorId: '9', location: '1S + 1B' }), { venues: ['1S', '1B'], venueUnclear: false }],
  [timed({ id: 'j', summary: 'x', colorId: '9', location: '1/F & 2/F' }), { venues: ['1B', '2F'], venueUnclear: false }],
  [timed({ id: 'k', summary: '1st meeting 1Bar', colorId: '9' }), { venues: ['2F'], venueDefaulted: true }],
  [{ id: 'l', summary: 'Open day', colorId: '9', location: '2/F', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }, { allDay: true, date: '2026-10-24', endDate: '2026-10-24', startTime: '' }],
  [{ id: 'm', summary: 'Retreat', colorId: '9', start: { date: '2026-10-24' }, end: { date: '2026-10-27' } }, { endDate: '2026-10-26' }],
  [{ id: 'n', summary: 'Late', colorId: '9', start: { dateTime: '2026-10-24T21:00:00+08:00' }, end: { dateTime: '2026-10-25T00:00:00+08:00' } }, { date: '2026-10-24', endDate: '2026-10-24', endTime: '23:59' }],
  [{ id: 'o', status: 'cancelled', start: { dateTime: '2026-10-24T21:00:00+08:00' } }, null],
];
for (const [input, expected] of cases) {
  const out = mapEvent(input, CONFIG);
  if (expected === null) { assert.strictEqual(out, null, input.id); continue; }
  for (const k of Object.keys(expected)) assert.deepStrictEqual(plain(out[k]), expected[k], `${input.id}.${k}: got ${JSON.stringify(out[k])}`);
}
assert.deepStrictEqual(plain(detectVenues('', '1 樓 Hall', CONFIG)), { venues: ['1B'], unclear: false, defaulted: false });
console.log('read checks passed:', cases.length + 1);

// ---- 寫入：網站表單 → Google 活動內容 ----
const base = { title: '  色彩工作坊 ', date: '2026-11-02', startTime: '19:00', endTime: '21:00', type: 'Course', venues: ['1S'] };
let r = buildEventResource(base, CONFIG, null, false);
assert.strictEqual(r.summary, '色彩工作坊');
assert.strictEqual(r.colorId, '5');
assert.strictEqual(r.location, 'White Club 1S');
assert.strictEqual(r.start.dateTime, '2026-11-02T19:00:00');
assert.strictEqual(r.start.timeZone, 'Asia/Hong_Kong');
assert.strictEqual(r.recurrence, undefined);
r = buildEventResource({ ...base, repeatWeeks: 6 }, CONFIG, null, false);
assert.deepStrictEqual(plain(r.recurrence), ['RRULE:FREQ=WEEKLY;COUNT=6']);
r = buildEventResource({ ...base, allDay: true, venues: ['2F', '1B'], type: 'Visit' }, CONFIG, null, false);
assert.strictEqual(r.start.date, '2026-11-02'); assert.strictEqual(r.end.date, '2026-11-03'); assert.strictEqual(r.start.dateTime, null);
assert.strictEqual(r.location, 'White Club 1B + 2/F'); assert.strictEqual(r.colorId, '1');
// 修改：場地不變 → 保留原有地點文字；重複只在新增時加入
r = buildEventResource({ ...base, repeatWeeks: 4 }, CONFIG, { summary: 'x', location: 'Mirror Room (1S) 請用後門' }, false);
assert.strictEqual(r.location, undefined); assert.strictEqual(r.recurrence, undefined);
// 原本只寫 1/F 或沒寫 → 一定寫入清楚的場地
r = buildEventResource({ ...base, venues: ['1S', '1B'] }, CONFIG, { summary: 'x', location: '1/F' }, false);
assert.strictEqual(r.location, 'White Club 1S + 1B');
r = buildEventResource({ ...base, venues: ['2F'] }, CONFIG, { summary: 'x', location: '' }, false);
assert.strictEqual(r.location, 'White Club 2/F');
r = buildEventResource({ ...base, venues: ['2F'] }, CONFIG, { summary: 'x', location: 'White Club 1S' }, true);
assert.deepStrictEqual(Object.keys(r).sort(), ['colorId', 'location', 'summary']);
throws(() => buildEventResource({ ...base, title: ' ' }, CONFIG, null, false), /標題/);
assert.strictEqual(buildEventResource({ ...base, type: 'Other' }, CONFIG, null, false).colorId, null);
throws(() => buildEventResource({ ...base, type: 'NotAType' }, CONFIG, null, false), /類型/);
throws(() => buildEventResource({ ...base, venues: [] }, CONFIG, null, false), /場地/);
throws(() => buildEventResource({ ...base, venues: ['3F'] }, CONFIG, null, false), /場地/);
throws(() => buildEventResource({ ...base, endTime: '18:00' }, CONFIG, null, false), /結束時間/);
throws(() => buildEventResource({ ...base, repeatWeeks: 60 }, CONFIG, null, false), /52/);

// ---- 登入驗證 ----
assert.strictEqual(checkEditor(200, { users: [{ email: 'Community@WhiteClub.co', emailVerified: true }] }, CONFIG), 'community@whiteclub.co');
throws(() => checkEditor(200, { users: [{ email: 'someone@gmail.com', emailVerified: true }] }, CONFIG), /沒有修改權限/);
throws(() => checkEditor(400, { error: { message: 'INVALID_ID_TOKEN' } }, CONFIG), /登入已過期/);
throws(() => checkEditor(403, { error: { message: 'Requests from referer <empty> are blocked.' } }, CONFIG), /金鑰/);
console.log('write + login checks passed');
