#!/usr/bin/env node
'use strict';
// Offline VM only: no browser, credentials, connector, or real Calendar/API calls.
// Run: node scripts/test-course-naming.cjs [apps-script/Code.gs]
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
const general = (extra = {}) => ({ mode: 'general', startNo: 4, term: 1, parts: 1, ...extra });
const classical = (extra = {}) => ({ mode: 'classical', startNo: 9, term: 3, parts: 2, ...extra });
const row = (date = '2026-12-01', extra = {}) => ({ date, startTime: '10:00', endTime: '11:00', ...extra });
const body = extra => ({ title: 'CS course', type: 'Course', venues: ['1S'], allDay: false, ...extra });
const props = e => e.extendedProperties?.private || {};
const ordered = h => [...h.db.values()].sort((a, b) => (a.start.dateTime || a.start.date).localeCompare(b.start.dateTime || b.start.date));
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
function lesson(id, date, no, extra = {}) {
  return event(id, {
    summary: 'CS course L' + no, description: 'PRIVATE: notes-' + id,
    start: { dateTime: date + 'T10:00:00+08:00' }, end: { dateTime: date + 'T11:00:00+08:00' },
    extendedProperties: { private: { wcSeries: 'wc-lessons', wcSeriesTitle: 'CS course', wcSessionNo: String(no), wcSessionAutoTitle: '1', unrelated: 'PRIVATE: ' + id }, public: { keepPublic: 'unchanged' } },
    ...extra,
  });
}
const save = extra => body({ action: 'saveSeries', seriesId: 'wc-lessons', preserveTypes: true, sessions: [], deletedIds: [], ...extra });
const convert = extra => body({ action: 'convertToSeries', id: 'original', expectedUpdated: 'v1', preserveTypes: true, sessions: [row()], ...extra });
function harness(initial = [], controls = {}) {
  const db = new Map(initial.map(e => [e.id, clone(e)]));
  const writes = [], locks = [], invalidated = [];
  let serial = 0, revision = 0, uuid = 0, insertAttempt = 0;
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
      if (options.timeMin) items = items.filter(e => (e.start.dateTime || e.start.date) >= options.timeMin);
      if (options.timeMax) items = items.filter(e => (e.start.dateTime || e.start.date) <= options.timeMax);
      return { items: clone(items) };
    },
    instances(calendar, id) {
      assert.equal(calendar, 'primary');
      return { items: clone([...db.values()].filter(e => e.recurringEventId === id)) };
    },
    insert(resource, calendar) {
      assert.equal(calendar, 'primary'); assert.equal(resource.id, undefined);
      writes.push({ op: 'insert', resource: clone(resource) });
      if (++insertAttempt === controls.failInsertAt) throw new Error('injected insert failure');
      let id; do { id = 'new-' + (++serial); } while (db.has(id));
      const e = merge({ id, status: 'confirmed', updated: 'insert-v' + (++revision) }, clone(resource));
      db.set(id, e); return clone(e);
    },
    patch(resource, calendar, id) {
      assert.equal(calendar, 'primary'); assert.ok(db.has(id));
      writes.push({ op: 'patch', id, resource: clone(resource) });
      if (id === controls.failPatchId) throw new Error('injected patch failure');
      const e = merge(db.get(id), clone(resource)); e.updated = 'patch-v' + (++revision); return clone(e);
    },
    remove(calendar, id) {
      assert.equal(calendar, 'primary'); writes.push({ op: 'remove', id });
      if (id === controls.failRemoveId) throw new Error('injected cleanup failure');
      db.delete(id);
    },
  };
  const lock = {
    waitLock(ms) { locks.push(['wait', ms]); this.held = true; },
    hasLock() { return !!this.held; },
    releaseLock() { locks.push(['release']); this.held = false; },
  };
  const ctx = {
    console: { log() {}, warn() {} }, Calendar: { Events },
    Utilities: { getUuid: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    CacheService: { getScriptCache: () => ({ remove: key => invalidated.push(key) }) },
    LockService: { getScriptLock: () => lock },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => ({ text }) }) },
    UrlFetchApp: { fetch() { throw new Error('Network/API use forbidden in this offline test'); } },
  };
  vm.createContext(ctx); vm.runInContext(source, ctx, { filename: bridgePath });
  return {
    ctx, db, writes, locks, invalidated,
    // Do not clone the request: validation must also reject NaN/Infinity, not convert them to JSON null.
    run: request => clone(ctx.handleWrite_(request)),
    post: request => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(request) } }).text),
    map: e => clone(ctx.mapEvent(e, ctx.CONFIG)),
    feed: () => clone(ctx.buildFeed_()),
  };
}
function zeroWrites(h, request, pattern = /命名|標題/) {
  const before = clone([...h.db.values()]);
  assert.throws(() => h.run(request), error => pattern.test(error.message));
  assert.equal(h.writes.length, 0, 'validation/conflict must make zero write attempts');
  assert.deepEqual([...h.db.values()], before);
}
function assertPrivate(mapped) {
  for (const key of ['remark', 'remarks', 'description', 'attendees', 'extendedProperties', 'wcSeriesNaming']) assert.equal(Object.hasOwn(mapped, key), false, key);
  assert.ok(!JSON.stringify(mapped).includes('PRIVATE:'));
  assert.ok(!JSON.stringify(mapped).includes('private@example.invalid'));
}
function assertFixed(h, e, title, ordinal, naming) {
  assert.equal(e.summary, title); assert.equal(props(e).wcSessionTitle, title);
  assert.equal(props(e).wcSessionAutoTitle, undefined); assert.equal(props(e).wcSessionNo, String(ordinal));
  assert.deepEqual(JSON.parse(props(e).wcSeriesNaming), naming);
  const mapped = h.map(e);
  assert.equal(mapped.title, title); assert.equal(mapped.sessionTitle, title); assert.equal(mapped.sessionAutoTitle, undefined);
  assert.equal(mapped.sessionNo, ordinal); assert.deepEqual(mapped.naming, naming); assertPrivate(mapped);
}
function requestFor(action, naming, sessions) {
  if (action === 'create') return body({ action, naming, sessions });
  if (action === 'convertToSeries') return convert({ naming, sessions });
  return save({ naming, sessions });
}
const initialFor = action => action === 'create' ? [] : action === 'convertToSeries' ? [event()] : [lesson('a', '2026-12-01', 1)];
const namedRowsFor = action => [row(undefined, { title: 'CS course L4', autoTitle: false, ...(action === 'saveSeries' ? { id: 'a' } : {}) }), row('2026-12-02', { title: 'CS course L5', autoTitle: false })];

test('general create preserves exact L4/L5, chronological ordinals and independent private notes', () => {
  const h = harness();
  const result = h.run(body({ action: 'create', title: '  CS course  ', naming: general(), sessions: [
    row('2026-12-02', { title: 'CS course L5', autoTitle: false, remark: 'PRIVATE: L5\n第二行' }),
    row(undefined, { title: 'CS course L4', autoTitle: false, remark: 'PRIVATE: L4' }),
  ] }));
  assert.equal(result.count, 2); assert.equal(h.db.size, 2);
  for (const [i, e] of ordered(h).entries()) {
    assertFixed(h, e, 'CS course L' + (i + 4), i + 1, general());
    assert.equal(props(e).wcSeries, result.seriesId); assert.equal(props(e).wcSeriesTitle, 'CS course');
    assert.equal(e.description, i ? 'PRIVATE: L5\n第二行' : 'PRIVATE: L4');
  }
});

