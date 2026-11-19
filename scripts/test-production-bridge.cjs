// Offline production-contract regression tests. No connector, network, or real Calendar writes.
// node scripts/test-production-bridge.cjs [Code.gs] [actual exported Code.before.gs]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const bridgePath = process.argv[2] || path.join(__dirname, '..', 'apps-script', 'Code.gs');
const baselinePath = process.argv[3] || process.env.WHITECLUB_PRODUCTION_BASELINE || path.join(__dirname, '..', 'apps-script', 'archive', 'Code.whiteclub-v3.before-2026-11-18.gs');
const source = fs.readFileSync(bridgePath, 'utf8');
const baseline = fs.readFileSync(baselinePath, 'utf8');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (err) { console.error('FAIL ' + name); throw err; }
}
function throws(fn, pattern, conflict) {
  assert.throws(fn, err => pattern.test(err.message) && (conflict === undefined || !!err.conflict === conflict));
}
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object') {
        Object.defineProperty(target, key, { value: {}, writable: true, enumerable: true, configurable: true });
      }
      merge(target[key], value);
    } else Object.defineProperty(target, key, { value: plain(value), writable: true, enumerable: true, configurable: true });
  }
  return target;
}
function event(id = 'original', extra = {}) {
  return {
    id, status: 'confirmed', summary: '原活動', colorId: '9',
    description: 'PRIVATE: 原有說明\n第二行', location: 'Mirror Room (1S) 請用後門',
    updated: 'v1', start: { dateTime: '2026-12-01T10:00:00+08:00' },
    end: { dateTime: '2026-12-01T11:00:00+08:00' },
    attendees: [{ email: 'private@example.com' }],
    extendedProperties: { private: { unrelated: 'PRIVATE: keep-me' }, public: { external: 'keep-public' } },
    ...extra,
  };
}
function seriesEvent(id, date, color, title, no, custom) {
  const e = event(id, {
    summary: custom || `${title} (第 ${no} 堂)`,
    start: { dateTime: `${date}T10:00:00+08:00` }, end: { dateTime: `${date}T11:00:00+08:00` },
    extendedProperties: { private: { wcSeries: 'wc-mixed', wcSeriesTitle: title, wcSessionNo: String(no), unrelated: 'PRIVATE: ' + id } },
    description: 'PRIVATE: notes-' + id,
  });
  if (color === undefined) delete e.colorId; else e.colorId = color;
  if (custom) e.extendedProperties.private.wcSessionTitle = custom;
  return e;
}
const row = (date = '2026-12-01', extra = {}) => ({ date, startTime: '10:00', endTime: '11:00', ...extra });
const body = extra => ({ title: '共同課程', type: 'Course', venues: ['1S'], allDay: false, ...extra });
const convertBody = extra => body({ action: 'convertToSeries', id: 'original', expectedUpdated: 'v1', preserveTypes: true, sessions: [row()], ...extra });
function harness(initial = [], controls = {}) {
  const db = new Map(initial.map(e => [e.id, plain(e)]));
  const calls = [], auth = [], cache = {}, locks = [];
  let serial = 0, revision = 0, uuid = 0, insertAttempt = 0;
  function call(op, id, resource) { calls.push({ op, id, resource: plain(resource) }); }
  const Events = {
    get(cal, id) {
      assert.equal(cal, 'primary');
      if (controls.onGet) controls.onGet(id, db, calls);
      if (!db.has(id)) { const e = new Error('404 Not Found'); e.code = 404; throw e; }
      return plain(db.get(id));
    },
    list(cal, options) {
      if (cal !== 'primary') return { items: [] };
      let items = [...db.values()].filter(e => e.status !== 'cancelled');
      if (options.privateExtendedProperty) {
        const [key, value] = options.privateExtendedProperty.split('=');
        items = items.filter(e => e.extendedProperties?.private?.[key] === value);
      }
      if (options.timeMin) items = items.filter(e => (e.start?.dateTime || e.start?.date || '') >= options.timeMin);
      if (options.timeMax) items = items.filter(e => (e.start?.dateTime || e.start?.date || '') <= options.timeMax);
      items = plain(items);
      if (controls.duplicateList && items.length) items.push(plain(items[0]));
      return { items };
    },
    instances(cal, seriesId) {
      assert.equal(cal, 'primary');
      return { items: plain([...db.values()].filter(e => e.recurringEventId === seriesId)) };
    },
    insert(resource, cal) {
      assert.equal(cal, 'primary'); assert.equal(resource.id, undefined);
      insertAttempt++; call('insert', null, resource);
      if (controls.failInsertAt === insertAttempt) throw new Error('injected insert failure');
      let id; do { id = 'new-' + (++serial); } while (db.has(id));
      const inserted = merge({ id, status: 'confirmed', updated: 'new-v' + (++revision) }, plain(resource));
      db.set(id, inserted);
      return plain(inserted);
    },
    patch(resource, cal, id) {
      assert.equal(cal, 'primary'); call('patch', id, resource);
      if (controls.failPatchId === id) throw new Error('injected patch failure');
      if (!db.has(id)) throw new Error('404 Not Found');
      const result = merge(db.get(id), plain(resource)); result.updated = 'patch-v' + (++revision);
      return plain(result);
    },
    remove(cal, id) {
      assert.equal(cal, 'primary'); call('remove', id);
      if (controls.failRemoveId === id) throw new Error('injected cleanup failure');
      db.delete(id);
    },
  };
  const lock = {
    waitLock(ms) { locks.push(['wait', ms]); if (controls.failLock) throw new Error('lock timeout'); this.held = true; },
    hasLock() { return !!this.held; },
    releaseLock() { locks.push(['release']); this.held = false; },
  };
  const ctx = {
    console: { log() {}, warn() {} }, module: { exports: {} }, Calendar: { Events },
    Utilities: { getUuid: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    CacheService: { getScriptCache: () => ({
      get: key => cache[key] || null,
      getAll: keys => Object.fromEntries(keys.filter(k => k in cache).map(k => [k, cache[k]])),
      putAll: values => Object.assign(cache, values), remove: key => { delete cache[key]; },
    }) },
    LockService: { getScriptLock: () => lock },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType(type) { this.mimeType = type; return this; } }) },
    UrlFetchApp: { fetch(url, options) {
      auth.push({ url, options: plain(options) });
      const token = JSON.parse(options.payload).idToken;
      const status = token === 'expired' ? 400 : 200;
      const result = token === 'expired' ? { error: { message: 'TOKEN_EXPIRED' } } : {
        users: [{ email: token === 'outsider' ? 'other@example.com' : 'Community@WhiteClub.co', emailVerified: token !== 'unverified' }],
      };
      return { getContentText: () => JSON.stringify(result), getResponseCode: () => status };
    } },
    Logger: { log() {} },
  };
  vm.createContext(ctx); vm.runInContext(source, ctx, { filename: bridgePath });
  return {
    ctx, db, calls, auth, cache, locks, controls,
    run: request => plain(ctx.handleWrite_(plain(request))),
    post: request => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(request) } }).text),
    get: refresh => JSON.parse(ctx.doGet({ parameter: { refresh: refresh ? '1' : '0' } }).text),
  };
}
function unchanged(h, before) { assert.deepStrictEqual([...h.db.values()], before); assert.equal(h.calls.length, 0, 'must make zero write attempts'); }

