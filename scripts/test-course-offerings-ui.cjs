'use strict';
// Entirely offline. test-ui serves a rewritten test-mode fixture and intercepts EVERY URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const UI_ROOT = process.env.WHITECLUB_UI_HARNESS || path.resolve(__dirname, '..', '..', 'white-club-ui-tests');
const {chromium} = require(require.resolve('playwright', {paths: [UI_ROOT]}));
const {setup} = require(path.join(UI_ROOT, 'test-ui.cjs'));
const ROOT = path.resolve(__dirname, '..');
const titleValues = p => p.locator('#ee-sessions input[data-field="title"]').evaluateAll(es=>es.map(e=>e.value));
const dateValues = p => p.locator('#ee-sessions input[data-field="date"]').evaluateAll(es=>es.map(e=>e.value));
const field = (p,i,name) => p.locator(`#ee-sessions [data-row="${i}"] [data-field="${name}"]`);
const records = p => p.evaluate(()=>readIlabTestEvents());
const cancel = p => p.locator('#event-editor-form').getByRole('button',{name:'取消',exact:true}).click();
async function save(p) { await p.locator('#ee-save').click(); await p.locator('#modal-event-editor').waitFor({state:'hidden'}); }
async function whole(p,id) { await p.evaluate(id=>openEventEditor(feedEvents.find(e=>e.id===id)),id); await p.locator('input[name="ee-scope"][value="series"]').locator('..').click(); }
async function plan(p,{start=17,term=5,count=4,parts=2,lessons=4,a='2026-11-19',b='2026-11-21',name='古文'}={}) {
 await p.evaluate(()=>openEventEditor(null)); await p.locator('#ee-title').fill(name); await p.locator('[data-booking-mode="plan"]').click();
 await p.locator('#ee-naming-mode').selectOption('classical'); await p.locator('#ee-start-no').fill(String(start)); await p.locator('#ee-term').fill(String(term));
 await p.locator('#ee-lessons-per-term').fill(String(lessons)); await p.locator('#ee-parts').fill(String(parts)); await p.locator('#ee-first-date').fill(a);
 if(parts>1 && b) await p.locator('#ee-first-date-b').fill(b);
 await p.locator('#ee-count').fill(String(count)); await p.locator('#ee-skip-holidays').uncheck(); await p.locator('#ee-regen').click();
}
function modernTitles(start,term,count,parts=2,lessons=4,name='古文') {
 return Array.from({length:count*parts},(_,i)=>{ const lesson=start+Math.floor(i/parts);const t=term+Math.floor((lesson-1)/lessons)-Math.floor((start-1)/lessons);return `${name} L${lesson}・${t}期・${String.fromCharCode(65+i%parts)}場`; });
}
function pureSafety() {
 const source=fs.readFileSync(`${ROOT}/index.html`,'utf8').split('<script>').at(-1).split('</script>')[0];
 const helpers=source.slice(source.indexOf('    function normalizeCourseNaming('),source.indexOf('    function buildWeeklyBookingPlan('));
 const c=vm.createContext({}); vm.runInContext(helpers,c); const plain=x=>JSON.parse(JSON.stringify(x));
 assert.deepEqual(plain(c.normalizeCourseNaming({mode:'general',startNo:4,term:8,parts:9})),{mode:'general',startNo:4,term:1,parts:1});
 assert.deepEqual(plain(c.normalizeCourseNaming({mode:'classical',startNo:9,term:3,parts:2})),{mode:'classical',startNo:9,term:3,parts:2});
 assert.equal(c.courseLessonTitle('古文',{mode:'classical',startNo:9,term:3,parts:2},1),'古文 L9・3期・2節');
 assert.deepEqual(plain(c.parseCourseLessonTitle('古文 L9(第3期) 1')),{course:'古文',mode:'classical',lesson:9,term:3,part:1});
 assert.deepEqual(plain(c.parseCourseLessonTitle('古文 L9・3期・1節')),{course:'古文',mode:'classical',lesson:9,term:3,part:1});
 assert.deepEqual(plain(c.inferCourseNaming([{title:'古文 L18・5期・A場'},{title:'古文 L18・5期・B場'}])),{mode:'classical',startNo:18,term:5,parts:2,lessonsPerTerm:4});
 assert.deepEqual(plain(c.normalizeCourseNaming({mode:'general',startNo:4,term:8,parts:9,lessonsPerTerm:4})),{mode:'general',startNo:4,term:1,parts:1});
 assert.equal(c.courseLessonTitle('古文',{mode:'classical',startNo:17,term:5,parts:12,lessonsPerTerm:4},11),'古文 L17・5期・L場');
 for(const bad of [0,61,1.5,'4',null]) assert.throws(()=>c.normalizeCourseNaming({mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:bad}));
 assert.deepEqual(plain(c.courseLessonIdentity({mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4},9)),{lessonNo:21,term:6,offering:2});
 assert.equal(c.courseLessonIdentity({mode:'classical',startNo:9,term:3,parts:2},1),undefined);
 assert.deepEqual(plain(c.normalizeLessonIdentity({lessonNo:9999,term:999,offering:12,privateNote:'DROP'})),{lessonNo:9999,term:999,offering:12});
 for(const key of ['lessonNo','term','offering']) for(const bad of [0,-1,1.5,'1',null,undefined,key==='lessonNo'?10000:key==='term'?1000:13]) assert.throws(()=>c.normalizeLessonIdentity({lessonNo:17,term:5,offering:2,[key]:bad}));
 assert.deepEqual(plain(c.savedLessonIdentity({title:'古文 L99・9期・A場',sessionNo:1,lessonIdentity:{lessonNo:17,term:5,offering:2}})),{lessonNo:17,term:5,offering:2});
 assert.equal(c.savedLessonIdentity({title:'手動 B 名稱',sessionNo:2,naming:{mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4}}),null);
 const publicHelper=source.slice(source.indexOf('    function publicFeedPayload('),source.indexOf('    function getTypeStyle('));
 c.FORMAL_FEED=true;c.formalObject=x=>!!x&&typeof x==='object'&&!Array.isArray(x);vm.runInContext(publicHelper,c);
 const cleaned=plain(c.publicFeedPayload({events:[{id:'identity',lessonIdentity:{lessonNo:17,term:5,offering:2,privateNote:'DROP'},wcLessonIdentity:'PRIVATE JSON',remark:'PRIVATE'},{id:'legacy',sessionNo:4}]}));
 assert.deepEqual(cleaned,{events:[{id:'identity',lessonIdentity:{lessonNo:17,term:5,offering:2}},{id:'legacy',sessionNo:4}]});
 const send=source.slice(source.indexOf('    async function sendCalendarWrite('),source.indexOf('    /**',source.indexOf('    async function sendCalendarWrite(')));
 let fetches=0,tokens=0;
 const auth={getIdToken:async()=>{tokens++;return 'OFFLINE_FAKE_TOKEN';}};
 const gate=vm.createContext({ILAB_TEST_MODE:false,FORMAL_FEED:true,approvedCloudUser:()=>true,cloudUser:auth,cloudSyncReady:true,cloudAuthGeneration:1,
  feedBridgeCapabilities:{courseNaming:true,sessionRemarks:true},ACTIVE_FEED_URL:'https://must-not-contact.invalid/',fetch:async()=>{fetches++;return {ok:true,json:async()=>({ok:true})};}});
 vm.runInContext(send,gate);
 return (async()=>{
  await assert.rejects(gate.sendCalendarWrite({action:'create',naming:{mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4}}),/可選場次/);
  assert.equal(fetches,0);assert.equal(tokens,0);
  gate.feedBridgeCapabilities.courseOfferings=true;
  await gate.sendCalendarWrite({action:'create',naming:{mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4}});assert.equal(fetches,1);
  gate.feedBridgeCapabilities.courseOfferings=false;
  await gate.sendCalendarWrite({action:'create',naming:{mode:'classical',startNo:9,term:3,parts:2}});assert.equal(fetches,2);
  console.log('PASS pure legacy four-field helpers, strict normalized identities/preference/no ordinal inference/public stripping, A..L, courseOfferings fail-closed before token/fetch (mock calls only)');
 })();
}
(async()=>{
 await pureSafety();
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});let cases=0;
 const pass=text=>console.log(`PASS ${++cases}: ${text}`);
 try {
  const t=await setup(browser);const p=t.page;
  p.on('dialog',d=>d.accept());
  await p.evaluate(()=>{saveIlabTestEvents([]);document.getElementById('firebase-first-step-guide')?.classList.add('hidden');document.querySelector('body > main').inert=false;document.querySelector('body > header').inert=false;});
  await plan(p);assert.deepEqual(await titleValues(p),modernTitles(17,5,4));
  assert.deepEqual(await dateValues(p),['2026-11-19','2026-11-21','2026-11-26','2026-11-28','2026-12-03','2026-12-05','2026-12-10','2026-12-12']);
  assert.equal(await p.locator('#ee-list-count').innerText(),'4堂・8場');assert.match(await p.locator('#ee-count-hint').innerText(),/只選其中一場/);
  await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),['古文 L21・6期・A場','古文 L21・6期・B場']);
  await cancel(p);pass('L17 A/B through L20; added L21 starts term6; A19/B21 then A26/B28 weekly, 4 content lessons/8 alternatives');
  await plan(p,{start:18,term:5,count:4});assert.deepEqual(await titleValues(p),modernTitles(18,5,4));assert.deepEqual((await titleValues(p)).slice(-2),['古文 L21・6期・A場','古文 L21・6期・B場']);await cancel(p);pass('mid-term start L18 crosses only at L21');
  await plan(p,{start:37,term:10,count:2});assert.deepEqual(await titleValues(p),modernTitles(37,10,2));assert.equal(await p.locator('#ee-sessions [data-row]').count(),4);await cancel(p);pass('partial final term L37/L38 produces exactly four events, no padding');
  await plan(p,{count:2});await p.locator('#ee-sessions [data-row="1"] summary').click();await field(p,1,'remark').fill('PRIVATE B17 ORIGINAL');await field(p,1,'title').fill('古文 B場特別導讀');
  await p.locator('#ee-title').fill('古文課');await p.locator('#ee-term').fill('6');assert.equal((await titleValues(p))[1],'古文 B場特別導讀');assert.equal(await field(p,1,'remark').inputValue(),'PRIVATE B17 ORIGINAL');
  await p.locator('#ee-title').fill('古文');await p.locator('#ee-term').fill('5');await p.locator('#ee-regen').click();assert.equal((await titleValues(p))[1],'古文 B場特別導讀');assert.equal(await field(p,1,'remark').inputValue(),'PRIVATE B17 ORIGINAL');
  await field(p,1,'date').fill('2026-11-18');await save(p);const saved=await records(p);const noteRow=saved.find(e=>e.title==='古文 B場特別導讀');assert.equal(noteRow.remark,'PRIVATE B17 ORIGINAL');assert.equal(noteRow.date,'2026-11-18');
  assert.ok(saved.every(e=>JSON.stringify(e.naming)===JSON.stringify({mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4})));
  await whole(p,saved[0].id);assert.equal(await p.locator('#ee-start-no').inputValue(),'17');assert.equal(await p.locator('#ee-term').inputValue(),'5');assert.equal(await p.locator('#ee-lessons-per-term').inputValue(),'4');assert.equal(await p.locator('#ee-parts').inputValue(),'2');
  const frozen=await titleValues(p);await p.locator('#ee-start-no').fill('25');await p.locator('#ee-term').fill('7');await p.locator('#ee-parts').fill('3');await p.locator('#ee-title').fill('改共享名');assert.deepEqual(await titleValues(p),frozen);await cancel(p);assert.deepEqual(await records(p),saved);
  pass('manual draft name/private note survive config, regeneration and reordering; IDs/notes preserved; saveSeries config reopened; saved titles frozen');
  await plan(p,{start:18,term:5,count:1,parts:1,lessons:4,name:'古文單場'});await save(p);const single=(await records(p)).find(e=>e.title==='古文單場 L18・5期・A場');assert.ok(single);
  await whole(p,single.id);assert.equal(await p.locator('#ee-title').inputValue(),'古文單場');assert.equal(await p.locator('#ee-start-no').inputValue(),'18');assert.equal(await p.locator('#ee-lessons-per-term').inputValue(),'4');assert.equal(await p.locator('#ee-parts').inputValue(),'1');await p.locator('#ee-add-session').click();assert.equal((await titleValues(p)).at(-1),'古文單場 L19・5期・A場');await save(p);assert.equal((await records(p)).find(e=>e.id===single.id).title,single.title);
  pass('one-event batch naming config reopens and original ID survives conversion');
  await p.evaluate(()=>saveIlabTestEvents([{id:'old-a',title:'古文 L9・3期・1節',seriesId:'old',seriesTitle:'古文',date:'2026-11-19',endDate:'2026-11-19',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],remark:'PRIVATE OLD A',hasRemark:true,updated:'v1'}, {id:'old-b',title:'古文 L9(第3期) 2',seriesId:'old',seriesTitle:'古文',date:'2026-11-21',endDate:'2026-11-21',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],remark:'PRIVATE OLD B',hasRemark:true,updated:'v1'}]));
  await whole(p,'old-a');const oldNames=await titleValues(p);await p.locator('#ee-term').fill('5');await p.locator('#ee-start-no').fill('17');await p.locator('#ee-lessons-per-term').fill('6');assert.deepEqual(await titleValues(p),oldNames);await save(p);const old=await records(p);for(const row of old){assert.equal(row.title,row.id==='old-a'?'古文 L9・3期・1節':'古文 L9(第3期) 2');assert.equal(row.remark,row.id==='old-a'?'PRIVATE OLD A':'PRIVATE OLD B');}
  assert.ok(old.every(row=>row.lessonIdentity===undefined),'Loading/saving legacy rows must not backfill inferred formal identities');
  pass('both legacy 節 and native 第期 names stay byte-for-byte unchanged on load/settings/save, original private notes remain');
  await p.evaluate(()=>{const config={mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4};saveIlabTestEvents([{id:'shown',title:'古文 L17・5期・A場',seriesId:'partial-modern',seriesTitle:'古文',date:'2026-11-19',endDate:'2026-11-19',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming:config,hasRemark:false,updated:'v1'}, {id:'hidden-a',title:'古文 L24・6期・A場',seriesId:'partial-modern',seriesTitle:'古文',date:'2028-11-19',endDate:'2028-11-19',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming:config,remark:'PRIVATE OUTSIDE',hasRemark:true,updated:'v1'}, {id:'hidden-b',title:'古文 L24・6期・B場',seriesId:'partial-modern',seriesTitle:'古文',date:'2028-11-21',endDate:'2028-11-21',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming:config,hasRemark:false,updated:'v1'}]);feedEvents=feedEvents.filter(e=>e.id==='shown');});
  await whole(p,'shown');await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),['古文 L25・7期・A場','古文 L25・7期・B場']);await save(p);assert.equal((await records(p)).find(e=>e.id==='hidden-a').remark,'PRIVATE OUTSIDE');assert.equal((await records(p)).find(e=>e.id==='shown').title,'古文 L17・5期・A場');
  pass('complete naming lookup scans DIFFERENT terms outside Feed range; new L25 term7 never reuses L18; unseen notes and visible original ID unchanged');
  await whole(p,'shown');await p.locator('#ee-title').fill('改共享名古文');await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),['改共享名古文 L26・7期・A場','改共享名古文 L26・7期・B場']);await cancel(p);
  await plan(p,{parts:12,count:5});assert.equal(await p.locator('#ee-count').getAttribute('max'),'5');assert.equal(await p.locator('#ee-sessions [data-row]').count(),60);assert.equal((await titleValues(p))[11],'古文 L17・5期・L場');assert.equal(await p.locator('#ee-offering-dates input').count(),11);
  const sixty=await titleValues(p);await p.locator('#ee-count').fill('6');await p.locator('#ee-regen').click();assert.deepEqual(await titleValues(p),sixty);assert.equal(await p.locator('#ee-count').inputValue(),'6');assert.match(await p.locator('#ee-error').innerText(),/不會自動減少/);await cancel(p);
  pass('1..12 independent date offerings supported; floor(60/parts) count limit rejects without silent clamp or row edits');
  await plan(p,{parts:3,count:2});await p.locator('#ee-first-date-c').fill('2026-11-23');await p.locator('#ee-interval').selectOption('2');await p.locator('#ee-regen').click();assert.deepEqual(await dateValues(p),['2026-11-19','2026-11-21','2026-11-23','2026-12-03','2026-12-05','2026-12-07']);
  await p.locator('#ee-parts').fill('2');await p.locator('#ee-parts').fill('3');assert.equal(await p.locator('#ee-first-date-c').inputValue(),'2026-11-23');await cancel(p);
  await plan(p,{count:2,a:'2026-12-25',b:'2026-12-26'});await p.locator('#ee-skip-holidays').check();await p.locator('#ee-regen').click();assert.deepEqual(await dateValues(p),['2027-01-08','2027-01-02','2027-01-15','2027-01-09']);assert.deepEqual(await titleValues(p),modernTitles(17,5,2));await cancel(p);
  pass('third optional date retained; all streams obey intervals/holidays independently; lesson interleave precedes title assignment even when dates cross');
  await plan(p,{count:2,b:null});assert.equal(await p.locator('#ee-first-date-b').inputValue(),'2026-11-20');await p.locator('#ee-first-date-b').fill('2026-11-22');await p.locator('#ee-first-date').fill('2026-11-26');assert.equal(await p.locator('#ee-first-date-b').inputValue(),'2026-11-22');await p.locator('#ee-naming-mode').selectOption('general');assert.equal(await p.locator('#ee-lessons-per-term').isVisible(),false);assert.equal(await p.locator('#ee-first-date-b').isVisible(),false);await p.locator('#ee-count').fill('3');await p.locator('#ee-regen').click();assert.equal(await p.locator('#ee-sessions [data-row]').count(),3);assert.equal(await p.locator('#ee-list-count').innerText(),'3');await cancel(p);
  pass('B defaults next day, manual B is independent of A; general hides classical inputs and count stays exact event count');
  await whole(p,'shown');const beforePending=await records(p);
  await p.evaluate(()=>{window.__offeringOriginalSend=sendCalendarWrite;sendCalendarWrite=payload=>payload.action==='getSeriesNaming'?new Promise(resolve=>{window.__offeringResolve=resolve;}):window.__offeringOriginalSend(payload);});
  await p.locator('#ee-add-session').click();assert.equal(await p.locator('#ee-add-session').isDisabled(),true);await cancel(p);await plan(p,{count:1});const fresh=await titleValues(p);
  await p.evaluate(()=>{window.__offeringResolve({ok:true,events:readIlabTestEvents().filter(e=>e.seriesId==='partial-modern')});sendCalendarWrite=window.__offeringOriginalSend;});await p.waitForTimeout(80);
  assert.deepEqual(await titleValues(p),fresh);assert.equal(await p.locator('#ee-error').isVisible(),false);assert.equal(await p.locator('#ee-add-session').isEnabled(),true);assert.deepEqual(await records(p),beforePending);await cancel(p);
  pass('modern pending full-series read cannot mutate a cancelled/reopened draft or allocate stale IDs/titles');

  // B17 precedes A17 chronologically. Identity—not date ordinal—must hold ID/name/note together.
  await p.evaluate(()=>saveIlabTestEvents([]));await plan(p,{count:1,a:'2026-11-23',b:'2026-11-21'});
  for(const i of [0,1]) {await p.locator(`#ee-sessions [data-row="${i}"] summary`).click();await field(p,i,'remark').fill(`PRIVATE ${i===0?'A':'B'}17 STABLE`);}
  await save(p);const crossed=await records(p);const a17=crossed.find(e=>e.lessonIdentity?.offering===1),b17=crossed.find(e=>e.lessonIdentity?.offering===2);
  assert.equal(crossed[0].id,b17.id);assert.deepEqual(a17.lessonIdentity,{lessonNo:17,term:5,offering:1});assert.deepEqual(b17.lessonIdentity,{lessonNo:17,term:5,offering:2});
  const stableState=es=>es.map(({id,title,date,startTime,endTime,remark,lessonIdentity})=>({id,title,date,startTime,endTime,remark,lessonIdentity})).sort((a,b)=>a.id.localeCompare(b.id));
  await whole(p,b17.id);assert.equal(await p.locator('#ee-first-date').inputValue(),'2026-11-23');assert.equal(await p.locator('#ee-first-date-b').inputValue(),'2026-11-21');
  for(const i of [0,1]) {await p.locator(`#ee-sessions [data-row="${i}"] summary`).click();await field(p,i,'remark').waitFor({state:'visible'});await p.waitForFunction(i=>!document.querySelector(`#ee-sessions [data-row="${i}"] textarea`).disabled,i);}
  await p.locator('#ee-skip-holidays').uncheck();await p.locator('#ee-regen').click();
  assert.equal(await p.locator(`#ee-sessions [data-session-id="${a17.id}"] [data-field="date"]`).inputValue(),'2026-11-23');
  assert.equal(await p.locator(`#ee-sessions [data-session-id="${b17.id}"] [data-field="date"]`).inputValue(),'2026-11-21');
  assert.equal(await p.locator(`#ee-sessions [data-session-id="${b17.id}"] [data-field="remark"]`).inputValue(),'PRIVATE B17 STABLE');
  await save(p);assert.deepEqual(stableState(await records(p)),stableState(crossed));
  await whole(p,b17.id);const fixedNames=await titleValues(p);await p.locator('#ee-title').fill('新共用名');await p.locator('#ee-term').fill('8');await p.locator('#ee-start-no').fill('25');assert.deepEqual(await titleValues(p),fixedNames);await cancel(p);
  pass('B17 Nov21 before A17 Nov23 save/reopen/regen preserves exact original IDs, dates, names, private notes and fixed term identity');

  await p.evaluate(id=>openEventEditor(feedEvents.find(e=>e.id===id)),b17.id);await p.locator('#ee-title').fill('B17 手動特別導讀');await save(p);
  assert.deepEqual((await records(p)).find(e=>e.id===b17.id).lessonIdentity,{lessonNo:17,term:5,offering:2});
  await whole(p,b17.id);await p.locator('#ee-skip-holidays').uncheck();await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),modernTitles(18,5,1));
  assert.equal((await titleValues(p)).filter(s=>s.includes('L17')&&s.includes('B場')).length,0);await save(p);
  const manualSaved=await records(p);assert.equal(manualSaved.find(e=>e.id===b17.id).title,'B17 手動特別導讀');assert.equal(manualSaved.find(e=>e.id===b17.id).remark,'PRIVATE B17 STABLE');
  assert.deepEqual(manualSaved.filter(e=>e.lessonIdentity.lessonNo===18).map(e=>e.lessonIdentity.offering).sort(),[1,2]);
  await whole(p,b17.id);await p.locator('#ee-count').fill('2');await p.locator('#ee-regen').click();await save(p);assert.deepEqual(stableState(await records(p)),stableState(manualSaved));
  pass('single-event manual rename keeps explicit B17 identity across save/reopen; add creates only next L18 A/B, and manual-name regen remains stable');

  await whole(p,b17.id);await p.locator('#ee-title').fill('新課程前綴');await p.locator('#ee-start-no').fill('25');await p.locator('#ee-term').fill('8');await p.locator('#ee-parts').fill('3');await p.locator('#ee-add-session').click();
  assert.deepEqual((await titleValues(p)).slice(-3),modernTitles(25,8,1,3,4,'新課程前綴'));await field(p,6,'title').fill('完全自訂 C 場顯示名稱');await save(p);
  const reconfigured=await records(p);assert.deepEqual(stableState(reconfigured.filter(row=>manualSaved.some(old=>old.id===row.id))),stableState(manualSaved));
  assert.deepEqual(reconfigured.find(row=>row.title==='完全自訂 C 場顯示名稱').lessonIdentity,{lessonNo:25,term:8,offering:3});
  assert.ok(reconfigured.every(row=>JSON.stringify(row.naming)===JSON.stringify({mode:'classical',startNo:25,term:8,parts:3,lessonsPerTerm:4})));
  await whole(p,b17.id);assert.equal(await p.locator('#ee-start-no').inputValue(),'25');assert.equal(await p.locator('#ee-term').inputValue(),'8');const beforeConfigRegen=await records(p);await p.locator('#ee-regen').click();assert.match(await p.locator('#ee-error').innerText(),/識別資料不符/);assert.deepEqual(await records(p),beforeConfigRegen);await cancel(p);
  pass('saved IDs/names/terms stay fixed after persisted start/term/parts/prefix edits; new custom display title stores exact helper-derived L25 term8 C identity');

  await p.evaluate(()=>{const naming={mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4};const base={seriesId:'manual-unseen',seriesTitle:'古文',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming,hasRemark:false,updated:'v1'};saveIlabTestEvents([
   {...base,id:'visible-identity',title:'A17 自訂名稱',date:'2026-11-23',endDate:'2026-11-23',lessonIdentity:{lessonNo:17,term:5,offering:1}},
   {...base,id:'unseen-identity-a',title:'A24 自訂名稱',date:'2028-11-19',endDate:'2028-11-19',lessonIdentity:{lessonNo:24,term:6,offering:1},remark:'PRIVATE UNSEEN MANUAL A',hasRemark:true},
   {...base,id:'unseen-identity-b',title:'B24 自訂名稱',date:'2028-11-21',endDate:'2028-11-21',lessonIdentity:{lessonNo:24,term:6,offering:2}}]);feedEvents=feedEvents.filter(e=>e.id==='visible-identity');});
  const unseenBefore=await records(p);await whole(p,'visible-identity');await p.locator('#ee-title').fill('更改共用前綴');await p.locator('#ee-skip-holidays').uncheck();await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),modernTitles(25,7,1,2,4,'更改共用前綴'));
  const unseenNextDates=await p.evaluate(()=>['2028-11-19','2028-11-21'].map(d=>addDaysYMD(d,7)));assert.deepEqual((await dateValues(p)).slice(-2),unseenNextDates);await save(p);
  for(const old of unseenBefore) {const row=(await records(p)).find(e=>e.id===old.id);assert.equal(row.title,old.title);assert.equal(row.remark||'',old.remark||'');assert.deepEqual(row.lessonIdentity,old.lessonIdentity);}
  assert.deepEqual((await records(p)).filter(e=>e.lessonIdentity.lessonNo===25).map(e=>e.lessonIdentity).sort((a,b)=>a.offering-b.offering),[{lessonNo:25,term:7,offering:1},{lessonNo:25,term:7,offering:2}]);
  pass('complete-series manual identities beyond Feed and prefix changes advance L25 term7; unseen independent dates, identities and notes preserved');

  await p.evaluate(()=>saveIlabTestEvents([]));await plan(p,{count:2});await save(p);const groupBefore=await records(p);const deletedB=groupBefore.find(e=>e.lessonIdentity.lessonNo===18&&e.lessonIdentity.offering===2);
  await whole(p,groupBefore[0].id);await p.locator(`#ee-sessions [data-session-id="${deletedB.id}"] [data-remove]`).click();await p.locator('#ee-first-start').fill('18:00');await p.locator('#ee-first-end').fill('19:15');await p.locator('#ee-skip-holidays').uncheck();await p.locator('#ee-add-session').click();
  assert.deepEqual((await titleValues(p)).slice(-2),modernTitles(19,5,1));assert.equal(await p.locator('#ee-sessions [data-row]').count(),5);assert.deepEqual((await dateValues(p)).slice(-2),['2026-12-03','2026-12-05']);
  for(const i of [3,4]) {assert.equal(await field(p,i,'startTime').inputValue(),'18:00');assert.equal(await field(p,i,'endTime').inputValue(),'19:15');}
  assert.equal(await p.locator('#ee-list-count').innerText(),'3堂・5場');await save(p);assert.equal((await records(p)).some(e=>e.id===deletedB.id),false);assert.equal((await records(p)).some(e=>e.lessonIdentity.lessonNo===18&&e.lessonIdentity.offering===2),false);
  pass('modern +one content lesson adds all A/B choices at shared default times on independent streams; intentionally deleted old B18 is never refilled');

  for(const legacy of [false,true]) {
   await p.evaluate(legacy=>{const naming=legacy?{mode:'classical',startNo:17,term:5,parts:2}:{mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4};const base={seriesId:'unknown',seriesTitle:'古文',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming,updated:'v1'};saveIlabTestEvents([{...base,id:'unknown-b',title:'沒有識別的手動 B 名稱',date:'2026-11-21',endDate:'2026-11-21',sessionNo:1,remark:'PRIVATE UNKNOWN B',hasRemark:true},{...base,id:'known-a',title:legacy?'古文 L17・5期・1節':'古文 L17・5期・A場',date:'2026-11-23',endDate:'2026-11-23',sessionNo:2,hasRemark:false}]);window.__identityWriteCount=0;window.__identityOriginalSend=sendCalendarWrite;sendCalendarWrite=payload=>{if(!['get','getSeriesNaming'].includes(payload.action))window.__identityWriteCount++;return window.__identityOriginalSend(payload);};},legacy);
   const unknownBefore=await records(p);await whole(p,'unknown-b');const unknownRows=await p.locator('#ee-sessions [data-row]').evaluateAll(es=>es.map(e=>({id:e.dataset.sessionId,title:e.querySelector('[data-field="title"]').value,date:e.querySelector('[data-field="date"]').value})));
   for(const selector of ['#ee-add-session','#ee-regen']) {await p.locator(selector).click();await p.locator('#ee-error').waitFor({state:'visible'});assert.match(await p.locator('#ee-error').innerText(),/識別資料/);assert.deepEqual(await records(p),unknownBefore);assert.deepEqual(await p.locator('#ee-sessions [data-row]').evaluateAll(es=>es.map(e=>({id:e.dataset.sessionId,title:e.querySelector('[data-field="title"]').value,date:e.querySelector('[data-field="date"]').value}))),unknownRows);}
   assert.equal(await p.evaluate(()=>window.__identityWriteCount),0);await cancel(p);await p.evaluate(()=>{sendCalendarWrite=window.__identityOriginalSend;});
  }
  pass('unresolved saved manual modern AND legacy rows block modern add/regen before any writes, sorting/date swaps or row/note changes; ordinal never used');

  await p.evaluate(()=>{const naming={mode:'classical',startNo:17,term:5,parts:2,lessonsPerTerm:4};const base={seriesId:'duplicate',seriesTitle:'古文',startTime:'19:00',endTime:'20:30',type:'Course',venues:['2F'],naming,lessonIdentity:{lessonNo:17,term:5,offering:1},updated:'v1'};saveIlabTestEvents([{...base,id:'duplicate-a',title:'第一個手動 A',date:'2026-11-21',endDate:'2026-11-21'},{...base,id:'duplicate-b',title:'第二個手動 A',date:'2026-11-23',endDate:'2026-11-23'}]);});
  const duplicateBefore=await records(p);await whole(p,'duplicate-a');const duplicateTitles=await titleValues(p);for(const selector of ['#ee-add-session','#ee-regen']) {await p.locator(selector).click();assert.match(await p.locator('#ee-error').innerText(),/重複/);assert.deepEqual(await titleValues(p),duplicateTitles);assert.deepEqual(await records(p),duplicateBefore);}await cancel(p);
  pass('ambiguous duplicate saved identities fail closed instead of assigning either ID by chronological ordinal');

  await p.evaluate(()=>saveIlabTestEvents([{id:'ordinary-single',title:'原有單次講座完整名稱',type:'Course',date:'2026-11-23',endDate:'2026-11-23',startTime:'19:00',endTime:'20:30',venues:['2F'],remark:'PRIVATE SINGLE CONVERSION',hasRemark:true,updated:'v1'}]));
  await whole(p,'ordinary-single');await p.locator('#ee-naming-mode').selectOption('classical');await p.locator('#ee-start-no').fill('17');await p.locator('#ee-term').fill('5');await p.locator('#ee-parts').fill('2');await p.locator('#ee-count').fill('1');await p.locator('#ee-first-date').fill('2026-11-23');await p.locator('#ee-first-date-b').fill('2026-11-21');await p.locator('#ee-skip-holidays').uncheck();await p.locator('#ee-regen').click();
  assert.equal(await p.locator('#ee-error').isVisible(),false);assert.equal(await p.locator('#ee-sessions [data-row]').count(),2);assert.equal((await titleValues(p))[0],'原有單次講座完整名稱');await p.locator('#ee-add-session').click();assert.deepEqual((await titleValues(p)).slice(-2),modernTitles(18,5,1,2,4,'原有單次講座完整名稱'));await save(p);
  const convertedSingle=await records(p);const originalSingle=convertedSingle.find(row=>row.id==='ordinary-single');assert.equal(originalSingle.title,'原有單次講座完整名稱');assert.equal(originalSingle.date,'2026-11-23');assert.equal(originalSingle.remark,'PRIVATE SINGLE CONVERSION');assert.deepEqual(originalSingle.lessonIdentity,{lessonNo:17,term:5,offering:1});
  assert.ok(convertedSingle.every(row=>row.seriesId===originalSingle.seriesId));assert.deepEqual(convertedSingle.filter(row=>row.lessonIdentity.lessonNo===17).map(row=>row.lessonIdentity.offering).sort(),[1,2]);
  pass('explicit ordinary SINGLE→modern conversion assigns selected A17 identity while keeping original ID/title/note even when B17 is earlier; then adds full L18 A/B');
  assert.equal(t.serviceRequests.length,0);assert.deepEqual(t.errors,[]);await t.context.close();
  for(const width of process.argv.includes('--flows-only')?[]:[730,640,375,320]) {
   const t=await setup(browser,width);const p=t.page;await plan(p,{count:2});
   const g=await p.evaluate(()=>{const r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,right:x.right,width:x.width};};const visible=e=>e.getClientRects().length;const form=document.getElementById('event-editor-form');return {font:getComputedStyle(document.querySelector('.event-type-label')).fontSize,fonts:[...document.querySelectorAll('#ee-plan-fields .ee-plan-setting-label,#ee-plan-fields .ee-plan-setting-input,#ee-sessions .ee-row-input')].filter(visible).map(e=>getComputedStyle(e).fontSize),naming:[...document.querySelectorAll('#ee-naming-grid label')].filter(visible).map(r),form:r(form),overflow:form.scrollWidth-form.clientWidth,inputs:[...document.querySelectorAll('#ee-plan-fields input,#ee-plan-fields select,#ee-sessions input')].filter(visible).map(r),dates:[...document.querySelectorAll('#ee-plan-fields input[type="date"],#ee-sessions input[type="date"]')].filter(visible).map(e=>({width:e.getBoundingClientRect().width,padding:parseFloat(getComputedStyle(e).paddingLeft)+parseFloat(getComputedStyle(e).paddingRight),font:parseFloat(getComputedStyle(e).fontSize)}))};});
   assert.equal(g.font,width>=640?'14px':'12px');assert.ok(g.fonts.every(f=>f===g.font));assert.ok(g.overflow<=1,JSON.stringify(g));assert.ok(g.inputs.every(i=>i.x>=g.form.x-1&&i.right<=g.form.right+1),JSON.stringify(g));
   if(width>=640)assert.ok(g.naming.every(i=>Math.abs(i.y-g.naming[0].y)<1),JSON.stringify(g));else assert.ok(g.naming.some(i=>i.y>g.naming[0].y));
   // Chromium native date segment + picker at the actual matching font, no shrinking text.
   assert.ok(g.dates.every(d=>d.width-d.padding>=d.font*6.3+14),JSON.stringify(g.dates));
   await p.locator('#ee-plan-fields').screenshot({path:`/home/ubuntu/work/white-club-ui-tests/course-offerings-${width}.png`});
   assert.equal(t.serviceRequests.length,0);assert.deepEqual(t.errors,[]);await t.context.close();console.log(`PASS geometry ${width}: same ${g.font} font, five readable naming fields, complete dates/no overflow`);
  }
  console.log(`ALL ${cases} modern UI flows + pure compatibility/identity/capability passed${process.argv.includes('--flows-only')?' (unchanged geometry intentionally not repeated)':' + 4 responsive checks'}. ZERO LIVE FETCH/WRITE.`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