const classicalTitles = ['古文 L9・3期・1節', '古文 L9・3期・2節', '古文 L10・3期・1節', '古文 L10・3期・2節', '古文 L11・3期・1節'];
for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' preserves exact classical punctuation and consecutive 1/2 parts, then next L', () => {
  const h = harness(initialFor(action));
  const sessions = classicalTitles.map((title, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), {
    title, autoTitle: false, remark: 'PRIVATE: part-' + (i + 1), ...(action === 'saveSeries' && i === 0 ? { id: 'a' } : {}),
  })).reverse();
  const result = h.run({ ...requestFor(action, classical(), sessions), title: '古文' });
  assert.equal(result.count, 5);
  for (const [i, e] of ordered(h).entries()) {
    assertFixed(h, e, classicalTitles[i], i + 1, classical());
    assert.equal(e.description, 'PRIVATE: part-' + (i + 1));
  }
  if (action === 'convertToSeries') {
    assert.equal(result.event.id, 'original'); assert.equal(ordered(h)[0].id, 'original');
    assert.equal(h.writes.at(-1).op, 'patch'); assert.equal(h.writes.at(-1).id, 'original');
  }
  if (action === 'saveSeries') assert.ok(h.db.has('a'));
});

for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' one-row general course uses exact L4 and stores naming, not L1', () => {
  const h = harness(initialFor(action));
  const result = h.run(requestFor(action, general(), namedRowsFor(action).slice(0, 1)));
  assert.equal(h.db.size, 1);
  const e = ordered(h)[0]; assertFixed(h, e, 'CS course L4', 1, general());
  if (action === 'create') { assert.equal(result.event.seriesId, null); assert.equal(props(e).wcSeries, undefined); }
  if (action === 'convertToSeries') { assert.equal(e.id, 'original'); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, 'patch'); }
  if (action === 'saveSeries') assert.equal(e.id, 'a');
});

for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' naming forces explicit titles to fixed custom despite autoTitle:true', () => {
  const h = harness(initialFor(action));
  const sessions = namedRowsFor(action).map(s => ({ ...s, autoTitle: true }));
  h.run(requestFor(action, general(), sessions));
  for (const [i, e] of ordered(h).entries()) assertFixed(h, e, 'CS course L' + (i + 4), i + 1, general());
});

test('naming is configuration only: unusual/manual/whitespace titles are used verbatim, never rendered', () => {
  const h = harness();
  const titles = ['  手動：導讀 L42  ', '完全不似模板', '古文 L9・3期・1節'];
  h.run(body({ action: 'create', title: 'Different common name', naming: general({ startNo: 987 }), sessions: titles.map((title, i) => row('2026-12-0' + (i + 1), { title })) }));
  for (const [i, e] of ordered(h).entries()) assertFixed(h, e, titles[i], i + 1, general({ startNo: 987 }));
});

for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' stores only whitelisted normalized config and leaves caller object untouched', () => {
  const input = general({ term: 5, parts: 7, remark: 'PRIVATE: never publish', notes: 'PRIVATE: naming note', unknown: { token: 'PRIVATE: secret' }, extra: 123 });
  const before = clone(input), h = harness(initialFor(action));
  h.run(requestFor(action, input, namedRowsFor(action)));
  assert.deepEqual(input, before);
  for (const [i, e] of ordered(h).entries()) {
    assertFixed(h, e, 'CS course L' + (i + 4), i + 1, general());
    assert.deepEqual(Object.keys(JSON.parse(props(e).wcSeriesNaming)).sort(), ['mode', 'parts', 'startNo', 'term']);
    assert.ok(props(e).wcSeriesNaming.length < 100);
  }
  assertPrivate(h.feed());
});

test('classical config accepts integer boundaries without deriving or changing supplied titles', () => {
  for (const naming of [classical({ startNo: 1, term: 1, parts: 1 }), classical({ startNo: 9999, term: 999, parts: 12 })]) {
    const h = harness();
    h.run(body({ action: 'create', naming, sessions: [row(undefined, { title: '手動堂名' })] }));
    assertFixed(h, ordered(h)[0], '手動堂名', 1, naming);
  }
});

test('public mapping sanitizes stored extra fields and canonicalizes stored general settings', () => {
  const e = lesson('a', '2026-12-01', 1);
  props(e).wcSeriesNaming = JSON.stringify(general({ term: 999, parts: 12, notes: 'PRIVATE: secret', description: 'PRIVATE: secret', raw: { token: 'PRIVATE: secret' }, __proto__: null }));
  const h = harness([e]), mapped = h.map(e);
  assert.deepEqual(mapped.naming, general()); assertPrivate(mapped); assertPrivate(h.feed());
  assert.ok(props(h.db.get('a')).wcSeriesNaming.includes('PRIVATE:'), 'read-only mapping must not mutate source metadata');
  assert.equal(h.writes.length, 0);
});

const malformed = [
  ['null', null], ['array', []], ['JSON text instead of object', JSON.stringify(general())],
  ['number', 4], ['boolean', false], ['empty object', {}], ['date object', new Date('2026-12-01')],
  ['bad mode', general({ mode: 'ai' })], ['mode case', general({ mode: 'General' })],
  ['numeric mode', general({ mode: 1 })], ['null mode', general({ mode: null })],
  ['missing mode', { startNo: 4, term: 1, parts: 1 }],
];
for (const [key, max] of [['startNo', 9999], ['term', 999], ['parts', 12]]) {
  const missing = general(); delete missing[key]; malformed.push(['missing ' + key, missing]);
  for (const [label, value] of [['string', '4'], ['null', null], ['boolean', true], ['object', {}], ['array', [1]], ['zero', 0], ['negative', -1], ['fraction', 1.5], ['too large', max + 1], ['NaN', NaN], ['Infinity', Infinity], ['undefined', undefined]]) {
    malformed.push([key + ' ' + label, general({ [key]: value })]);
  }
}
for (const [name, naming] of malformed) {
  for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' rejects malformed naming ' + name + ' with zero writes', () => {
    const h = harness(initialFor(action)); zeroWrites(h, requestFor(action, naming, namedRowsFor(action)), /命名/);
  });
}

test('JSON object inherited required fields are not accepted as configuration', () => {
  const h = harness();
  zeroWrites(h, body({ action: 'create', naming: Object.create(general()), sessions: namedRowsFor('create') }), /命名/);
});

for (const stored of ['{bad json', 'null', '[]', '4', 'true', '"a string"', '{}', JSON.stringify(general({ startNo: '4' })), JSON.stringify(classical({ parts: 13 }))]) test('malformed stored config omitted safely from public mapping: ' + stored, () => {
  const e = lesson('a', '2026-12-01', 1); props(e).wcSeriesNaming = stored;
  const h = harness([e]); assert.equal(Object.hasOwn(h.map(e), 'naming'), false);
  assertPrivate(h.feed()); assert.equal(h.writes.length, 0);
});