// The source-of-truth comparison is against the actual exported production script, not a recovery file.
test('actual production CONFIG byte-for-byte invariance and verifyEditor/checkEditor unchanged', () => {
  const block = s => s.slice(s.indexOf('var CONFIG = {'), s.indexOf('\n};', s.indexOf('var CONFIG = {')) + 3);
  assert.equal(block(source), block(baseline));
  const authBlock = s => s.slice(s.indexOf('function verifyEditor_('), s.indexOf('// 在編輯器按'));
  assert.equal(authBlock(source), authBlock(baseline));
  const h = harness();
  assert.equal(h.ctx.CONFIG.CALENDAR_ID, 'primary');
  assert.deepStrictEqual(plain(h.ctx.CONFIG.ALLOWED_EDITORS), ['community@whiteclub.co']);
  assert(h.ctx.CONFIG.TYPES.some(t => t.key === 'Misc' && t.colorIds[0] === '2'));
  assert.equal(h.ctx.CONFIG.TITLE_OVERRIDES[0].type, 'Misc');
});

test('legacy single create/get/delete and legacy repeatWeeks remain compatible', () => {
  const h = harness();
  const one = h.run(body({ action: 'create', date: '2026-12-01', startTime: '10:00', endTime: '11:00', remark: 'PRIVATE: note' }));
  assert.equal(one.event.title, '共同課程'); assert.equal(one.event.seriesId, null); assert.equal(one.event.colorId, '5');
  assert.deepStrictEqual(h.run({ action: 'get', id: one.event.id }), { ok: true, remark: 'PRIVATE: note' });
  assert.equal(h.run({ action: 'delete', id: one.event.id, expectedUpdated: one.event.updated }).ok, true);
  const repeated = h.run(body({ action: 'create', repeatWeeks: 3, sessions: [row()] }));
  assert.deepStrictEqual(h.db.get(repeated.event.id).recurrence, ['RRULE:FREQ=WEEKLY;COUNT=3']);
});

