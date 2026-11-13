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

test('registration exposes its primary submit intent through the real action adapter',()=>{
  const {createRequire}=require('node:module');
  const webRequire=createRequire(path.join(web,'package.json'));
  const ts=webRequire('typescript');
  const source=fs.readFileSync(path.join(web,'app/event/[slug]/register/RegisterForm.tsx'),'utf8');
  const file=ts.createSourceFile('RegisterForm.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const submits=[];
  const visit=node=>{
    if(ts.isJsxOpeningElement(node)&&node.tagName.getText(file)==='ProductButton'){
      const props={};
      for(const attr of node.attributes.properties){
        if(ts.isJsxAttribute(attr)&&attr.initializer&&ts.isStringLiteral(attr.initializer)) props[attr.name.getText(file)]=attr.initializer.text;
      }
      if(props.type==='submit')submits.push(props);
    }
    ts.forEachChild(node,visit);
  };
  visit(file);
  assert.equal(submits.length,1);
  const {renderComponent}=require('./helpers/render-web-component.cjs');
  const button=renderComponent('ProductButton',submits[0],'신청하기').querySelector('button');
  assert.equal(button.getAttribute('data-variant'),'primary');
});
