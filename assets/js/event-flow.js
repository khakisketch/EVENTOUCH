(function(E){
'use strict';
const e=E.esc,B=E.button,L=E.link;
const eventHash=(ev,page='home')=>'#/event/'+encodeURIComponent(ev.slug)+'/'+page;
const staffHash=(eventId,assignmentId)=>'#/staff/'+encodeURIComponent(eventId)+'/'+encodeURIComponent(assignmentId);
const isOpen=desk=>desk?.open!==false;
const actionName=action=>action==='IN'?'입장':'퇴장';
const qr=value=>'<div class="qr event-qr-code">'+window.ETQR.encode(value)+'</div>';
const printSheet=(size,markup)=>{
 const style=document.createElement('style');
 style.dataset.eventouchPrintPage='true';
 style.textContent='@page{size:'+(size==='A3'?'A3':'A4')+' portrait;margin:12mm}';
 document.head.append(style);
 const clear=()=>{style.remove();window.removeEventListener('afterprint',clear);};
 window.addEventListener('afterprint',clear,{once:true});
 E.printContent(markup);
};

const deskSave=E.handlers['desk.save'];
E.register('desk.save',deskSave.group,(s,p,c)=>{
 const old=p.id&&c.workspace.desks.find(d=>d.id===p.id);
 const oldAction=old?.action,oldOpen=old?.open;
 const changed=!!old&&oldAction!==p.action;
 if(changed&&!p.confirmDirectionChange)throw Error('입장·퇴장 방향 변경을 확인한 뒤 저장하세요.');
 const result=deskSave.fn(s,p,c);
 const desk=p.id?c.workspace.desks.find(d=>d.id===p.id):c.workspace.desks[c.workspace.desks.length-1];
 if(desk)desk.open=changed?false:(old?oldOpen!==false:p.open!==false);
 return result;
},deskSave.options);

const checkScan=E.handlers['check.scan'];
E.register('check.scan',checkScan.group,(s,p,c)=>{
 const desk=c.workspace.desks.find(d=>d.id===p.deskId);
 if(desk?.open===false)throw Error('이 데스크는 닫혀 있습니다. 매니저가 다시 열 때까지 입퇴장을 처리하지 않습니다.');
 return checkScan.fn(s,p,c);
},checkScan.options);

const createParticipant=E.handlers['participant.create'];
E.register('participant.create',createParticipant.group,(s,p,c)=>{
 if(E.route.scope==='staff'){
  const assignment=c.workspace.assignments.find(a=>a.id===E.route.assignmentId&&a.accountId===E.session?.id);
  const desk=assignment?.type==='DESK'&&c.workspace.desks.find(d=>d.id===assignment.targetId);
  if(!desk||desk.open===false)throw Error('현장 등록 데스크가 닫혀 있습니다. 행사 매니저에게 확인하세요.');
 }
 return createParticipant.fn(s,p,c);
},createParticipant.options);

E.register('desk.set-open','onsite',(s,p,c)=>{
 const desk=c.workspace.desks.find(d=>d.id===p.id);
 if(!desk)throw Error('데스크를 찾을 수 없습니다.');
 if(typeof p.open!=='boolean')throw Error('데스크 가동 상태를 지정하세요.');
 desk.open=p.open;
});

E.actions['edit-desk']=d=>{
 const desk=E.work().desks.find(x=>x.id===d.id)||{};
 E.dialog('데스크 설정',E.field('데스크 이름 *','name',desk.name||'','text','required maxlength="60"')+E.select('처리 방향','action',[['IN','입장 처리'],['OUT','퇴장 처리']],desk.action||'IN')+E.check('방향 변경 시 지점을 닫고 기존 기록을 보존합니다.','confirmDirectionChange',false)+E.check('처리 지점 열기','open',desk.open!==false)+E.notice('입장·퇴장 방향을 바꾸면 이 지점은 닫힙니다. 행사 전체 모드는 바뀌지 않습니다.'),async p=>{
  const changed=!!desk.id&&desk.action!==p.action;
  if(changed&&!p.confirmDirectionChange)throw Error('입장·퇴장 방향을 바꾸려면 확인란을 선택하세요.');
  await E.run('desk.save',{...p,id:desk.id,confirmDirectionChange:!!p.confirmDirectionChange,open:changed?false:!!p.open});
  E.close();
 });
};

E.actions['toggle-desk-open']=d=>{
 const desk=E.work().desks.find(x=>x.id===d.id);
 if(!desk)throw Error('데스크를 찾을 수 없습니다.');
 const open=!isOpen(desk);
 E.confirm(open?'입퇴장 지점 열기':'입퇴장 지점 닫기',open?'이 데스크에서 '+actionName(desk.action)+' 처리를 다시 받습니다. 현재 방향은 그대로 유지됩니다.':actionName(desk.action)+' 처리가 중지됩니다. 이 지점의 참가자 QR 처리가 거부되고 기록은 유지됩니다.',()=>E.run('desk.set-open',{id:desk.id,open,name:desk.name+(open?' · 열기':' · 닫기')}));
};

const oldDeskView=E.views.desks;
E.views.desks=()=>{
 const w=E.work(),ev=E.event(),editable=E.can('onsite',true);
 const stations=w.desks.length?w.desks.map(d=>'<div class="event-flow-station"><div class="od-field"><strong>'+e(d.name)+'</strong><span>'+e(actionName(d.action))+' 처리</span></div><div class="event-flow-station-state"><span class="badge '+(isOpen(d)?'good':'warn')+'">'+(isOpen(d)?(ev.stage==='LIVE'?'열림':'열림 · 행사 시작 대기'):'닫힘')+'</span>'+(editable?'<div class="actions">'+B(isOpen(d)?'지점 닫기':'지점 열기','toggle-desk-open','data-id="'+e(d.id)+'"')+B('설정','edit-desk','data-id="'+e(d.id)+'"')+'</div>':'')+'</div></div>').join(''):E.empty('입퇴장 지점이 없습니다','입장 지점과 퇴장 지점을 각각 만들어 주세요.');
 const assignments=w.assignments.filter(a=>a.type==='DESK'&&w.desks.some(d=>d.id===a.targetId));
 const qrRows=assignments.length?'<div class="event-flow-qr-list">'+assignments.map(a=>{const desk=w.desks.find(d=>d.id===a.targetId),account=E.state.accounts.find(x=>x.id===a.accountId),url=E.url(staffHash(ev.id,a.id));return '<article class="event-flow-qr-card"><div class="od-field"><strong>'+e(desk.name)+' · '+e(actionName(desk.action))+'</strong><small>'+e(account?.name||'담당 스태프')+' · 배정 업무로만 접근</small></div>'+qr(url)+'<div class="od-field"><span class="code">'+e(url)+'</span><small class="muted">스태프 계정 로그인 후 지정된 데스크가 열립니다.</small></div><div class="actions">'+B('업무 QR 인쇄','print-staff-qr','data-id="'+e(a.id)+'"')+B('링크 복사','copy-staff-link','data-id="'+e(a.id)+'"')+'</div></article>';}).join('')+'</div>':E.empty('스태프 업무 QR을 만들 수 없습니다','먼저 데스크를 스태프에게 배정하세요.',editable?B('업무 배정','assign-staff'):'');
 return oldDeskView()+E.panel('입퇴장 지점 가동 상태','<p class="help">각 지점의 방향은 고정됩니다. 입장과 퇴장을 동시에 운영할 수 있으며, 행사 전체를 한 번에 전환하지 않습니다.</p><div class="event-flow-stations">'+stations+'</div>')+E.panel('스태프용 데스크 업무 QR',qrRows+E.notice('이 QR은 배정된 스태프의 업무 페이지를 여는 링크입니다. 참가자용 행사 안내 QR이나 개인 티켓 QR과 다릅니다. 링크를 공유해도 실제 계정 인증·여러 기기 동기화가 제공되지는 않습니다.'));
};

E.views['event-qr']=()=>{
 const ev=E.event(),w=E.work(),url=E.url(eventHash(ev));
 const accepting=w.registrationOpen&&w.publishedVersion>0&&!['ENDED','ARCHIVED'].includes(ev.stage);
 const qrInstructions=accepting?'사전 등록자는 행사 안내를 확인하고, 미등록자는 휴대폰에서 참가 신청을 진행하세요.':'행사 안내는 볼 수 있습니다. 현재 현장 등록은 열려 있지 않습니다.';
 return E.head('행사 QR·안내판','입구 A3/A4 안내판에 사용할 참가자 행사 QR입니다. 스캔 자체가 입장 처리되지는 않습니다.')+E.eventTabs('page')+E.panel('입구에 부착할 행사 QR','<div class="event-flow-public-qr"><div><span class="eyebrow">참가자 모바일 페이지</span><h2>'+e(ev.name)+'</h2><p>'+e(qrInstructions)+'</p>'+E.badge(accepting?'현장 등록 가능':'등록 닫힘',accepting?'good':'warn')+E.notice('A3/A4 안내판에는 행사장 안내에 입력한 주소·길찾기·문의처가 함께 인쇄됩니다.')+(E.event().features.includes('venue')?L('행사장 안내 입력',E.consoleURL('venue'),'','arrow'):'')+'<div class="od-field event-flow-url"><strong>행사 링크</strong><span class="code">'+e(url)+'</span></div><div class="actions">'+B('A3 안내판 인쇄','print-event-poster','data-size="A3"')+B('A4 안내판 인쇄','print-event-poster','data-size="A4"')+B('링크 복사','copy-event-link')+L('참가자 화면 열기',eventHash(ev),'','arrow')+'</div></div>'+qr(url)+'</div>'+E.notice('안내판 QR은 행사 안내·신청 페이지로 연결됩니다. 실제 입장·퇴장 기록은 데스크에서 참가자의 개인 티켓 QR을 확인해 처리합니다.'))+E.panel('현장 QR 세 가지','<div class="event-flow-qr-types"><div class="od-field"><strong>행사 안내 QR</strong><span>입구 A3/A4 포스터 · 행사 홈과 등록</span></div><div class="od-field"><strong>개인 티켓 QR</strong><span>참가자 휴대폰 · 데스크에서 개인 확인과 입퇴장 처리</span></div><div class="od-field"><strong>스태프 업무 QR</strong><span>데스크별 배정 링크 · 노트북 현장 업무 화면</span></div></div>');
};

E.actions['copy-event-link']=()=>E.copyLink(E.url(eventHash(E.event())));
E.actions['print-event-poster']=d=>{
 const ev=E.event(),venue=E.work().venue||{},size=d.size==='A3'?'A3':'A4',url=E.url(eventHash(ev));
 const venueInfo=[venue.address?'<p><strong>주소</strong><span>'+e(venue.address)+'</span></p>':'',venue.directions?'<p><strong>오시는 길</strong><span>'+e(venue.directions)+'</span></p>':'',venue.contact?'<p><strong>문의</strong><span>'+e(venue.contact)+'</span></p>':''].filter(Boolean).join('');
 const venueBlock=venueInfo?'<section class="event-qr-sheet-info" aria-label="행사장 길찾기와 문의처">'+venueInfo+'</section>':'';
 const markup='<main class="event-qr-sheet '+(size==='A3'?'is-a3':'is-a4')+'"><div class="event-qr-sheet-brand">EVENTOUCH</div><p>행사 안내 · 참가 등록</p><h1>'+e(ev.name)+'</h1><p class="event-qr-sheet-meta">'+e(ev.date)+' · '+e(ev.start)+(venue.name?' · '+e(venue.name):'')+'</p>'+venueBlock+'<div class="qr">'+window.ETQR.encode(url)+'</div><h2>QR을 스캔해 행사 안내를 확인하세요</h2><p>사전 등록하지 않았다면 휴대폰에서 참가 신청을 진행할 수 있습니다.</p><p class="event-qr-sheet-note">이 QR은 행사 페이지용입니다. 입장 확인은 접수 데스크에서 개인 티켓 QR로 처리합니다.</p><p class="code">'+e(url)+'</p></main>';
 printSheet(size,markup);
};
E.actions['copy-staff-link']=d=>{const a=E.work().assignments.find(x=>x.id===d.id);if(a)E.copyLink(E.url(staffHash(E.event().id,a.id)));};
E.actions['print-staff-qr']=d=>{
 const ev=E.event(),w=E.work(),a=w.assignments.find(x=>x.id===d.id&&x.type==='DESK'),desk=a&&w.desks.find(x=>x.id===a.targetId),account=a&&E.state.accounts.find(x=>x.id===a.accountId);
 if(!a||!desk)throw Error('배정된 데스크를 찾을 수 없습니다.');
 const url=E.url(staffHash(ev.id,a.id)),markup='<main class="event-qr-sheet is-a4 event-staff-qr-sheet"><div class="event-qr-sheet-brand">EVENTOUCH · 스태프 업무</div><p>현장 데스크</p><h1>'+e(desk.name)+'</h1><h2>'+e(actionName(desk.action))+' 처리 · '+e(account?.name||'배정 스태프')+'</h2><div class="qr">'+window.ETQR.encode(url)+'</div><p>이 QR은 스태프 업무 페이지용입니다. 참가자 개인 티켓 QR은 현장 화면에서 별도로 확인하세요.</p><p>배정 계정으로 로그인하면 이 데스크만 열립니다.</p><p class="code">'+e(url)+'</p></main>';
 printSheet('A4',markup);
};

const oldCheckin=E.views.checkin;
E.views.checkin=()=>{
 const w=E.work(),desk=w.desks.find(x=>x.id===E.ui.deskId)||w.desks[0];
 if(!desk||isOpen(desk))return oldCheckin();
 const records=w.checks.filter(x=>x.deskId===desk.id).slice(0,8);
 return E.head(desk.name,actionName(desk.action)+' 처리가 중지되었습니다.',L('데스크 설정',E.consoleURL('desks'),'primary','settings'))+E.eventTabs('onsite')+E.fieldOperationWarning(desk)+E.panel('이 지점은 닫혀 있습니다',E.detail([['지점',desk.name],['고정 작업',actionName(desk.action)],['상태','닫힘']])+L('데스크 가동 설정',E.consoleURL('desks')))+E.panel('최근 처리 기록',records.length?E.table(['시점','참가자','처리'],records.map(r=>'<tr><td>'+e(E.date(r.at))+'</td><td>'+e(r.name)+'</td><td>'+e(actionName(r.action))+'</td></tr>')):E.empty('기록이 없습니다','이 데스크에서 처리한 업무가 여기에 표시됩니다.'));
};

const oldScanForm=E.scanForm;
if(oldScanForm)E.scanForm=(type,target)=>{
 if(type==='desk'){
  const desk=E.work()?.desks.find(x=>x.id===target);
  if(desk?.open===false)return E.notice('이 지점은 닫혀 있습니다. 매니저가 다시 열 때까지 QR 처리를 할 수 없습니다.','warning');
 }
 return oldScanForm(type,target).replace('class="btn primary" type="submit"','class="btn scan-code-submit" type="submit"');
};

})(window.ET);