test('non-string stored naming and absent naming remain optional without exposing raw private fields', () => {
  for (const stored of [undefined, null, general(), 123]) {
    const e = lesson('a', '2026-12-01', 1); if (stored !== undefined) props(e).wcSeriesNaming = stored;
    const h = harness([e]); assert.equal(Object.hasOwn(h.map(e), 'naming'), false); assertPrivate(h.feed());
  }
});

for (const missing of [{}, { title: '' }, { title: ' \n\t ' }]) {
  for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' rejects new row missing/blank exact title ' + JSON.stringify(missing) + ' before any writes', () => {
    const h = harness(initialFor(action));
    const sessions = [namedRowsFor(action)[0], row('2026-12-02', { autoTitle: true, ...missing })];
    zeroWrites(h, requestFor(action, general(), sessions), /標題/);
  });
}

test('new single create without exact title rejects rather than using top-level common name', () => {
  const h = harness(); zeroWrites(h, body({ action: 'create', naming: general(), ...row() }), /標題/);
});

test('conversion omitted title for sorted first/existing row uses source summary and preserves source properties', () => {
  const original = event('original', { summary: '  Google 現有堂名  ' }), h = harness([original]);
  const result = h.run(convert({ naming: general(), title: 'New common name', sessions: [row('2026-12-02', { title: 'CS course L5', remark: '' }), row(undefined, { autoTitle: true })] }));
  assert.equal(result.event.id, 'original'); assertFixed(h, h.db.get('original'), original.summary, 1, general());
  assert.equal(h.db.get('original').description, original.description); assert.equal(h.db.get('original').location, original.location);
  assert.equal(h.db.get('original').colorId, original.colorId); assert.deepEqual(h.db.get('original').attendees, original.attendees);
  assert.deepEqual(h.db.get('original').extendedProperties.public, original.extendedProperties.public);
  assert.equal(props(h.db.get('original')).unrelated, props(original).unrelated);
  assert.equal(h.db.get('new-1').description, ''); assert.equal(h.db.get('new-1').attendees, undefined);
});

test('one-row conversion with naming but no title freezes source summary', () => {
  const original = event(), h = harness([original]); h.run(convert({ naming: classical() }));
  assertFixed(h, h.db.get('original'), original.summary, 1, classical());
});

for (const sourceDate of ['2026-11-29', '2026-12-01', '2026-12-04']) {
  for (const reverse of [false, true]) test('marked conversion preserves original ID/title/date/notes at ' + sourceDate + ', reversed=' + reverse, () => {
    const original = event('original', { summary: '  CS course L4  ' }), h = harness([original]);
    const sessions = [
      row('2026-11-30', { original: false, title: 'CS course L5', remark: '' }),
      row(sourceDate, { original: true, autoTitle: true }),
      row('2026-12-03', { original: false, title: 'CS course L6', remark: 'PRIVATE: new later row' }),
    ];
    if (reverse) sessions.reverse();
    const before = clone(sessions), result = h.run(convert({ naming: general(), sessions }));
    assert.deepEqual(sessions, before); assert.equal(result.count, 3); assert.equal(result.event.id, 'original');
    const sorted = ordered(h), selected = h.db.get('original');
    assertFixed(h, selected, original.summary, sorted.findIndex(e => e.id === 'original') + 1, general());
    assert.equal(selected.start.dateTime, sourceDate + 'T10:00:00'); assert.equal(result.event.date, sourceDate);
    assert.equal(selected.end.dateTime, sourceDate + 'T11:00:00'); assert.equal(selected.description, original.description);
    assert.equal(selected.location, original.location); assert.equal(selected.colorId, original.colorId);
    assert.deepEqual(selected.attendees, original.attendees); assert.deepEqual(selected.extendedProperties.public, original.extendedProperties.public);
    assert.equal(props(selected).unrelated, props(original).unrelated);
    for (const [title, date, remark] of [['CS course L5', '2026-11-30', ''], ['CS course L6', '2026-12-03', 'PRIVATE: new later row']]) {
      const added = sorted.find(e => e.summary === title);
      assert.notEqual(added.id, original.id); assert.equal(added.start.dateTime, date + 'T10:00:00'); assert.equal(added.description, remark);
      assert.equal(added.location, original.location); assert.equal(added.attendees, undefined); assert.equal(added.extendedProperties.public, undefined);
      assertFixed(h, added, title, sorted.indexOf(added) + 1, general());
    }
    assert.deepEqual(h.writes.map(w => w.op), ['insert', 'insert', 'patch']);
    assert.deepEqual(h.writes.slice(0, 2).map(w => w.resource.summary), ['CS course L5', 'CS course L6']);
    assert.equal(h.writes.at(-1).id, 'original'); assert.equal(h.writes.at(-1).resource.description, undefined);
  });
}

test('conversion accepts one original:true marker without requiring false markers on other rows', () => {
  const original = event(), h = harness([original]);
  h.run(convert({ naming: general(), sessions: [row('2026-11-30', { title: 'CS course L5', remark: '' }), row(undefined, { original: true })] }));
  assert.equal(ordered(h)[0].id, 'new-1'); assertFixed(h, h.db.get('original'), original.summary, 2, general());
  assert.equal(h.db.get('original').description, original.description); assert.equal(h.db.get('new-1').description, '');
});

for (const markers of [[false, false], [false, undefined], [true, true], [true, 'false'], [true, 1], [true, null], [true, {}], [true, []], [true, undefined]]) {
  test('conversion rejects invalid original markers ' + JSON.stringify(markers) + ' before writes or cleanup', () => {
    const h = harness([event()]);
    zeroWrites(h, convert({ naming: general(), sessions: markers.map((original, i) => row('2026-12-0' + (i + 1), { original, title: 'CS course L' + (i + 4) })) }), /原活動/);
  });
}

test('conversion new sorted-first row without title cannot borrow marked later original title', () => {
  const h = harness([event()]);
  zeroWrites(h, convert({ naming: general(), sessions: [row('2026-11-30', { original: false, remark: '' }), row(undefined, { original: true })] }), /標題/);
});

test('conversion without markers retains chronological-first source identity, even for a new earlier date', () => {
  const original = event(), h = harness([original]);
  h.run(convert({ naming: general(), sessions: [row(undefined, { title: 'CS course L5', remark: '' }), row('2026-11-30')] }));
  assert.equal(ordered(h)[0].id, 'original'); assertFixed(h, h.db.get('original'), original.summary, 1, general());
  assert.equal(h.db.get('original').description, original.description); assert.equal(h.db.get('new-1').description, '');
});

test('conversion original marker also preserves legacy non-naming title generation', () => {
  const original = event(), h = harness([original]);
  h.run(convert({ sessions: [row('2026-11-30', { original: false, remark: '' }), row(undefined, { original: true })] }));
  assert.deepEqual(ordered(h).map(e => [e.id, e.summary]), [['new-1', 'CS course (第 1 堂)'], ['original', 'CS course (第 2 堂)']]);
  assert.equal(h.db.get('original').description, original.description); assert.equal(h.db.get('new-1').description, '');
});

