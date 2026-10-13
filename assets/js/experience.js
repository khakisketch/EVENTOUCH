/* EVENTOUCH completed product experience. Runs after the existing feature modules. */
(function(E){'use strict';
const e=E.esc,B=E.button,L=E.link,F=E.field,S=E.select;
const stages=['DRAFT','READY','LIVE','ENDED','ARCHIVED'];
const dateLabel=value=>{const d=new Date(value+'T12:00:00');return Number.isFinite(d.getTime())?d.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'short'}):value;};
const quick=(title,desc,page)=>'<a class="quick-link" href="'+e(E.consoleURL(page))+'"><div class="od-field od-fill"><strong>'+e(title)+'</strong><small>'+e(desc)+'</small></div>'+E.icon('arrow')+'</a>';
E.actions['close-menu']=()=>{document.body.classList.remove('menu-open');const main=document.querySelector('.admin-main');if(main)main.inert=false;const b=document.querySelector('.menu-button');b?.setAttribute('aria-expanded','false');b?.focus();};
E.actions['toggle-menu']=()=>{const open=document.body.classList.toggle('menu-open');const main=document.querySelector('.admin-main');if(main)main.inert=open;document.querySelector('.menu-button')?.setAttribute('aria-expanded',String(open));if(open)document.querySelector('.sidebar a')?.focus();};
document.addEventListener('keydown',ev=>{if(document.querySelector('.overlay')||!document.body.classList.contains('menu-open'))return;if(ev.key==='Escape')E.actions['close-menu']();if(ev.key==='Tab'){const nodes=Array.from(document.querySelectorAll('.sidebar a,.sidebar button,.menu-dismiss')).filter(n=>!n.disabled&&n.getClientRects().length),first=nodes[0],last=nodes[nodes.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last?.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first?.focus();}}});

const oldLogin=E.loginPage;
E.loginPage=()=>{
 let page=oldLogin();
 const active=E.state.accounts.filter(a=>a.active&&['OPERATOR','AGENCY','MANAGER','STAFF'].includes(a.role));
 const roles=[
  {id:'operator',name:'운영사 구성원',help:'계정별 조직·행사 권한에 맞는 화면으로 이동합니다.',matches:a=>['OPERATOR','AGENCY','MANAGER'].includes(a.role)},
  {id:'staff',name:'현장 스태프',help:'계정에 배정된 데스크·부스 업무로 이동합니다.',matches:a=>a.role==='STAFF'}
 ];
 const accounts=roles.map(group=>{const members=active.filter(group.matches);if(!members.length)return '';const options=members.map(a=>[a.id,a.name+' · '+a.email]);return '<section class="login-role-group od-stack"><div class="od-field"><h3>'+e(group.name)+'</h3><p class="help">'+e(group.help)+'</p></div>'+S('체험 계정','accountChoice_'+group.id,options,members[0].id,'data-account-choice="'+group.id+'"')+B('시작','fill-account','data-role-group="'+group.id+'" aria-label="'+e(group.name+' 선택 계정으로 시작')+'"','primary')+'</section>';}).join('');
 page=page.replace(/<details class="login-account-list">[\s\S]*?<\/details>/,'<details class="login-account-list" open><summary>역할을 선택하고 계정으로 시작</summary><p class="help">같은 역할의 계정을 한곳에서 고릅니다. 선택한 계정에 따라 권한과 배정 업무가 달라집니다.</p><div class="login-role-list">'+accounts+'</div></details>');
 const ev=E.state.events.find(a=>a.stage!=='ARCHIVED');
 if(ev)page=page.replace('<p class="help">계정은 관리자가 초대합니다.','<div class="login-preview od-field"><strong>참가자는 로그인 없이 행사 링크로 접속합니다.</strong><a href="#/event/'+e(ev.slug)+'/home">'+e(ev.name)+' 참가자 페이지</a></div><p class="help">계정은 관리자가 초대합니다.');
 return page;
};
E.actions['fill-account']=async(d,b)=>{
 const group=d.roleGroup,picker=group?document.querySelector('[data-account-choice="'+group+'"]'):null,id=picker?.value||d.id;
 const a=E.state.accounts.find(x=>x.id===id&&x.active);
 if(!a)throw Error('이 체험 계정은 사용할 수 없습니다. 다른 활성 계정을 선택하세요.');
 const f=document.querySelector('form[data-form="login"]');
 if(!f)throw Error('로그인 화면을 찾을 수 없습니다. 로그인 페이지를 다시 열어주세요.');
 if(typeof E.forms.login!=='function')throw Error('로그인 처리가 초기화되지 않았습니다. 페이지를 다시 불러오세요.');
 f.elements.namedItem('email').value=a.email;
 f.elements.namedItem('password').value='eventouch';
 const sum=f.querySelector('.error-summary');
 if(sum)sum.textContent='';
 E.ui.returnTo=null;
 if(a.role==='MANAGER'){
  const membership=E.state.memberships.find(m=>m.accountId===a.id&&E.state.events.some(ev=>ev.id===m.eventId&&ev.stage!=='ARCHIVED'));
  if(membership)E.ui.returnTo='#/console/events/'+encodeURIComponent(membership.eventId)+'/overview';
 }
 const label=b?.querySelector('.od-fixed');
 if(label)label.textContent='접속 중…';
 try{await E.forms.login({email:a.email,password:'eventouch'});}
 catch(err){
  E.ui.returnTo=null;
  if(sum){sum.textContent=err.message||'로그인하지 못했습니다. 다시 시도하세요.';sum.tabIndex=-1;sum.focus();}
  throw err;
 }finally{if(label)label.textContent='시작';}
};