test('legacy multi create sorts dates, generates names and original Course color', () => {
  const h = harness(); const result = h.run(body({ action: 'create', sessions: [row('2026-12-03'), row('2026-12-01')] }));
  assert.equal(result.count, 2); assert(result.seriesId.startsWith('wc-'));
  assert.deepStrictEqual([...h.db.values()].map(e => e.summary), ['共同課程 (第 1 堂)', '共同課程 (第 2 堂)']);
  assert([...h.db.values()].every(e => e.colorId === '5' && e.extendedProperties.private.wcSeries === result.seriesId));
});

test('doPost auth retained: token required, email allowlist/verified/expiry enforced; get is private', () => {
  const h = harness([event()]);
  for (const token of [undefined, 'outsider', 'unverified', 'expired']) {
    const result = h.post({ action: 'get', id: 'original', idToken: token });
    assert.equal(result.ok, false); assert.equal(result.remark, undefined);
  }
  assert.deepStrictEqual(h.post({ action: 'get', id: 'original', idToken: 'editor' }), { ok: true, remark: event().description });
  assert.equal(h.calls.length, 0); assert.equal(h.locks.length, 0);
  assert(h.auth.every(a => a.url.endsWith(encodeURIComponent(h.ctx.CONFIG.FIREBASE_WEB_API_KEY))));
  assert(h.auth.every(a => a.options.method === 'post' && a.options.muteHttpExceptions === true));
});

test('mutating doPost locks after auth, releases after success/failure, invalidates cache', () => {
  const h = harness(); h.cache.feed_parts = '1';
  assert.equal(h.post(body({ action: 'create', idToken: 'editor', sessions: [row()] })).ok, true);
  assert.equal(h.cache.feed_parts, undefined);
  assert.deepStrictEqual(h.locks, [['wait', 30000], ['release']]);
  assert.equal(h.post(body({ action: 'create', idToken: 'editor', sessions: [row('', { endTime: '99:00' })] })).ok, false);
  assert.deepStrictEqual(h.locks.slice(2), [['wait', 30000], ['release']]);
  const denied = harness(); denied.post(body({ action: 'create', idToken: 'outsider', sessions: [row()] }));
  assert.equal(denied.locks.length, 0); assert.equal(denied.calls.length, 0);
  const busy = harness([], { failLock: true });
  assert.equal(busy.post(body({ action: 'create', idToken: 'editor', sessions: [row()] })).ok, false);
  assert.equal(busy.calls.length, 0);
});

test('custom titles exact, blank auto names, single custom metadata without a series', () => {
  const h = harness();
  const single = h.run(body({ action: 'create', sessions: [row('2026-12-01', { title: '  第一課：特別名稱  ' })] }));
  assert.equal(single.event.title, '  第一課：特別名稱  '); assert.equal(single.event.sessionTitle, single.event.title);
  assert.equal(single.event.seriesTitle, '共同課程'); assert.equal(single.event.sessionNo, 1); assert.equal(single.event.seriesId, null);
  const result = h.run(body({ action: 'create', sessions: [row('2026-12-01', { title: '堂名 A' }), row('2026-12-02', { title: '   ' }), row('2026-12-03')] }));
  const lessons = [...h.db.values()].filter(e => e.extendedProperties.private.wcSeries === result.seriesId);
  assert.deepStrictEqual(lessons.map(e => e.summary), ['堂名 A', '共同課程 (第 2 堂)', '共同課程 (第 3 堂)']);
  assert.equal(lessons[1].extendedProperties.private.wcSessionTitle, undefined);
});

