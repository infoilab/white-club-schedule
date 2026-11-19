#!/usr/bin/env node
'use strict';
// Offline VM only. No browser, credentials, connector, or real Calendar/API calls.
// Run: node scripts/test-lesson-fields.cjs [apps-script/Code.gs]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bridgePath = process.argv[2] || path.join(__dirname, '..', 'apps-script', 'Code.gs');
const source = fs.readFileSync(bridgePath, 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object') {
        Object.defineProperty(target, key, { value: {}, writable: true, enumerable: true, configurable: true });
      }
      merge(target[key], value);
    } else Object.defineProperty(target, key, { value: clone(value), writable: true, enumerable: true, configurable: true });
  }
  return target;
}
function event(id = 'original', extra = {}) {
  return {
    id, status: 'confirmed', summary: '原活動', updated: 'v1', colorId: '9',
    location: 'Mirror Room (1S) 請用後門', description: 'PRIVATE: 原有說明\n第二行',
    start: { dateTime: '2026-12-01T10:00:00+08:00' }, end: { dateTime: '2026-12-01T11:00:00+08:00' },
    attendees: [{ email: 'private@example.invalid' }],
    extendedProperties: { private: { unrelated: 'PRIVATE: keep-me' }, public: { keepPublic: 'unchanged' } },
    ...extra,
  };
}
const row = (date = '2026-12-01', extra = {}) => ({ date, startTime: '10:00', endTime: '11:00', ...extra });
const body = extra => ({ title: 'CS course', type: 'Course', venues: ['1S'], allDay: false, ...extra });
function lesson(id, date, no, extra = {}) {
  const e = event(id, {
    summary: 'CS course L' + no, description: 'PRIVATE: notes-' + id,
    start: { dateTime: date + 'T10:00:00+08:00' }, end: { dateTime: date + 'T11:00:00+08:00' },
    extendedProperties: { private: { wcSeries: 'wc-lessons', wcSeriesTitle: 'CS course', wcSessionNo: String(no), wcSessionAutoTitle: '1', unrelated: 'PRIVATE: ' + id }, public: { keepPublic: 'unchanged' } },
    ...extra,
  });
  return e;
}
const props = e => e.extendedProperties?.private || {};
const ordered = h => [...h.db.values()].sort((a, b) => (a.start.dateTime || a.start.date).localeCompare(b.start.dateTime || b.start.date));
function harness(initial = [], controls = {}) {
  const db = new Map(initial.map(e => [e.id, clone(e)]));
  const writes = [];
  let serial = 0, revision = 0, uuid = 0;
  const Events = {
    get(calendar, id) {
      assert.equal(calendar, 'primary');
      if (controls.onGet) controls.onGet(id, db, writes);
      if (!db.has(id)) { const error = new Error('404 Not Found'); error.code = 404; throw error; }
      return clone(db.get(id));
    },
    list(calendar, options) {
      if (calendar !== 'primary') return { items: [] };
      let items = [...db.values()].filter(e => e.status !== 'cancelled');
      if (options.privateExtendedProperty) {
        const [key, value] = options.privateExtendedProperty.split('=');
        items = items.filter(e => props(e)[key] === value);
      }
      return { items: clone(items) };
    },
    instances(calendar, id) {
      assert.equal(calendar, 'primary');
      return { items: clone([...db.values()].filter(e => e.recurringEventId === id)) };
    },
    insert(resource, calendar) {
      assert.equal(calendar, 'primary'); assert.equal(resource.id, undefined);
      writes.push({ op: 'insert', resource: clone(resource) });
      let id; do { id = 'new-' + (++serial); } while (db.has(id));
      const e = merge({ id, status: 'confirmed', updated: 'insert-v' + (++revision) }, clone(resource));
      db.set(id, e); return clone(e);
    },
    patch(resource, calendar, id) {
      assert.equal(calendar, 'primary'); assert.ok(db.has(id));
      writes.push({ op: 'patch', id, resource: clone(resource) });
      const e = merge(db.get(id), clone(resource)); e.updated = 'patch-v' + (++revision); return clone(e);
    },
    remove(calendar, id) { assert.equal(calendar, 'primary'); writes.push({ op: 'remove', id }); db.delete(id); },
  };
  const ctx = {
    console: { log() {}, warn() {} }, Calendar: { Events },
    Utilities: { getUuid: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    UrlFetchApp: { fetch() { throw new Error('Network/API use forbidden in this offline test'); } },
  };
  vm.createContext(ctx); vm.runInContext(source, ctx, { filename: bridgePath });
  return {
    ctx, db, writes,
    run: request => clone(ctx.handleWrite_(request)),
    map: e => clone(ctx.mapEvent(e, ctx.CONFIG)),
    feed: () => clone(ctx.buildFeed_()),
  };
}
const save = extra => body({ action: 'saveSeries', seriesId: 'wc-lessons', preserveTypes: true, sessions: [], deletedIds: [], ...extra });
const convert = extra => body({ action: 'convertToSeries', id: 'original', expectedUpdated: 'v1', preserveTypes: true, sessions: [row()], ...extra });
function zeroWrites(h, request, pattern) {
  const before = clone([...h.db.values()]);
  assert.throws(() => h.run(request), error => pattern.test(error.message));
  assert.equal(h.writes.length, 0, 'validation/conflict must make zero write attempts');
  assert.deepEqual([...h.db.values()], before);
}
function assertPrivate(mapped) {
  for (const key of ['remark', 'remarks', 'description', 'attendees', 'extendedProperties']) assert.equal(Object.hasOwn(mapped, key), false, key);
  assert.ok(!JSON.stringify(mapped).includes('PRIVATE:'));
  assert.ok(!JSON.stringify(mapped).includes('private@example.invalid'));
}

test('create 15 unsorted lessons generates exact CS course L1..L15 and distinct private notes', () => {
  const h = harness();
  const sessions = Array.from({ length: 15 }, (_, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), {
    autoTitle: true, title: 'ignored when explicitly automatic', remark: 'PRIVATE: lesson-' + (i + 1) + '\n第二行',
  })).reverse();
  const result = h.run(body({ action: 'create', title: '  CS course  ', remark: 'PRIVATE: common fallback', sessions }));
  assert.equal(result.count, 15); assert.equal(h.db.size, 15);
  for (const [index, e] of ordered(h).entries()) {
    const n = index + 1;
    assert.equal(e.summary, 'CS course L' + n); assert.equal(e.description, 'PRIVATE: lesson-' + n + '\n第二行');
    assert.equal(props(e).wcSeries, result.seriesId); assert.equal(props(e).wcSeriesTitle, 'CS course');
    assert.equal(props(e).wcSessionNo, String(n)); assert.equal(props(e).wcSessionAutoTitle, '1');
    assert.equal(Object.hasOwn(props(e), 'wcSessionTitle'), false);
    const mapped = h.map(e); assert.equal(mapped.sessionAutoTitle, true); assert.equal(mapped.sessionNo, n);
    assert.equal(Object.hasOwn(mapped, 'sessionTitle'), false); assert.equal(mapped.hasRemark, true); assertPrivate(mapped);
  }
});

