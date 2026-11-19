'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const web=path.join(__dirname,'../apps/web');

test('coarse-pointer theme adaptations never reintroduce the parent Figtree font',()=>{
  const stylesheet=fs.readFileSync(path.join(web,'src/themes/eventouch/eventouch.css'),'utf8');
  assert.equal(stylesheet.includes('Figtree'),false,'all responsive font roles must retain the canonical Pretendard bridge');
});

test('production selects only the local theme and explicit light mode',()=>{
  const registry=fs.readFileSync(path.join(web,'astryx-themes.ts'),'utf8');
  const layout=fs.readFileSync(path.join(web,'app/layout.tsx'),'utf8');
  assert.match(registry,/defaultThemeSlug[^=]*= "eventouch"/);
  assert.doesNotMatch(registry,/theme-neutral\/fonts|design-review/);
  assert.equal((layout.match(/<Theme\b/g)||[]).length,1);
  assert.match(layout,/<Theme[^>]+mode="light"/);
});

test('installed Astryx packages remain aligned to the verified release',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(web,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(web,'package-lock.json'),'utf8'));
  for(const name of ['core','theme-neutral','cli']){
    const key='@astryxdesign/'+name;
    assert.equal((name==='cli'?pkg.devDependencies:pkg.dependencies)[key],'0.7.15');
    assert.equal(lock.packages['node_modules/'+key].version,'0.7.15');
  }
});

test('registration exposes its primary submit intent through the attendee BottomAction',()=>{
  // Reopened 2026-11-20: the submit is the one primary of the BottomAction bar (inside the form, type submit),
  // not a ProductButton; the bar's primary is the strong event-color fill (BottomAction.module.css .primary).
  const source=fs.readFileSync(path.join(web,'app/event/[slug]/register/RegisterForm.tsx'),'utf8');
  assert.match(source,/<BottomAction[\s\S]*?primary=\{\{[\s\S]*?type: "submit"/u);
  assert.doesNotMatch(source,/<ProductButton[^>]*type="submit"/u);
  const css=fs.readFileSync(path.join(web,'app/event/[slug]/ui/BottomAction.module.css'),'utf8');
  assert.match(css,/\.primary\s*\{[^}]*background:\s*var\(--ev-accent/su);
});