test('public feed declares capability/version, roundtrips only safe metadata and hasRemark bool; cached doGet compatible', () => {
  const h = harness([seriesEvent('safe', '2026-12-01', '9', '共同課程', 2, '自訂堂名')]);
  const feed = h.get(true);
  assert.equal(feed.bridgeVersion, '2026-11-18-ilab-v1');
  assert.deepStrictEqual(feed.capabilities, { sessionTitles: true, convertToSeries: true, saveSeries: true, privateRemarks: true, typeOnly: true, sessionRemarks: true, courseNaming: true, courseOfferings: true });
  const e = feed.events[0];
  assert.equal(e.seriesTitle, '共同課程'); assert.equal(e.sessionTitle, '自訂堂名'); assert.equal(e.sessionNo, 2);
  assert.equal(e.hasRemark, true); assert.equal(typeof e.hasRemark, 'boolean');
  for (const key of ['remark', 'remarks', 'description', 'attendees', 'extendedProperties']) assert.equal(Object.hasOwn(e, key), false);
  assert(!JSON.stringify(feed).includes('PRIVATE:')); assert(!JSON.stringify(feed).includes('private@example.com'));
  assert.deepStrictEqual(h.get(false), feed);
});

test('native recurring grouping beats wcSeries and legacy title grouping, listSeries deduplicates IDs', () => {
  const a = seriesEvent('instance', '2026-12-01', '9', '共同課程', 1);
  a.recurringEventId = 'native'; a.extendedProperties.private.wcSeries = 'native';
  const h = harness([a], { duplicateList: true });
  assert.equal(h.ctx.mapEvent(a, h.ctx.CONFIG).seriesId, 'native');
  assert.equal(h.ctx.listSeries_('native').length, 1);
  assert.equal(h.ctx.listSeries_('wc-mixed').length, 0);
  h.run(body({ action: 'saveSeries', seriesId: 'native', preserveTypes: true, sessions: [{ id: 'instance', ...row() }] }));
  assert.equal(h.calls.filter(c => c.op === 'patch').length, 1);
});

for (const count of [1, 3]) test(`convert ${count} lessons retains original ID, sorted first, unique children, notes/location/color/private props`, () => {
  const h = harness([event(), event('unrelated')]);
  const sessions = count === 1 ? [row()] : [row('2026-12-03', { title: '尾堂' }), row('2026-12-01'), row('2026-12-02', { title: '自訂中堂' })];
  const result = h.run(convertBody({ type: 'Other', sessions }));
  const lessons = [...h.db.values()].filter(e => e.extendedProperties.private.wcSeries === result.seriesId);
  assert.equal(result.event.id, 'original'); assert.equal(lessons.length, count); assert.equal(result.count, count);
  assert.equal(new Set(lessons.map(e => e.id)).size, count);
  assert.equal(h.db.get('original').start.dateTime.slice(0, 10), '2026-12-01');
  assert(h.db.has('unrelated')); assert(!h.calls.some(c => c.op === 'remove'));
  assert(lessons.every(e => e.colorId === '9' && e.description === event().description && e.location === event().location));
  assert(lessons.every(e => e.extendedProperties.private.unrelated === 'PRIVATE: keep-me'));
  assert.equal(h.calls.at(-1).op, 'patch'); assert.equal(h.calls.at(-1).id, 'original');
  assert.deepStrictEqual(h.db.get('original').attendees, event().attendees);
  assert(lessons.filter(e => e.id !== 'original').every(e => !e.attendees));
  if (count === 3) assert.equal(h.db.get('original').summary, '共同課程 (第 1 堂)');
});