E.actions['clear-event-filters']=()=>{E.ui.filters.events='';E.ui.filters.eventStatus='';E.render();};

E.phaseStrip=()=>{const stage=E.event().stage,current=stages.indexOf(stage);return '<ol class="workflow-strip" aria-label="행사 진행 단계">'+stages.map((s,i)=>'<li class="'+(i===current?'current':i<current?'done':'')+'" '+(i===current?'aria-current="step"':'')+'><strong>'+e(E.stages[s])+'</strong><small>'+e(['기본 구성','공개·배정','현장 처리','보고·공유','기록 보관'][i])+'</small></li>').join('')+'</ol>';};
const overviewStage=()=>E.badge(E.stages[E.event().stage]||E.event().stage,E.event().stage==='LIVE'?'good':(['DRAFT','READY'].includes(E.event().stage)?'warn':''));
const syncOverviewChrome=()=>document.body.classList.toggle('overview-scrolled',!!document.querySelector('.overview-page')&&window.scrollY>32);
const scheduleOverviewChromeSync=()=>window.requestAnimationFrame?window.requestAnimationFrame(syncOverviewChrome):window.setTimeout(syncOverviewChrome,0);
if(!E.ui.overviewChromeBound){E.ui.overviewChromeBound=true;window.addEventListener('scroll',syncOverviewChrome,{passive:true});window.addEventListener('hashchange',scheduleOverviewChromeSync);}
E.views.overview=()=>{
 const ev=E.event(),w=E.work(),m=E.metrics(w),prep=['DRAFT','READY'].includes(ev.stage),ended=['ENDED','ARCHIVED'].includes(ev.stage),todo=E.readiness().filter(a=>!a[1]);
 const review=w.questions.filter(a=>!a.approved).length+w.photos.filter(a=>a.status==='PENDING').length+w.posts.filter(a=>a.status==='PENDING').length;
 let tasks=[];
 if(prep)tasks=todo.filter(a=>E.can(E.groupForPage(a[2]),false)).map(([t,ok,p,d])=>[(p==='form'||p==='notices'||p==='schedule'?'게시할 ':p==='desks'?(t==='스태프 배정'?'배정할 ':'설정할 '):'확인할 ')+t,d,p,null]);
 else if(!ended){if(m.pending&&E.can('participants',false))tasks.push(['승인할 신청','신청 내용을 확인하세요.','participants',m.pending]);if(review&&E.can('programs',false))tasks.push(['검토할 참가자 콘텐츠','질문·사진·게시글을 확인하세요.','programs',review]);const scheduledMessages=w.messages.filter(a=>a.status==='SCHEDULED').length;if(scheduledMessages&&E.can('messages',false))tasks.push(['확인할 예약 메시지','예약은 실제 자동 발송이 아닌 체험 기록입니다.','messages',scheduledMessages]);}
 else{if(w.registrationOpen&&E.can('participants',true))tasks.push(['닫을 참가 접수','마감 후 추가 신청을 차단하세요.','form',null]);const openModules=w.modules.filter(a=>a.status==='OPEN').length;if(openModules&&E.can('programs',false))tasks.push(['정리할 진행 프로그램','행사 후 설문을 제외한 접수를 정리하세요.','programs',openModules]);if(!w.reports.some(a=>a.status==='PUBLISHED')&&E.can('results',false))tasks.push(['공유할 결과 보고서','집계와 요약을 확정해 고객사에 전달하세요.','reports',null]);}
 const routeIcons={form:'file',notices:'message',desks:'people',results:'chart',reports:'file',audit:'file',checkin:'scan',booths:'ticket',page:'home',participants:'people',programs:'file',messages:'message',readiness:'calendar',checks:'check'};
 const canPage=p=>E.can(E.groupForPage(p),false),canCheckin=canPage('checkin'),canParticipants=canPage('participants'),canChecks=canPage('checks');
 const primary=prep?(E.can('settings',true)?['운영 준비 이어하기','readiness','calendar']:null):ended?(E.can(E.groupForPage('results'),false)?['결과 분석 보기','results','chart']:null):(canCheckin?['체크인 시작','checkin','scan']:null);
 const primaryRow=primary?'<a class="overview-primary-row" href="'+e(E.consoleURL(primary[1]))+'">'+E.icon(primary[2])+'<span>'+e(primary[0])+'</span>'+E.icon('arrow')+'</a>':'';
 const statusCard=(label,value,unit,href='')=>{const body='<span class="overview-status-label">'+e(label)+'</span><strong class="overview-status-value">'+e(value)+'<small> '+e(unit)+'</small></strong>';return href?'<a class="overview-status-card" href="'+e(href)+'">'+body+'</a>':'<div class="overview-status-card">'+body+'</div>';};
 const firstPending=tasks.find(([,d,p,count])=>count===null||count>0);
 const liveCheckinTarget=ev.stage==='LIVE'&&canCheckin?E.consoleURL('checkin'):'';
 const pendingTarget=firstPending&&canPage(firstPending[2])?E.consoleURL(firstPending[2]):'';
 const liveStatusCard=(label,value,unit,href,icon)=>{const body='<span class="overview-live-stat-icon" aria-hidden="true">'+E.icon(icon)+'</span><span class="overview-live-stat-copy"><small>'+e(label)+'</small><strong>'+e(value)+'<em> '+e(unit)+'</em></strong></span>';return href?'<a class="overview-live-stat" href="'+e(href)+'">'+body+'</a>':'<div class="overview-live-stat">'+body+'</div>';};
 const statusStrip=ev.stage==='LIVE'?'<section class="overview-live-status" aria-labelledby="overview-status-title"><h2 id="overview-status-title">등록·입장 현황</h2><div class="overview-live-metrics">'+liveStatusCard('등록',m.total,'명',canParticipants?E.consoleURL('participants'):'','people')+liveStatusCard('현재 입장',m.inside,'명',canPage('onsite')?E.consoleURL('onsite'):'','scan')+liveStatusCard('누적 입장',m.checked,'명',canChecks?E.consoleURL('checks'):'','check')+'</div></section>':'<section class="overview-status-strip" aria-label="현재 운영 지표">'+statusCard('현재 입장',m.inside,'명')+statusCard('처리 대기',tasks.reduce((sum,[,d,p,count])=>sum+(count===null?1:count),0),'건',pendingTarget)+'<div class="overview-status-secondary">'+statusCard('등록',m.total,'명',canParticipants?E.consoleURL('participants'):'')+statusCard('누적 입장',m.checked,'명',canChecks?E.consoleURL('checks'):'')+'</div></section>';
 const checkTime=at=>{const date=new Date(at);return Number.isNaN(date.getTime())?'—':date.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});};
 const activitySection=ev.stage==='LIVE'&&canChecks?'<section class="overview-check-activity" aria-labelledby="overview-check-activity-title"><div class="overview-check-activity-heading"><h2 id="overview-check-activity-title">최근 입퇴장</h2><a href="'+e(E.consoleURL('checks'))+'">전체 기록 보기</a></div>'+(w.checks.length?'<ol class="overview-check-activity-list">'+w.checks.slice(0,2).map(record=>'<li><strong>'+e(record.name)+'</strong><span class="overview-check-activity-meta">'+e(record.action)+' · <time datetime="'+e(record.at)+'">'+e(checkTime(record.at))+'</time></span>'+(record.corrected?'<span class="overview-check-correction">정정</span>':'')+'</li>').join('')+'</ol>':'<p class="overview-check-activity-empty">아직 입퇴장 기록이 없습니다.</p>')+'</section>':'';
 const taskRows=tasks.length?'<div class="overview-task-list">'+tasks.map(([title,description,page,count])=>'<a class="overview-task-row" href="'+e(E.consoleURL(page))+'"><span class="overview-task-icon" aria-hidden="true">'+E.icon(routeIcons[page]||'file')+'</span><span class="overview-task-copy"><strong>'+e(title)+'</strong><small>'+e(description)+'</small></span>'+(count===null?'':'<span class="overview-task-count"><strong>'+e(count)+'</strong><small>건</small></span>')+E.icon('arrow')+'</a>').join('')+'</div>':'<p class="overview-task-empty">'+(prep?'기본 준비가 완료되었습니다.':'현재 대기 중인 업무가 없습니다.')+'</p>';
 const taskSection='<section class="overview-action-panel" aria-labelledby="overview-action-title"><h2 id="overview-action-title">현장 운영</h2>'+primaryRow+taskRows+'</section>';
 const menuItems=[['참가자','등록과 신청 관리','participants','people'],['부스 운영','부스와 인증 기록 관리','booths','ticket'],['운영 기록','입퇴장 처리 기록','checks','check']].filter(([,d,p])=>canPage(p)&&(p!=='booths'||ev.features.includes('stamp'))&&(p!=='checks'||ev.stage!=='LIVE'));
 const quickMenu=menuItems.length?'<section class="overview-menu-section" aria-labelledby="overview-menu-title"><h2 id="overview-menu-title">관리 메뉴</h2><nav class="overview-menu-grid" aria-label="관리 메뉴">'+menuItems.map(([label,description,page,icon])=>'<a class="overview-menu-link" href="'+e(E.consoleURL(page))+'" aria-label="'+e(label+': '+description)+'">'+E.icon(icon)+'<span>'+e(label)+'</span></a>').join('')+'</nav></section>':'';
 const attendeeLink=canPage('page')?'<a class="overview-attendee-link" target="_blank" rel="noopener" href="#/event/'+e(ev.slug)+'/home">참가자 페이지 '+E.icon('arrow')+'</a>':'';
 const identity='<section class="overview-identity" aria-label="행사 정보"><div class="overview-identity-main"><h1 class="overview-page-title">운영 현황</h1><div class="overview-event-facts"><strong>'+e(dateLabel(ev.date)+' · '+ev.start+'–'+ev.end)+'</strong><span>'+e(w.venue.name||'장소 미정')+'</span></div><div class="overview-status-chips"><span class="overview-stage-context"><span class="overview-stage-label">운영 단계</span>'+overviewStage()+'</span>'+E.badge(w.registrationOpen?'접수 중':'접수 마감',w.registrationOpen?'good':'')+'</div></div>'+attendeeLink+'</section>';
 const note='<details class="overview-help"><summary>일정·집계 기준</summary><div class="overview-help-content"><p>'+(ev.isDemo?'가상 행사 데이터입니다. ':'')+'운영 단계는 행사 일정과 별도로 저장된 상태를 따릅니다.</p><p>지표는 이 행사의 저장 기록을 기준으로 계산하며, 재입장은 누적 입장 수에 중복 합산하지 않습니다.</p><p>'+e(dateLabel(ev.date)+' · '+ev.start+'–'+ev.end+' · '+(w.venue.name||'장소 미정'))+'</p></div></details>';
 const lower='<div class="overview-lower">'+quickMenu+'</div>';
 scheduleOverviewChromeSync();
 return '<div class="overview-page">'+identity+taskSection+statusStrip+activitySection+lower+note+
 (E.state.migration?.available&&E.can('settings',true)?E.panel('이전 자료',E.notice('출처 행사가 불명확한 이전 명단은 선택한 행사로 가져오기 전에 검토가 필요합니다. 원본은 보존합니다.','warning')+B('이전 자료 가져오기','legacy-import')):'')+'</div>';
};
E.views.readiness=()=>{const all=E.readiness(),done=all.filter(a=>a[1]).length;return E.head('운영 준비 체크','신청부터 현장 처리까지 필요한 준비를 확인하세요.',E.can('settings',true)&&E.event().stage!=='LIVE'?B('행사 시작','start-event','','primary'):'')+E.phaseStrip()+E.panel('기본 준비','<div class="task-count"><strong>'+done+' / '+all.length+'</strong><span>준비 완료</span></div><progress class="progress-meter" value="'+done+'" max="'+all.length+'" aria-label="행사 준비 진행률"></progress>'+all.map(([t,ok,p,d])=>'<div class="task-row"><div class="od-row od-fill">'+E.icon(ok?'check':'file')+'<div class="od-field od-fill"><strong>'+e(t)+'</strong><small class="muted">'+e(d)+'</small></div></div>'+E.badge(ok?'준비됨':'준비 필요',ok?'good':'warn')+(E.can(E.groupForPage(p),false)?L('확인',E.consoleURL(p)):'')+'</div>').join(''));};
E.actions['open-readiness']=()=>E.navigate(E.consoleURL('readiness'));