test('single create supports L1 and per-row remark without inventing series or changing recurrence compatibility', () => {
  const h = harness();
  const result = h.run(body({ action: 'create', repeatWeeks: 3, sessions: [row(undefined, { autoTitle: true, remark: '' })] }));
  const e = h.db.get(result.event.id);
  assert.equal(result.event.title, 'CS course L1'); assert.equal(result.event.seriesId, null);
  assert.equal(result.event.sessionNo, 1); assert.equal(result.event.sessionAutoTitle, true);
  assert.equal(e.description, ''); assert.deepEqual(e.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=3']);
});

test('create false/manual exact whitespace, false/blank legacy name, omitted flag legacy name', () => {
  const h = harness();
  h.run(body({ action: 'create', sessions: [row(undefined, { autoTitle: false, title: '  手改堂名  ' }), row('2026-12-02', { autoTitle: false, title: '' }), row('2026-12-03')] }));
  assert.deepEqual(ordered(h).map(e => e.summary), ['  手改堂名  ', 'CS course (第 2 堂)', 'CS course (第 3 堂)']);
  assert.equal(h.map(ordered(h)[0]).sessionTitle, '  手改堂名  ');
  assert.ok(ordered(h).every(e => props(e).wcSessionAutoTitle === undefined && !h.map(e).sessionAutoTitle));
});

test('remark boundary accepts exactly 8000 JS string units, multiline and explicit empty without trimming', () => {
  const h = harness();
  h.run(body({ action: 'create', remark: 'PRIVATE: fallback', sessions: [row(undefined, { remark: '字'.repeat(8000) }), row('2026-12-02', { remark: '' }), row('2026-12-03', { remark: ' \n\t ' })] }));
  assert.deepEqual(ordered(h).map(e => e.description), ['字'.repeat(8000), '', ' \n\t ']);
  assert.equal(h.map(ordered(h)[2]).hasRemark, false);
});

test('convert 15 lessons sorts/reuses original ID, supports independent auto titles and notes, retains source properties', () => {
  const original = event(); const h = harness([original, event('unrelated')]);
  const sessions = Array.from({ length: 15 }, (_, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), { autoTitle: true, remark: 'PRIVATE: converted-' + (i + 1) })).reverse();
  const result = h.run(convert({ sessions }));
  assert.equal(result.event.id, 'original'); assert.equal(result.count, 15);
  const lessons = ordered(h).filter(e => props(e).wcSeries === result.seriesId);
  assert.equal(lessons[0].id, 'original'); assert.equal(new Set(lessons.map(e => e.id)).size, 15);
  for (const [i, e] of lessons.entries()) {
    assert.equal(e.summary, 'CS course L' + (i + 1)); assert.equal(e.description, 'PRIVATE: converted-' + (i + 1));
    assert.equal(e.location, original.location); assert.equal(e.colorId, original.colorId); assert.equal(props(e).unrelated, 'PRIVATE: keep-me');
  }
  assert.deepEqual(h.db.get('original').attendees, original.attendees);
  assert.deepEqual(h.db.get('original').extendedProperties.public, original.extendedProperties.public);
  assert.ok(lessons.slice(1).every(e => !e.attendees)); assert.ok(h.db.has('unrelated'));
  assert.equal(h.writes.at(-1).op, 'patch'); assert.equal(h.writes.at(-1).id, 'original');
  assert.equal(h.writes.filter(w => w.op === 'remove').length, 0);
});

