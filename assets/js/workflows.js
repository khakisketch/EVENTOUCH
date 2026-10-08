/* Role-aware workflow completion. Loaded after the existing product modules. */
(function(E){'use strict';
const e=E.esc,B=E.button,L=E.link,F=E.field,S=E.select;
const groups={
 'new-event':'agency','duplicate-event':'agency','edit-client':'agency','invite-member':'agency','revoke-invite':'agency',
 'edit-person':'participants','person-status':'participants','reissue-ticket':'participants','bulk-approve':'participants','bulk-cancel':'participants','bulk-group':'participants','new-group':'participants','edit-field':'participants','move-field':'participants','delete-field':'participants','close-registration':'participants','import-commit':'participants','import-edit-row':'participants',
 'edit-desk':'onsite','assign-staff':'onsite','unassign-staff':'onsite','scan-person':'onsite','correct-check':'onsite',
 'edit-booth':'booth','booth-mode':'booth',
 'edit-notice':'page','delete-notice':'page','edit-program':'page','delete-program':'page','moderate-post':'page',
 'edit-module':'programs','module-status':'programs','reveal-quiz':'programs','run-draw':'programs','publish-draw':'programs','manage-question':'programs','moderate-photo':'programs','new-reward':'programs','fulfill-reward':'programs','cancel-reward':'programs',
 'compose-message':'messages','edit-template':'messages','retry-message':'messages','cancel-message':'messages',
 'display-idle':'screen','new-report':'results','edit-report':'results','publish-report':'results',
 'assign-member':'settings','legacy-import':'settings','start-event':'settings','end-event':'settings','archive-event':'settings'
};
const canAction=(name)=>name==='new-person'?(E.can('participants',true)||E.can('onsite',true)):!groups[name]||E.can(groups[name],true);
let lockId=0;
const lockControl=(control,reason)=>{control.disabled=true;control.setAttribute('aria-disabled','true');control.title=reason;const hint=document.createElement('span');hint.className='action-feedback';hint.id='interaction-lock-'+(++lockId);hint.setAttribute('role','note');hint.textContent=reason;control.insertAdjacentElement('afterend',hint);const described=(control.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);described.push(hint.id);control.setAttribute('aria-describedby',[...new Set(described)].join(' '));};
E.applyAccessUI=()=>{
 if(!['console','agency','staff'].includes(E.route.scope))return;
 const main=document.getElementById('main-content');if(!main)return;
 const archived=E.event()?.stage==='ARCHIVED'&&E.route.scope!=='agency',group=E.route.scope==='agency'?'agency':E.groupForPage(E.route.page);
 const readonly=E.route.scope==='console'&&(!E.can(group,true)||(archived&&E.route.page!=='settings'));
 if(readonly){const info=document.createElement('div');info.className='notice';info.setAttribute('role','status');info.textContent=archived?'보관된 행사입니다. 기록은 조회만 가능합니다.':'조회 전용 화면입니다. 변경이 필요하면 운영사 관리자에게 해당 업무의 수정 권한을 요청하세요.';main.prepend(info);main.querySelectorAll('form').forEach(f=>{f.dataset.readonly='true';f.querySelectorAll('input,select,textarea,button[type="submit"]').forEach(i=>{i.disabled=true;});});}
 const stageBlocked=(E.route.scope==='staff'||E.route.page==='checkin')&&E.event()?.stage!=='LIVE';
 if(stageBlocked){const info=document.createElement('div');info.className='notice warning';info.setAttribute('role','status');const copy=document.createElement('span');copy.textContent='현장 처리는 행사가 진행 중일 때 사용할 수 있습니다. ';info.append(copy);if(E.route.scope==='console'){const link=document.createElement('a');link.href=E.consoleURL('settings');link.textContent='행사 설정에서 진행 단계를 확인하세요.';info.append(link);}else info.append(document.createTextNode('행사 매니저에게 진행 상태를 확인해 주세요.'));main.prepend(info);}
 main.querySelectorAll('[data-action]').forEach(button=>{const name=button.dataset.action;let reason='';if(!canAction(name))reason='현재 계정은 조회 권한입니다. 운영사 관리자에게 이 업무의 수정 권한을 요청하세요.';else if(archived&&(groups[name]||name==='new-person'))reason='보관된 행사는 조회만 가능합니다. 기록은 유지됩니다.';else if(stageBlocked&&['camera-scan','scan-person','new-person'].includes(name))reason='현장 처리는 행사가 진행 중일 때 사용할 수 있습니다.';if(reason&&!button.disabled)lockControl(button,reason);});
 if(stageBlocked)main.querySelectorAll('form[data-form="desk-scan"] button[type="submit"],form[data-form="booth-scan"] button[type="submit"]').forEach(button=>{if(!button.disabled)lockControl(button,'현장 처리는 행사가 진행 중일 때 사용할 수 있습니다.');});
};
for(const name of [...Object.keys(groups),'new-person']){const action=E.actions[name];if(!action)continue;E.actions[name]=async(d,b)=>{if(['console','agency','staff'].includes(E.route.scope)&&!canAction(name))throw Error('조회 권한입니다. 이 작업의 수정 권한을 행사 매니저에게 요청하세요.');if(E.route.scope!=='agency'&&E.event()?.stage==='ARCHIVED')throw Error('보관된 행사에서는 변경할 수 없습니다. 설정에서 운영 단계를 먼저 변경하세요.');return action(d,b);};}
function extend(name,check){const handler=E.handlers[name];if(!handler)return;const original=handler.fn;handler.fn=(s,p,c)=>{check(s,p,c);return original(s,p,c);};}
extend('event.update',(s,p,c)=>{if(p.stage==='LIVE'&&c.event.stage!=='LIVE'&&(!c.workspace.desks.length||!c.workspace.assignments.some(a=>a.type==='DESK'&&s.accounts.some(u=>u.id===a.accountId&&u.active&&u.role==='STAFF'))))throw Error('현장 운영을 시작하려면 등록 데스크와 활성 스태프를 먼저 배정하세요.');});
extend('form.publish',(s,p,c)=>{if(['ENDED','ARCHIVED'].includes(c.event.stage))throw Error('종료된 행사에서는 새 접수를 열 수 없습니다. 행사 운영 단계를 먼저 확인하세요.');if(!String(p.consentText||'').trim())throw Error('게시할 필수 정보 안내를 작성하세요.');});
extend('event.features',(s,p,c)=>{for(const m of c.workspace.modules)if(m.status==='OPEN'&&!(p.features||[]).includes(m.type))m.status='CLOSED';});
E.forms['event-features']=async p=>{const closing=E.work().modules.filter(m=>m.status==='OPEN'&&!(p.features||[]).includes(m.type));if(closing.length&&!window.confirm(closing.map(m=>m.title).join(', ')+' 접수를 종료하고 기능을 끌까요? 기존 응답은 유지됩니다.'))throw Error('변경을 적용하지 않았습니다. 유지할 기능을 확인하세요.');await E.run('event.features',p);E.toast('기능 설정을 적용했습니다. 꺼진 기능의 진행 중 프로그램은 종료하고 기록을 보존했습니다.');};
extend('participant.status',(s,p,c)=>{const ids=p.ids||[p.id];if(p.status!=='APPROVED'&&ids.some(id=>c.workspace.participants.some(a=>a.id===id&&a.inside)))throw Error('입장 중인 참가자는 퇴장 후 등록 상태를 변경하세요.');});
const changeStatus=E.handlers['participant.status'].fn;
E.handlers['participant.status'].fn=(s,p,c)=>{const restored=new Set(c.workspace.participants.filter(a=>a.revoked).map(a=>a.id));const result=changeStatus(s,p,c);for(const id of (p.ids||[p.id])){const person=c.workspace.participants.find(a=>a.id===id),pay=c.workspace.payments.find(a=>a.participantId===id);if(!person)continue;if(pay)person.paymentStatus=pay.status;if(person.status!=='CANCELLED'&&restored.has(id))person.ticketExpiresAt=new Date(Date.now()+90*86400000).toISOString();}return result;};
extend('participant.import',(s,p,c)=>{if(!Array.isArray(p.rows))throw Error('파일을 검토한 뒤 유효 행을 반영하세요.');});
extend('module.save',(s,p)=>{for(const key of p.type==='poll'?['options']:p.type==='survey'?['questions']:[]){const lines=String(p[key]||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(new Set(lines).size!==lines.length)throw Error(key==='options'?'중복된 투표 선택지를 제거하세요.':'평가 항목 이름은 서로 다르게 작성하세요.');if(lines.length>30)throw Error('항목은 30개 이하로 작성하세요.');p[key]=lines.join('\n');}});
extend('reward.create',(s,p,c)=>{if(!c.event.features.includes('reward'))throw Error('경품 기능을 먼저 활성화하세요.');});
extend('reward.fulfill',(s,p,c)=>{const reward=c.workspace.rewards.find(r=>r.id===p.id),person=c.workspace.participants.find(a=>a.id===reward?.participantId);if(!person||person.status!=='APPROVED'||person.revoked)throw Error('참가 확정 상태를 확인한 뒤 경품을 처리하세요.');});

// Keep preparation and optional modules useful even for an otherwise empty event.
const basePrograms=E.views.programs;
E.views.programs=()=>{let body=basePrograms();if(E.event().features.includes('reward'))body+=E.panel('경품 지급','<p>참가자에게 현장 경품 또는 기프티콘 요청을 배정하고 처리 기록을 확인합니다.</p>'+L('경품·수령',E.consoleURL('rewards')));const available=['poll','quiz','qa','draw','survey'].some(k=>E.event().features.includes(k));if(!available)body=body.replace(/<button[^>]*data-action="edit-module"[^>]*>[\s\S]*?<\/button>/,'');return body;};
const baseParticipants=E.views.participants;
E.views.participants=()=>{const body=baseParticipants();if(E.can('participants',true))return body;return body.replace(/<a class="btn [^"]*" href="[^"]*\/import">[\s\S]*?<\/a>/,'');};
const oldEventTabs=E.eventTabs;
E.eventTabs=group=>{if(group==='onsite')return E.tabs([['현장 현황',E.consoleURL('onsite'),E.route.page==='onsite'],['데스크·배정',E.consoleURL('desks'),E.route.page==='desks'],['체크인',E.consoleURL('checkin'),E.route.page==='checkin'],['입퇴장 기록',E.consoleURL('checks'),E.route.page==='checks']]);return oldEventTabs(group);};

// Choose compatible accounts and assignments before submitting, not after an error.
const baseStaff=E.views.staff;
E.views.staff=()=>{const body=baseStaff();if(!E.assignment())return body;return body.replace('<div class="od-scroll mobile-body" id="main-content">','<div class="od-scroll mobile-body" id="main-content">'+B('배정 업무 변경','choose-assignment'));};
E.actions['scan-person']=d=>{const p=E.work().participants.find(x=>x.id===d.id),desk=E.work().desks.find(x=>x.id===d.desk);if(!p||!desk)throw Error('검색 결과 또는 데스크가 변경되었습니다. 최신 자료에서 다시 검색하세요.');E.dialog('참가자 확인',E.detail([['이름',p.name],['소속',p.company||'미등록'],['연락처',E.maskPhone(p.phone)],['등록 상태',E.registrationStates[p.status]],['현장 상태',p.inside?'입장 중':p.everIn?'퇴장':'미도착'],['처리 데스크',desk.name]])+E.notice('이름과 소속을 참가자에게 확인한 뒤 처리하세요.'),()=>E.processScan('desk',desk.id,p.ticket,p.id),desk.action==='IN'?'입장 확인':'퇴장 확인');};
E.actions['staff-search']=()=>{const a=E.assignment();if(!a||a.type!=='DESK')throw Error('활성 등록 데스크 배정을 확인하세요.');E.dialog('참가자 찾기',F('이름·소속·연락처 *','query','','text','required minlength="2"'),p=>{const current=E.assignment();if(!current||current.id!==a.id)throw Error('업무 배정이 변경되었습니다. 배정된 업무로 다시 접속하세요.');const q=String(p.query||'').trim();if(q.length<2)throw Error('검색어를 두 글자 이상 입력하세요.');const found=E.work().participants.filter(x=>(x.name+' '+x.company+' '+x.phone).includes(q)).slice(0,12);E.dialog('검색 결과',(found.length?found.map(x=>'<div class="task-row"><div class="od-field od-fill"><strong>'+e(x.name)+'</strong><small>'+e(x.company)+' · '+e(E.maskPhone(x.phone))+' · '+e(E.registrationStates[x.status])+'</small></div>'+B('참가자 확인','scan-person','data-id="'+e(x.id)+'" data-desk="'+e(a.targetId)+'"')+'</div>').join(''):E.empty('참가자를 찾지 못했습니다','이름이나 연락처로 다시 검색하세요.'))+B('다시 검색','staff-search'));},'찾기');};
E.actions['camera-scan']=async d=>{
 if(E.event()?.stage!=='LIVE')throw Error('현장 인증은 행사 진행 중에 사용할 수 있습니다. 현재 행사 단계를 확인하세요.');
 E.dialog('티켓·QR 확인','<div class="notice" id="camera-help" role="status">카메라 권한을 확인하고 있습니다.</div><video id="camera-video" playsinline muted class="scanner-video"></video>'+F(d.type==='self'?'부스 코드 *':'티켓 코드 *','manual-code','','text','autocomplete="off"')+'<p class="help">카메라를 사용할 수 없거나 인식되지 않으면 코드를 직접 입력하세요.</p>',async p=>{if(!String(p['manual-code']||'').trim())throw Error('처리할 코드를 입력하세요.');if(d.type==='self')await E.actions['self-booth-code']({code:p['manual-code']});else await E.processScan(d.type,d.target,p['manual-code']);},'코드 처리');
 const video=document.getElementById('camera-video'),help=document.getElementById('camera-help');let stream;
 if(!navigator.mediaDevices?.getUserMedia){help.textContent='이 실행 환경에서 카메라를 사용할 수 없습니다. 코드를 직접 입력하세요.';return;}
 try{
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(!video.isConnected){stream.getTracks().forEach(t=>t.stop());return;}
  E.ui.cameraStream=stream;video.srcObject=stream;await video.play();if(!video.isConnected){E.stopCamera();return;}
  if(!window.BarcodeDetector){help.textContent='이 브라우저는 QR 자동 인식을 지원하지 않습니다. 티켓 코드 또는 부스 코드를 직접 입력하세요.';E.stopCamera();return;}
  const formats=await window.BarcodeDetector.getSupportedFormats();if(!video.isConnected)return;
  if(!formats.includes('qr_code')){help.textContent='QR 자동 인식을 지원하지 않습니다. 코드를 직접 입력하세요.';E.stopCamera();return;}
  const detector=new window.BarcodeDetector({formats:['qr_code']});help.textContent='QR 전체가 화면에 들어오도록 맞춰주세요.';let failures=0;
  const detect=async()=>{
   if(!video.isConnected||E.ui.cameraStream!==stream)return;
   try{const found=await detector.detect(video);failures=0;if(!video.isConnected||E.ui.cameraStream!==stream)return;if(found[0]){E.stopCamera();if(d.type==='self')await E.actions['self-booth-code']({code:found[0].rawValue});else await E.processScan(d.type,d.target,found[0].rawValue);return;}}
   catch{failures++;if(failures>=3){E.stopCamera();if(help.isConnected)help.textContent='카메라 영상을 분석하지 못했습니다. 코드를 직접 입력해 처리하세요.';return;}}
   E.ui.cameraFrame=requestAnimationFrame(detect);
  };detect();
 }catch(err){if(stream&&E.ui.cameraStream===stream)E.stopCamera();else stream?.getTracks().forEach(t=>t.stop());if(help.isConnected)help.textContent=err.name==='NotAllowedError'?'카메라 권한이 거부되었습니다. 브라우저 권한을 허용하거나 코드를 직접 입력하세요.':err.name==='NotFoundError'?'사용할 카메라를 찾지 못했습니다. 코드를 직접 입력하세요.':'카메라를 시작하지 못했습니다. 코드를 직접 입력하세요.';}
};

// Drafts are tab-local and account-specific; successful transactions clear them.
const logout=E.logout;
E.logout=()=>{E.ui.formDrafts={};E.ui.campaignDraft=null;E.ui.selected=[];logout();};

// Tables in dialogs paginate in place instead of repainting only the page behind them.
const baseTable=E.table;
E.table=(heads,rows)=>{const key=(E.route?.key||'page')+'|'+heads.join('|');E.ui.tableData=E.ui.tableData||{};E.ui.tableData[key]={heads,rows};return '<div data-table-key="'+e(key)+'">'+baseTable(heads,rows)+'</div>';};
E.actions['table-page']=(d,b)=>{E.ui.tablePages[d.key]=Math.max(1,Number(d.page)||1);const holder=b?.closest('[data-table-key]'),data=E.ui.tableData?.[d.key];if(holder&&data){const host=document.createElement('div');host.innerHTML=E.table(data.heads,data.rows);const replacement=host.firstElementChild;holder.replaceWith(replacement);replacement.querySelector('button:not(:disabled)')?.focus();}else E.render();};

// Participant rewards have their own entry, independent of the draw feature.
const baseMore=E.mobileMore,baseHome=E.mobileHome,baseEngagement=E.mobileEngagement;
E.mobileMore=()=>baseMore()+(E.event().features.includes('reward')?'<h2 class="section-title">내 경품</h2>'+L('경품·수령 상태',E.aurl('rewards')):'');
E.mobileHome=()=>baseHome()+(E.person()&&E.event().features.includes('reward')?E.panel('내 경품','<p>배정된 경품과 수령 상태를 확인하세요.</p>'+L('경품 확인',E.aurl('rewards'))):'');
E.mobileEngagement=page=>{if(page!=='rewards')return baseEngagement(page);if(!E.event().features.includes('reward'))return E.mobileState('사용하지 않는 기능입니다','이 행사에서는 경품 기능을 제공하지 않습니다.',L('행사 홈',E.aurl('home')));const person=E.person();if(!person)return E.needTicket();const rows=E.work().rewards.filter(r=>r.participantId===person.id),names={READY:'지급 대기',RECEIVED:'수령 확인 · 시뮬레이션',NEEDS_CONNECTION:'공급자 미연동',CANCELLED:'지급 취소',FAILED:'처리 실패'};return '<h1 class="mobile-title">내 경품</h1>'+E.notice('현장 경품은 담당 스태프에게 개인 티켓을 제시하세요. 기프티콘 발행과 실제 전송은 연결되지 않았습니다.')+(rows.length?rows.map(r=>'<article class="mobile-card od-stack"><h2>'+e(r.name)+'</h2>'+E.badge(names[r.status]||r.status)+E.detail([['지급 방식',r.method==='GIFT'?'기프티콘 요청':'현장 수령'],['배정 시각',E.date(r.at)]])+'</article>').join(''):E.empty('배정된 경품이 없습니다','경품 대상이면 운영자의 배정 후 표시됩니다.'))+L('내 티켓',E.aurl('ticket'));};

// Message templates, composition and review form one reversible flow.
E.openCampaign=(draft={},selected=false)=>{
 const templates=E.work().templates||E.defaultTemplates,chosen=templates.find(t=>t.id===draft.templateId),first=chosen||templates[0];
 const current={title:'',channel:first?.channel||'SMS',target:selected?'selected':'all',body:first?.body||'',scheduled:'',simulate:true,templateId:first?.id||'',...draft,selected};
 const targets=selected?[['selected','선택한 참가자']]:[['all','전체 참가자'],['checked','누적 입장 참가자'],['not-arrived','미도착 참가자'],...E.work().groups.map(g=>['group:'+g,'그룹 · '+g])];
 E.dialog('메시지 작성','<div class="progress-steps"><span class="current">1 작성</span><span>2 대상 검토</span><span>3 요청 기록</span></div>'+S('저장된 템플릿','templateId',[['','직접 작성'],...templates.map(t=>[t.id,t.name])],current.templateId)+B('선택 템플릿 적용','apply-message-template')+F('캠페인 제목 *','title',current.title,'text','required maxlength="100"')+S('채널','channel',[['ALIMTALK','알림톡'],['SMS','SMS']],current.channel)+S('대상','target',targets,current.target)+F('메시지 내용 *','body',current.body,'textarea','required maxlength="2000"')+'<p class="help">사용 가능 변수: {{이름}}, {{행사명}}, {{행사일}}, {{티켓링크}}</p>'+F('예약 시각 · 선택','scheduled',current.scheduled,'datetime-local')+E.check('실제 전송 없이 시뮬레이션으로 기록','simulate',current.simulate),p=>{
  const ids=selected?(draft.ids||E.ui.selected||[]):undefined,people=E.recipients({...p,ids});if(!people.length)throw Error('해당 조건의 수신자가 없습니다. 대상이나 참가자 명단을 확인하세요.');
  if(p.scheduled&&(!Number.isFinite(Date.parse(p.scheduled))||Date.parse(p.scheduled)<=Date.now()))throw Error('예약 시각을 현재 이후로 선택하세요.');
  const unsupported=String(p.body).replace(/\{\{(이름|행사명|행사일|티켓링크)\}\}/g,'');if(/\{\{[^}]+\}\}/.test(unsupported))throw Error('안내된 개인화 변수만 사용하세요.');
  E.ui.campaignDraft={...p,selected,ids:people.map(a=>a.id)};
  E.dialog('발송 대상 검토','<div class="progress-steps"><span>1 작성</span><span class="current">2 검토</span><span>3 기록</span></div>'+E.detail([['캠페인',p.title],['대상',people.length+'명'],['채널',p.channel==='SMS'?'SMS':'알림톡'],['예약',p.scheduled?E.date(p.scheduled):'즉시 요청'],['전송',p.simulate?'시뮬레이션 · 전달 없음':'미연동 · 실제 전송 불가']])+E.panel('개인화 예시','<p class="preserve-lines">'+e(E.personalize(p.body,people[0],E.event()))+'</p>')+E.table(['수신자','소속','연락처'],people.slice(0,50).map(a=>'<tr><td>'+e(a.name)+'</td><td>'+e(a.company)+'</td><td>'+e(E.maskPhone(a.phone))+'</td></tr>'))+(people.length>50?E.notice('전체 '+people.length+'명 중 첫 50명입니다. 요청은 검토한 전체 대상에 기록됩니다.'):'')+E.notice('검토 시점의 대상에만 요청을 기록하며 실제 메시지는 전송하지 않습니다.','warning')+B('작성으로 돌아가기','campaign-back'),async()=>{await E.run('message.create',E.ui.campaignDraft);E.ui.campaignDraft=null;E.close();E.navigate(E.consoleURL('messages'));E.toast('캠페인을 기록했습니다. 실제 전송은 발생하지 않았습니다.');},'요청 기록');
 },'대상 검토');
};
E.actions['compose-message']=d=>{if(!E.can('messages',true))throw Error('메시지 작성 권한이 없습니다.');const selected=d.selected==='true';E.ui.campaignDraft=null;E.openCampaign({ids:selected?[...(E.ui.selected||[])]:undefined},selected);};
E.actions['apply-message-template']=()=>{const form=document.querySelector('.overlay form'),id=form?.elements.namedItem('templateId')?.value,t=(E.work().templates||E.defaultTemplates).find(t=>t.id===id);if(!t)throw Error('적용할 저장 템플릿을 선택하세요.');const body=form.elements.namedItem('body');if(body.value&&body.value!==t.body&&!window.confirm('작성 중인 내용을 선택한 템플릿으로 바꿀까요?'))return;body.value=t.body;form.elements.namedItem('channel').value=t.channel;form.dataset.dirty='true';E.toast('템플릿을 적용했습니다. 내용과 대상을 확인하세요.');};
E.actions['campaign-back']=()=>{const draft=E.ui.campaignDraft;if(!draft)throw Error('작성 내용이 없습니다. 메시지를 다시 작성하세요.');E.openCampaign(draft,draft.selected);};
const messageDetail=E.actions['message-detail'];
E.actions['message-detail']=d=>{messageDetail(d);const m=E.work().messages.find(a=>a.id===d.id),button=document.querySelector('.overlay [data-action="retry-message"]');if(m?.scheduled&&Date.parse(m.scheduled)>Date.now()&&button){button.disabled=true;button.insertAdjacentHTML('afterend','<p class="help">예약 시각 이후에 실행 요청을 기록할 수 있습니다. 자동 전송은 수행하지 않습니다.</p>');}};

// Public output is projected afresh from currently enabled and approved content.
const snapshot=E.publicSnapshot;
E.publicSnapshot=()=>{const value=snapshot();if(!value)return value;const w=E.work(),features=E.event().features,mod=w.modules.find(m=>m.id===value.display.moduleId);if(value.module&&(!mod?.published||!features.includes(mod.type)))value.module=null;value.questions=features.includes('qa')?w.questions.filter(q=>q.approved&&w.modules.some(m=>m.id===q.moduleId&&m.type==='qa'&&m.published)).map(q=>({text:q.text,answer:q.answer,name:q.name})):[];if(!features.includes('photo'))value.photos=[];if(['qa','photo'].includes(value.display.type)&&!features.includes(value.display.type))value.display.type='idle';return value;};
extend('display.set',(s,p,c)=>{if(['qa','photo','poll','quiz','draw'].includes(p.type)&&!c.event.features.includes(p.type))throw Error('현재 행사에서 활성화한 콘텐츠만 출력할 수 있습니다.');if(p.type==='qa'&&!c.workspace.questions.some(q=>q.approved&&c.workspace.modules.some(m=>m.id===q.moduleId&&m.published)))throw Error('공개 승인된 질문이 없습니다. 질문 검토 후 출력하세요.');});
const outputNames={idle:'대기 화면',notice:'공지',poll:'투표 결과',draw:'당첨 결과',quiz:'퀴즈 정답',qa:'승인 질문',photo:'승인 사진'};
E.views.screen=()=>{const w=E.work(),features=E.event().features,allowed=Object.entries(outputNames).filter(([k])=>['idle','notice'].includes(k)||features.includes(k)),type=allowed.some(([k])=>k===w.display.type)?w.display.type:'idle';return E.head('행사장 출력','공개 콘텐츠를 선택하고 확인한 뒤 출력합니다.', '<a class="btn" href="'+e(E.url('#/screen/'+E.event().id))+'" target="_blank" rel="noopener">별도 출력 화면<span class="sr-only"> · 새 탭</span></a>')+E.panel('공개 화면 제어','<form data-form="display" novalidate>'+S('출력 내용','type',allowed,type,'data-display-choice')+'<div data-display-fields>'+E.outputFields(type,w.display)+'</div>'+E.notice('공개한 콘텐츠만 표시합니다. 연락처·티켓 코드·관리 기록은 출력하지 않습니다.')+(E.can('screen',true)?E.submit('공개 화면 적용'):'')+'</form>')+E.panel('현재 출력',E.detail([['설정',outputNames[w.display.type]||'대기'],['적용 시각',E.date(w.display.at)]])+B('대기 화면으로 전환','display-idle'));};
E.outputFields=(type,selection={})=>['poll','draw','quiz'].includes(type)?S('연결 프로그램 *','moduleId',[['','선택하세요'],...E.work().modules.filter(m=>m.type===type&&m.published&&(type!=='quiz'||m.revealed)&&(type!=='draw'||(m.drawHistory||[]).some(r=>r.published))).map(m=>[m.id,m.title])],selection.moduleId||'','required'):type==='notice'?S('연결 공지 *','noticeId',[['','선택하세요'],...E.work().notices.filter(n=>n.published).map(n=>[n.id,n.title])],selection.noticeId||'','required'):E.notice(type==='qa'?'공개 승인된 질문을 표시합니다.':type==='photo'?'공개 승인된 사진을 표시합니다.':'행사 기본 안내를 표시합니다.');
document.addEventListener('change',event=>{if(!event.target.matches('[data-display-choice]'))return;const fields=event.target.closest('form')?.querySelector('[data-display-fields]');if(fields)fields.innerHTML=E.outputFields(event.target.value);});
const displayView=E.views.display;
E.views.display=()=>{if(E.event()?.stage==='ARCHIVED')return '<main class="display-stage"><h1>행사가 마감되었습니다</h1><p>공개 화면 운영을 종료했습니다.</p></main>';const html=displayView();return E.event()?.stage==='ENDED'?html.replace('<p>잠시 후 시작합니다.</p>','<p>행사가 종료되었습니다.</p>'):html;};

// A published report stays fixed. A successor receives its own id and share token.
const reportData=E.reportData;
E.reportData=()=>{const data=reportData();data.programs=E.work().modules.map(m=>({name:m.title,type:m.type,responses:m.type==='qa'?E.work().questions.filter(q=>q.moduleId===m.id).length:m.type==='draw'?(m.drawHistory||[]).reduce((sum,r)=>sum+r.winners.length,0):E.work().responses.filter(r=>r.moduleId===m.id).length}));return data;};
E.register('report.successor','results',(s,p,c)=>{const old=c.workspace.reports.find(r=>r.id===p.id);if(!old||old.status!=='PUBLISHED')throw Error('공유된 보고서를 선택하세요.');const family=old.familyId||old.id,version=Math.max(...c.workspace.reports.filter(r=>(r.familyId||r.id)===family).map(r=>r.version))+1;const row={...E.copy(old),id:c.id,familyId:family,parentId:old.id,version,status:'DRAFT',snapshot:p.source==='current'?E.reportData():E.copy(old.snapshot),createdAt:c.now,publishedAt:null,shareToken:E.id('report')};c.workspace.reports.unshift(row);return row.id;});
const reportDetail=E.actions['report-detail'];
E.actions['report-detail']=d=>{reportDetail(d);const r=E.work().reports.find(r=>r.id===d.id);if(r?.status==='PUBLISHED'&&E.can('results',true)&&E.event().stage!=='ARCHIVED'){const box=document.querySelector('.overlay .modal>footer');box?.insertAdjacentHTML('afterbegin',B('새 보고서 버전','report-successor','data-id="'+e(r.id)+'"'));}};
E.workflowVersion=14;
})(window.ET);
