'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../apps/web');
const ts = require(path.join(web, 'node_modules/typescript'));
const source = fs.readFileSync(path.join(web, 'lib/operator-receipts.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const KEY = 'eventouch.receipts.operator';
const PREFIX = 'eventouch.receipt.operator.v2.';
function fixture() {
  const shared = new Map(); const tabs = [];
  function makeStorage(map, guard, notify) {
    return {
      get length() { guard('read'); return map.size; },
      key(i) { guard('read'); return [...map.keys()][i] ?? null; },
      getItem(k) { guard('read'); return map.has(k) ? map.get(k) : null; },
      setItem(k,v) { guard('write'); map.set(k,String(v)); notify?.(k); },
      removeItem(k) { guard('write'); map.delete(k); notify?.(k); },
    };
  }
  function tab(initialSession) {
    const session = new Map(initialSession || []), listeners = new Map();
    let denyShared = false, denySession = false, denySharedWrites = false, denySessionWrites = false;
    const fire = (type, event={}) => { for (const fn of listeners.get(type) || []) fn(event); };
    const sessionStorage = makeStorage(session, op => { if(denySession || (denySessionWrites && op==='write')) throw Error('session denied'); });
    const window = {
      sessionStorage,
      addEventListener(type, fn) { const set=listeners.get(type)||new Set(); set.add(fn); listeners.set(type,set); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(event) { fire(event.type,event); return true; },
    };
    window.localStorage = makeStorage(shared, op => { if(denyShared || (denySharedWrites && op==='write')) throw Error('shared denied'); }, key => {
      for(const other of tabs) if(other.window!==window) other.fire('storage',{key});
    });
    const sandbox={window,Event,Map,Set,JSON,Number,Date,Object,Array,Error}; vm.createContext(sandbox);
    const module={exports:{}}; vm.runInContext(`(function(exports,module){${code}})`,sandbox)(module.exports,module);
    const result={window,fire,session,api:module.exports,denyShared(v=true){denyShared=v},denySession(v=true){denySession=v},
      denySharedWrites(v=true){denySharedWrites=v},denySessionWrites(v=true){denySessionWrites=v}};
    tabs.push(result); return result;
  }
  return {tab,shared};
}
const pointer=(commandId, changes={})=>({userId:'user-1',organizationId:'org-1',eventId:'event-1',commandId,command:'participant.bulk-cancel',...changes});

test('one scoped pointer per key is shared, notified, and independently removed', () => {
  const f=fixture(), a=f.tab(), b=f.tab(); let updates=0;
  const unsubscribe=b.api.subscribeOperatorReceipts(()=>updates++);
  const p=pointer('cross-tab-0001'), q=pointer('cross-tab-0002',{organizationId:'org-2'});
  assert.equal(a.api.beginOperatorReceipt(p),false);
  assert.equal(b.api.operatorReceipts().length,1);
  assert.equal(b.api.beginOperatorReceipt(q),false);
  assert.equal(a.api.operatorReceipts().length,2);
  a.api.endOperatorReceipt(p.commandId,false); b.api.endOperatorReceipt(q.commandId,false);
  a.api.forgetOperatorReceipt(p.commandId);
  assert.deepEqual([...b.api.operatorReceipts()].map(x=>x.commandId),[q.commandId]);
  assert.equal([...f.shared.values()].join('').includes('participant name'),false);
  assert.ok(updates>=2); unsubscribe();
  assert.deepEqual(Object.keys(JSON.parse(a.session.get(KEY)||'[]')[0]||{}).sort(),[]);
});

test('legacy copied sessions migrate, and deletion cannot resurrect an old copy', () => {
  const p=pointer('legacy-tab-0001'), serialized=JSON.stringify([p]);
  const f=fixture(), a=f.tab([[KEY,serialized]]), b=f.tab([[KEY,serialized]]);
  assert.equal(a.api.operatorReceipts().length,1);
  a.api.forgetOperatorReceipt(p.commandId);
  assert.equal(JSON.parse(f.shared.get(PREFIX+'done.'+p.commandId)).done,true);
  assert.equal(b.api.operatorReceipts().length,0);
  assert.equal(b.session.has(KEY),false);
  // Simulate an import whose write races after the other tab's deletion.
  f.shared.set(PREFIX+'legacy.'+p.commandId,JSON.stringify({pointer:p}));
  assert.equal(b.api.operatorReceipts().length,0);
});

test('new shared pointers do not leave tombstones and tab copies do not revive them', () => {
  const f=fixture(), a=f.tab(); const p=pointer('new-copy-0001');
  a.api.beginOperatorReceipt(p); a.api.endOperatorReceipt(p.commandId,false);
  const b=f.tab([...a.session]);
  a.api.forgetOperatorReceipt(p.commandId);
  assert.equal(f.shared.has(PREFIX+p.commandId),false);
  assert.equal(b.api.operatorReceipts().length,0);
});

test('expired legacy tombstones are pruned without deleting a newer explicit request', () => {
  const f=fixture(), a=f.tab(), p=pointer('expired-legacy-1');
  f.shared.set(PREFIX+'done.'+p.commandId,JSON.stringify({done:true,at:Date.now()-31*24*60*60*1000}));
  f.shared.set(PREFIX+'legacy.'+p.commandId,JSON.stringify({pointer:p}));
  f.shared.set(PREFIX+p.commandId,JSON.stringify({pointer:p}));
  assert.equal(a.api.operatorReceipts().length,1);
  assert.equal(f.shared.has(PREFIX+'done.'+p.commandId),false);
  assert.equal(f.shared.has(PREFIX+'legacy.'+p.commandId),false);
  assert.equal(f.shared.has(PREFIX+p.commandId),true);
});

test('closing or logging out in one tab never clears another account or organization', () => {
  const f=fixture(), a=f.tab(), b=f.tab(); const p=pointer('own-logout-01'), q=pointer('other-logout-01',{userId:'user-2',organizationId:'org-2'});
  a.api.beginOperatorReceipt(p); b.api.beginOperatorReceipt(q);
  a.api.clearOperatorReceipts();
  assert.deepEqual([...b.api.operatorReceipts()].map(x=>x.commandId).sort(),[p.commandId,q.commandId].sort());
});

test('removing a still in-flight request cannot hide a later unknown result', () => {
  const f=fixture(), a=f.tab(), b=f.tab(); const p=pointer('in-flight-0001');
  a.api.beginOperatorReceipt(p); b.api.forgetOperatorReceipt(p.commandId,p);
  assert.equal(b.api.operatorReceipts().length,0);
  a.api.endOperatorReceipt(p.commandId,false);
  assert.equal(b.api.operatorReceipts().length,1);
});

test('a confirmed refresh waits for the response observer before acknowledging its pointer', async () => {
  const f=fixture(), a=f.tab(), p=pointer('review-exit-wait-01', { command: 'check.reviewed-exit' });
  a.api.beginOperatorReceipt(p);
  let ready=false;
  const waiting=a.api.waitForOperatorReceiptIdle(p.commandId).then(()=>{ ready=true; });
  await Promise.resolve(); assert.equal(ready,false);
  a.api.endOperatorReceipt(p.commandId,false);
  await waiting; assert.equal(ready,true);
  a.api.forgetOperatorReceipt(p.commandId);
  assert.equal(a.api.operatorReceipts().length,0);
});

test('shared storage failure retains same-tab recovery and reports degraded sharing', () => {
  const f=fixture(), a=f.tab(), b=f.tab(); a.denyShared();
  const p=pointer('shared-denied-01');
  assert.equal(a.api.beginOperatorReceipt(p),false); a.api.endOperatorReceipt(p.commandId,false);
  assert.equal(a.api.operatorReceipts().length,1);
  assert.equal(a.api.operatorReceiptStorageAvailable(),true);
  assert.equal(a.api.operatorReceiptSharingAvailable(),false);
  assert.equal(b.api.operatorReceipts().length,0);
  a.denyShared(false); assert.equal(a.api.operatorReceipts().length,1);
  assert.equal(b.api.operatorReceipts().length,1);
});

test('readable but unwritable storage does not claim result recovery is available', () => {
  const f=fixture(), a=f.tab(); a.denySharedWrites(); a.denySessionWrites();
  assert.equal(a.api.beginOperatorReceipt(pointer('quota-denied-01')),null);
  assert.equal(a.api.operatorReceipts().length,0);
  assert.equal(a.api.operatorReceiptStorageAvailable(),false);
  assert.equal(a.api.operatorReceiptSharingAvailable(),false);
});

test('a failed shared delete reports failure and preserves the pending pointer', () => {
  const f=fixture(), a=f.tab(), b=f.tab(), p=pointer('delete-quota-01');
  a.api.beginOperatorReceipt(p); a.api.endOperatorReceipt(p.commandId,false);
  b.denySharedWrites();
  assert.equal(b.api.forgetOperatorReceipt(p.commandId,p),false);
  assert.equal(a.api.operatorReceipts().length,1);
  assert.equal(b.api.operatorReceiptSharingAvailable(),false);
});

test('a different owner cannot replace an existing command ID', () => {
  const f=fixture(), a=f.tab(), b=f.tab(); const p=pointer('collision-0001');
  a.api.beginOperatorReceipt(p);
  assert.equal(b.api.beginOperatorReceipt(pointer(p.commandId,{userId:'other-user'})),null);
  assert.equal(a.api.operatorReceipts()[0].userId,'user-1');
  assert.equal(b.api.forgetOperatorReceipt(p.commandId,pointer(p.commandId,{userId:'other-user'})),false);
  assert.equal(a.api.operatorReceipts().length,1);
});