E.register('event.stage','settings',(s,p,c)=>{if(!stages.includes(p.stage))throw Error('진행 단계를 확인하세요.');if(p.stage==='LIVE'&&(!c.workspace.desks.length||!c.workspace.assignments.some(a=>a.type==='DESK'&&s.accounts.some(u=>u.id===a.accountId&&u.active&&u.role==='STAFF'))))throw Error('등록 데스크와 스태프를 먼저 배정하세요.');if(p.stage==='ARCHIVED'&&(c.workspace.registrationOpen||c.workspace.modules.some(a=>a.status==='OPEN')))throw Error('접수와 참여 프로그램을 닫은 뒤 보관하세요.');c.event.stage=p.stage;});
E.actions['start-event']=()=>E.confirm('현장 운영 시작','진행 중으로 전환하면 스태프가 입퇴장과 부스 이용을 처리할 수 있습니다.',async()=>{await E.run('event.stage',{stage:'LIVE'});E.navigate(E.consoleURL('overview'));});

E.mobileFeatureLinks=()=>{
 const w=E.work(),ev=E.event(),items=[];
 for(const [k,v] of Object.entries(E.features)){
  if(!['poll','quiz','qa','stamp','draw','survey','photo','board'].includes(k)||!ev.features.includes(k))continue;
  if(['poll','quiz','qa','draw','survey'].includes(k)&&!w.modules.some(m=>m.type===k&&m.published))continue;
  const live=w.modules.some(m=>m.type===k&&m.status==='OPEN'&&m.published);
  items.push('<a class="engagement-link" href="'+e(E.aurl(k))+'"><strong>'+e(v)+'</strong><small>'+e(k==='stamp'?'내 인증 현황':k==='photo'?'사진 제출·공개':k==='board'?'행사 이야기':live?'참여 가능':'결과 확인')+'</small></a>');
 }
 return items.length?'<div class="engagement-links">'+items.join('')+'</div>':E.notice('공개된 참여 프로그램이 없습니다.');
};
E.mobileHome=()=>{
 const ev=E.event(),w=E.work(),p=E.person(),notices=w.notices.filter(n=>n.published).sort((a,b)=>Number(b.pinned)-Number(a.pinned)),program=w.program.filter(s=>s.published);
 const canRegister=!['ENDED','ARCHIVED'].includes(ev.stage)&&w.registrationOpen&&w.publishedVersion;
 const title=p?(p.status==='APPROVED'?'내 티켓 보기':'신청 상태 보기'):canRegister?'참가 신청':'신청 안내';
 const destination=p?(p.status==='APPROVED'?'ticket':'info'):'register';
 const own=p?'<div class="mobile-status">'+E.icon('ticket')+'<div class="od-field od-fill"><strong>'+e(p.name)+'님</strong><small>'+e(E.registrationStates[p.status])+(p.inside?' · 입장 중':'')+'</small></div></div>':'';
 const section=(name,page)=>'<div class="mobile-section-head"><h2>'+name+'</h2><a href="'+e(E.aurl(page))+'">전체 보기</a></div>';
 return '<section class="mobile-hero"><span class="eyebrow">'+e(dateLabel(ev.date))+' · '+e(ev.start)+'</span><h1>'+e(ev.name)+'</h1><p>'+e(w.branding.tagline)+'</p>'+(w.branding.keyvisual?E.image(w.branding.keyvisual,ev.name+' 행사 이미지'):'')+'<div class="hero-actions">'+L(title,E.aurl(destination),'primary','ticket')+'</div>'+own+'</section>'+
 (ev.stage==='ENDED'?E.notice('행사가 종료되었습니다. 안내와 열려 있는 만족도 평가를 확인하세요.'):'')+section('주요 안내','notices')+
 (notices.length?notices.slice(0,2).map(n=>'<a class="mobile-card od-row" href="'+e(E.aurl('notice-detail',{id:n.id}))+'"><div class="od-field od-fill"><strong class="od-clamp-2">'+e(n.title)+'</strong><small class="muted">'+(n.pinned?'중요 공지':'행사 안내')+'</small></div>'+E.icon('arrow')+'</a>').join(''):E.notice('등록과 입장 안내가 게시되면 표시됩니다.'))+
 section('행사 일정','schedule')+(program.length?program.slice(0,2).map(s=>'<a class="mobile-card od-row" href="'+e(E.aurl('program-detail',{id:s.id}))+'"><div class="od-cell time-cell"><strong>'+e(s.start)+'</strong><small>'+e(s.end)+'</small></div><div class="od-field od-fill"><strong class="od-clamp-2">'+e(s.title)+'</strong><small>'+e(s.place)+'</small></div>'+E.icon('arrow')+'</a>').join(''):E.notice('일정이 준비되면 여기에서 확인하세요.'))+
 (ev.features.some(k=>['poll','quiz','qa','stamp','draw','survey','photo','board'].includes(k))?'<div class="mobile-section-head"><h2>행사 참여</h2></div>'+E.mobileFeatureLinks():'')+
 (ev.features.includes('venue')?'<div class="mobile-section-head"><h2>오시는 길</h2></div><a class="mobile-card od-row" href="'+e(E.aurl('venue'))+'"><div class="od-field od-fill"><strong>'+e(w.venue.name||'행사장 안내')+'</strong><small class="muted od-clamp-2">'+e(w.venue.address||'상세 위치를 확인하세요.')+'</small></div>'+E.icon('arrow')+'</a>':'');
};