test('save omitted submitted title and unseen auto title freeze current summaries, not changed common name', () => {
  const a = lesson('a', '2026-12-01', 4), unseen = lesson('unseen', '2030-01-01', 5), h = harness([a, unseen]);
  const result = h.run(save({ naming: general(), title: 'Renamed common course', sessions: [row(undefined, { id: 'a', autoTitle: true })] }));
  assert.equal(result.count, 2);
  assertFixed(h, h.db.get('a'), a.summary, 1, general()); assertFixed(h, h.db.get('unseen'), unseen.summary, 2, general());
  for (const original of [a, unseen]) {
    const e = h.db.get(original.id); assert.equal(e.description, original.description);
    assert.equal(props(e).wcSeriesTitle, 'Renamed common course'); assert.equal(props(e).unrelated, props(original).unrelated);
  }
  assert.deepEqual(h.db.get('unseen').start, unseen.start); assert.deepEqual(h.db.get('unseen').end, unseen.end);
  assert.ok(h.writes.every(w => w.resource.extendedProperties.private.wcSessionAutoTitle === null));
});

test('save naming with zero submitted rows freezes every member including old auto L titles', () => {
  const initial = [lesson('a', '2026-12-01', 1), lesson('unseen', '2030-01-01', 2)], h = harness(initial);
  h.run(save({ naming: classical(), title: 'Changed course' }));
  for (const [i, original] of initial.entries()) assertFixed(h, h.db.get(original.id), original.summary, i + 1, classical());
});

for (const titles of [['CS course L4', 'CS course L5', '手改結課名'], classicalTitles.slice(0, 3)]) test('saved IDs/titles/notes survive insertion, date reorder, deletion, common rename and settings switch: ' + titles[0], () => {
  const naming = titles === undefined ? general() : titles[0].startsWith('古文') ? classical() : general();
  const h = harness();
  const created = h.run(body({ action: 'create', naming, sessions: titles.map((title, i) => row('2026-12-0' + (i + 1), { title, remark: 'PRIVATE: saved-' + i })) }));
  const originals = ordered(h).map(clone), [a, b, c] = originals;
  h.run(save({ seriesId: created.seriesId, naming: classical({ startNo: 99, term: 5, parts: 3 }), title: 'New common title', sessions: [
    row('2026-11-30', { title: '新加堂：不影響舊堂', autoTitle: true, remark: '' }),
    row('2026-12-10', { id: a.id, title: a.summary }),
    row('2026-12-05', { id: c.id, title: c.summary }),
    row('2026-12-04', { id: b.id, title: b.summary }),
  ], expectedUpdates: Object.fromEntries(originals.map(e => [e.id, e.updated])) }));
  for (const original of originals) {
    const e = h.db.get(original.id); assert.equal(e.summary, original.summary); assert.equal(e.description, original.description);
    assert.equal(props(e).wcSessionTitle, original.summary); assert.deepEqual(e.extendedProperties.public, original.extendedProperties.public);
  }
  assert.deepEqual(originals.map(e => props(h.db.get(e.id)).wcSessionNo), ['4', '2', '3']);
  const added = ordered(h)[0]; assert.equal(added.description, '');
  h.run(save({ seriesId: created.seriesId, naming: general({ startNo: 500 }), title: 'Another common title', deletedIds: [b.id], sessions: [row('2026-12-07', { id: c.id }), row('2026-11-29', { id: a.id })] }));
  assert.ok(!h.db.has(b.id)); assert.equal(h.db.size, 3);
  assertFixed(h, h.db.get(a.id), a.summary, 1, general({ startNo: 500 }));
  assertFixed(h, h.db.get(c.id), c.summary, 3, general({ startNo: 500 }));
  assertFixed(h, h.db.get(added.id), added.summary, 2, general({ startNo: 500 }));
  for (const original of [a, c]) assert.equal(h.db.get(original.id).description, original.description);
  assert.equal(h.writes.at(-1).op, 'remove'); assert.equal(h.writes.at(-1).id, b.id);
});

test('legacy title-group series opt-in naming freezes submitted and unseen generated names, migrates grouping only', () => {
  const a = event('a', { summary: '舊課程 (第 1 堂)' }), unseen = event('unseen', { summary: '舊課程 (第 2 堂)', start: { dateTime: '2030-01-01T10:00:00+08:00' }, end: { dateTime: '2030-01-01T11:00:00+08:00' } });
  const h = harness([a, unseen]);
  const result = h.run(save({ seriesId: 'title:舊課程', naming: general(), title: 'Renamed', sessions: [row(undefined, { id: 'a' })] }));
  assert.ok(result.seriesId.startsWith('wc-'));
  for (const [i, original] of [a, unseen].entries()) {
    assertFixed(h, h.db.get(original.id), original.summary, i + 1, general());
    assert.equal(props(h.db.get(original.id)).wcSeries, result.seriesId);
    assert.equal(h.db.get(original.id).description, original.description);
  }
});

test('native recurring series opt-in titles retain native grouping and original IDs', () => {
  const e = lesson('instance', '2026-12-01', 1); e.recurringEventId = 'native'; props(e).wcSeries = 'native';
  const h = harness([e]); h.run(save({ seriesId: 'native', naming: classical(), sessions: [row(undefined, { id: 'instance', title: classicalTitles[0] })] }));
  assertFixed(h, h.db.get('instance'), classicalTitles[0], 1, classical()); assert.equal(h.map(h.db.get('instance')).seriesId, 'native');
});

test('Google hand rename overrides stale custom metadata and is frozen by naming save without title', () => {
  const original = lesson('a', '2026-12-01', 4, { summary: '  同事 Google 最新改名  ' });
  props(original).wcSessionTitle = '舊堂名'; props(original).wcSeriesNaming = JSON.stringify(general());
  const h = harness([original]); assert.equal(h.map(original).sessionTitle, original.summary);
  h.run(save({ naming: classical(), title: 'Changed common name', sessions: [row(undefined, { id: 'a' })] }));
  assertFixed(h, h.db.get('a'), original.summary, 1, classical()); assert.equal(h.db.get('a').description, original.description);
});

for (const titleOnly of [false, true]) test('ordinary update ' + (titleOnly ? 'with titleOnly flag ' : '') + 'preserves wcSeriesNaming verbatim and all unrelated metadata', () => {
  const original = lesson('a', '2026-12-01', 4); props(original).wcSessionTitle = original.summary; delete props(original).wcSessionAutoTitle;
  props(original).wcSeriesNaming = '{"mode":"general","startNo":4,"term":1,"parts":1,"unknown":"PRIVATE: keep stored only"}';
  const h = harness([original]);
  const result = h.run(body({ action: 'update', titleOnly, id: 'a', expectedUpdated: 'v1', preserveTypes: true, title: '  單堂手改  ', ...row() }));
  assert.equal(h.db.get('a').summary, '  單堂手改  '); assert.equal(props(h.db.get('a')).wcSeriesNaming, props(original).wcSeriesNaming);
  assert.equal(props(h.db.get('a')).wcSeriesTitle, 'CS course'); assert.equal(props(h.db.get('a')).wcSessionNo, '4');
  assert.equal(h.db.get('a').description, original.description); assert.equal(props(h.db.get('a')).unrelated, props(original).unrelated);
  assert.deepEqual(result.event.naming, general()); assertPrivate(result.event);
});