test('convert omitted per-row/shared notes inherit source; explicit row beats shared override including clear', () => {
  const retained = harness([event()]);
  retained.run(convert({ sessions: [row(undefined, { autoTitle: true }), row('2026-12-02', { autoTitle: false, title: '手改' })] }));
  assert.ok([...retained.db.values()].every(e => e.description === event().description));
  const h = harness([event()]);
  h.run(convert({ remark: 'PRIVATE: shared', sessions: [row(undefined, { autoTitle: true, remark: '' }), row('2026-12-02', { autoTitle: true, remark: 'PRIVATE: individual' }), row('2026-12-03', { autoTitle: true, remark: undefined })] }));
  assert.deepEqual(ordered(h).map(e => e.description), ['', 'PRIVATE: individual', 'PRIVATE: shared']);
});

test('single conversion and previously automatic standalone source preserve automatic mode when omitted', () => {
  const h = harness([event()]); const result = h.run(convert({ sessions: [row(undefined, { autoTitle: true })] }));
  assert.equal(result.event.id, 'original'); assert.equal(result.event.title, 'CS course L1'); assert.equal(result.event.seriesId, result.seriesId);
  const original = lesson('original', '2026-12-01', 1); delete props(original).wcSeries;
  const h2 = harness([original]); const converted = h2.run(convert({ title: 'New course', sessions: [row(), row('2026-12-02')] }));
  assert.equal(converted.event.title, 'New course L1'); assert.ok(ordered(h2).every(e => h2.map(e).sessionAutoTitle === true));
});

