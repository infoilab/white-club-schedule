#!/usr/bin/env node
'use strict';
// All Calendar calls are mocked. Never send requests or access real business data.
const assert = require('node:assert/strict');
const bridge = require('../apps-script/Code.gs');
const clone = value => JSON.parse(JSON.stringify(value));
const baseline = {
  id: 'mock-type-only', updated: 'v1', summary: '原有活動標題', colorId: '6',
  location: '', description: 'PRIVATE REMARK\n第二行',
  start: { date: '2027-09-03' }, end: { date: '2027-09-04' },
  extendedProperties: { private: { wcSeries: 'mock-series', wcSessionNo: '2', keep: 'unchanged' } },
  attendees: [{ email: 'fake@example.invalid' }], unknownField: 'preserve'
};
let event;
let patches;
global.Calendar = { Events: {
  get(calendar, id) { assert.equal(calendar, 'primary'); assert.equal(id, baseline.id); return clone(event); },
  patch(resource, calendar, id) {
    assert.equal(calendar, 'primary'); assert.equal(id, baseline.id);
    assert.deepEqual(Object.keys(resource), ['colorId']);
    patches.push(clone(resource));
    event = { ...event, ...clone(resource), updated: 'v2' };
    return clone(event);
  },
  insert() { throw new Error('Type-only must never insert'); },
  remove() { throw new Error('Type-only must never delete'); }
} };
const reset = () => { event = clone(baseline); patches = []; };
for (const type of bridge.CONFIG.TYPES) {
  reset();
  const result = bridge.handleWrite_({ action: 'update', typeOnly: true, id: baseline.id, expectedUpdated: 'v1', type: type.key });
  assert.equal(result.ok, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].colorId, type.colorIds.length ? type.colorIds[0] : null);
  assert.equal(result.event.type, type.key);
  for (const key of Object.keys(baseline).filter(key => !['colorId', 'updated'].includes(key))) assert.deepEqual(event[key], baseline[key], key + ' must be preserved');
  assert.ok(!JSON.stringify(result).includes('PRIVATE REMARK'));
}
console.log('PASS: all six types patch colorId only; Other clears color; title, all-day dates, venue, private notes, attendees and series fields unchanged');
for (const payload of [
  { expectedUpdated: 'stale', type: 'Event' },
  { expectedUpdated: null, type: 'Event' },
  { expectedUpdated: 'v1', type: 'invalid' }
]) {
  reset();
  assert.throws(() => bridge.handleWrite_({ action: 'update', typeOnly: true, id: baseline.id, ...payload }));
  assert.equal(patches.length, 0); assert.deepEqual(event, baseline);
}
reset(); event.status = 'cancelled';
assert.throws(() => bridge.handleWrite_({ action: 'update', typeOnly: true, id: baseline.id, expectedUpdated: 'v1', type: 'Event' }));
assert.equal(patches.length, 0);
console.log('PASS: stale/missing version, invalid type and deleted event fail without patch; no real service contacted');