test('ordinary update with unchanged exact title preserves every naming property', () => {
  const original = lesson('a', '2026-12-01', 4); props(original).wcSessionTitle = original.summary; delete props(original).wcSessionAutoTitle;
  props(original).wcSeriesNaming = JSON.stringify(general()); const h = harness([original]);
  h.run(body({ action: 'update', id: 'a', preserveTypes: true, title: original.summary, expectedUpdated: 'v1', ...row('2026-12-10') }));
  assert.deepEqual(h.db.get('a').extendedProperties, original.extendedProperties); assert.equal(h.db.get('a').description, original.description);
});

test('typeOnly remains exactly colorId-only and does not change fixed naming, titles, dates, notes or other props', () => {
  const original = lesson('a', '2026-12-01', 4); props(original).wcSessionTitle = original.summary; delete props(original).wcSessionAutoTitle;
  props(original).wcSeriesNaming = JSON.stringify(general()); const h = harness([original]);
  const result = h.run({ action: 'update', typeOnly: true, id: 'a', expectedUpdated: 'v1', type: 'Other' });
  assert.deepEqual(h.writes[0].resource, { colorId: null });
  for (const key of Object.keys(original).filter(k => !['colorId', 'updated'].includes(k))) assert.deepEqual(h.db.get('a')[key], original[key]);
  assert.deepEqual(result.event.naming, general()); assertPrivate(result.event);
});

test('opt-in save retains per-row notes when omitted; explicit row remarks beat shared override and clear only that row', () => {
  const initial = [lesson('a', '2026-12-01', 4), lesson('b', '2026-12-02', 5), lesson('unseen', '2030-01-01', 6)], h = harness(initial);
  h.run(save({ naming: general(), sessions: [row(undefined, { id: 'a', title: initial[0].summary, remark: '' })] }));
  assert.deepEqual(initial.map(e => h.db.get(e.id).description), ['', initial[1].description, initial[2].description]);
  h.run(save({ naming: general(), remark: 'PRIVATE: deliberate common change', sessions: [row(undefined, { id: 'a', remark: 'PRIVATE: explicit row' })] }));
  assert.deepEqual(initial.map(e => h.db.get(e.id).description), ['PRIVATE: explicit row', 'PRIVATE: deliberate common change', 'PRIVATE: deliberate common change']);
  assert.deepEqual(initial.map(e => h.db.get(e.id).summary), initial.map(e => e.summary));
});

test('legacy save after new save keeps fixed names and naming metadata when title/auto/naming omitted', () => {
  const initial = [lesson('a', '2026-12-01', 4), lesson('unseen', '2030-01-01', 5)], h = harness(initial);
  h.run(save({ naming: general(), title: 'New common title' }));
  const namingStrings = initial.map(e => props(h.db.get(e.id)).wcSeriesNaming);
  h.run(save({ title: 'Legacy common rename', sessions: [row('2026-12-10', { id: 'a' }), row('2026-11-30', { title: 'Legacy added custom', remark: '' })] }));
  for (const [i, original] of initial.entries()) {
    const e = h.db.get(original.id); assert.equal(e.summary, original.summary); assert.equal(e.description, original.description);
    assert.equal(props(e).wcSeriesNaming, namingStrings[i]); assert.equal(h.map(e).sessionAutoTitle, undefined);
  }
});

test('no-naming legacy create, convert and save retain auto L renumbering and old 第 N 堂 modes', () => {
  const h = harness(); h.run(body({ action: 'create', sessions: [row(undefined, { autoTitle: true, title: 'ignored' }), row('2026-12-02', { autoTitle: true })] }));
  assert.deepEqual(ordered(h).map(e => e.summary), ['CS course L1', 'CS course L2']);
  assert.ok(ordered(h).every(e => !Object.hasOwn(props(e), 'wcSeriesNaming')));
  const old = harness(); old.run(body({ action: 'create', sessions: [row(), row('2026-12-02')] }));
  assert.deepEqual(ordered(old).map(e => e.summary), ['CS course (第 1 堂)', 'CS course (第 2 堂)']);
  const converted = harness([event()]); converted.run(convert({ sessions: [row(), row('2026-12-02')] }));
  assert.deepEqual(ordered(converted).map(e => e.summary), ['CS course (第 1 堂)', 'CS course (第 2 堂)']);
  const saved = harness([lesson('a', '2026-12-01', 1), lesson('unseen', '2030-01-01', 2)]);
  saved.run(save({ naming: undefined, title: 'Renamed', sessions: [row(undefined, { id: 'a' })] }));
  assert.deepEqual(ordered(saved).map(e => e.summary), ['Renamed L1', 'Renamed L2']); assert.ok(ordered(saved).every(e => saved.map(e).sessionAutoTitle === true));
});

test('old explicit autoTitle:true still overrides custom names after opt-in save, without discarding naming metadata', () => {
  const h = harness([lesson('a', '2026-12-01', 4)]); h.run(save({ naming: general() }));
  h.run(save({ title: 'Legacy changed', sessions: [row(undefined, { id: 'a', autoTitle: true, title: 'ignored' })] }));
  assert.equal(h.db.get('a').summary, 'Legacy changed L1'); assert.equal(props(h.db.get('a')).wcSessionAutoTitle, '1');
  assert.equal(props(h.db.get('a')).wcSessionTitle, undefined); assert.equal(props(h.db.get('a')).wcSeriesNaming, JSON.stringify(general()));
});

test('legacy conversion without naming preserves stored naming properties on source and child copies', () => {
  const original = event(); props(original).wcSeriesNaming = JSON.stringify(classical()); const h = harness([original]);
  h.run(convert({ sessions: [row(), row('2026-12-02')] }));
  assert.ok(ordered(h).every(e => props(e).wcSeriesNaming === props(original).wcSeriesNaming));
});

test('opt-in public feed adds courseNaming:true without removing legacy capabilities; get alone returns notes', () => {
  const h = harness([lesson('a', '2026-12-01', 4)]); h.run(save({ naming: general() })); const feed = h.feed();
  assert.equal(feed.bridgeVersion, '2026-11-18-ilab-v1');
  for (const key of ['sessionTitles', 'convertToSeries', 'saveSeries', 'privateRemarks', 'typeOnly', 'sessionRemarks', 'courseNaming']) assert.equal(feed.capabilities[key], true);
  assert.equal(feed.events[0].hasRemark, true); assert.deepEqual(feed.events[0].naming, general()); assertPrivate(feed);
  const writeCount = h.writes.length;
  assert.deepEqual(h.run({ action: 'get', id: 'a' }), { ok: true, remark: 'PRIVATE: notes-a' }); assert.equal(h.writes.length, writeCount);
});

