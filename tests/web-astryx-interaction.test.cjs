'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {React,renderComponent,loadComponent}=require('./helpers/render-web-component.cjs');

test('locked action clicks cannot activate either the action or an ancestor',()=>{
  const ProductButton=loadComponent('ProductButton');
  let calls=0;
  const rendered=ProductButton.render({'aria-disabled':true,onClick(){calls++;},children:'인쇄하기'},null);
  const event=new Event('click',{bubbles:true,cancelable:true});
  rendered.props.onClick(event);
  assert.equal(calls,0);
  assert.equal(event.defaultPrevented,true);
  assert.equal(event.cancelBubble,true);
});

test('locked Enter and Space activation cannot reach an ancestor shortcut',()=>{
  const ProductButton=loadComponent('ProductButton');
  for(const key of ['Enter',' ']){
    let calls=0;
    const rendered=ProductButton.render({busy:true,onKeyDown(){calls++;},children:'조회 중'},null);
    const event=new Event('keydown',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'key',{value:key});
    rendered.props.onKeyDown(event);
    assert.equal(calls,0);
    assert.equal(event.defaultPrevented,true);
    assert.equal(event.cancelBubble,true);
  }
});

test('an available action forwards its original event once',()=>{
  const ProductButton=loadComponent('ProductButton');
  const event=new Event('click',{bubbles:true,cancelable:true});
  const events=[];
  ProductButton.render({onClick(received){events.push(received);},children:'검토'},null).props.onClick(event);
  assert.deepEqual(events,[event]);
  assert.equal(event.defaultPrevented,false);
});

test('an accessible icon action retains its supplied visible SVG through IconButton',()=>{
  const icon=React.createElement('span',{'aria-hidden':true},React.createElement('svg',{'data-visible-icon':'refresh'},React.createElement('path',{d:'M1 1h4'})));
  const document=renderComponent('ProductButton',{'aria-label':'다시 불러오기'},icon);
  assert.equal(document.querySelector('button').getAttribute('aria-label'),'다시 불러오기');
  assert.equal(document.querySelector('svg[data-visible-icon="refresh"]')!==null,true);
});
