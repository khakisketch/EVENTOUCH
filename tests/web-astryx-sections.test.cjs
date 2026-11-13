'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {React,renderComponent}=require('./helpers/render-web-component.cjs');
function section(){
  return renderComponent('../console/console-ui/ConsoleSection',{
    headingId:'roster-heading',title:'참가자 명단',className:'rosterSection',
  },React.createElement('input',{type:'checkbox','aria-label':'참가자 선택'}));
}

test('a console section remains a named region through the real vendor wrappers',()=>{
  const document=section();
  const region=document.querySelector('[data-workspace-section]');
  assert.equal(region.getAttribute('role'),'region');
  assert.equal(region.getAttribute('aria-labelledby'),document.querySelector('h2').id);
});

test('roster heading clipping never hides the vendor content container or its controls',()=>{
  const document=section();
  const css=fs.readFileSync(path.join(__dirname,'../apps/web/app/console/events/[id]/participants/participants.module.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,selector,body])=>selector.includes('.rosterSection')&&body.includes('clip-path'));
  assert.equal(rules.length,1,'the supplementary heading stays available to screen readers');
  const clipped=document.querySelectorAll(rules[0][1].trim());
  assert.equal(clipped.length,1);
  assert.equal(Boolean(clipped[0].querySelector('input')),false,'record controls must never be inside a clipped ancestor');
  assert.ok(clipped[0].querySelector('h2'),'only the section heading is visually hidden');
});