test('authenticated getSeriesNaming reads unseen past/future members, public fields only, with no lock or Calendar writes', () => {
  const initial = [lesson('past', '2020-01-01', 3), lesson('visible', '2026-12-01', 4), lesson('future', '2030-01-01', 5)];
  for (const e of initial) props(e).wcSeriesNaming = JSON.stringify(general({ notes: 'PRIVATE: hidden naming', extra: { secret: 'PRIVATE: secret' } }));
  const h = harness([...initial, event('foreign'), lesson('cancelled', '2040-01-01', 6, { status: 'cancelled' })]);
  assert.deepEqual(h.feed().events.filter(e => e.seriesId === 'wc-lessons').map(e => e.id), ['visible']);
  const before = clone([...h.db.values()]), queries = [], auth = [], list = h.ctx.Calendar.Events.list;
  h.ctx.Calendar.Events.list = (calendar, options) => { queries.push(clone(options)); return list(calendar, options); };
  h.ctx.LockService.getScriptLock = () => { throw new Error('Read must not access LockService'); };
  h.ctx.UrlFetchApp.fetch = (url, options) => {
    assert.match(url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup\?key=/);
    assert.equal(options.method, 'post'); assert.equal(options.contentType, 'application/json');
    assert.deepEqual(JSON.parse(options.payload), { idToken: 'mock-token' }); auth.push('verified');
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ users: [{ email: 'community@whiteclub.co', emailVerified: true }] }) };
  };
  const result = h.post({ action: 'getSeriesNaming', seriesId: 'wc-lessons', idToken: 'mock-token' });
  assert.deepEqual(result, { ok: true, events: initial.map(h.map) }); assert.deepEqual(auth, ['verified']);
  assert.equal(queries.length, 1); assert.equal(queries[0].timeMin, undefined); assert.equal(queries[0].timeMax, undefined);
  assert.equal(queries[0].privateExtendedProperty, 'wcSeries=wc-lessons');
  for (const e of result.events) { assertPrivate(e); assert.deepEqual(e.naming, general()); assert.equal(e.hasRemark, true); }
  assertPrivate(result); assert.equal(h.writes.length, 0); assert.equal(h.locks.length, 0); assert.deepEqual([...h.db.values()], before);
});

for (const denial of ['missing token', 'expired token', 'unauthorized editor']) test('getSeriesNaming retains Firebase auth: ' + denial, () => {
  const h = harness([lesson('a', '2026-12-01', 4)]), auth = [];
  h.ctx.LockService.getScriptLock = () => { throw new Error('Read must not access LockService'); };
  h.ctx.Calendar.Events.list = () => { throw new Error('Unauthenticated read must not access Calendar'); };
  h.ctx.UrlFetchApp.fetch = (url, options) => {
    auth.push(JSON.parse(options.payload).idToken);
    return { getResponseCode: () => denial === 'expired token' ? 400 : 200, getContentText: () => JSON.stringify(denial === 'expired token'
      ? { error: { message: 'TOKEN_EXPIRED' } } : { users: [{ email: 'other@example.invalid', emailVerified: true }] }) };
  };
  const result = h.post({ action: 'getSeriesNaming', seriesId: 'wc-lessons', ...(denial === 'missing token' ? {} : { idToken: 'mock-token' }) });
  assert.equal(result.ok, false); assert.match(result.error, /登入|權限/); assert.equal(result.events, undefined);
  assert.deepEqual(auth, denial === 'missing token' ? [] : ['mock-token']); assert.equal(h.writes.length, 0); assert.equal(h.locks.length, 0);
});

for (const seriesId of [undefined, null, 1, true, [], {}, '', ' \n\t ', 'wc-missing', 'title:missing', 'native-empty']) test('getSeriesNaming rejects invalid/missing series ' + JSON.stringify(seriesId) + ' as conflict without writes', () => {
  const h = harness([lesson('a', '2026-12-01', 4)]), before = clone([...h.db.values()]);
  assert.throws(() => h.run({ action: 'getSeriesNaming', seriesId }), error => error.conflict === true && /課程/.test(error.message));
  assert.equal(h.writes.length, 0); assert.deepEqual([...h.db.values()], before);
});

for (const code of [404, 410]) test('getSeriesNaming maps missing native series API ' + code + ' to conflict without locking', () => {
  const h = harness(); h.ctx.verifyEditor_ = () => 'community@whiteclub.co';
  h.ctx.Calendar.Events.instances = () => { const error = new Error(code + ' Not Found'); error.code = code; throw error; };
  h.ctx.LockService.getScriptLock = () => { throw new Error('Read must not access LockService'); };
  const result = h.post({ action: 'getSeriesNaming', seriesId: 'native-missing', idToken: 'mock-token' });
  assert.equal(result.ok, false); assert.equal(result.conflict, true); assert.match(result.error, /課程/); assert.equal(h.writes.length, 0);
});

test('getSeriesNaming preserves unexpected Calendar errors rather than reporting deletion', () => {
  const h = harness(); h.ctx.Calendar.Events.list = () => { throw new Error('503 temporary Calendar failure'); };
  assert.throws(() => h.run({ action: 'getSeriesNaming', seriesId: 'wc-lessons' }), error => !error.conflict && /503/.test(error.message));
  assert.equal(h.writes.length, 0);
});

for (const seriesId of ['title:舊課程', 'native']) test('getSeriesNaming supports existing grouping and all-date pagination: ' + seriesId, () => {
  const initial = [lesson('past', '2020-01-01', 4), lesson('future', '2030-01-01', 5)];
  for (const [i, e] of initial.entries()) {
    if (seriesId.startsWith('title:')) { e.summary = '舊課程 (第 ' + (i + 1) + ' 堂)'; delete props(e).wcSeries; }
    else { e.recurringEventId = 'native'; props(e).wcSeries = 'native'; }
  }
  const h = harness(initial), pages = [];
  const paged = (calendar, idOrOptions, maybeOptions) => {
    const options = maybeOptions || idOrOptions; pages.push(clone(options));
    assert.equal(options.timeMin, undefined); assert.equal(options.timeMax, undefined);
    return { items: [clone(initial[options.pageToken ? 1 : 0])], ...(options.pageToken ? {} : { nextPageToken: 'page-2' }) };
  };
  if (seriesId.startsWith('title:')) h.ctx.Calendar.Events.list = paged;
  else { h.ctx.Calendar.Events.instances = paged; h.ctx.Calendar.Events.list = () => ({ items: clone(initial) }); }
  const result = h.run({ action: 'getSeriesNaming', seriesId });
  assert.deepEqual(result, { ok: true, events: initial.map(h.map) }); assert.equal(pages.length, 2); assert.equal(pages[1].pageToken, 'page-2');
  assertPrivate(result); assert.equal(h.writes.length, 0);
});

test('existing authenticated get still returns private notes without locking', () => {
  const h = harness([event()]); h.ctx.verifyEditor_ = token => { assert.equal(token, 'mock-token'); return 'community@whiteclub.co'; };
  h.ctx.LockService.getScriptLock = () => { throw new Error('Existing get must not access LockService'); };
  assert.deepEqual(h.post({ action: 'get', id: 'original', idToken: 'mock-token' }), { ok: true, remark: event().description });
  assert.equal(h.writes.length, 0); assert.deepEqual(h.invalidated, ['ilab_v1_feed_parts', 'feed_parts']);
});

test('doPost malformed JSON naming rejects before writes after mocked auth and releases lock', () => {
  const h = harness(); h.ctx.verifyEditor_ = token => { assert.equal(token, 'mock-token'); return 'community@whiteclub.co'; };
  const result = h.post(body({ action: 'create', idToken: 'mock-token', naming: general({ parts: '2' }), sessions: namedRowsFor('create') }));
  assert.equal(result.ok, false); assert.match(result.error, /命名/); assert.equal(h.writes.length, 0);
  assert.deepEqual(h.locks, [['wait', 30000], ['release']]); assert.deepEqual(h.invalidated, ['ilab_v1_feed_parts', 'feed_parts']);
});