test('saveSeries sorts moved/added/deleted rows and retained unseen member, preserves IDs and renumbers auto mode', () => {
  const a = lesson('a', '2026-12-01', 1), b = lesson('b', '2026-12-02', 2), distant = lesson('unseen', '2030-01-01', 3);
  const h = harness([a, b, distant, event('foreign')]);
  const result = h.run(save({ title: '  New CS  ', sessions: [row('2026-11-30', { autoTitle: true, remark: 'PRIVATE: added' }), row('2026-12-03', { id: 'a', autoTitle: true })], deletedIds: ['b'], expectedUpdates: { a: 'v1', b: 'v1', unseen: 'v1' } }));
  assert.equal(result.count, 3); assert.ok(h.db.has('a')); assert.ok(h.db.has('unseen')); assert.ok(h.db.has('foreign')); assert.ok(!h.db.has('b'));
  assert.equal(h.db.get('new-1').summary, 'New CS L1'); assert.equal(h.db.get('a').summary, 'New CS L2'); assert.equal(h.db.get('unseen').summary, 'New CS L3');
  assert.equal(h.db.get('new-1').description, 'PRIVATE: added');
  for (const original of [a, distant]) {
    const e = h.db.get(original.id); assert.equal(e.description, original.description); assert.equal(props(e).unrelated, props(original).unrelated);
    assert.deepEqual(e.extendedProperties.public, original.extendedProperties.public);
  }
  assert.deepEqual(h.db.get('unseen').start, distant.start); assert.deepEqual(h.db.get('unseen').end, distant.end);
  assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), ['b']); assert.equal(h.writes.at(-1).op, 'remove');
});

test('saveSeries supports 15 individual notes and all L1..L15, without a shared note', () => {
  const initial = Array.from({ length: 15 }, (_, i) => lesson('s' + (i + 1), '2026-12-' + String(i + 1).padStart(2, '0'), i + 1));
  const h = harness(initial);
  h.run(save({ sessions: initial.map(e => row(e.start.dateTime.slice(0, 10), { id: e.id, autoTitle: true, remark: 'PRIVATE: saved-' + props(e).wcSessionNo })).reverse() }));
  for (const [i, e] of ordered(h).entries()) { assert.equal(e.summary, 'CS course L' + (i + 1)); assert.equal(e.description, 'PRIVATE: saved-' + (i + 1)); }
});

test('saveSeries omitted row title/autoTitle retains auto even for unsubmitted row after common title change', () => {
  const h = harness([lesson('a', '2026-12-01', 1), lesson('unseen', '2030-01-01', 2)]);
  h.run(save({ title: 'Renamed', sessions: [row(undefined, { id: 'a' })] }));
  assert.deepEqual(ordered(h).map(e => e.summary), ['Renamed L1', 'Renamed L2']);
  assert.ok(ordered(h).every(e => h.map(e).sessionAutoTitle === true && props(e).wcSessionTitle === undefined));
});

test('saveSeries false/manual removes previous auto flag; false/blank restores legacy numbering', () => {
  const h = harness([lesson('a', '2026-12-01', 1), lesson('b', '2026-12-02', 2)]);
  h.run(save({ sessions: [row(undefined, { id: 'a', autoTitle: false, title: '  自訂堂名  ' }), row('2026-12-02', { id: 'b', autoTitle: false, title: '' })] }));
  assert.equal(h.db.get('a').summary, '  自訂堂名  '); assert.equal(props(h.db.get('a')).wcSessionTitle, '  自訂堂名  ');
  assert.equal(h.db.get('b').summary, 'CS course (第 2 堂)');
  assert.ok(ordered(h).every(e => props(e).wcSessionAutoTitle === undefined && !h.map(e).sessionAutoTitle));
  assert.ok(h.writes.every(w => w.resource.extendedProperties.private.wcSessionAutoTitle === null));
});