test('convert explicit remark applied to all; unknown/no-color source never coerced; all-day dates supported', () => {
  for (const color of ['11', undefined]) {
    const original = event(); if (color === undefined) delete original.colorId; else original.colorId = color;
    const h = harness([original]);
    const r = h.run(convertBody({ type: undefined, allDay: true, remark: '', sessions: [row(), row('2026-12-02')] }));
    assert.equal(r.count, 2);
    for (const e of h.db.values()) { assert.equal(e.colorId, color); assert.equal(e.description, ''); assert.equal(e.start.dateTime, undefined); assert(e.start.date); }
  }
});

test('preserveTypes retains unchanged unrecognized/blank location; explicitly changed venues use new location', () => {
  for (const location of ['', '場地待確認：由職員安排']) {
    const original = event('original', { location });
    original.extendedProperties.private = JSON.parse('{"unrelated":"keep","__proto__":"keep-special-key"}');
    const h = harness([original]);
    h.run(convertBody({ venues: ['2F'], sessions: [row(), row('2026-12-02')] }));
    for (const e of h.db.values()) {
      assert.equal(e.location, location);
      assert.equal(e.extendedProperties.private['__proto__'], 'keep-special-key');
    }
  }
  const h = harness([event()]);
  h.run(convertBody({ venues: ['1B'], sessions: [row(), row('2026-12-02')] }));
  assert([...h.db.values()].every(e => e.location === 'White Club 1B'));
});

const invalidSources = [
  ['missing', [], {}, /刪除/],
  ['cancelled', [event('original', { status: 'cancelled' })], {}, /刪除/],
  ['stale', [event()], { expectedUpdated: 'old' }, /修改/],
  ['native instance', [event('original', { recurringEventId: 'native' })], {}, /課程或重複/],
  ['native master', [event('original', { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] })], {}, /課程或重複/],
  ['already tagged', [seriesEvent('original', '2026-12-01', '9', '原活動', 1)], {}, /課程或重複/],
  ['legacy title series', [event('original', { summary: '原活動 (第 1 堂)' })], {}, /課程或重複/],
];
for (const [name, events, extra, pattern] of invalidSources) test('convert ' + name + ' rejects before any writes', () => {
  const h = harness(events); const before = plain([...h.db.values()]);
  throws(() => h.run(convertBody(extra)), pattern, true); unchanged(h, before);
});
const invalidInputs = [
  ['empty lessons', { sessions: [] }, /最少/],
  ['61 lessons', { sessions: Array.from({ length: 61 }, () => row()) }, /60/],
  ['invalid child date', { sessions: [row(), row('2026-02-30')] }, /日期/],
  ['invalid child hour', { sessions: [row(), row('2026-12-02', { startTime: '25:00', endTime: '26:00' })] }, /時間/],
  ['invalid child minute', { sessions: [row(), row('2026-12-02', { startTime: '10:90' })] }, /時間/],
  ['invalid child range', { sessions: [row(), row('2026-12-02', { endTime: '09:00' })] }, /結束時間/],
  ['invalid child title', { sessions: [row(), row('2026-12-02', { title: 123 })] }, /標題/],
  ['missing common title', { title: ' ', sessions: [row('2026-12-01', { title: 'custom' })] }, /標題/],
  ['generated title too long', { title: 'x'.repeat(1024) }, /標題太長/],
  ['invalid venue', { venues: ['1S', 'foreign'] }, /場地/],
  ['invalid remark', { remark: 123 }, /備註/],
  ['long remark', { remark: 'x'.repeat(8001) }, /8000/],
  ['invalid allDay', { allDay: 'false' }, /全日/],
  ['missing source version', { expectedUpdated: undefined }, /版本/],
  ['child supplied ID', { sessions: [row('2026-12-01', { id: 'unrelated' })] }, /ID/],
];
for (const [name, extra, pattern] of invalidInputs) test('convert ' + name + ' rejects before any writes', () => {
  const h = harness([event()]); const before = plain([...h.db.values()]);
  throws(() => h.run(convertBody(extra)), pattern); unchanged(h, before);
});