test('doPost still enforces auth before accepting naming; network is explicitly blocked in VM', () => {
  const h = harness();
  const denied = h.post(body({ action: 'create', naming: general(), sessions: namedRowsFor('create') }));
  assert.equal(denied.ok, false); assert.match(denied.error, /登入/); assert.equal(h.writes.length, 0); assert.equal(h.locks.length, 0);
  assert.throws(() => h.ctx.verifyEditor_('attempted-real-token'), /Network\/API use forbidden/);
});

for (const id of ['a', 'unseen', 'deleted']) test('opt-in save conflict on ' + id + ' prevents all writes', () => {
  const h = harness([lesson('a', '2026-12-01', 4), lesson('deleted', '2026-12-02', 5), lesson('unseen', '2030-01-01', 6)]);
  zeroWrites(h, save({ naming: general(), sessions: [row(undefined, { id: 'a', title: 'CS course L4' }), row('2026-12-03', { title: 'CS course L7' })], deletedIds: ['deleted'], expectedUpdates: { [id]: 'stale' } }), /修改/);
});

for (const extra of [
  { sessions: [row(undefined, { id: 'foreign', title: 'new title' })] },
  { deletedIds: ['foreign'] },
  { sessions: [row(undefined, { id: 'a', title: 'new title' })], deletedIds: ['a'] },
]) test('opt-in naming retains series membership/conflicting deletion guards ' + JSON.stringify(extra), () => {
  const h = harness([lesson('a', '2026-12-01', 4), event('foreign')]); zeroWrites(h, save({ naming: general(), ...extra }), /不屬於|同時/);
});

test('opt-in conversion conflict after child insert cleans child only, not Google hand edit or private notes', () => {
  const h = harness([event()], { onGet(id, db, writes) {
    if (id === 'original' && writes.some(w => w.op === 'insert')) {
      db.get(id).updated = 'google-v2'; db.get(id).summary = 'Google hand rename'; db.get(id).description = 'PRIVATE: Google edit';
    }
  } });
  assert.throws(() => h.run(convert({ naming: general(), sessions: namedRowsFor('create') })), error => error.conflict === true);
  assert.equal(h.db.size, 1); assert.equal(h.db.get('original').summary, 'Google hand rename'); assert.equal(h.db.get('original').description, 'PRIVATE: Google edit');
  assert.equal(h.writes.filter(w => w.op === 'patch').length, 0); assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), ['new-1']);
});

test('marked later-original conversion rechecks version after all inserts and cleans only new rows on conflict', () => {
  const h = harness([event()], { onGet(id, db, writes) {
    if (id === 'original' && writes.some(w => w.op === 'insert')) {
      db.get(id).updated = 'google-v2'; db.get(id).summary = 'Google hand rename'; db.get(id).description = 'PRIVATE: Google edit';
    }
  } });
  assert.throws(() => h.run(convert({ naming: general(), sessions: [
    row('2026-11-29', { original: false, title: 'Earlier L5', remark: '' }),
    row('2026-11-30', { original: false, title: 'Earlier L6', remark: '' }), row(undefined, { original: true }),
  ] })), error => error.conflict === true);
  assert.equal(h.db.size, 1); assert.equal(h.db.get('original').summary, 'Google hand rename'); assert.equal(h.db.get('original').description, 'PRIVATE: Google edit');
  assert.deepEqual(h.writes.map(w => w.op), ['insert', 'insert', 'remove', 'remove']);
  assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), ['new-1', 'new-2']);
});

for (const controls of [{ failInsertAt: 2 }, { failPatchId: 'original' }, { failPatchId: 'original', failRemoveId: 'new-1' }]) test('marked original cleanup behavior is unchanged: ' + JSON.stringify(controls), () => {
  const original = event(), h = harness([original], controls);
  assert.throws(() => h.run(convert({ naming: general(), sessions: [
    row('2026-11-29', { original: false, title: 'Earlier L5', remark: '' }), row(undefined, { original: true }),
    row('2026-12-02', { original: false, title: 'Later L6', remark: '' }),
  ] })), error => /injected/.test(error.message) && (!controls.failRemoveId || /未能清理/.test(error.message)));
  assert.deepEqual(h.db.get('original'), original);
  assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), controls.failInsertAt ? ['new-1'] : ['new-1', 'new-2']);
  assert.equal(h.db.size, controls.failRemoveId ? 2 : 1);
});

for (const controls of [{ failInsertAt: 2 }, { failPatchId: 'original' }]) test('opt-in conversion rollback remains best effort: ' + JSON.stringify(controls), () => {
  const initial = [event(), event('foreign')], h = harness(initial, controls);
  const sessions = [...namedRowsFor('create'), row('2026-12-03', { title: 'CS course L6' })];
  assert.throws(() => h.run(convert({ naming: general(), sessions })), /injected/);
  assert.deepEqual([...h.db.values()], initial);
  assert.deepEqual(h.writes.filter(w => w.op === 'remove').map(w => w.id), controls.failInsertAt ? ['new-1'] : ['new-1', 'new-2']);
});

test('opt-in save patch failure does not execute pending deletions', () => {
  const h = harness([lesson('a', '2026-12-01', 4), lesson('b', '2026-12-02', 5), lesson('deleted', '2026-12-03', 6)], { failPatchId: 'b' });
  assert.throws(() => h.run(save({ naming: general(), deletedIds: ['deleted'] })), /injected/);
  assert.equal(h.writes.filter(w => w.op === 'remove').length, 0); assert.ok(h.db.has('deleted'));
});