const oldScanForm=E.scanForm;
E.scanForm=(type,target)=>'<section class="scan-station"><div class="scan-mark">'+E.icon('scan')+'</div><h2>'+e(type==='booth'?'참가자 티켓 확인':'티켓을 확인하세요')+'</h2><p class="muted">먼저 카메라로 스캔하고, QR이 없으면 코드를 입력하세요.</p>'+B('카메라 스캔','camera-scan','data-type="'+e(type)+'" data-target="'+e(target)+'"','primary')+'</section><details class="scan-manual"><summary>코드 입력</summary>'+oldScanForm(type,target)+'</details>';
const oldStaff=E.views.staff;
E.views.staff=()=>{
 const body=oldStaff(),a=E.assignment();if(!a)return body;
 const w=E.work(),target=(a.type==='DESK'?w.desks:w.booths).find(t=>t.id===a.targetId);if(!target)return body;
 const count=a.type==='DESK'?w.checks.filter(x=>x.deskId===target.id&&!x.corrected).length:w.visits.filter(x=>x.boothId===target.id).length;
 const summary='<div class="staff-step"><strong>1 확인</strong><span>→</span><span>2 처리</span><span>→</span><span>3 다음 참가자</span></div><div class="staff-summary"><div class="od-stat"><strong>'+count+'</strong><small>이 업무의 처리 기록</small></div><div class="od-stat"><strong>'+e(a.type==='DESK'?(target.action==='IN'?'입장':'퇴장'):target.capacity?Math.max(0,target.capacity-target.used):'무제한')+'</strong><small>'+e(a.type==='DESK'?'배정 작업':'남은 수량')+'</small></div></div>';
 return body.replace('<div class="od-scroll mobile-body" id="main-content">','<div class="od-scroll mobile-body" id="main-content">'+summary);
};
E.scanResult=()=>{const r=E.ui.scanResult;if(!r)return '';return '<div class="status-block '+(r.error?'failure':'')+'" role="status" aria-live="polite"><div class="od-row">'+E.icon(r.error?'close':'check')+'<h2>'+e(r.title)+'</h2></div><p>'+e(r.text)+'</p><div class="actions">'+B(r.error?'다시 확인하기':'다음 참가자','clear-scan')+'</div></div>';};
const oldClear=E.actions['clear-scan'];
E.actions['clear-scan']=()=>{oldClear();requestAnimationFrame(()=>document.querySelector('[data-action="camera-scan"]')?.focus());};