test('saveSeries explicitly true replaces prior custom title and removes custom marker, regardless of title payload', () => {
  const e = lesson('a', '2026-12-01', 1, { summary: '舊手改' });
  delete props(e).wcSessionAutoTitle; props(e).wcSessionTitle = '舊手改';
  const h = harness([e]);
  h.run(save({ sessions: [row(undefined, { id: 'a', autoTitle: true, title: 'ignored' })] }));
  assert.equal(h.db.get('a').summary, 'CS course L1'); assert.equal(props(h.db.get('a')).wcSessionTitle, undefined);
  assert.equal(props(h.db.get('a')).wcSessionAutoTitle, '1'); assert.equal(h.map(h.db.get('a')).sessionAutoTitle, true);
});

test('saveSeries explicit title without autoTitle uses old manual/blank semantics, not implicit L mode', () => {
  const h = harness([lesson('a', '2026-12-01', 1), lesson('b', '2026-12-02', 2)]);
  h.run(save({ sessions: [row(undefined, { id: 'a', title: '手改' }), row('2026-12-02', { id: 'b', title: '' })] }));
  assert.deepEqual(ordered(h).map(e => e.summary), ['手改', 'CS course (第 2 堂)']);
  assert.ok(ordered(h).every(e => props(e).wcSessionAutoTitle === undefined));
});

test('saveSeries explicit false with omitted title preserves already-custom title and clears stale auto flag', () => {
  const e = lesson('a', '2026-12-01', 1, { summary: 'Google 手改' }); const h = harness([e]);
  h.run(save({ sessions: [row(undefined, { id: 'a', autoTitle: false })] }));
  assert.equal(h.db.get('a').summary, 'Google 手改'); assert.equal(props(h.db.get('a')).wcSessionTitle, 'Google 手改');
  assert.equal(props(h.db.get('a')).wcSessionAutoTitle, undefined);
});

for (const submit of [true, false]) test('Google direct rename is custom, never auto, and survives saveSeries (' + (submit ? 'submitted' : 'unsubmitted') + ')', () => {
  const original = lesson('a', '2026-12-01', 1, { summary: '同事在 Google 最新堂名' }); const h = harness([original]);
  const mapped = h.map(original); assert.equal(mapped.sessionTitle, original.summary); assert.equal(Object.hasOwn(mapped, 'sessionAutoTitle'), false); assertPrivate(mapped);
  h.run(save({ title: 'New common name', sessions: submit ? [row(undefined, { id: 'a' })] : [] }));
  const saved = h.db.get('a'); assert.equal(saved.summary, original.summary); assert.equal(props(saved).wcSessionTitle, original.summary);
  assert.equal(props(saved).wcSessionAutoTitle, undefined); assert.equal(h.map(saved).sessionTitle, original.summary);
});

test('auto expected title is compared against stored common title/no, never a generic trailing L regex', () => {
  const h = harness(); const unchanged = lesson('a', '2026-12-01', 12);
  assert.equal(h.map(unchanged).sessionAutoTitle, true); assert.equal(h.map(unchanged).sessionTitle, undefined);
  for (const summary of ['CS course L11', 'Other title L12', 'CS course (第 12 堂)', 'CS course L12 ']) {
    const mapped = h.map({ ...unchanged, summary }); assert.equal(mapped.sessionTitle, summary); assert.equal(mapped.sessionAutoTitle, undefined);
  }
});

test('single update rename turns auto into manual while preserving series title/no, private notes and source ID', () => {
  for (const tagged of [true, false]) {
    const original = lesson('a', '2026-12-01', 1); if (!tagged) delete props(original).wcSeries;
    const h = harness([original]);
    const result = h.run(body({ action: 'update', id: 'a', expectedUpdated: 'v1', preserveTypes: true, title: '  單堂手改  ', ...row() }));
    const e = h.db.get('a'); assert.equal(result.event.id, 'a'); assert.equal(result.event.sessionTitle, '  單堂手改  '); assert.equal(result.event.sessionAutoTitle, undefined);
    assert.equal(props(e).wcSessionAutoTitle, undefined); assert.equal(props(e).wcSessionTitle, e.summary); assert.equal(props(e).wcSeriesTitle, 'CS course');
    assert.equal(props(e).wcSessionNo, '1'); assert.equal(e.description, original.description); assert.deepEqual(e.attendees, original.attendees);
  }
});