const offeringNaming = (extra = {}) => classical({ startNo: 17, term: 5, lessonsPerTerm: 4, ...extra });
for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' keeps alternative A/B titles, periods and per-term metadata exact', () => {
  const h = harness(initialFor(action));
  const titles = ['古文 L17・5期・A場', '古文 L17・5期・B場', '古文 L21・6期・A場'];
  const sessions = titles.map((title, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), {
    title, autoTitle: false, remark: 'PRIVATE: offering-' + i,
    ...(action === 'saveSeries' && i === 0 ? { id: 'a' } : {}),
  }));
  const result = h.run({ ...requestFor(action, offeringNaming(), sessions), title: '古文' });
  assert.equal(result.count, sessions.length);
  for (const [i, e] of ordered(h).entries()) {
    assertFixed(h, e, titles[i], i + 1, offeringNaming());
    assert.equal(e.description, 'PRIVATE: offering-' + i);
  }
  const read = h.run({ action: 'getSeriesNaming', seriesId: result.seriesId || 'wc-lessons' });
  assert.equal(read.events.length, sessions.length); read.events.forEach(e => { assert.deepEqual(e.naming, offeringNaming()); assertPrivate(e); });
});
test('partial last period L37/L38 creates only its four requested dates, without padding', () => {
  const h = harness();
  const titles = ['古文 L37・10期・A場', '古文 L37・10期・B場', '古文 L38・10期・A場', '古文 L38・10期・B場'];
  h.run(body({ action: 'create', title: '古文', naming: offeringNaming({ startNo: 37, term: 10 }), sessions: titles.map((title, i) => row('2026-12-' + String(i + 1).padStart(2, '0'), { title })) }));
  assert.equal(h.db.size, titles.length); assert.deepEqual(ordered(h).map(e => e.summary), titles);
});
for (const perTerm of [1, 4, 60]) test('valid per-term count ' + perTerm + ' is persisted; unknown private fields are stripped', () => {
  const h = harness();
  const normalized = clone(h.ctx.normalizeCourseNaming_(offeringNaming({ lessonsPerTerm: perTerm, unknown: 'PRIVATE: excluded' })));
  assert.deepEqual(normalized, offeringNaming({ lessonsPerTerm: perTerm }));
  assert.deepEqual(clone(h.ctx.normalizeCourseNaming_(general({ lessonsPerTerm: perTerm }))), general());
});
for (const perTerm of [undefined, null, 0, -1, 61, 1.5, NaN, Infinity, '4', true, {}, [4]]) {
  for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' rejects invalid per-term count without Calendar writes: ' + String(perTerm), () => {
    const h = harness(initialFor(action));
    zeroWrites(h, requestFor(action, offeringNaming({ lessonsPerTerm: perTerm }), namedRowsFor(action)), /每期堂數/);
  });
}
test('legacy client save retains modern offering metadata and exact titles/private notes', () => {
  const naming = offeringNaming(), initial = lesson('a', '2026-12-01', 1, {
    summary: '古文 L17・5期・A場',
    extendedProperties: { private: { wcSeries: 'wc-lessons', wcSeriesTitle: '古文', wcSessionNo: '1', wcSessionTitle: '古文 L17・5期・A場', wcSeriesNaming: JSON.stringify(naming), unrelated: 'PRIVATE: retained' } },
  });
  const h = harness([initial]); h.run(save({ title: '古文' }));
  assert.equal(h.db.get('a').summary, initial.summary); assert.equal(h.db.get('a').description, initial.description);
  assert.deepEqual(JSON.parse(props(h.db.get('a')).wcSeriesNaming), naming);
  assertPrivate(h.map(h.db.get('a')));
});
test('public Feed declares courseOfferings and retains all previous capabilities', () => {
  const capabilities = harness().feed().capabilities;
  for (const key of ['sessionTitles', 'convertToSeries', 'saveSeries', 'privateRemarks', 'typeOnly', 'sessionRemarks', 'courseNaming', 'courseOfferings']) assert.equal(capabilities[key], true);
});

const logicalIdentity = (extra = {}) => ({ lessonNo: 17, term: 5, offering: 1, ...extra });
for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' keeps manual B identity despite chronological ordinal1 before A', () => {
  const h = harness(initialFor(action));
  const sessions = [
    row('2026-12-01', { title: '手改 B 場名稱', lessonIdentity: logicalIdentity({ offering: 2 }), remark: 'PRIVATE: B', ...(action === 'saveSeries' ? { id: 'a' } : {}) }),
    row('2026-12-03', { title: '古文 L17・5期・A場', lessonIdentity: logicalIdentity(), remark: 'PRIVATE: A' }),
  ];
  const result = h.run({ ...requestFor(action, offeringNaming(), sessions), title: '古文' });
  const events = ordered(h);
  assert.equal(props(events[0]).wcSessionNo, '1'); assert.equal(events[0].summary, '手改 B 場名稱');
  assert.equal(props(events[1]).wcSessionNo, '2');
  for (const [i, e] of events.entries()) {
    const expected = logicalIdentity({ offering: i ? 1 : 2 });
    assert.deepEqual(JSON.parse(props(e).wcLessonIdentity), expected);
    assert.deepEqual(h.map(e).lessonIdentity, expected); assertPrivate(h.map(e));
    assert.equal(e.description, i ? 'PRIVATE: A' : 'PRIVATE: B');
  }
  const read = h.run({ action: 'getSeriesNaming', seriesId: result.seriesId || 'wc-lessons' });
  assert.deepEqual(read.events.map(e => e.lessonIdentity), [logicalIdentity({ offering: 2 }), logicalIdentity()]);
});
test('legacy save preserves independent identity and exact source date/notes without guessing from ordinal', () => {
  const identity = logicalIdentity({ offering: 2 }), initial = lesson('a', '2026-12-01', 1, {
    summary: '手改 B 場名稱',
    extendedProperties: { private: { wcSeries: 'wc-lessons', wcSeriesTitle: '古文', wcSessionNo: '1', wcSessionTitle: '手改 B 場名稱', wcLessonIdentity: JSON.stringify(identity), unrelated: 'PRIVATE: retained' } },
  });
  const h = harness([initial]); h.run(save({ title: '古文' }));
  const e = h.db.get('a'); assert.equal(e.summary, initial.summary); assert.deepEqual(e.start, initial.start); assert.equal(e.description, initial.description);
  assert.deepEqual(h.map(e).lessonIdentity, identity); assert.equal(props(e).unrelated, 'PRIVATE: retained');
});
test('legacy conversion preserves original identity but does not clone it onto newly inserted rows', () => {
  const initial = event('original', { extendedProperties: { private: { wcLessonIdentity: JSON.stringify(logicalIdentity()) } } });
  const h = harness([initial]); h.run(convert({ sessions: [row(), row('2026-12-02')] }));
  assert.deepEqual(h.map(h.db.get('original')).lessonIdentity, logicalIdentity());
  const added = ordered(h).find(e => e.id !== 'original');
  assert.equal(props(added).wcLessonIdentity, undefined); assert.equal(h.map(added).lessonIdentity, undefined);
});
test('identity white list strips unrelated private data; malformed stored identity is omitted from Feed', () => {
  const h = harness();
  assert.deepEqual(clone(h.ctx.normalizeLessonIdentity_(logicalIdentity({ unknown: 'PRIVATE: must not leak' }))), logicalIdentity());
  for (const raw of ['broken', JSON.stringify({ lessonNo: 0, term: 5, offering: 1 }), JSON.stringify({ lessonNo: 17, term: 5, offering: '2' })]) {
    const e = event('bad', { extendedProperties: { private: { wcLessonIdentity: raw } } });
    assert.equal(h.map(e).lessonIdentity, undefined); assertPrivate(h.map(e));
  }
});
const badIdentities = [null, false, 3, 'identity', {}, [], { lessonNo: 17, term: 5 }, logicalIdentity({ lessonNo: 0 }), logicalIdentity({ lessonNo: 10000 }), logicalIdentity({ term: 0 }), logicalIdentity({ term: 1000 }), logicalIdentity({ offering: 0 }), logicalIdentity({ offering: 13 }), logicalIdentity({ offering: 1.5 }), logicalIdentity({ term: '5' }), logicalIdentity({ lessonNo: NaN }), logicalIdentity({ offering: Infinity })];
for (const identity of badIdentities) for (const action of ['create', 'convertToSeries', 'saveSeries']) test(action + ' rejects malformed logical identity with zero Calendar writes: ' + JSON.stringify(identity), () => {
  const h = harness(initialFor(action));
  const sessions = namedRowsFor(action).map(s => ({ ...s, lessonIdentity: identity }));
  zeroWrites(h, requestFor(action, offeringNaming(), sessions), /場次身份/);
});

console.log('\nAll ' + passed + ' offline course-naming checks passed.');
console.log('Bridge: ' + bridgePath);
console.log('Only in-memory Calendar/Utilities/Cache/Lock/ContentService VM mocks were used; network/API access is blocked.');