// Existing handlers retain their storage transaction; add complete input/state boundaries.
function guard(name,check){const h=E.handlers[name];if(!h)return;const old=h.fn;h.fn=(s,p,c)=>{check(s,p,c);return old(s,p,c);};}
guard('staff.assign',(s,p,c)=>{if(!['DESK','BOOTH'].includes(p.type))throw Error('업무 유형을 선택하세요.');const account=s.accounts.find(a=>a.id===p.accountId&&a.active);if(!account)throw Error('활성 팀원을 선택하세요.');if(account.role==='DESK'&&p.type!=='DESK'||account.role==='BOOTH'&&p.type!=='BOOTH')throw Error('팀원의 역할에 맞는 데스크 또는 부스를 배정하세요.');});
guard('participant.self-update',(s,p,c)=>{p.group=c.participant.group;});
guard('field.save',(s,p,c)=>{const base=c.workspace.fields.find(f=>f.id===p.id);if(base&&['name','phone'].includes(base.id)){p.type='text';p.required=true;}});
guard('event.create',(s,p)=>{if(!Number.isInteger(Number(p.capacity))||Number(p.capacity)<0)throw Error('정원은 0 이상의 정수로 입력하세요.');if(!Number.isFinite(Date.parse(p.date+'T12:00:00'))||p.start>=p.end)throw Error('행사 날짜와 시작·종료 시간을 확인하세요.');});
guard('event.update',(s,p,c)=>{if(p.clientId&&!s.clients.some(x=>x.id===p.clientId))throw Error('유효한 고객사를 선택하세요.');if(p.slug!==c.event.slug&&(c.workspace.participants.length||c.workspace.registrationOpen))throw Error('신청 접수 후 행사 주소는 변경할 수 없습니다. 기존 참가자 링크를 유지하세요.');if(p.stage==='ARCHIVED'&&(c.workspace.registrationOpen||c.workspace.modules.some(x=>x.status==='OPEN')))throw Error('접수와 참여 프로그램을 먼저 닫으세요.');});
guard('question.submit',(s,p,c)=>{if(['DRAFT','ARCHIVED'].includes(c.event.stage))throw Error('현재 질문을 제출할 수 없습니다.');});
guard('question.like',(s,p,c)=>{if(c.participant.status!=='APPROVED')throw Error('참가 확정 후 공감할 수 있습니다.');});
for(const command of ['photo.submit','post.submit'])guard(command,(s,p,c)=>{if(['DRAFT','ARCHIVED'].includes(c.event.stage)||c.participant.status!=='APPROVED')throw Error('참가 확정된 행사에서 제출할 수 있습니다.');});
guard('response.submit',(s,p,c)=>{const m=c.workspace.modules.find(x=>x.id===p.moduleId);if(m?.type==='survey'){const qs=m.questions||['전반적인 만족도','프로그램 구성','현장 운영','행사장 편의성','재참석 의향'];if(!p.ratings||Object.keys(p.ratings).length!==qs.length||qs.some(q=>!Object.hasOwn(p.ratings,q)))throw Error('모든 만족도 질문에 답해주세요.');}});
guard('module.status',(s,p,c)=>{if(['DRAFT','ARCHIVED'].includes(c.event.stage)&&p.status==='OPEN')throw Error('행사 준비를 마친 뒤 프로그램을 시작하세요.');});
guard('booth.visit',(s,p,c)=>{const person=E.route.scope==='attendee'?c.participant:c.workspace.participants.find(x=>x.ticket===E.resolveCode(p.ticket));if(person&&!['FREE','PAID'].includes(person.paymentStatus))throw Error('결제가 완료된 참가자만 이용할 수 있습니다.');});
guard('message.create',(s,p)=>{if(p.scheduled&&!Number.isFinite(Date.parse(p.scheduled)))throw Error('예약 날짜와 시간을 확인하세요.');if(/\{\{[^}]+\}\}/.test(String(p.body).replace(/\{\{(이름|행사명|행사일|티켓링크)\}\}/g,'')))throw Error('지원하는 개인화 변수만 사용하세요.');});