test('convert retry of successful conversion rejects before new children', () => {
  const h = harness([event()]); h.run(convertBody({ sessions: [row(), row('2026-12-02')] }));
  h.calls.length = 0;
  throws(() => h.run(convertBody({ expectedUpdated: h.db.get('original').updated })), /課程或重複/, true);
  assert.equal(h.calls.length, 0); assert.equal(h.db.size, 2);
});

for (const controls of [{ failInsertAt: 2 }, { failPatchId: 'original' }]) test('convert failure rolls back only inserted children: ' + JSON.stringify(controls), () => {
  const h = harness([event(), event('unrelated')], controls); const before = plain([...h.db.values()]);
  throws(() => h.run(convertBody({ sessions: [row(), row('2026-12-02'), row('2026-12-03')] })), /injected/);
  assert.deepStrictEqual([...h.db.values()], before);
  const removed = h.calls.filter(c => c.op === 'remove').map(c => c.id);
  assert.deepStrictEqual(removed, controls.failInsertAt ? ['new-1'] : ['new-1', 'new-2']);
  assert(!removed.includes('original') && !removed.includes('unrelated'));
});

test('convert rechecks source version after child inserts; external edit retained, children cleaned', () => {
  const h = harness([event(), event('unrelated')], {
    onGet(id, db, calls) { if (id === 'original' && calls.some(c => c.op === 'insert')) { db.get(id).updated = 'external-edit'; db.get(id).summary = '外部更改'; } },
  });
  throws(() => h.run(convertBody({ sessions: [row(), row('2026-12-02')] })), /修改/, true);
  assert.equal(h.db.get('original').summary, '外部更改'); assert.equal(h.db.size, 2);
  assert.equal(h.calls.filter(c => c.op === 'patch').length, 0);
  assert.deepStrictEqual(h.calls.filter(c => c.op === 'remove').map(c => c.id), ['new-1']);
});

test('convert rollback is best effort and reports failed child cleanup, never deletes original', () => {
  const h = harness([event()], { failPatchId: 'original', failRemoveId: 'new-1' });
  throws(() => h.run(convertBody({ sessions: [row(), row('2026-12-02')] })), /部分新增堂數未能清理/);
  assert(h.db.has('original')); assert(h.db.has('new-1'));
  assert.equal(h.db.get('original').updated, 'v1');
});

test('update preserveTypes retains original 9/11/2/no-color including Other, descriptions and unknown props', () => {
  for (const color of ['9', '11', '2', undefined]) {
    const original = event(); if (color === undefined) delete original.colorId; else original.colorId = color;
    const h = harness([original]);
    h.run(body({ action: 'update', id: 'original', ...row(), type: 'Other', preserveTypes: true, expectedUpdated: 'v1' }));
    const e = h.db.get('original'); assert.equal(e.colorId, color); assert.equal(e.description, original.description);
    assert.deepStrictEqual(e.extendedProperties, original.extendedProperties);
  }
  const h = harness([event()]); h.run(body({ action: 'update', id: 'original', ...row(), type: 'Visit' }));
  assert.equal(h.db.get('original').colorId, '1', 'old clients still change type');
});

test('update changed series title creates only wcSessionTitle; unchanged generated title not promoted', () => {
  const e = seriesEvent('original', '2026-12-01', '9', '共同課程', 1);
  const h = harness([e]);
  h.run(body({ action: 'update', id: 'original', ...row(), title: e.summary, preserveTypes: true }));
  assert.equal(h.db.get('original').extendedProperties.private.wcSessionTitle, undefined);
  h.run(body({ action: 'update', id: 'original', ...row(), title: '新堂名', preserveTypes: true }));
  const props = h.db.get('original').extendedProperties.private;
  assert.equal(props.wcSessionTitle, '新堂名'); assert.equal(props.wcSeriesTitle, '共同課程');
  assert.equal(props.unrelated, 'PRIVATE: original');
});

test('update keeps existing common series title byte-exact even if it contains surrounding whitespace', () => {
  const e = seriesEvent('original', '2026-12-01', '9', '共同課程', 1);
  e.extendedProperties.private.wcSeriesTitle = '  共同課程  ';
  const h = harness([e]);
  h.run(body({ action: 'update', id: 'original', ...row(), title: '更改這堂', preserveTypes: true }));
  assert.equal(h.db.get('original').extendedProperties.private.wcSeriesTitle, '  共同課程  ');
});

