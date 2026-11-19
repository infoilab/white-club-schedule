#!/usr/bin/env node
'use strict';
// Entirely offline: mock Calendar/Utilities only; no network, tokens or business data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bridge = require(path.join(root, 'apps-script', 'Code.gs'));
const clone = value => JSON.parse(JSON.stringify(value));
const items = new Map();
const writes = [];
let serial = 0;
global.Utilities = { getUuid: () => '12345678-1234-4567-89ab-123456789abc' };
global.Calendar = { Events: {
  get(calendar, id) { assert.equal(calendar, 'primary'); assert.ok(items.has(id)); return clone(items.get(id)); },
  insert(resource, calendar) { assert.equal(calendar, 'primary'); const event = { ...clone(resource), id: 'mock-child-' + (++serial), updated: 'v2' }; items.set(event.id, event); writes.push(['insert', event.id]); return clone(event); },
  patch(resource, calendar, id) { assert.equal(calendar, 'primary'); assert.ok(items.has(id)); const event = { ...items.get(id), ...clone(resource), updated: 'v2' }; items.set(id, event); writes.push(['patch', id]); return clone(event); },
  remove(calendar, id) { assert.equal(calendar, 'primary'); writes.push(['remove', id]); items.delete(id); }
} };
const original = {
  id: 'original', summary: '原活動', updated: 'v1', colorId: '6', location: 'White Club 1S', description: '原有備註',
  start: { dateTime: '2026-11-18T14:00:00+08:00' }, end: { dateTime: '2026-11-18T15:00:00+08:00' }
};
items.set(original.id, clone(original));
const line = html.split('\n').find(line => line.trim().startsWith(": { action: 'convertToSeries'"));
assert.ok(line, 'Actual editor conversion expression must exist');
const expression = line.trim().slice(2, -1);
const sessions = [
  { id: 'original', title: '', date: '2026-11-18', startTime: '14:00', endTime: '15:00' },
  { id: undefined, title: '第二堂自訂名稱', date: '2026-11-25', startTime: '14:00', endTime: '15:00' },
  { id: undefined, title: '', date: '2026-12-02', startTime: '14:00', endTime: '15:00' }
];
const payload = clone(vm.runInNewContext('(' + expression + ')', {
  src: { id: 'original', updated: 'v1' }, sessions, allDay: false,
  common: { title: '系列課程', type: 'Visit', venues: ['1S'], remark: undefined }, stripSessionNo: bridge.stripSessionNo
}));
assert.equal(payload.id, 'original');
assert.ok(payload.sessions.every(session => !Object.hasOwn(session, 'id')), 'Conversion rows must not carry existing IDs');
assert.equal(payload.sessions[1].title, '第二堂自訂名稱');
const result = bridge.handleWrite_(payload);
assert.equal(result.ok, true);
assert.equal(items.size, 3);
assert.equal(writes.filter(([action]) => action === 'insert').length, 2);
assert.deepEqual(writes.at(-1), ['patch', 'original']);
assert.ok(items.has('original'));
assert.ok([...items.values()].every(event => event.colorId === '1' && event.description === '原有備註'));
assert.equal(items.get('mock-child-1').summary, '第二堂自訂名稱');
console.log('PASS: actual editor conversion payload accepted by bridge; original ID retained, two new IDs, selected type color and notes preserved');
for (const oldCustom of ['', '舊自訂堂名']) {
  const event = clone(items.get('original'));
  event.extendedProperties.private.wcSeriesTitle = '系列課程';
  event.extendedProperties.private.wcSessionNo = '1';
  if (oldCustom) event.extendedProperties.private.wcSessionTitle = oldCustom;
  else delete event.extendedProperties.private.wcSessionTitle;
  event.summary = '同事在 Google 最新修改的堂名';
  const mapped = bridge.mapEvent(event, bridge.CONFIG);
  assert.equal(mapped.title, event.summary);
  assert.equal(mapped.sessionTitle, event.summary, 'Feed must not return old custom metadata or an empty generated title');
  assert.ok(!Object.hasOwn(mapped, 'remark') && !Object.hasOwn(mapped, 'description'));
}
const generated = clone(items.get('original'));
generated.summary = '系列課程 (第 1 堂)';
delete generated.extendedProperties.private.wcSessionTitle;
assert.ok(!Object.hasOwn(bridge.mapEvent(generated, bridge.CONFIG), 'sessionTitle'));
console.log('PASS: Google direct rename maps to actual session title; unchanged generated title remains automatic; private notes never enter public Feed');
console.log('All production contract checks passed. No real service contacted.');

const cacheValues = new Map([['feed_parts', '1'], ['feed_0', '{"ok":true,"legacy":true}']]);
const removed = [];
const cache = {
  get(key) { return cacheValues.get(key) || null; },
  getAll(keys) { return Object.fromEntries(keys.filter(key => cacheValues.has(key)).map(key => [key, cacheValues.get(key)])); },
  putAll(values) { for (const [key, value] of Object.entries(values)) cacheValues.set(key, value); },
  remove(key) { removed.push(key); cacheValues.delete(key); }
};
const cacheCtx = vm.createContext({
  CacheService: { getScriptCache: () => cache }, console,
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => ({ text }) }) }
});
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script', 'Code.gs'), 'utf8'), cacheCtx);
assert.equal(cacheCtx.readCache_(), null, 'New deployment must not reuse old cache without capabilities');
const newPayload = '{"ok":true,"bridgeVersion":"2026-11-18-ilab-v1"}';
cacheCtx.writeCache_(newPayload);
assert.equal(cacheCtx.readCache_(), newPayload);
assert.equal(cacheValues.get('feed_parts'), '1');
assert.equal(cacheValues.get('feed_0'), '{"ok":true,"legacy":true}');
cacheCtx.verifyEditor_ = () => { throw new Error('fake auth rejection'); };
const denied = cacheCtx.doPost({ postData: { contents: '{"action":"get"}' } });
assert.equal(JSON.parse(denied.text).ok, false);
assert.deepEqual(removed, ['ilab_v1_feed_parts', 'feed_parts']);
console.log('PASS: independent deployment cache namespaces prevent capability contamination; writes invalidate both sites without changing old cache data');
console.log('All production contract and cache checks passed offline.');