test('single unchanged title update preserves auto metadata; explicit single remark empty clears only that event', () => {
  const a = lesson('a', '2026-12-01', 1), b = lesson('b', '2026-12-02', 2); const h = harness([a, b]);
  h.run(body({ action: 'update', id: 'a', expectedUpdated: 'v1', preserveTypes: true, title: a.summary, remark: '', ...row() }));
  assert.equal(h.db.get('a').description, ''); assert.equal(h.db.get('b').description, b.description);
  assert.deepEqual(h.db.get('a').extendedProperties, a.extendedProperties); assert.equal(h.map(h.db.get('a')).sessionAutoTitle, true);
});

test('type-only update continues to patch colorId alone and does not expose or alter auto/notes', () => {
  const original = lesson('a', '2026-12-01', 1); const h = harness([original]);
  const result = h.run({ action: 'update', typeOnly: true, id: 'a', expectedUpdated: 'v1', type: 'Other' });
  assert.deepEqual(h.writes[0].resource, { colorId: null });
  for (const key of Object.keys(original).filter(k => !['colorId', 'updated'].includes(k))) assert.deepEqual(h.db.get('a')[key], original[key]);
  assert.equal(result.event.sessionAutoTitle, true); assertPrivate(result.event);
});

test('saveSeries absent/undefined remarks preserve existing rows; new-row inheritance retains original preserveTypes semantics', () => {
  const a = lesson('a', '2026-12-01', 1), b = lesson('b', '2026-12-02', 2); const h = harness([a, b]);
  h.run(save({ remark: undefined, sessions: [row(undefined, { id: 'a', remark: undefined }), row('2026-12-03', { autoTitle: true })] }));
  assert.equal(h.db.get('a').description, a.description); assert.equal(h.db.get('b').description, b.description);
  assert.ok(h.writes.filter(w => w.op === 'patch').every(w => !Object.hasOwn(w.resource, 'description')));
  // preserveTypes uses the first member as insert source: absent notes inherit that member, as before.
  assert.equal(h.db.get('new-1').description, a.description);
  const h2 = harness([a]); h2.run(save({ preserveTypes: false, sessions: [row('2026-12-03', { autoTitle: true })] }));
  assert.equal(h2.db.get('new-1').description, undefined);
});

test('saveSeries row clear affects only that row; unsubmitted member and its schedule remain intact', () => {
  const a = lesson('a', '2026-12-01', 1), unseen = lesson('unseen', '2030-01-01', 2); const h = harness([a, unseen]);
  h.run(save({ sessions: [row(undefined, { id: 'a', remark: '' })] }));
  assert.equal(h.db.get('a').description, ''); assert.equal(h.db.get('unseen').description, unseen.description);
  assert.deepEqual(h.db.get('unseen').start, unseen.start); assert.equal(h.map(h.db.get('a')).hasRemark, false);
});

test('saveSeries row remark has priority over shared explicit override; shared reaches omitted/undefined/unsubmitted rows', () => {
  const initial = [lesson('a', '2026-12-01', 1), lesson('b', '2026-12-02', 2), lesson('c', '2026-12-03', 3), lesson('unseen', '2030-01-01', 4)];
  const h = harness(initial);
  h.run(save({ remark: 'PRIVATE: shared override', sessions: [row(undefined, { id: 'a', remark: 'PRIVATE: individual' }), row('2026-12-02', { id: 'b', remark: '' }), row('2026-12-03', { id: 'c', remark: undefined })] }));
  assert.deepEqual(initial.map(e => h.db.get(e.id).description), ['PRIVATE: individual', '', 'PRIVATE: shared override', 'PRIVATE: shared override']);
  const clear = harness(initial); clear.run(save({ remark: '', sessions: [row(undefined, { id: 'a', remark: 'PRIVATE: keep individual' })] }));
  assert.deepEqual(initial.map(e => clear.db.get(e.id).description), ['PRIVATE: keep individual', '', '', '']);
});