function mixed() {
  return [
    seriesEvent('a', '2026-12-01', '9', '舊共同課程', 1, '特別 A'),
    seriesEvent('b', '2026-12-02', '11', '舊共同課程', 2),
    seriesEvent('d', '2026-12-04', '2', '舊共同課程', 3),
    seriesEvent('unseen', '2030-01-01', undefined, '舊共同課程', 4, '遠期特別堂'),
    event('foreign'),
  ];
}
const saveBody = extra => body({
  action: 'saveSeries', seriesId: 'wc-mixed', title: '新共同課程', type: 'Other', preserveTypes: true,
  sessions: [{ id: 'a', ...row() }, { id: 'b', ...row('2026-12-02', { title: '' }) }, row('2026-12-03', { title: '新增自訂堂' })],
  deletedIds: ['d'], expectedUpdates: { a: 'v1', b: 'v1', d: 'v1', unseen: 'v1' }, ...extra,
});

test('saveSeries mixed colors/custom/unseen lessons preserved; new inherits first color; only explicit deletion last', () => {
  const h = harness(mixed()); const unseen = plain(h.db.get('unseen'));
  const result = h.run(saveBody()); assert.equal(result.count, 4);
  assert.equal(h.db.get('a').summary, '特別 A'); assert.equal(h.db.get('a').colorId, '9');
  assert.equal(h.db.get('b').summary, '新共同課程 (第 2 堂)'); assert.equal(h.db.get('b').colorId, '11');
  assert.equal(h.db.get('unseen').summary, '遠期特別堂'); assert.equal(h.db.get('unseen').colorId, undefined);
  assert.deepStrictEqual(h.db.get('unseen').start, unseen.start); assert.deepStrictEqual(h.db.get('unseen').end, unseen.end);
  assert.equal(h.db.get('unseen').extendedProperties.private.wcSeriesTitle, '新共同課程');
  assert.equal(h.db.get('unseen').extendedProperties.private.wcSessionNo, '4');
  assert.equal(h.db.get('new-1').summary, '新增自訂堂'); assert.equal(h.db.get('new-1').colorId, '9');
  for (const id of ['a', 'b', 'unseen']) {
    assert.equal(h.db.get(id).description, 'PRIVATE: notes-' + id);
    assert.equal(h.db.get(id).extendedProperties.private.unrelated, 'PRIVATE: ' + id);
  }
  assert(h.db.has('foreign')); assert(!h.db.has('d'));
  assert.deepStrictEqual(h.calls.filter(c => c.op === 'remove').map(c => c.id), ['d']); assert.equal(h.calls.at(-1).op, 'remove');
});

test('saveSeries explicit blank resets custom tag, absent title from old client preserves custom name', () => {
  const h = harness(mixed());
  h.run(saveBody({ sessions: [{ id: 'a', ...row(), title: '' }], deletedIds: [] }));
  assert.equal(h.db.get('a').summary, '新共同課程 (第 1 堂)');
  assert.equal(h.db.get('a').extendedProperties.private.wcSessionTitle, undefined);
  const h2 = harness(mixed());
  h2.run(saveBody({ preserveTypes: undefined, type: 'Course', sessions: [{ id: 'a', ...row() }], deletedIds: [] }));
  assert.equal(h2.db.get('a').summary, '特別 A'); assert.equal(h2.db.get('unseen').summary, '遠期特別堂');
  assert.equal(h2.db.get('a').colorId, '5', 'legacy type behavior retained');
});

test('saveSeries keeps unsubmitted lessons even beyond old legacy 400-day window, converts legacy tags', () => {
  const distant = event('old-distant', { summary: '舊課程 (第 2 堂)', start: { dateTime: '2030-01-01T10:00:00+08:00' }, end: { dateTime: '2030-01-01T11:00:00+08:00' } });
  const h = harness([event('old', { summary: '舊課程 (第 1 堂)' }), distant]);
  const result = h.run(body({ action: 'saveSeries', seriesId: 'title:舊課程', preserveTypes: true, sessions: [{ id: 'old', ...row() }] }));
  assert.equal(result.count, 2); assert(result.seriesId.startsWith('wc-'));
  assert.deepStrictEqual(h.db.get('old-distant').start, distant.start); assert.equal(h.db.get('old-distant').extendedProperties.private.wcSeries, result.seriesId);
});