// Additional registration fields appear in both editing and confirmation screens.
const oldPersonFields=E.personFields;
E.personFields=(p={},includeGroup=true)=>{
 const fields=E.route.scope==='attendee'?E.work().publishedFields:E.work().fields;
 const extra=fields.filter(f=>!['name','phone','email','company'].includes(f.id));
 return oldPersonFields(p,includeGroup)+(extra.length?'<div class="form-grid section-title">'+extra.map(f=>{
  const label=f.label+(f.required?' *':''),value=p.answers?.[f.id]??'',attrs=f.required?'required':'';
  if(f.type==='select')return S(label,f.id,[['','선택하세요'],...(f.options||[])],value,attrs);
  if(f.type==='checkbox')return '<label class="checkline"><input type="checkbox" name="'+e(f.id)+'" '+(value?'checked':'')+' '+attrs+'><span class="od-field"><span>'+e(label)+'</span></span></label>';
  return F(label,f.id,value,f.type==='email'?'email':'text',attrs);
 }).join('')+'</div>':'');
};
for(const name of ['participant.update','participant.self-update']){
 const h=E.handlers[name],old=h.fn;
 h.fn=(s,p,c)=>{
  const fields=E.route.scope==='attendee'?c.workspace.publishedFields:c.workspace.fields;
  const answers={};for(const f of fields){if(['name','phone','email','company'].includes(f.id))continue;const value=p[f.id];if(f.required&&(value===undefined||value===''||value===false))throw Error(f.label+'은(는) 필수 항목입니다.');if(f.type==='select'&&value&&!f.options.includes(value))throw Error(f.label+'의 선택지를 확인하세요.');answers[f.id]=value??'';}
  const result=old(s,p,c),person=name==='participant.self-update'?c.participant:c.workspace.participants.find(x=>x.id===p.id);person.answers={...(person.answers||{}),...answers};return result;
 };
}