test('public feed declares sessionRemarks:true, retains old capabilities, exposes only hasRemark and safe naming metadata; get remains private', () => {
  const h = harness([lesson('a', '2026-12-01', 1)]); const feed = h.feed();
  assert.equal(feed.bridgeVersion, '2026-11-18-ilab-v1');
  for (const key of ['sessionTitles', 'convertToSeries', 'saveSeries', 'privateRemarks', 'typeOnly', 'sessionRemarks']) assert.equal(feed.capabilities[key], true);
  assertPrivate(feed); assert.equal(feed.events[0].sessionAutoTitle, true); assert.equal(feed.events[0].hasRemark, true);
  assert.deepEqual(h.run({ action: 'get', id: 'a' }), { ok: true, remark: 'PRIVATE: notes-a' });
  assert.equal(h.writes.length, 0);
});

const invalidFields = [
  ['null remark', { remark: null }, /備註/], ['number remark', { remark: 123 }, /備註/],
  ['object remark', { remark: {} }, /備註/], ['overlong remark', { remark: 'x'.repeat(8001) }, /8000/],
  ['null autoTitle', { autoTitle: null }, /自動標題/], ['string autoTitle', { autoTitle: 'true' }, /自動標題/],
  ['number autoTitle', { autoTitle: 1 }, /自動標題/], ['object autoTitle', { autoTitle: {} }, /自動標題/],
];
for (const [name, extra, pattern] of invalidFields) {
  for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' validates later ' + name + ' before any writes', () => {
    const h = action === 'create' ? harness() : action === 'convertToSeries' ? harness([event()]) : harness([lesson('a', '2026-12-01', 1)]);
    const sessions = [row(undefined, { autoTitle: true, ...(action === 'saveSeries' ? { id: 'a' } : {}) }), row('2026-12-02', { autoTitle: true, ...extra })];
    const request = action === 'create' ? body({ action, sessions }) : action === 'convertToSeries' ? convert({ sessions }) : save({ sessions });
    zeroWrites(h, request, pattern);
  });
}
for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' rejects invalid shared note even if all submitted rows override it', () => {
  const h = action === 'create' ? harness() : action === 'convertToSeries' ? harness([event()]) : harness([lesson('a', '2026-12-01', 1)]);
  const sessions = [row(undefined, { remark: 'valid', ...(action === 'saveSeries' ? { id: 'a' } : {}) })];
  const request = action === 'create' ? body({ action, remark: false, sessions }) : action === 'convertToSeries' ? convert({ remark: false, sessions }) : save({ remark: false, sessions });
  zeroWrites(h, request, /備註/);
});

test('saveSeries invalid shared note with no submitted rows has zero writes', () => {
  const h = harness([lesson('a', '2026-12-01', 1)]); zeroWrites(h, save({ remark: 'x'.repeat(8001) }), /8000/);
});

test('auto generated title length checks run before any writes, including later L10 suffix overflow', () => {
  for (const action of ['create', 'convertToSeries', 'saveSeries']) {
    const h = action === 'create' ? harness() : action === 'convertToSeries' ? harness([event()]) : harness([lesson('a', '2026-12-01', 1)]);
    const sessions = Array.from({ length: 10 }, (_, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), { autoTitle: true, ...(action === 'saveSeries' && i === 0 ? { id: 'a' } : {}) }));
    const title = 'x'.repeat(1021); // L1 fits (1024); L10 does not.
    const request = action === 'create' ? body({ action, title, sessions }) : action === 'convertToSeries' ? convert({ title, sessions }) : save({ title, sessions });
    zeroWrites(h, request, /標題太長/);
  }
});

