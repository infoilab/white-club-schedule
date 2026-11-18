#!/usr/bin/env node
'use strict';
// Offline only: no SDK, browser, HTTP server or real service endpoints are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.split('<script>').at(-1).split('</script>')[0];
const plain = value => JSON.parse(JSON.stringify(value));
const uid = 'mock-community-uid';
const day = '2026-11-18';
let passed = 0;
function pass(label) { console.log(`PASS ${++passed}: ${label}`); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Element {
  constructor(id = '', tag = 'div') {
    this.id = id; this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.handlers = {};
    this.classes = new Set(['hidden']); this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x), toggle: (x, force) => { const yes = force ?? !this.classes.has(x); yes ? this.classes.add(x) : this.classes.delete(x); return yes; } };
  }
  set innerHTML(value) { this.html = value; if (this.tagName === 'TEXTAREA') this.value = String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
  get innerHTML() { return this.html || ''; }
  set className(value) { this.classes = new Set(value.split(/\s+/)); }
  get className() { return [...this.classes].join(' '); }
  append(...xs) { this.children.push(...xs); xs.forEach(x => { x.parent = this; }); }
  appendChild(x) { this.append(x); return x; }
  prepend(x) { this.children.unshift(x); }
  replaceChildren(...xs) { this.children = xs; this.html = ''; }
  remove() { this.removed = true; }
  setAttribute(key, value) { this[key] = value; }
  getAttribute(key) { return this[key]; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  getBoundingClientRect() { return { height: 100, width: 220 }; }
  focus() {}
  click() { return Promise.all((this.handlers.click || []).map(fn => fn({ target: this, stopPropagation() {}, preventDefault() {} }))); }
}
function harness({ test = false, legacy = false, root: suppliedRoot, collections: suppliedCollections } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  get('roster-f1-hours').value = '11a-7p'; get('roster-f2-hours').value = '12p-9p';
  const storage = new Map([
    ['wc_events_data', JSON.stringify([{ id: 'old-event', remark: 'old secret' }])],
    ['wc_roster_data', JSON.stringify({ '2026-10-01': { floor1: 'OLD LOCAL' } })],
    ['ilab_test_v1:wc_events_data', JSON.stringify([{ id: 'test-event' }])],
    ['ilab_test_v1:wc_roster_data', JSON.stringify({ '2026-10-02': { floor1: 'TEST LOCAL' } })],
    ['ilab_live_v1:wc_roster_data', JSON.stringify({ '2026-10-03': { floor1: 'STALE LIVE CACHE' } })]
  ]);
  const storageReads = [], storageWrites = [], storageDeletes = [], requests = [], reads = [], writes = [], timers = new Map();
  let timerId = 0, renders = 0, root = suppliedRoot === undefined ? {
    storageMode: 'records', schemaVersion: 2, revision: 273, ownerUid: uid, ownerEmail: 'community@whiteclub.co',
    counts: { events: 497, rosterDays: 1, settings: 1, futureCount: 9 }, migrationInProgress: false,
    unknownRoot: { kept: true }, payload: { eventsData: [{ id: 'never-copy' }], futurePayload: 'kept' }
  } : suppliedRoot;
  const collections = suppliedCollections || {
    rosterDays: { [day]: { record: { floor1: 'Server staff', floor2: '', all: '', unknownDay: { kept: true } }, recordKey: day, unknownWrapper: 'kept' } },
    settings: { main: { record: { rosterF1Hours: '11a-7p', rosterF2Hours: '12p-9p', unknownSetting: { kept: true } }, futureWrapper: 'kept' } }
  };
  let listener, listenerError, getHook, transactionHook, fetchHook;
  const snapshot = (value, metadata = {}) => ({ exists: value != null, data: () => value == null ? undefined : plain(value), metadata: { fromCache: false, hasPendingWrites: false, ...metadata } });
  const rootRef = {
    path: `whiteClubData/${uid}`,
    async get(options) { assert.equal(options?.source, 'server'); reads.push('root'); if (getHook) await getHook(); return snapshot(root); },
    collection(name) {
      assert.ok(['rosterDays', 'settings'].includes(name), `Forbidden collection ${name}`);
      return {
        async get(options) { assert.equal(options?.source, 'server'); reads.push(name); const docs = Object.entries(collections[name] || {}).map(([id, value]) => ({ id, data: () => plain(value) })); return { docs, metadata: { fromCache: false }, forEach: cb => docs.forEach(cb) }; },
        doc(id) { return { path: `${rootRef.path}/${name}/${id}`, collectionName: name, id }; }
      };
    },
    onSnapshot(fn, error) { listener = fn; listenerError = error; return () => { listener = null; listenerError = null; }; }
  };
  const db = {
    collection(name) { assert.equal(name, 'whiteClubData'); return { doc(id) { assert.equal(id, uid); return rootRef; } }; },
    async runTransaction(fn) {
      const staged = [];
      const tx = {
        async get(ref) { assert.equal(ref, rootRef); reads.push('transaction.root'); if (transactionHook) await transactionHook(); return snapshot(root); },
        set(ref, value, options) { assert.notEqual(ref, rootRef, 'Root must use update, never set'); staged.push({ action: 'set', ref, value: plain(value), options }); },
        delete(ref) { assert.notEqual(ref, rootRef); staged.push({ action: 'delete', ref }); },
        update(ref, value) { assert.equal(ref, rootRef); staged.push({ action: 'update', ref, value: plain(value) }); }
      };
      const result = await fn(tx);
      for (const op of staged) {
        writes.push({ action: op.action, path: op.ref.path, value: op.value });
        if (op.action === 'update') {
          for (const [key, value] of Object.entries(op.value)) {
            assert.ok(['clientId', 'revision', 'counts.rosterDays', 'counts.settings', 'changes', 'updatedAt', 'payload.rosterData', 'payload.settings'].includes(key), `Unsafe root update ${key}`);
            const parts = key.split('.'); let obj = root;
            parts.slice(0, -1).forEach(part => { obj = obj[part] ||= {}; }); obj[parts.at(-1)] = value;
          }
        } else if (op.action === 'delete') delete collections[op.ref.collectionName][op.ref.id];
        else (collections[op.ref.collectionName] ||= {})[op.ref.id] = op.value;
      }
      return result;
    }
  };
  const context = {
    console: { log() {}, warn() {}, error() {} }, Date, URLSearchParams, AbortController, Blob,
    crypto: require('node:crypto').webcrypto,
    location: { hostname: 'offline.invalid', search: '' },
    document: { getElementById: get, createElement: tag => new Element('', tag), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: new Element('body'), hidden: false },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    fetch: async (url, options = {}) => { requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined }); if (fetchHook) return fetchHook(url, options); throw new Error('Unmocked HTTP request blocked'); },
    firebase: { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' } }) }
  };
  context.window = context;
  context.window.localStorage = { getItem(key) { storageReads.push(key); return storage.get(key) ?? null; }, setItem(key, value) { storageWrites.push(key); storage.set(key, value); }, removeItem(key) { storageDeletes.push(key); storage.delete(key); } };
  context.window.addEventListener = () => {}; context.window.matchMedia = () => ({ matches: false }); context.window.confirm = () => true;
  vm.createContext(context);
  const code = source.replace(/const ILAB_TEST_MODE = (?:true|false);/, `const ILAB_TEST_MODE = ${test};`);
  vm.runInContext(legacy ? code.replace(/const CALENDAR_FEED_URL = '[^']*';/, "const CALENDAR_FEED_URL = '';") : code, context);
  vm.runInContext('renderCurrentView = () => __render(); cloudDb = __db;', Object.assign(context, { __render: () => renders++, __db: db }));
  const run = code => vm.runInContext(code, context);
  context.__user = { uid, email: 'community@whiteclub.co', emailVerified: true, getIdToken: async () => 'FAKE_ID_TOKEN' };
  return {
    run, context, elements, get, requests, reads, writes, storage, storageReads, storageWrites, storageDeletes, timers, collections,
    root: () => root, setRoot(value) { root = value; }, setGetHook(fn) { getHook = fn; }, setTransactionHook(fn) { transactionHook = fn; }, setFetchHook(fn) { fetchHook = fn; },
    login: () => run('handleFirebaseUser(__user)'), logout: () => run('handleFirebaseUser(null)'),
    async emit(metadata) { assert.ok(listener); listener(snapshot(root, metadata)); await run('formalListenerQueue'); },
    async listenerFail() { listenerError(new Error('fake listener failure')); await new Promise(resolve => setImmediate(resolve)); },
    async flushDelay(delay) { const chosen = [...timers].filter(([, t]) => t.delay === delay); for (const [id, t] of chosen) { timers.delete(id); await t.fn(); } await new Promise(resolve => setImmediate(resolve)); },
    renders: () => renders
  };
}
async function main() {
  new vm.Script(source);
  assert.match(html, /const ILAB_TEST_MODE = (?:true|false);/);
  assert.match(html, /const FORMAL_FEED = FEED_MODE && !ILAB_TEST_MODE;/);
  pass('shipping flag is explicit; formal and isolated modes are independently mocked; full inline JS syntax valid');
  const h = harness();
  assert.equal(h.run('FORMAL_FEED'), true);
  assert.equal(h.run('APP_STORAGE_PREFIX'), 'ilab_live_v1:');
  assert.deepEqual(plain(h.run('eventsData')), []); assert.deepEqual(plain(h.run('rosterData')), {});
  assert.ok(!h.storageReads.some(key => /wc_events_data|wc_roster_data/.test(key)));
  assert.deepEqual(h.storageDeletes, []);
  assert.equal(await h.login(), true);
  assert.equal(h.run('cloudSyncReady'), true);
  assert.equal(h.run('rosterData["2026-11-18"].floor1'), 'Server staff');
  assert.deepEqual(h.writes, []);
  assert.ok(h.reads.every(name => ['root', 'rosterDays', 'settings'].includes(name)));
  assert.equal(h.run('cloudSyncTimer'), null);
  await h.run('initializeOrMergeCloudSync()'); await h.run('loadCloudStateToLocal()');
  assert.deepEqual(h.writes, []);
  await assert.rejects(h.run('replaceCloudWithRecordCollections({})'), /禁止/);
  assert.throws(() => h.run('getCloudCollectionRef("events")'), /禁止/);
  assert.deepEqual(plain(h.run('buildCloudDiff({eventsData:[{id:"old"}],rosterData:{},settings:{}},{eventsData:[],rosterData:{},settings:{}}).operations')), []);
  assert.equal(h.run('importFullBackup({})'), false);
  assert.deepEqual(h.writes, []);
  pass('fresh formal session ignores all old/test/local seeds; records load/old merge entrances perform zero writes');

  h.run('rosterData["2026-11-18"].floor1 = "Edited staff"; document.getElementById("roster-f1-hours").value = "10a-8p"; persistAllData();');
  assert.ok(!h.storageWrites.some(key => key.endsWith('wc_events_data')));
  assert.equal(await h.run('runCloudSyncWrite()'), true);
  const root = h.root();
  assert.equal(root.counts.events, 497); assert.equal(root.counts.futureCount, 9); assert.deepEqual(root.unknownRoot, { kept: true });
  assert.equal(root.storageMode, 'records'); assert.equal(root.schemaVersion, 2); assert.deepEqual(root.payload.eventsData, [{ id: 'never-copy' }]);
  assert.deepEqual(h.collections.settings.main.record.unknownSetting, { kept: true }); assert.equal(h.collections.settings.main.futureWrapper, 'kept');
  assert.deepEqual(h.collections.rosterDays[day].record.unknownDay, { kept: true }); assert.equal(h.collections.rosterDays[day].unknownWrapper, 'kept');
  assert.equal(h.collections.settings.main.record.rosterF1Hours, '10a-8p');
  assert.ok(h.writes.every(op => !/\/events\//.test(op.path)));
  assert.deepEqual(h.writes.filter(op => op.action === 'update').flatMap(op => Object.keys(op.value)).sort(), ['changes', 'clientId', 'counts.rosterDays', 'counts.settings', 'revision', 'updatedAt'].sort());
  pass('records transaction uses specific root update, preserves events/counts/unknown metadata/settings/day wrappers');

  const legacyRoot = { revision: 4, schemaVersion: 1, unknown: 'root', payload: { rosterData: { [day]: { floor1: 'Legacy' } }, settings: { rosterF1Hours: '11a-7p', unknownSetting: 'kept' }, unknownPayload: 'kept' } };
  const l = harness({ root: legacyRoot });
  assert.equal(await l.login(), true); assert.deepEqual(l.writes, []); assert.ok(l.reads.every(name => name === 'root'));
  l.root().payload.eventsData = [{ id: 'preserve-event', remark: 'private old data' }];
  l.run('rosterData["2026-11-18"].floor1 = "Legacy edit"');
  assert.equal(await l.run('runCloudSyncWrite()'), true);
  assert.deepEqual(l.root().payload.eventsData, [{ id: 'preserve-event', remark: 'private old data' }]);
  assert.equal(l.root().payload.unknownPayload, 'kept'); assert.equal(l.root().payload.settings.unknownSetting, 'kept'); assert.equal(l.root().unknown, 'root');
  assert.equal(l.root().schemaVersion, 1); assert.equal(l.root().storageMode, undefined);
  assert.ok(l.writes.every(op => op.action === 'update' && !Object.keys(op.value).includes('payload')));
  pass('legacy root loads without eventsData; writes same schema with dotted roster/settings only, no collections');

  for (const badRoot of [null, {}, { storageMode: 'records', revision: 1, migrationInProgress: true }, { storageMode: 'records', revision: 'bad' }, { payload: { rosterData: [], settings: {} } }]) {
    const bad = harness({ root: badRoot }); assert.equal(await bad.login(), false); assert.equal(bad.run('cloudSyncReady'), false); assert.deepEqual(bad.writes, []); assert.deepEqual(plain(bad.run('rosterData')), {});
    await bad.run('initializeOrMergeCloudSync()'); assert.deepEqual(bad.writes, []);
  }
  pass('missing/malformed/migration-busy roots fail closed, never seed or migrate');

  const retry = harness(); let count = 0;
  retry.setGetHook(() => { if (++count === 2) retry.root().revision++; });
  assert.equal(await retry.login(), true); assert.equal(count, 4); assert.deepEqual(retry.writes, []);
  const unstable = harness(); unstable.setGetHook(() => { unstable.root().revision++; });
  assert.equal(await unstable.login(), false); assert.equal(unstable.reads.filter(x => x === 'root').length, 6); assert.deepEqual(unstable.writes, []);
  pass('root-records-root revision stability retries, bounded at three attempts');

  const stale = harness(); await stale.login(); stale.root().revision++; stale.run('rosterData["2026-11-18"].floor1 = "Draft"');
  assert.equal(await stale.run('runCloudSyncWrite()'), false); assert.deepEqual(stale.writes, []); assert.equal(stale.run('cloudSyncReady'), false); assert.equal(stale.run('rosterData["2026-11-18"].floor1'), 'Draft');
  const authRace = harness(); await authRace.login(); authRace.run('rosterData["2026-11-18"].floor1 = "No commit"'); authRace.setTransactionHook(() => authRace.logout());
  assert.equal(await authRace.run('runCloudSyncWrite()'), false); assert.deepEqual(authRace.writes, []);
  const loadRace = harness(); loadRace.setGetHook(() => loadRace.logout()); assert.equal(await loadRace.login(), false); assert.deepEqual(plain(loadRace.run('rosterData')), {}); assert.deepEqual(loadRace.writes, []);
  const rejected = harness(); rejected.context.__user.email = 'other@example.invalid'; assert.equal(await rejected.login(), undefined); assert.deepEqual(rejected.reads, []); assert.deepEqual(rejected.writes, []);
  pass('stale revision, auth drop during transaction/load, and unapproved email cannot write or apply stale data');

  const bulk = harness(); await bulk.login(); bulk.run('for (let i=0;i<451;i++) rosterData[formatDateYMD(new Date(2030,0,i+1))] = {floor1:"x"};');
  assert.equal(await bulk.run('runCloudSyncWrite()'), false); assert.deepEqual(bulk.writes, []);
  pass('more than 450 roster operations rejected before transaction');

  const listen = harness(); await listen.login(); listen.run('rosterData["2026-11-18"].floor1 = "Local draft"; persistAllData();');
  listen.root().revision++; listen.root().counts.events++;
  await listen.emit(); assert.equal(listen.run('cloudSyncReady'), true); assert.equal(listen.run('rosterData["2026-11-18"].floor1'), 'Local draft');
  listen.root().revision++; listen.collections.rosterDays[day].record.floor1 = 'Remote staff';
  await listen.emit(); assert.equal(listen.run('cloudSyncReady'), false); assert.equal(listen.run('cloudSyncTimer'), null); assert.equal(listen.run('rosterData["2026-11-18"].floor1'), 'Local draft'); assert.match(listen.get('cloud-sync-error').textContent, /草稿|唯讀/);
  assert.deepEqual(listen.writes, []);
  pass('serialized listener ignores event-only metadata changes, protects dirty roster draft, pauses with readonly recovery');

  const eventModal = harness(); await eventModal.login(); eventModal.get('modal-event-editor').classList.remove('hidden'); eventModal.root().revision++; eventModal.collections.rosterDays[day].record.floor1 = 'Remote okay';
  await eventModal.emit(); assert.equal(eventModal.run('cloudSyncReady'), true); assert.equal(eventModal.run('rosterData["2026-11-18"].floor1'), 'Remote okay');
  const rosterModal = harness(); await rosterModal.login(); rosterModal.get('modal-personal-shift').classList.remove('hidden'); rosterModal.root().revision++; rosterModal.collections.rosterDays[day].record.floor1 = 'Remote conflict';
  await rosterModal.emit(); assert.equal(rosterModal.run('cloudSyncReady'), false);
  pass('only roster-editable modal causes roster conflict; event editor does not');

  const race = harness(); await race.login(); const gate = deferred(); race.setTransactionHook(() => gate.promise); race.run('rosterData["2026-11-18"].floor1 = "Write one"'); const writing = race.run('runCloudSyncWrite()');
  await new Promise(resolve => setImmediate(resolve)); race.root().revision++; // Deliberately stale before transaction resumes.
  const observing = race.emit(); gate.resolve(); assert.equal(await writing, false); await observing; assert.equal(race.run('cloudSyncReady'), false); assert.deepEqual(race.writes, []);
  pass('listener/write promise race does not accept stale commit or overwrite draft');

  const notes = harness(); notes.run(`feedEvents = [{id:'note',sourceId:'note',updated:'v1',date:'${day}',title:'Private note',type:'Event',venues:['2F'],startTime:'12:00',endTime:'13:00',hasRemark:true,remark:'UNTRUSTED PUBLIC',desc:'UNTRUSTED DESCRIPTION'}];`);
  assert.equal(notes.run('getTimelineRemarkText(feedEvents[0])'), ''); await assert.rejects(notes.run('loadRemark(feedEvents[0])'), /登入/); assert.equal(notes.requests.length, 0);
  await notes.login(); const response = deferred(); notes.setFetchHook(() => response.promise);
  const one = notes.run('loadRemark(feedEvents[0])'), two = notes.run('loadRemark(feedEvents[0])'); assert.equal(one, two);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(notes.requests.length, 1); assert.equal(notes.requests[0].options.method, 'POST'); assert.deepEqual(notes.requests[0].body, { action: 'get', id: 'note', idToken: 'FAKE_ID_TOKEN' }); assert.ok(!notes.requests[0].url.includes('?'));
  response.resolve({ ok: true, json: async () => ({ ok: true, remark: 'Line 1<br>Line 2 &amp; safe' }) });
  assert.equal(await one, 'Line 1\nLine 2 & safe'); assert.equal(notes.run('getTimelineRemarkText(feedEvents[0])'), 'Line 1\nLine 2 & safe');
  const card = notes.run('makeTimelineEventCard(feedEvents[0])'); assert.equal(card.children[0].children.at(-1).textContent, '備註：Line 1\nLine 2 & safe');
  assert.ok(![...notes.storage.values()].some(value => value.includes('Line 1')));
  notes.run('openSimpleSyncModal()'); assert.match(notes.get('modal-login-sync').innerHTML, /simple-roster-reload/);
  await notes.logout(); assert.equal(notes.run('remarkCache.size'), 0); assert.equal(notes.run('getTimelineRemarkText(feedEvents[0])'), ''); assert.equal(notes.run('cloudSyncTimer'), null); assert.ok(notes.renders() > 0);
  assert.equal(notes.storage.get('ilab_test_v1:wc_roster_data'), JSON.stringify({ '2026-10-02': { floor1: 'TEST LOCAL' } }));
  pass('private remarks require approved auth, use POST/inflight dedup, render full DOM text from memory only; logout wipes private text not test data');

  const failure = harness(); await failure.login(); failure.run(`feedEvents = [{id:'fail',sourceId:'fail',updated:'v1',date:'${day}',hasRemark:true}];`); failure.setFetchHook(async () => { throw new Error('Fake get failure'); });
  await assert.rejects(failure.run('loadRemark(feedEvents[0])'), /failure/); assert.equal(failure.run('remarkCache.size'), 0); await assert.rejects(failure.run('loadRemark(feedEvents[0])'), /稍後/); assert.equal(failure.requests.length, 1);
  const old = harness(); await old.login(); old.run(`feedEvents = [{id:'old',sourceId:'old',updated:'v1',date:'${day}',hasRemark:true}];`); const oldResponse = deferred(); old.setFetchHook(() => oldResponse.promise); const pending = old.run('loadRemark(feedEvents[0])'); await new Promise(resolve => setImmediate(resolve)); old.run('feedEvents[0].updated = "v2"'); oldResponse.resolve({ ok: true, json: async () => ({ ok: true, remark: 'Stale secret' }) }); await assert.rejects(pending, /版本已更新/); assert.equal(old.run('remarkCache.size'), 0);
  const dropped = harness(); await dropped.login(); dropped.run(`feedEvents = [{id:'drop',sourceId:'drop',updated:'v1',date:'${day}',hasRemark:true}];`); const late = deferred(); dropped.setFetchHook(() => late.promise); const lateTask = dropped.run('loadRemark(feedEvents[0])'); await new Promise(resolve => setImmediate(resolve)); await dropped.logout(); late.resolve({ ok: true, json: async () => ({ ok: true, remark: 'Late secret' }) }); await assert.rejects(lateTask, /登入狀態/); assert.equal(dropped.run('remarkCache.size'), 0); assert.equal(dropped.run('remarkCooldown.size'), 0);
  const timeout = harness(); await timeout.login(); timeout.run(`feedEvents = [{id:'timeout',sourceId:'timeout',updated:'v1',date:'${day}',hasRemark:true}];`); timeout.setFetchHook(() => new Promise(() => {})); const timed = timeout.run('loadRemark(feedEvents[0])'); const timedCheck = assert.rejects(timed, /逾時/); await timeout.flushDelay(12000); await timedCheck; assert.equal(timeout.run('remarkCache.size'), 0);
  pass('failed/timeout/stale-version/auth-dropped remark reads never cache empty or private text; cooldown prevents repeated requests');

  const prefetch = harness(); await prefetch.login(); prefetch.run(`currentStartDate = parseYMD('${day}'); feedEvents = Array.from({length:7},(_,i)=>({id:'p'+i,sourceId:'p'+i,updated:'v1',date:'${day}',hasRemark:true}));`);
  const waiting = []; let active = 0, maxActive = 0;
  prefetch.setFetchHook(() => { const item = deferred(); waiting.push(item); active++; maxActive = Math.max(maxActive, active); return item.promise.finally(() => active--); });
  const work = prefetch.run('prefetchVisiblePrivateRemarks()');
  for (let i = 0; i < 30 && prefetch.run('remarkCache.size') < 7; i++) {
    await new Promise(resolve => setImmediate(resolve)); waiting.splice(0).forEach(item => item.resolve({ ok: true, json: async () => ({ ok: true, remark: 'Private prefetch' }) }));
  }
  await work; assert.equal(maxActive, 3); assert.equal(prefetch.requests.length, 7); assert.equal(prefetch.run('remarkCache.size'), 7);
  await prefetch.run('prefetchVisiblePrivateRemarks()'); assert.equal(prefetch.requests.length, 7);
  prefetch.run('feedEvents = Array.from({length:600},(_,i)=>({id:"cap"+i,sourceId:"cap"+i,updated:"v1"})); feedEvents.forEach(ev=>remarkCache.set(remarkKey(ev), "x")); prunePrivateRemarks();'); assert.equal(prefetch.run('remarkCache.size'), 512);
  pass('visible-range remark prefetch bounded to three workers, same-key dedup, cache capped/pruned at 512');

  const bridge = harness(); await bridge.login(); await assert.rejects(bridge.run('sendCalendarWrite({action:"convertToSeries"})'), /尚未確認支援/); assert.equal(bridge.requests.length, 0);
  bridge.setFetchHook(async () => ({ ok: true, json: async () => ({ ok: true }) })); bridge.run('applyFeedPayload({events:[],capabilities:{convertToSeries:true,contractVersion:"2026-11-18-ilab-v1"}})');
  for (const action of ['update', 'saveSeries', 'convertToSeries']) { bridge.context.__action = action; await bridge.run('sendCalendarWrite({action:__action,expectedUpdates:{a:"v1",deleted:"v2"}})'); assert.equal(bridge.requests.at(-1).body.preserveTypes, true); }
  await bridge.run('sendCalendarWrite({action:"create",type:"Event"})'); assert.equal(bridge.requests.at(-1).body.preserveTypes, undefined); assert.equal(bridge.requests.at(-1).body.type, 'Event');
  const safe = plain(bridge.run('publicFeedPayload({ok:true,events:[{id:"pub",remark:"SECRET",desc:"SECRET",description:"SECRET",attendees:["SECRET"],hasRemark:true}]})'));
  assert.deepEqual(safe.events, [{ id: 'pub', hasRemark: true }]);
  const reusablePath = path.join(__dirname, '..', '..', 'white-club-ui-tests', 'booking-editor.js');
  const editor = source.slice(source.indexOf('    function buildWeeklyBookingPlan('), source.indexOf('    function openAttentionModal(')).trim();
  assert.match(editor, /expectedUpdates = Object\.fromEntries\(existingSessions\.map\(session => \[session\.id, session\.updated \|\| null\]\)\)/);
  assert.match(editor, /action: 'saveSeries', seriesId: src\.seriesId, preserveTypes: true, expectedUpdates/);
  assert.match(editor, /deletedIds: \[\.\.\.deletedIds\]/); assert.match(editor, /if \(!remarkLoaded\) return undefined/);
  assert.match(editor, /feedBridgeCapabilities\.convertToSeries !== true/);
  if (fs.existsSync(reusablePath)) assert.equal(fs.readFileSync(reusablePath, 'utf8').trim(), editor);
  assert.ok(!/loadRemark\(/.test(source.slice(source.indexOf('    function makeTimelineEventCard('), source.indexOf('    function createTimelineFloorColumn('))));
  pass('bridge capability gating, update/save/convert preserveTypes, expectedUpdates including deleted originals, reusable editor exact match, no requests during card measurement');

  const publicLoad = harness(); publicLoad.setFetchHook(async () => ({ ok: true, json: async () => ({ ok: true, capabilities: {convertToSeries:true,contractVersion:'2026-11-18-ilab-v1'}, events: [{id:'pub-cache',title:'Public title',date:day,updated:'v1',hasRemark:true,remark:'PRIVATE_FEED_LEAK',desc:'PRIVATE_FEED_LEAK'}] }) }));
  await publicLoad.run('fetchCalendarFeed()');
  assert.equal(publicLoad.run('feedBridgeCapabilities.convertToSeries'), true);
  assert.equal(publicLoad.run('feedEvents[0].remark'), undefined);
  assert.ok(![...publicLoad.storage.values()].some(value => value.includes('PRIVATE_FEED_LEAK')));
  assert.ok(publicLoad.storage.has('ilab_live_v1:wc_feed_cache'));
  assert.equal(publicLoad.requests.length, 1); assert.equal(publicLoad.requests[0].options.method, undefined);
  publicLoad.setFetchHook(async () => ({ok:true,json:async()=>({ok:true})}));
  await publicLoad.run('fetchCalendarFeed()'); assert.equal(publicLoad.run('feedEvents[0].id'), 'pub-cache'); assert.ok(publicLoad.run('feedLastError'));
  pass('actual mocked public Feed success strips private fields; malformed feed fails without clearing confirmed events');

  const capped = harness(); await capped.login(); capped.run(`currentStartDate=parseYMD('${day}'); feedEvents=Array.from({length:600},(_,i)=>({id:'limit'+i,sourceId:'limit'+i,updated:'v1',date:'${day}',hasRemark:true})); feedEvents.slice(0,512).forEach(ev=>remarkCache.set(remarkKey(ev),'cached'));`);
  capped.setFetchHook(async () => { throw new Error('Must not request evicted overflow'); });
  await capped.run('prefetchVisiblePrivateRemarks()'); assert.equal(capped.requests.length, 0);
  pass('more than 512 visible sources does not fill evicted overflow or trigger perpetual remark requests');

  const ownRace = harness(); await ownRace.login(); const ownGate = deferred(); ownRace.setTransactionHook(()=>ownGate.promise); ownRace.run('rosterData["2026-11-18"].floor1="Committed own edit"'); const ownWriting=ownRace.run('runCloudSyncWrite()');
  await new Promise(resolve => setImmediate(resolve)); const ownListening=ownRace.emit(); ownGate.resolve(); assert.equal(await ownWriting,true); await ownListening;
  assert.equal(ownRace.run('rosterData["2026-11-18"].floor1'),'Committed own edit'); assert.equal(ownRace.run('cloudSyncReady'),true); assert.equal(ownRace.writes.filter(op=>op.action==='update').length,1);
  pass('own snapshot queued while transaction is in flight accepts committed baseline exactly once');

  const tokenDrop = harness(); await tokenDrop.login(); const tokenGate=deferred(); tokenDrop.context.__user.getIdToken=()=>tokenGate.promise;
  const tokenWrite=tokenDrop.run('sendCalendarWrite({action:"update",id:"never-send"})'); const tokenCheck=assert.rejects(tokenWrite,/登入狀態/); await tokenDrop.logout(); tokenGate.resolve('FAKE_LATE_TOKEN'); await tokenCheck; assert.equal(tokenDrop.requests.length,0);
  pass('auth drop while obtaining ID token blocks Calendar POST before transmission');

  const test = harness({ test: true }); assert.equal(test.run('FORMAL_FEED'), false); assert.equal(test.run('APP_STORAGE_PREFIX'), 'ilab_test_v1:'); assert.equal(test.run('isCombinedLoginComplete()'), true); assert.deepEqual(test.requests, []);
  const nonFeed = harness({ legacy: true }); assert.equal(nonFeed.run('FEED_MODE'), false); assert.equal(nonFeed.run('eventsData[0].id'), 'old-event'); assert.ok(nonFeed.storageReads.includes('wc_events_data'));
  pass('isolated test mode and empty-feed legacy storage paths remain available');
  console.log(`\n${passed} offline production-frontend checks passed. No live service tested or contacted.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