// Import errors can be corrected before any participant is committed.
const oldImport=E.views.import;
E.views.import=()=>{
 const page=oldImport(),data=E.ui.importData;
 if(!data?.preview?.errors.length)return page;
 return page+E.panel('오류 행 수정',data.preview.errors.slice(0,50).map(r=>'<div class="task-row"><div class="od-field od-fill"><strong>파일 '+r.row+'행</strong><small class="muted">'+e(r.reason)+'</small></div>'+B('행 수정','import-edit-row','data-row="'+r.row+'"')+'</div>').join('')+E.notice('수정 후 전체 명단을 다시 검토합니다. 참가자 등록은 유효 행 반영을 누른 뒤 실행됩니다.'));
};
E.actions['import-edit-row']=d=>{
 const data=E.ui.importData,index=Number(d.row)-2,row=data?.rows[index];if(!row)return;
 const keys=[['name','이름 *'],['phone','연락처 *'],['email','이메일'],['company','소속']];
 E.dialog('파일 '+d.row+'행 수정',keys.filter(([k])=>data.map[k]!=='').map(([k,t])=>F(t,k,row[Number(data.map[k])]||'',k==='phone'?'tel':k==='email'?'email':'text',['name','phone'].includes(k)?'required':'')).join(''),p=>{
  for(const [k] of keys)if(data.map[k]!=='')row[Number(data.map[k])]=p[k]||'';
  E.forms['import-map'](data.map);E.close();E.toast('수정한 명단을 다시 검토했습니다.');
 },'수정·재검토');
};
const oldImportMap=E.forms['import-map'];
E.forms['import-map']=p=>{const used=Object.values(p).filter(v=>v!=='');if(new Set(used).size!==used.length)throw Error('각 항목은 서로 다른 파일 열에 연결하세요.');return oldImportMap(p);};
guard('participant.import',(s,p,c)=>{if(['ENDED','ARCHIVED'].includes(c.event.stage))throw Error('종료된 행사는 새 명단을 받을 수 없습니다.');});