test('saveSeries stale expectedUpdates on unsubmitted member/deleted member blocks all writes', () => {
  for (const id of ['unseen', 'deleted']) {
    const h = harness([lesson('a', '2026-12-01', 1), lesson('deleted', '2026-12-02', 2), lesson('unseen', '2030-01-01', 3)]);
    zeroWrites(h, save({ sessions: [row(undefined, { id: 'a', autoTitle: true, remark: 'PRIVATE: new note' })], deletedIds: ['deleted'], expectedUpdates: { [id]: 'stale' } }), /修改/);
  }
});

test('saveSeries foreign ID and contradictory submitted/deleted IDs still reject before writes', () => {
  for (const extra of [{ sessions: [row(undefined, { id: 'foreign', autoTitle: true })] }, { sessions: [row(undefined, { id: 'a' })], deletedIds: ['a'] }]) {
    const h = harness([lesson('a', '2026-12-01', 1), event('foreign')]); zeroWrites(h, save(extra), /不屬於|同時/);
  }
});

test('conversion rechecks original version after child inserts and cleans children without undoing Google edit', () => {
  const h = harness([event()], { onGet(id, db, writes) {
    if (id === 'original' && writes.some(w => w.op === 'insert')) { db.get(id).updated = 'google-v2'; db.get(id).description = 'PRIVATE: Google edit'; }
  } });
  assert.throws(() => h.run(convert({ sessions: [row(undefined, { autoTitle: true, remark: 'PRIVATE: overwrite' }), row('2026-12-02', { autoTitle: true })] })), error => error.conflict === true);
  assert.equal(h.db.size, 1); assert.equal(h.db.get('original').description, 'PRIVATE: Google edit');
  assert.equal(h.writes.filter(w => w.op === 'patch').length, 0); assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), ['new-1']);
});

test('legacy create/convert/save still use (第 N 堂), preserve custom exactness and unsubmitted members', () => {
  const h = harness();
  const single = h.run(body({ action: 'create', ...row(), remark: 'PRIVATE: old' }));
  assert.equal(single.event.title, 'CS course'); assert.equal(single.event.seriesId, null);
  h.run(body({ action: 'create', sessions: [row('2026-12-03'), row('2026-12-02', { title: '  舊自訂  ' })] }));
  assert.ok([...h.db.values()].some(e => e.summary === 'CS course (第 2 堂)'));
  const converted = harness([event()]); converted.run(convert({ sessions: [row(), row('2026-12-02')] }));
  assert.deepEqual(ordered(converted).map(e => e.summary), ['CS course (第 1 堂)', 'CS course (第 2 堂)']);
  const a = lesson('a', '2026-12-01', 1, { summary: '  舊自訂  ' }), unseen = lesson('unseen', '2030-01-01', 2, { summary: 'CS course (第 2 堂)' });
  delete props(a).wcSessionAutoTitle; props(a).wcSessionTitle = a.summary; delete props(unseen).wcSessionAutoTitle;
  const saved = harness([a, unseen]); saved.run(save({ title: 'New legacy title', sessions: [row(undefined, { id: 'a' })] }));
  assert.equal(saved.db.get('a').summary, a.summary); assert.equal(saved.db.get('unseen').summary, 'New legacy title (第 2 堂)');
  assert.ok([...saved.db.values()].every(e => !saved.map(e).sessionAutoTitle));
});

test('native recurring series keeps original grouping/ID when auto titles and session notes are saved', () => {
  const e = lesson('instance', '2026-12-01', 1); e.recurringEventId = 'native'; props(e).wcSeries = 'native';
  const h = harness([e]); const result = h.run(save({ seriesId: 'native', sessions: [row(undefined, { id: 'instance', autoTitle: true, remark: 'PRIVATE: instance' })] }));
  assert.equal(result.seriesId, 'native'); assert.equal(h.map(h.db.get('instance')).seriesId, 'native');
  assert.equal(h.db.get('instance').description, 'PRIVATE: instance'); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].id, 'instance');
});

console.log('\nAll ' + passed + ' offline lesson-field checks passed.');
console.log('Bridge: ' + bridgePath);
console.log('Only in-memory Calendar/Utilities VM mocks were used; network/API access is blocked.');
