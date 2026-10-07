'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load() {
  const E = {handlers:{},register(name,group,fn){this.handlers[name]={group,fn};}};
  const source = 'assets/js/booth-map-data.js';
  if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source,'utf8'),{window:{ET:E}});
  return E;
}
test('stamp counts deduplicate own committed records by existing booth ID including closed and unplaced booths', () => {
  const E = load(); assert.equal(typeof E.boothStampSummary,'function');
  const booths = [{id:'a',name:'Same'},{id:'b',name:'Same'},{id:'c',status:'CLOSED'},{id:'a'},null];
  const visits = [{boothId:'a',participantId:'me'},{boothId:'a',participantId:'me'},
    {boothId:'b',participantId:'other'},{boothId:'orphan',participantId:'me'}];
  assert.deepEqual(JSON.parse(JSON.stringify(E.boothStampSummary(booths,visits,'me'))),{total:3,completed:1,visitedBoothIds:['a']});
  assert.deepEqual(JSON.parse(JSON.stringify(E.boothStampSummary(booths,visits,null))),{total:3,completed:null,visitedBoothIds:[]});
  assert.deepEqual(JSON.parse(JSON.stringify(E.boothStampSummary([],[], 'me'))),{total:0,completed:0,visitedBoothIds:[]});
});
test('map command declarations cannot create local authoritative preview data', () => {
  const E = load();
  for (const name of ['booth.map.save','booth.map.publish','booth.map.unpublish']) {
    assert.equal(E.handlers[name]?.group,'booth');
    assert.throws(() => E.handlers[name].fn(),/서버/);
  }
});