// Program-specific forms reveal only the fields needed for the selected format.
E.actions['edit-module']=d=>{
 const m=E.work().modules.find(x=>x.id===d.id)||{};
 const allowed=['poll','quiz','qa','draw','survey'].filter(k=>E.event().features.includes(k));
 if(!allowed.length){E.dialog('참여 기능을 선택하세요',E.notice('행사 설정에서 사용할 참여 기능을 먼저 켜세요.')+L('기능 설정',E.consoleURL('features')));return;}
 const type=m.type||d.type||allowed[0];
 if(!m.id&&!d.chosen){E.dialog('프로그램 만들기',S('프로그램 종류','type',allowed.map(k=>[k,E.features[k]]),allowed.includes(type)?type:allowed[0]),p=>E.actions['edit-module']({type:p.type,chosen:true}),'다음');return;}
 const fixed='<div class="context-summary">'+E.badge(E.features[type])+'</div>';
 let body=fixed+F('제목 *','title',m.title,'text','required maxlength="100"');
 if(type==='poll')body+=F('선택지 * · 줄마다 하나','options',(m.options||[]).join('\n'),'textarea','required');
 if(type==='quiz')body+=F('정답 *','answer',m.answer,'text','required maxlength="200"');
 if(type==='survey')body+=F('평가 항목 * · 줄마다 하나','questions',(m.questions||['전반적인 만족도','프로그램 구성','현장 운영','행사장 편의성','재참석 의향']).join('\n'),'textarea','required');
 if(type==='qa')body+=E.notice('질문은 검토 후 공개하며 운영자가 답변할 수 있습니다.');
 if(type==='draw')body+=E.notice('추첨은 참가 확정·누적 입장·미당첨 참가자를 대상으로 합니다.');
 E.dialog(m.id?'프로그램 편집':E.features[type]+' 만들기',body,async p=>{await E.run('module.save',{...p,id:m.id,type});E.close();E.toast('프로그램을 저장했습니다. 시작하면 참가자에게 공개됩니다.');});
};
guard('module.save',(s,p,c)=>{if(p.type==='survey'&&!String(p.questions||'').trim())throw Error('평가 항목을 하나 이상 입력하세요.');if(!c.event.features.includes(p.type))throw Error('행사에서 사용하도록 설정한 종류를 선택하세요.');});

// Lifecycle controls preserve the editable draft and fixed published snapshots.
const oldSettings=E.views.settings;
E.views.settings=()=>oldSettings()+(E.can('settings',true)?E.panel('행사 마감과 보관',E.notice('행사 종료와 접수 마감은 별개입니다. 종료 후 만족도 평가를 계속 받을 수 있으며, 보관 전에는 모든 접수를 닫아야 합니다.')+'<div class="actions">'+(E.event().stage==='LIVE'?B('행사 종료','end-event','','danger'):'')+(E.event().stage==='ENDED'?B('행사 보관','archive-event'):'')+(E.event().stage==='ARCHIVED'?'<p class="help">다시 운영하려면 기본정보의 진행 단계를 변경하세요.</p>':'')+'</div>'):'');
E.actions['end-event']=()=>E.confirm('행사 종료','현장 입퇴장과 부스 인증이 중단됩니다. 아직 열린 접수와 만족도 평가는 별도로 닫을 수 있습니다.',()=>E.run('event.stage',{stage:'ENDED'}));
E.actions['archive-event']=()=>E.confirm('행사 보관','보관 이후 참가자와 기록은 조회 전용입니다. 접수와 참여 프로그램을 먼저 닫아주세요.',()=>E.run('event.stage',{stage:'ARCHIVED'}));
guard('report.create',(s,p)=>{if(p.sections?.some(x=>!['overview','attendance','programs','survey','photos'].includes(x)))throw Error('보고서 구성 항목을 확인하세요.');if(p.color&&!/^#[0-9a-fA-F]{6}$/.test(p.color))throw Error('보고서 색상은 6자리 색 코드로 선택하세요.');});
guard('report.update',(s,p)=>{if(p.color&&!/^#[0-9a-fA-F]{6}$/.test(p.color))throw Error('보고서 색상을 확인하세요.');});
guard('payment.refund-request',(s,p,c)=>{c.participant.paymentStatus='REFUND_REQUESTED';});
guard('payment.refund',(s,p,c)=>{const pay=c.workspace.payments.find(x=>x.id===p.id),person=c.workspace.participants.find(x=>x.id===pay?.participantId);if(person?.inside)throw Error('입장 중인 참가자는 퇴장 후 환불 처리하세요.');});

const oldDisplay=E.views.display;
E.views.display=()=>!E.route.eventId||!E.event()?'<main class="display-stage"><h1>행사를 찾을 수 없습니다</h1><p>운영자가 전달한 출력 주소를 확인하세요.</p></main>':oldDisplay();
const oldValidate=E.validateInput;
E.validateInput=input=>{if(!input.id&&input.willValidate&&!input.checkValidity())input.id=E.id('validation');return oldValidate(input);};

// Main navigation restores route-specific scroll and puts the new heading in keyboard reach.
document.addEventListener('click',ev=>{const a=ev.target.closest('a[href^="#/"]');if(a&&a.target!=='_blank'&&!ev.defaultPrevented){E.ui.routeFocus=true;document.body.classList.remove('menu-open');const main=document.querySelector('.admin-main');if(main)main.inert=false;}});
const oldRender=E.render;
E.render=()=>{const next=E.parseRoute();if(E.route&&(next.eventId!==E.route.eventId||next.scope!==E.route.scope||next.assignmentId!==E.route.assignmentId)){E.ui.scanResult=null;E.ui.deskId=null;E.ui.selected=[];E.ui.importData=null;E.ui.filters.deskSearch='';}oldRender();if(E.ui.routeFocus){E.ui.routeFocus=false;requestAnimationFrame(()=>{const main=document.getElementById('main-content');if(main){main.setAttribute('tabindex','-1');main.focus({preventScroll:true});}});}};
})(window.ET);