const invalidSaves = [
  ['foreign submitted ID', { sessions: [{ id: 'foreign', ...row() }] }, /不屬於/],
  ['missing submitted ID', { sessions: [{ id: 'missing', ...row() }] }, /不屬於/],
  ['foreign deleted ID', { deletedIds: ['foreign'] }, /不屬於/],
  ['missing deleted ID', { deletedIds: ['missing'] }, /不屬於/],
  ['duplicate submitted ID', { sessions: [{ id: 'a', ...row() }, { id: 'a', ...row() }] }, /重複/],
  ['duplicate delete ID', { deletedIds: ['d', 'd'] }, /重複/],
  ['submitted and deleted ID', { deletedIds: ['a'] }, /同時/],
  ['foreign expected version ID', { expectedUpdates: { foreign: 'v1' } }, /不屬於/],
  ['stale submitted version', { expectedUpdates: { a: 'old' } }, /修改/],
  ['stale deleted version', { expectedUpdates: { d: 'old' } }, /修改/],
  ['stale unseen version', { expectedUpdates: { unseen: 'old' } }, /修改/],
  ['invalid child date', { sessions: [{ id: 'a', ...row() }, row('2026-02-30')] }, /日期/],
  ['invalid child time', { sessions: [{ id: 'a', ...row() }, row('2026-12-02', { endTime: '10:00' })] }, /結束時間/],
  ['invalid child title', { sessions: [{ id: 'a', ...row() }, row('2026-12-02', { title: false })] }, /標題/],
  ['61 submitted rows', { sessions: Array.from({ length: 61 }, () => row()) }, /60/],
  ['final count exceeds 60', { sessions: Array.from({ length: 58 }, () => row()), deletedIds: [] }, /60/],
  ['delete all lessons', { sessions: [], deletedIds: ['a', 'b', 'd', 'unseen'] }, /最少/],
  ['common title missing', { title: ' ' }, /標題/],
  ['bad venue', { venues: ['3F'] }, /場地/],
];
for (const [name, extra, pattern] of invalidSaves) test('saveSeries ' + name + ' rejected with zero writes', () => {
  const h = harness(mixed()); const before = plain([...h.db.values()]);
  throws(() => h.run(saveBody(extra)), pattern); unchanged(h, before);
});

test('saveSeries deleted known event is re-read for expectedUpdates before any writes', () => {
  const h = harness(mixed(), { onGet(id, db) { if (id === 'd') db.get(id).status = 'cancelled'; } });
  throws(() => h.run(saveBody()), /刪除/, true); assert.equal(h.calls.length, 0);
});

test('saveSeries API patch failure does not perform pending deletions (multiwrite is not atomic)', () => {
  const h = harness(mixed(), { failPatchId: 'b' });
  throws(() => h.run(saveBody()), /injected patch failure/);
  assert.equal(h.calls.filter(c => c.op === 'remove').length, 0); assert(h.db.has('d'));
  assert.equal(h.db.get('a').extendedProperties.private.wcSeriesTitle, '新共同課程', 'prior patch may already have succeeded');
});

test('create validates every child before any insert', () => {
  for (const extra of [{ sessions: [row(), row('2026-12-02', { title: 3 })] }, { sessions: [row(), row('2026-02-30')] }, { sessions: [] }]) {
    const h = harness(); throws(() => h.run(body({ action: 'create', ...extra })), /標題|日期|最少/); assert.equal(h.calls.length, 0);
  }
});

console.log(`\nAll ${passed} offline production-bridge checks passed.`);
console.log('Bridge: ' + bridgePath);
console.log('Exact production baseline: ' + baselinePath);
console.log('Calendar/Utilities/Cache/Lock/ContentService/UrlFetchApp are VM mocks only; no actual service writes.');
