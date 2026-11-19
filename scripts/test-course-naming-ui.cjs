'use strict';
// Finite, offline Playwright checks: every URL intercepted, only .invalid fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
const UI_ROOT = process.env.WHITECLUB_UI_HARNESS || path.resolve(__dirname, '..', '..', 'white-club-ui-tests');
const { chromium } = require(require.resolve('playwright', { paths: [UI_ROOT] }));
const { setup } = require(path.join(UI_ROOT, 'test-ui.cjs'));
// Uses existing fully intercepted .invalid harness; requires its local vendor files.
// Run: node scripts/test-course-naming-ui.cjs (or set WHITECLUB_UI_HARNESS).
const DAY = '2026-11-23';
const titles = p => p.locator('#ee-sessions input[data-field="title"]').evaluateAll(es => es.map(e => e.value));
const input = (p,i,f) => p.locator(`#ee-sessions [data-row="${i}"] [data-field="${f}"]`);
const records = p => p.evaluate(() => readIlabTestEvents());
async function cancel(p) { await p.locator('#event-editor-form').getByRole('button',{name:'取消',exact:true}).click(); }
async function save(p) { await p.locator('#ee-save').click(); await p.locator('#modal-event-editor').waitFor({state:'hidden'}); }
async function whole(p,id) { await p.evaluate(id => openEventEditor(feedEvents.find(e=>e.id===id)),id); await p.locator('input[name="ee-scope"][value="series"]').locator('..').click(); }
async function newPlan(p,{name='CS Course',start=4,count=3,mode='general',term=3,parts=2}={}) {
  await p.evaluate(()=>openEventEditor(null));
  await p.locator('#ee-title').fill(name);
  await p.locator('[data-booking-mode="plan"]').click();
  await p.locator('#ee-naming-mode').selectOption(mode);
  await p.locator('#ee-start-no').fill(String(start));
  if(mode==='classical') { await p.locator('#ee-term').fill(String(term)); await p.locator('#ee-parts').fill(String(parts)); }
  await p.locator('#ee-first-date').fill(DAY);
  await p.locator('#ee-count').fill(String(count));
  await p.locator('#ee-skip-holidays').uncheck();
  await p.locator('#ee-regen').click();
}
async function assertGeometry(p,width) {
 const g = await p.evaluate(()=>{
   const rect = e=> { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,right:r.right,bottom:r.bottom}; };
   const settings=[...document.querySelectorAll('#ee-naming-grid label:not(.hidden)')];
   return {type:getComputedStyle(document.querySelector('.event-type-label')).fontSize,
    fonts:[...document.querySelectorAll('#ee-plan-fields .ee-plan-setting-label, #ee-plan-fields .ee-plan-setting-input, #ee-sessions .ee-row-input')].filter(e=>e.getClientRects().length).map(e=>getComputedStyle(e).fontSize),
    naming:settings.map(rect),schedule:[...document.querySelectorAll('.ee-schedule-grid label')].map(rect),
    form:rect(document.querySelector('#event-editor-form')), panel:rect(document.querySelector('#ee-plan-fields')),
    controls:[...document.querySelectorAll('#ee-plan-fields input, #ee-plan-fields select, #ee-sessions input, #ee-sessions details')].filter(e=>e.getClientRects().length).map(rect),
    overflow:document.querySelector('#event-editor-form').scrollWidth-document.querySelector('#event-editor-form').clientWidth,
    row:[...document.querySelector('[data-row="0"]').children].filter(e=>e.getClientRects().length).map(rect)};
 });
 assert.ok(g.fonts.every(s=>s===g.type),JSON.stringify({width,g}));
 assert.equal(g.type,width>=640?'14px':'12px');
 assert.ok(g.overflow<=1,JSON.stringify(g));
 assert.ok(g.controls.every(r=>r.x>=g.form.x-1&&r.right<=g.form.right+1),JSON.stringify(g));
 if(width>=640) { assert.ok(g.naming.every(r=>Math.abs(r.y-g.naming[0].y)<1)); assert.ok(g.schedule.every(r=>Math.abs(r.y-g.schedule[0].y)<1)); }
 else assert.ok(g.naming.some(r=>r.y>g.naming[0].y));
 console.log('PASS geometry',width,'font',g.type,'naming fields',g.naming.length);
}
(async()=>{
 const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 let cases=0;
 const ok=s=>console.log('PASS',++cases,s);
 try {
  const t=await setup(b); const p=t.page;
  await p.evaluate(()=>{saveIlabTestEvents([]); document.getElementById('firebase-first-step-guide')?.classList.add('hidden');document.querySelector('body > main').inert=false;document.querySelector('body > header').inert=false;});
  await newPlan(p);
  assert.deepEqual(await titles(p),['CS Course L4','CS Course L5','CS Course L6']);
  assert.equal(await p.locator('#ee-term').isVisible(),false); assert.equal(await p.locator('#ee-parts').isVisible(),false);
  await input(p,1,'title').fill('CS Course 實作堂');
  await p.locator('#ee-start-no').fill('10');
  assert.deepEqual(await titles(p),['CS Course L10','CS Course 實作堂','CS Course L12']);
  await p.locator('#ee-start-no').fill('4');
  await p.locator('#ee-sessions [data-row="0"] summary').click(); await input(p,0,'remark').fill('PRIVATE 第一堂');
  await save(p); let saved=await records(p);
  assert.deepEqual(saved.map(e=>e.title),['CS Course L4','CS Course 實作堂','CS Course L6']);
  assert.ok(saved.every(e=>JSON.stringify(e.naming)===JSON.stringify({mode:'general',startNo:4,term:1,parts:1})));
  const firstId=saved[0].id;
  await whole(p,firstId); assert.equal(await p.locator('#ee-start-no').inputValue(),'4');
  assert.deepEqual(await titles(p),saved.map(e=>e.title));
  await p.locator('#ee-title').fill('改共用名'); await p.locator('#ee-start-no').fill('20');
  assert.deepEqual(await titles(p),saved.map(e=>e.title));
  await cancel(p); assert.deepEqual(await records(p),saved);
  ok('general L4..L6, manual override, notes, save/reopen, common rename/start change/cancel preserve original');

  await whole(p,firstId); await p.locator('#ee-add-session').click();
  assert.deepEqual(await titles(p),['CS Course L4','CS Course 實作堂','CS Course L6','CS Course L7']);
  await input(p,3,'date').fill('2026-11-24');
  await save(p); saved=await records(p);
  assert.equal(saved.find(e=>e.id===firstId).remark,'PRIVATE 第一堂');
  assert.ok(saved.some(e=>e.title==='CS Course L7'&&e.date==='2026-11-24'));
  await whole(p,firstId); const before=await titles(p);
  await p.locator('#ee-sessions [data-row="1"] button[data-remove]').click();
  assert.deepEqual(await titles(p),before.filter((_,i)=>i!==1)); await save(p);
  assert.equal((await records(p)).find(e=>e.id===firstId).remark,'PRIVATE 第一堂');
  ok('add L7 then insert date and delete: saved names fixed, notes attached to same ID');

  await newPlan(p,{name:'古文',mode:'classical',start:9,count:3,term:3,parts:2});
  const classical=['古文 L9・3期・A場','古文 L9・3期・B場','古文 L10・3期・A場','古文 L10・3期・B場','古文 L11・3期・A場','古文 L11・3期・B場'];
  assert.deepEqual(await titles(p),classical); assert.equal(await p.locator('#ee-list-count').innerText(),'3堂・6場');
  await input(p,1,'title').fill('古文 L9・3期・B場 補堂');
  await p.locator('#ee-term').fill('4');
  assert.equal((await titles(p))[1],'古文 L9・3期・B場 補堂');
  assert.equal((await titles(p))[0],'古文 L9・4期・A場');
  await p.locator('#ee-term').fill('3');
  await p.locator('#ee-sessions [data-row="2"] summary').click(); await input(p,2,'remark').fill('PRIVATE 古文');
  await save(p); const ancient=(await records(p)).filter(e=>e.seriesTitle==='古文');
  assert.equal(ancient.length,6); assert.ok(ancient.every(e=>e.naming.parts===2&&e.naming.term===3));
  await whole(p,ancient[0].id); assert.equal(await p.locator('#ee-naming-mode').inputValue(),'classical');
  assert.equal(await p.locator('#ee-term').inputValue(),'3'); assert.equal(await p.locator('#ee-parts').inputValue(),'2');
  assert.deepEqual(await titles(p),ancient.map(e=>e.title));
  await p.locator('#ee-parts').fill('3'); assert.deepEqual(await titles(p),ancient.map(e=>e.title));
  await p.locator('#ee-parts').fill('2'); await p.locator('#ee-add-session').click();
  assert.deepEqual((await titles(p)).slice(-2),['古文 L12・3期・A場','古文 L12・3期・B場']);
  assert.equal(await p.locator('#ee-sessions [data-row]').count(),8);
  await save(p); assert.equal((await records(p)).find(e=>e.id===ancient[2].id).remark,'PRIVATE 古文');
  ok('classical exact punctuation, three content lessons make six alternative offerings, manual override, persisted config, next L12 A/B, private notes');

  await newPlan(p,{name:'古文',mode:'classical',start:9,count:1,term:3,parts:1});
  assert.deepEqual(await titles(p),['古文 L9・3期・A場']);
  await p.locator('#ee-add-session').click(); assert.equal((await titles(p)).at(-1),'古文 L10・3期・A場'); await cancel(p);
  ok('classical one part advances L, draft cancelled without writes');

  await newPlan(p,{name:'CS Course',start:4,count:1}); const snap=await records(p);
  for(const bad of ['0','-1','1.5','10000','']) { await p.locator('#ee-start-no').fill(bad); await p.locator('#ee-save').click(); assert.equal(await p.locator('#modal-event-editor').isVisible(),true); assert.deepEqual(await records(p),snap); }
  await cancel(p); ok('invalid start numbers block saving without changing data');

  await p.evaluate(()=>saveIlabTestEvents([{id:'native',title:'2026 古文 L9(第3期) 1',type:'Course',date:'2026-11-23',endDate:'2026-11-23',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'native-series',hasRemark:false,updated:'v1'}, {id:'native2',title:'2026 古文 L9(第3期) 2',type:'Course',date:'2026-11-30',endDate:'2026-11-30',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'native-series',hasRemark:false,updated:'v1'}]));
  await whole(p,'native'); assert.equal(await p.locator('#ee-title').inputValue(),'2026 古文');
  assert.deepEqual(await titles(p),['2026 古文 L9(第3期) 1','2026 古文 L9(第3期) 2']);
  await p.locator('#ee-add-session').click(); assert.equal((await titles(p)).at(-1),'2026 古文 L10・3期・B場'); await cancel(p);
  ok('legacy native ancient names inferred for new suggestions only, original full names untouched');
  await newPlan(p,{name:'CS Course',start:4,count:1}); await p.locator('#ee-sessions [data-row="0"] summary').click(); await input(p,0,'remark').fill('PRIVATE ORIGINAL COURSE NOTE'); await save(p);
  const single=(await records(p)).find(e=>e.title==='CS Course L4');
  await whole(p,single.id); assert.equal(await p.locator('#ee-title').inputValue(),'CS Course');
  await p.locator('#ee-add-session').click(); assert.equal((await titles(p)).at(-1),'CS Course L5');
  await input(p,1,'date').fill('2026-11-22'); await save(p);
  const converted=(await records(p)).filter(e=>e.seriesId&&(e.title==='CS Course L4'||e.title==='CS Course L5'));
  assert.equal(converted.find(e=>e.id===single.id).title,'CS Course L4');
  assert.equal(converted.find(e=>e.id===single.id).date,DAY);
  assert.equal(converted.find(e=>e.id===single.id).remark,'PRIVATE ORIGINAL COURSE NOTE');
  assert.equal(converted.find(e=>e.title==='CS Course L5').remark,'');
  assert.ok(converted.some(e=>e.title==='CS Course L5'&&e.id!==single.id&&e.date==='2026-11-22'));
  ok('one-row plan reopen uses original course prefix; earlier conversion row cannot steal original ID');

  await p.evaluate(()=>saveIlabTestEvents([{id:'onepart-a',title:'古文 L9・3期・1節',type:'Course',date:'2026-11-23',endDate:'2026-11-23',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'onepart',hasRemark:false,updated:'v1'}, {id:'onepart-b',title:'古文 L10・3期・1節',type:'Course',date:'2026-11-30',endDate:'2026-11-30',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'onepart',hasRemark:false,updated:'v1'}]));
  await whole(p,'onepart-a'); assert.equal(await p.locator('#ee-parts').inputValue(),'1');
  await p.locator('#ee-add-session').click(); assert.equal((await titles(p)).at(-1),'古文 L11・3期・A場'); await cancel(p);
  ok('legacy single-part ancient course inferred as one part, not hardcoded two');

  await p.evaluate(()=>{saveIlabTestEvents([{id:'visible-a',title:'CS Course L4',seriesTitle:'CS Course',type:'Course',date:'2026-11-23',endDate:'2026-11-23',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'partial',hasRemark:false,updated:'v1'}, {id:'unseen-b',title:'CS Course L5',seriesTitle:'CS Course',type:'Course',date:'2028-11-30',endDate:'2028-11-30',venues:['2F'],startTime:'19:00',endTime:'20:30',seriesId:'partial',remark:'PRIVATE OUTSIDE FEED',hasRemark:true,updated:'v1'}]); feedEvents=feedEvents.filter(e=>e.id!=='unseen-b');});
  await whole(p,'visible-a'); await p.locator('#ee-add-session').click();
  assert.equal((await titles(p)).at(-1),'CS Course L6'); await save(p);
  const partial=(await records(p)).filter(e=>e.seriesId==='partial');
  assert.deepEqual(partial.map(e=>e.title).sort(),['CS Course L4','CS Course L5','CS Course L6']);
  assert.equal(partial.find(e=>e.id==='unseen-b').remark,'PRIVATE OUTSIDE FEED');
  ok('all-date public naming lookup avoids duplicate unseen L5 and keeps its private notes');
  await whole(p,'visible-a'); const unchanged=await records(p); const current=await titles(p);
  await p.evaluate(()=>{window.__courseOriginalSend=sendCalendarWrite;sendCalendarWrite=async payload=>{if(payload.action==='getSeriesNaming')throw new Error('INJECTED READ FAILURE');return window.__courseOriginalSend(payload);};});
  await p.locator('#ee-add-session').click(); await p.locator('#ee-error').waitFor({state:'visible'});
  assert.deepEqual(await titles(p),current); assert.deepEqual(await records(p),unchanged); assert.equal(await p.locator('#ee-add-session').isEnabled(),true);
  await p.evaluate(()=>{sendCalendarWrite=window.__courseOriginalSend;}); await cancel(p);
  ok('full naming lookup failure blocks allocation without edits and restores retry controls');
  await whole(p,'visible-a');
  await p.evaluate(()=>{sendCalendarWrite=payload=>payload.action==='getSeriesNaming'?new Promise(resolve=>{window.__courseResolve=resolve;}):window.__courseOriginalSend(payload);});
  await p.locator('#ee-add-session').click(); assert.equal(await p.locator('#ee-add-session').isDisabled(),true); await cancel(p);
  await newPlan(p,{name:'新表單',start:1,count:1}); const draft=await titles(p);
  await p.evaluate(()=>{window.__courseResolve({ok:true,events:readIlabTestEvents().filter(e=>e.seriesId==='partial')});sendCalendarWrite=window.__courseOriginalSend;});
  await p.waitForTimeout(80); assert.deepEqual(await titles(p),draft); assert.equal(await p.locator('#ee-error').isVisible(),false); assert.equal(await p.locator('#ee-add-session').isEnabled(),true); assert.deepEqual(await records(p),unchanged); await cancel(p);
  ok('cancel and reopen while naming read is pending cannot mutate or show stale errors in new editor');
  assert.equal(t.serviceRequests.length,0); assert.deepEqual(t.errors,[]); await t.context.close();

  for(const width of process.argv.includes('--flows-only')?[]:[1440,730,640,375,320]) {
   const t=await setup(b,width); const p=t.page;
   await newPlan(p,{name:'古文',mode:'classical',start:9,count:2,term:3,parts:2});
   await assertGeometry(p,width);
   if(width===730||width===375) await p.locator('#ee-plan-fields').screenshot({path:`/home/ubuntu/course-naming-${width}.png`});
   assert.equal(t.serviceRequests.length,0); assert.deepEqual(t.errors,[]); await t.context.close();
  }
  console.log('ALL',cases,'course naming flows passed'+(process.argv.includes('--flows-only')?' (unchanged geometry intentionally not repeated)':' and 5 responsive geometry checks')+'. ZERO LIVE SERVICES.');
 } finally {await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
