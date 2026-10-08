(function(E){'use strict';
const e=E.esc,B=E.button,L=E.link,F=E.field,S=E.select;
const org={ 'events.all':'모든 행사 보기','events.create':'행사 생성·복제','clients.manage':'고객사 내부 기록','team.manage':'팀·권한 관리','integrations.manage':'서비스 연동 설정' };
const event={participants:'참가자',page:'참가자 페이지',programs:'참여 프로그램',onsite:'현장 운영',booth:'부스 운영',messages:'메시지',results:'결과 보고',settings:'행사 설정'};
const eventPages={overview:'overview',readiness:'overview',participants:'participants',form:'participants',import:'participants',groups:'participants',onsite:'onsite',desks:'onsite',checks:'onsite',checkin:'onsite',booths:'booth',visits:'booth',page:'page','event-qr':'page',notices:'page',schedule:'page',venue:'page',board:'page',programs:'programs',poll:'programs',quiz:'programs',qa:'programs',draw:'programs',survey:'programs',photo:'programs',rewards:'programs',messages:'messages',templates:'messages',deliveries:'messages',screen:'screen',results:'results',reports:'results',settings:'settings',features:'settings',members:'settings',audit:'settings'};
const isOperator=a=>!!a&&['OPERATOR','AGENCY','MANAGER'].includes(a.role);
const list=x=>Array.isArray(x)?x:typeof x==='string'?[x]:[];
const orgList=x=>Array.from(new Set(list(x).filter(k=>Object.hasOwn(org,k))));
const eventList=x=>{const a=Array.from(new Set(list(x).filter(k=>k==='all'||Object.hasOwn(event,k))));return a.includes('all')?['all']:a;};
E.isOperator=isOperator;E.roleNames={...E.roleNames,OPERATOR:'운영사 구성원',AGENCY:'운영사 구성원',MANAGER:'운영사 구성원',STAFF:'현장 스태프'};
E.orgPermissionLabels=org;E.eventPermissionLabels=event;
E.orgPermissionForPage=page=>({events:'events.view',clients:'clients.manage',team:'team.manage',integrations:'integrations.manage'}[page]||null);
E.orgCan=(permission,write=false,account=E.session)=>!!(isOperator(account)&&account.active&&(account.orgOwner||(permission==='events.view'&&!write)||orgList(account.orgPermissions).includes(permission)));
E.eventAllowed=id=>{const a=E.session;if(!a||!a.active)return false;if(isOperator(a))return !!(a.orgOwner||orgList(a.orgPermissions).includes('events.all')||E.state.memberships.some(m=>m.accountId===a.id&&m.eventId===id));return a.role==='STAFF'&&E.activeAssignments(id).length>0;};
E.can=(group,write=false)=>{
 const a=E.session;if(!a||!a.active)return false;
 if(group==='agency'){const page=E.route?.page||'events',permission=write&&page==='events'?'events.create':E.orgPermissionForPage(page);return E.orgCan(permission,write,a);}
 const ev=E.event();if(!ev||!E.eventAllowed(ev.id))return false;
 if(isOperator(a)){if(a.orgOwner)return true;const m=E.state.memberships.find(x=>x.accountId===a.id&&x.eventId===ev.id);if(!m)return false;if(!write)return true;const rights=eventList(m.write);return rights.includes('all')||rights.includes(group);}
 if(a.role!=='STAFF'||E.route?.scope!=='staff')return false;
 const task=E.assignment();if(!task)return false;if(!write&&group==='overview')return true;
 return task.type==='DESK'&&['onsite','participants'].includes(group)||task.type==='BOOTH'&&group==='booth';
};
E.authorizeCommand=(name,group)=>group==='agency'?E.can('agency',true):E.can(group,true);
E.adminShell=body=>{
 const agency=E.route.scope==='agency',ev=E.event(),client=E.state.clients.find(c=>c.id===ev?.clientId);
 const orgMenu=[['events','calendar','행사','events.view'],['clients','building','고객사','clients.manage'],['team','shield','팀·권한','team.manage'],['integrations','settings','서비스 연동','integrations.manage']].filter(x=>E.orgCan(x[3]));
 const eventMenu=[['overview','grid','운영 현황'],['participants','people','참가자'],['onsite','scan','현장 운영'],...(ev?.features.includes('stamp')?[['booths','ticket','부스 운영']]:[]),['page','file','참가자 페이지'],...(ev?.features.some(x=>['poll','quiz','qa','draw','survey','photo','board','reward'].includes(x))?[['programs','play','참여 프로그램']]:[]),['messages','message','메시지'],...(ev?.features.includes('screen')?[['screen','monitor','행사장 출력']]:[]),['results','chart','결과·보고서'],['settings','settings','설정']].filter(x=>E.can(eventPages[x[0]]||x[0]));
 const menu=agency?orgMenu:eventMenu,active=x=>agency?E.route.page===x[0]:(eventPages[E.route.page]||E.route.page)===(eventPages[x[0]]||x[0]);
 const itemLink=x=>'<a class="nav-item '+(active(x)?'active':'')+'" '+(active(x)?'aria-current="page"':'')+' href="'+e(agency?'#/console/agency/'+x[0]:E.consoleURL(x[0]))+'">'+E.icon(x[1])+'<span>'+e(x[2])+'</span></a>';
 const eventGroups=[['preparation','준비',['participants','page','programs','messages']],['live-operation','현장 운영',['overview','onsite','booths','screen']],['wrap-up','마무리',['results','settings']]];
 const nav=agency?menu.map(itemLink).join(''):eventGroups.map(([id,label,pages])=>{const items=eventMenu.filter(x=>pages.includes(x[0]));if(!items.length)return '';const expanded=items.some(active);return '<section class="nav-group"><button type="button" class="nav-group-toggle" data-action="toggle-sidebar-group" data-group="'+id+'" aria-expanded="'+expanded+'" aria-controls="sidebar-nav-'+id+'">'+e(label)+'</button><div class="nav-group-items" id="sidebar-nav-'+id+'"'+(expanded?'':' hidden')+'>'+items.map(itemLink).join('')+'</div></section>';}).join('');
 const top=!agency&&ev?E.badge(E.stages[ev.stage],ev.stage==='LIVE'?'good':'')+'<a class="btn" target="_blank" href="#/event/'+e(ev.slug)+'/home">참가자 페이지</a>':'';
 return '<div class="admin-shell"><button class="menu-dismiss" data-action="close-menu" aria-label="메뉴 닫기"></button><aside class="sidebar"><a class="wordmark" href="#/console/agency/events">EVENTOUCH<span>행사 운영 워크스페이스</span></a>'+(!agency?'<div class="sidebar-event od-field"><small>'+e(client?.name||'')+'</small><strong>'+e(ev?.name||'선택한 행사')+'</strong>'+L('행사 목록','#/console/agency/events','sidebar-back','back')+'</div>':'<div class="workspace-caption">운영 워크스페이스</div>')+'<nav class="side-nav" aria-label="주요 메뉴">'+nav+'</nav><div class="sidebar-bottom"><div class="od-field"><strong>'+e(E.session.name)+'</strong><small>운영사 구성원'+(E.session.orgOwner?' · 조직 소유자':'')+'</small></div>'+B('로그아웃','logout','','sidebar-logout')+'</div></aside><div class="admin-main"><header class="topbar"><button type="button" class="btn square menu-button" data-action="toggle-menu" aria-label="주요 메뉴 열기">'+E.icon('menu')+'</button><div class="breadcrumb '+(agency?'agency-context':'event-context')+'"><span class="workspace-context">운영 워크스페이스</span>'+(agency?'':'<span class="context-separator">/</span><strong class="event-context">'+e(ev?.name||'행사')+'</strong>')+'</div><div class="actions">'+top+'<span class="environment-label">브라우저 체험</span></div></header><main class="content" id="main-content" tabindex="-1">'+(E.storageWarning?E.notice(E.storageWarning,'warning'):'')+body+'</main><footer class="workspace-footer">EVENTOUCH · 브라우저 프로토타입 · 실제 개인정보와 외부 전송은 사용하지 마세요.</footer></div></div>';
};
E.actions['toggle-sidebar-group']=(d,button)=>{const items=document.getElementById('sidebar-nav-'+d.group);if(!items||!button)return;const expanded=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!expanded));items.hidden=expanded;};
E.views['agency-events']=()=>{
 const allowed=E.state.events.filter(x=>E.eventAllowed(x.id)),q=String(E.ui.filters.events||'').toLowerCase(),status=E.ui.filters.eventStatus||'';
 const rows=allowed.filter(x=>(x.name+' '+(E.state.clients.find(c=>c.id===x.clientId)?.name||'')).toLowerCase().includes(q)&&(!status||x.stage===status));
 const cards=rows.map(x=>{const w=E.state.workspaces[x.id],m=E.metrics(w),keyvisual=w.branding?.keyvisual,thumbnail=keyvisual?'<div class="event-card-keyvisual" aria-hidden="true">'+E.image(keyvisual,'').replace('class="od-media"','class="od-media od-media-cover"')+'</div>':'';return '<article class="panel event-card">'+thumbnail+'<div class="card-top"><span>'+e(x.date)+'</span>'+E.badge(E.stages[x.stage],x.stage==='LIVE'?'good':'')+'</div><h2>'+e(x.name)+'</h2><p class="muted">'+m.total+'명 등록 · '+e(x.start)+'–'+e(x.end)+'</p><div class="card-footer">'+L('행사 관리',E.consoleURL('overview',x.id),'primary','arrow')+'</div></article>';}).join('');
 return E.head('행사','담당 범위의 행사에서 준비와 운영을 이어갑니다.',E.orgCan('events.create',true)?B('새 행사 만들기','new-event','','primary'):'','운영 워크스페이스')+'<div class="toolbar"><label class="sr-only" for="event-query">행사 검색</label><input id="event-query" placeholder="행사명·고객사 검색" value="'+e(E.ui.filters.events||'')+'" data-filter="events"><label class="sr-only" for="event-status">진행 상태</label><select id="event-status" data-filter="eventStatus"><option value="">모든 상태</option>'+Object.entries(E.stages).map(([k,v])=>'<option value="'+e(k)+'" '+(status===k?'selected':'')+'>'+e(v)+'</option>').join('')+'</select><span>'+rows.length+'개 행사</span></div>'+(cards?'<div class="event-card-grid'+(rows.length===1?' event-card-grid-single':'')+'">'+cards+'</div>':E.empty('담당 행사가 없습니다','조직 구성원에게 행사 접근 권한을 요청하세요.'))+(E.orgCan('team.manage')?'<p class="help">팀과 행사 권한은 <a href="#/console/agency/team">팀·권한</a>에서 관리합니다.</p>':'');
};
const eventRights=x=>eventList(x);
const assignmentNames=account=>E.state.events.flatMap(ev=>{const w=E.state.workspaces[ev.id];return (w.assignments||[]).filter(a=>a.accountId===account.id).map(a=>{const target=(a.type==='DESK'?w.desks:w.booths).find(t=>t.id===a.targetId);return target?ev.name+' · '+target.name:'';});}).filter(Boolean).join(' · ')||'업무 미배정';
const memberEvents=account=>E.state.memberships.filter(m=>m.accountId===account.id).map(m=>{const ev=E.state.events.find(x=>x.id===m.eventId);return ev?ev.name+(eventRights(m.write).includes('all')?' · 전체':eventRights(m.write).length?' · '+eventRights(m.write).map(x=>event[x]).join('·'):' · 조회'):'';}).filter(Boolean).join(' · ')||'미배정';
E.views['agency-team']=()=>{
 const accounts=E.state.accounts.filter(a=>a.active&&(isOperator(a)||a.role==='STAFF'));
 const canManageMembers=!!E.session.orgOwner&&accounts.some(a=>isOperator(a)&&!a.orgOwner);
 const memberHeads=['이름','제품 역할','권한 범위',...(canManageMembers?['관리']:[])];
 const rows=accounts.map(a=>'<tr><td><div class="od-field"><strong>'+e(a.name)+'</strong><small>'+e(a.email)+'</small></div></td><td>'+E.badge(isOperator(a)?'운영사 구성원':'현장 스태프')+(a.orgOwner?'<small class="scope-note">조직 소유자</small>':'')+'</td><td><div class="od-field"><span>'+e(a.role==='STAFF'?assignmentNames(a):(a.orgOwner?'조직 전체':orgList(a.orgPermissions).map(x=>org[x]).join(' · ')||'행사 범위'))+'</span><small>'+e(a.role==='STAFF'?'':memberEvents(a))+'</small></div></td>'+(canManageMembers?'<td>'+(E.session.orgOwner&&isOperator(a)&&!a.orgOwner?B('조직 권한','edit-org-permissions','data-id="'+e(a.id)+'"'):'—')+'</td>':'')+'</tr>');
 const invites=E.state.invitations.filter(i=>['OPERATOR','MANAGER','STAFF'].includes(i.role)).map(i=>'<tr><td><div class="od-field"><strong>'+e(i.name)+'</strong><small>'+e(i.email)+'</small></div></td><td>'+e(i.role==='STAFF'?'현장 스태프':'운영사 구성원')+'</td><td>'+e(E.state.events.find(ev=>ev.id===i.eventId)?.name||orgList(i.orgPermissions).map(x=>org[x]).join(' · ')||'미배정')+'</td><td>'+E.badge({PENDING:'수락 대기',ACCEPTED:'수락',REVOKED:'철회'}[i.status]||i.status)+'</td><td>'+(i.status==='PENDING'?B('수락 링크','invite-link','data-token="'+e(i.token||'')+'" data-id="'+e(i.id)+'"')+B('철회','revoke-invite','data-id="'+e(i.id)+'"','','danger'):'—')+'</td></tr>');
 const teamContent=(rows.length?E.table(memberHeads,rows):E.empty('팀원이 없습니다','팀원을 초대해 행사 또는 조직 업무를 배정하세요.'))+E.notice('고객사 담당자 정보는 내부 기록으로만 관리합니다. 고객사 계정이나 포털은 없습니다.');
 return E.head('팀·권한','운영사 구성원은 한 제품 역할을 사용하고, 조직·행사 범위 권한으로 접근을 관리합니다.',E.can('agency',true)?B('팀원 초대','invite-member','','primary'):'','운영 워크스페이스')+E.panel('팀원',teamContent)+(invites.length?E.panel('초대 내역',E.table(['받는 사람','제품 역할','대상 범위','상태','작업'],invites)):'');
};
E.actions['edit-org-permissions']=d=>{
 if(!E.session.orgOwner)throw Error('조직 권한은 조직 소유자만 변경할 수 있습니다.');
 const account=E.state.accounts.find(a=>a.id===d.id&&a.active&&isOperator(a));
 if(!account||account.orgOwner)throw Error('권한을 변경할 구성원을 찾지 못했습니다.');
 const controls=Object.keys(org).map(k=>E.check(org[k],'orgPermissions',orgList(account.orgPermissions).includes(k),k)).join('');
 E.dialog('조직 권한 설정',E.detail([['구성원',account.name],['이메일',account.email]])+'<fieldset class="permission-fieldset"><legend>허용할 업무</legend>'+controls+'</fieldset>'+E.notice('조직 권한과 행사별 운영 권한은 각각 관리합니다.','warning'),async p=>{await E.run('org.permissions.save',{accountId:account.id,orgPermissions:p.orgPermissions||[]});E.close();E.toast('조직 권한을 저장했습니다.');},'저장');
};
E.register('org.permissions.save','agency',(s,p,c)=>{
 if(!s.accounts.find(a=>a.id===c.actor)?.orgOwner)throw Error('조직 소유자만 조직 권한을 변경할 수 있습니다.');
 const account=s.accounts.find(a=>a.id===p.accountId&&a.active&&isOperator(a));
 if(!account||account.orgOwner)throw Error('대상 구성원의 권한을 변경할 수 없습니다.');
 account.orgPermissions=orgList(p.orgPermissions);
});
const originalCreate=E.handlers['event.create'];
if(originalCreate)E.register('event.create','agency',(s,p,c)=>{const id=originalCreate.fn(s,p,c),actor=s.accounts.find(a=>a.id===c.actor);if(isOperator(actor)&&!actor.orgOwner)s.memberships.push({accountId:actor.id,eventId:id,write:['all']});return id;});
E.register('member.invite','agency',(s,p,c)=>{
 const role=p.role==='MANAGER'?'OPERATOR':p.role;
 if(!['OPERATOR','STAFF'].includes(role))throw Error('운영사 구성원 또는 현장 스태프만 초대할 수 있습니다.');
 const email=E.require(p.email,'이메일',120).trim().toLowerCase();
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))throw Error('이메일 형식을 확인하세요.');
 if(s.accounts.some(a=>a.active&&a.email.toLowerCase()===email)||s.invitations.some(a=>a.email.toLowerCase()===email&&a.status==='PENDING'))throw Error('이미 등록되거나 초대된 이메일입니다.');
 const eventId=p.eventId||null;if(eventId&&!s.events.some(a=>a.id===eventId))throw Error('담당 행사를 찾을 수 없습니다.');
 const orgPermissions=role==='OPERATOR'?orgList(p.orgPermissions):[],write=role==='OPERATOR'?eventRights(p.write):[];
 if(role==='OPERATOR'&&!eventId&&!orgPermissions.length)throw Error('행사 접근 또는 조직 권한을 하나 이상 지정하세요.');
 if(orgPermissions.length&&!s.accounts.find(a=>a.id===c.actor)?.orgOwner)throw Error('조직 범위 권한은 조직 소유자가 부여할 수 있습니다.');
 s.invitations.push({id:E.id('invite'),token:E.id('accept'),name:E.require(p.name,'이름',60),email,role,status:'PENDING',eventId,write,orgPermissions,expiresAt:new Date(Date.now()+7*86400000).toISOString(),at:c.now});
});
E.register('member.accept','agency',(s,p,c)=>{
 const i=s.invitations.find(a=>a.token===p.token&&a.status==='PENDING');if(!i||new Date(i.expiresAt)<new Date())throw Error('초대가 만료되었거나 철회되었습니다.');
 const role=i.role==='MANAGER'?'OPERATOR':i.role;if(!['OPERATOR','STAFF'].includes(role))throw Error('지원하지 않는 초대입니다.');
 if(s.accounts.some(a=>a.active&&a.email.toLowerCase()===i.email.toLowerCase()))throw Error('이미 등록된 이메일입니다.');
 if(i.eventId&&!s.events.some(a=>a.id===i.eventId))throw Error('초대에 연결된 행사가 없습니다.');
 const account={id:E.id('user'),name:i.name,email:i.email,role,active:true,orgOwner:false,orgPermissions:role==='OPERATOR'?orgList(i.orgPermissions):[]};s.accounts.push(account);
 if(i.eventId)s.memberships.push({accountId:account.id,eventId:i.eventId,write:role==='OPERATOR'?eventRights(i.write):[]});
 i.status='ACCEPTED';return account.id;
},{guest:true});
E.register('member.assign','settings',(s,p,c)=>{
 const account=s.accounts.find(a=>a.id===p.accountId&&a.active&&isOperator(a));if(!account||account.orgOwner)throw Error('행사 권한을 설정할 구성원을 찾지 못했습니다.');
 const i=s.memberships.findIndex(m=>m.accountId===account.id&&m.eventId===c.event.id);
 if(!p.enabled){if(i>=0)s.memberships.splice(i,1);return;}
 const write=eventRights(p.write);if(i>=0)s.memberships[i].write=write;else s.memberships.push({accountId:account.id,eventId:c.event.id,write});
});
E.views.members=()=>{
 const ev=E.event(),ops=E.state.accounts.filter(a=>a.active&&isOperator(a));
 const rows=ops.map(a=>{const m=E.state.memberships.find(x=>x.accountId===a.id&&x.eventId===ev.id),rights=a.orgOwner?'조직 전체':m?(eventRights(m.write).includes('all')?'행사 전체':eventRights(m.write).map(x=>event[x]).join(' · ')||'조회만'):'접근 없음';return '<tr><td>'+e(a.name)+'<small class="scope-note">'+e(a.email)+'</small></td><td>'+E.badge(rights,m||a.orgOwner?'good':'')+'</td><td>'+(E.can('settings',true)&&!a.orgOwner?B('권한 설정','assign-member','data-id="'+e(a.id)+'"'):'—')+'</td></tr>';});
 return E.head('행사 권한','같은 운영사 구성원에게 필요한 행사 작업만 허용합니다.')+E.eventTabs('settings')+E.panel('운영사 구성원',rows.length?E.table(['구성원','접근 범위','관리'],rows):E.empty('운영사 구성원이 없습니다','팀·권한 메뉴에서 구성원을 초대하세요.'))+E.panel('현장 스태프',E.notice('현장 스태프는 전체 행사 권한을 받지 않습니다. 데스크·부스 배정으로 업무 링크를 제한합니다.'));
};
E.actions['assign-member']=d=>{
 const a=E.state.accounts.find(x=>x.id===d.id&&x.active&&isOperator(x)),ev=E.event();if(!a||a.orgOwner)throw Error('행사 권한을 설정할 구성원을 찾지 못했습니다.');
 const m=E.state.memberships.find(x=>x.accountId===a.id&&x.eventId===ev.id),current=eventRights(m?.write);
 const controls=[E.check('모든 행사 업무','write',current.includes('all'),'all'),...Object.keys(event).map(k=>E.check(event[k],'write',current.includes('all')||current.includes(k),k))].join('');
 E.dialog('행사 범위 권한',E.detail([['행사',ev.name],['구성원',a.name]])+E.check('이 행사 접근 허용','enabled',!!m)+'<fieldset class="permission-fieldset"><legend>허용할 업무</legend>'+controls+'</fieldset>'+E.notice('선택하지 않은 업무는 조회할 수 있지만 변경할 수 없습니다.'),async p=>{await E.run('member.assign',{accountId:a.id,enabled:!!p.enabled,write:p.write||[]});E.close();E.toast('행사 권한을 저장했습니다.');},'저장');
};
E.views['agency-integrations']=()=>{
 const entries=[['로그인·인증','미연동','체험 계정은 이 브라우저에만 저장됩니다.'],['문자·알림톡','미연동','대상 검토와 요청 기록만 체험할 수 있습니다.'],['결제·환불','미연동','공급자 연결 전에는 제품 화면에서 사용할 수 없습니다.'],['지도·길찾기','미연동','행사별 주소와 안내 문구를 표시합니다.'],['QR·인쇄','브라우저 기능','기기 카메라와 프린터 연결은 별도 확인이 필요합니다.']];
 const rows=entries.map(x=>'<div class="list-item agency-integration-row"><div class="od-field od-fill"><strong>'+e(x[0])+'</strong><p class="muted">'+e(x[2])+'</p></div>'+E.badge(x[1])+'</div>').join('');
 return E.head('서비스 연동','실제 서비스 연결 상태와 프로토타입에서 체험할 수 있는 범위를 구분합니다.','','운영 워크스페이스')+E.panel('서비스별 상태','<div class="list">'+rows+'</div>')+E.notice('실제 인증 정보나 참가자 개인정보를 입력하지 마세요.');
};

E.actions['invite-member']=()=>{
 if(!E.orgCan('team.manage',true))throw Error('팀 초대 권한이 없습니다.');
 const owner=!!E.session.orgOwner,events=E.state.events.filter(ev=>owner||E.eventAllowed(ev.id));
 const eventOptions=[['','행사 선택'],...events.map(ev=>[ev.id,ev.name])];
 const orgChecks=Object.entries(org).map(([key,label])=>'<label class="checkline"><input type="checkbox" name="orgGrant_'+e(key)+'" value="'+e(key)+'"><span>'+e(label)+'</span></label>').join('');
 const eventChecks=[['all','모든 행사 업무'],...Object.entries(event).map(([key,label])=>[key,label])].map(([key,label])=>E.check(label,'write',key==='all',key)).join('');
 const body='<form data-form="invite-member" novalidate class="od-stack">'+F('이름 *','name','','text','required maxlength="60"')+F('이메일 *','email','','email','required maxlength="120"')+S('제품 역할','role',[['OPERATOR','운영사 구성원'],['STAFF','현장 스태프']],'OPERATOR')+S('행사 접근','eventId',eventOptions,'')+'<fieldset class="permission-fieldset"><legend>행사별 변경 권한</legend>'+eventChecks+'</fieldset>'+(owner?'<fieldset class="permission-fieldset"><legend>조직 권한 · 조직 소유자만 부여</legend>'+orgChecks+'</fieldset>':'')+E.notice((owner?'행사 권한은 지정 행사에서만 작동합니다. 조직 권한은 구성원·고객사 내부 기록·연동 등 조직 메뉴에 적용됩니다.':'이 초대는 본인이 접근할 수 있는 행사에만 연결됩니다. 조직 범위 권한은 조직 소유자가 부여합니다.')+' 현장 스태프는 행사에 초대된 뒤 데스크·부스 배정을 받아야 업무 화면을 열 수 있습니다.')+E.submit('초대 링크 만들기')+'</form>';
 E.dialog('팀원 초대',body,null,'',true);
};
E.forms['invite-member']=async(p,f)=>{
 p.orgPermissions=Array.from(f.querySelectorAll('input[name^="orgGrant_"]:checked'),x=>x.value);
 if(p.eventId&&!E.session.orgOwner&&!E.eventAllowed(p.eventId))throw Error('접근 권한이 있는 행사만 초대에 지정할 수 있습니다.');
 await E.run('member.invite',p);E.close();E.toast('초대 링크를 만들었습니다. 초대 내역에서 복사해 전달하세요. 실제 이메일은 발송되지 않습니다.');
};
E.invitePage=()=>{
 const i=E.state.invitations.find(x=>x.token===E.route.token);
 if(!i||i.status!=='PENDING'||new Date(i.expiresAt)<new Date())return E.accessPage('초대를 사용할 수 없습니다','링크가 만료되었거나 철회되었습니다. 운영사 구성원에게 새 초대를 요청하세요.');
 if(!['OPERATOR','AGENCY','MANAGER','STAFF'].includes(i.role))return E.accessPage('지원하지 않는 초대입니다','운영사 구성원에게 올바른 팀 초대를 요청하세요.');
 const ev=E.state.events.find(x=>x.id===i.eventId),role=i.role==='STAFF'?'현장 스태프':'운영사 구성원';
 const access=orgList(i.orgPermissions).map(k=>org[k]).concat(ev?[ev.name+' · '+(eventRights(i.write).includes('all')?'행사 전체':eventRights(i.write).map(k=>event[k]).join(' · ')||'조회')]:[]).join(' · ')||'행사 접근 미지정';
 return '<main class="access-page">'+E.head('팀 초대 수락','초대 역할과 접근 범위를 확인하세요.','','EVENTOUCH')+E.panel('초대 정보',E.detail([['이름',i.name],['이메일',i.email],['제품 역할',role],['접근 범위',access],['만료',E.date(i.expiresAt)]])+E.notice(i.role==='STAFF'?'수락 후에도 현장 화면은 배정된 데스크 또는 부스가 있어야 열립니다.':'운영사 구성원은 같은 콘솔을 사용하며, 조직·행사 권한에 따라 작업이 제한됩니다. 실제 이메일 인증은 사용하지 않는 체험 초대입니다.')+B('초대 수락','accept-invite','data-token="'+e(i.token)+'"','primary'))+'</main>';
};
E.actions['accept-invite']=async d=>{
 const invite=E.state.invitations.find(x=>x.token===d.token),eventId=invite?.eventId,id=await E.run('member.accept',{token:d.token});
 E.login(id);const account=E.state.accounts.find(x=>x.id===id),assignment=account?.role==='STAFF'?E.state.events.flatMap(ev=>E.activeAssignments(ev.id).filter(a=>a.accountId===id).map(a=>({ev,a})))[0]:null;
 E.toast('팀 초대를 수락했습니다.');
 if(assignment)E.navigate(E.staffURLFor(assignment.ev.id,assignment.a));else if(account?.role==='STAFF')E.navigate('#/login');else E.navigate(eventId?'#/console/events/'+encodeURIComponent(eventId)+'/overview':'#/console/agency/events');
};
E.forms.login=async p=>{
 if(p.password!=='eventouch')throw Error('체험 비밀번호 eventouch를 입력하세요.');
 const a=E.state.accounts.find(x=>x.email.toLowerCase()===p.email.trim().toLowerCase()&&x.active&&(['OPERATOR','AGENCY','MANAGER'].includes(x.role)||x.role==='STAFF'));
 if(!a)throw Error('활성 운영사 구성원 또는 현장 스태프 계정 이메일을 확인하세요.');
 E.login(a.id);let hash=E.ui.returnTo;E.ui.returnTo=null;
 if(!hash||!hash.startsWith('#/')){
  if(a.role==='STAFF'){const pair=E.state.events.flatMap(ev=>E.activeAssignments(ev.id).filter(x=>x.accountId===a.id).map(x=>({ev,x})))[0];hash=pair?E.staffURLFor(pair.ev.id,pair.x):'#/login';}
  else hash='#/console/agency/events';
 }
 E.close();E.navigate(hash);
};

const brandAccent=()=>getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()||'#E76D26';
const validAccent=value=>/^#[0-9a-f]{6}$/i.test(String(value||''))?String(value).toUpperCase():brandAccent();
const contrastInk=hex=>{
 const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2));
 const lum=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2],ratio=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 return ratio(lum,0)<ratio(lum,1)?'#FFFFFF':'#000000';
};
const pageDefaults=w=>({accent:brandAccent(),intro:String(w.branding?.tagline||'참가에 필요한 안내와 내 티켓을 확인하세요.'),showAnnouncements:true,showSchedule:true,showVenue:true,showPrograms:true,logo:w.branding?.logo||null,keyvisual:w.branding?.keyvisual||null});
const pageState=w=>{
 const fallback=pageDefaults(w),state=w.pageExperience||{},clean=value=>({...fallback,...(value||{}),accent:validAccent(value?.accent||fallback.accent),intro:String(value?.intro??fallback.intro).slice(0,160),showAnnouncements:value?.showAnnouncements!==false,showSchedule:value?.showSchedule!==false,showVenue:value?.showVenue!==false,showPrograms:value?.showPrograms!==false,logo:Object.hasOwn(value||{},'logo')?value.logo:fallback.logo,keyvisual:Object.hasOwn(value||{},'keyvisual')?value.keyvisual:fallback.keyvisual});
 return {draft:clean(state.draft||fallback),published:clean(state.published||fallback),publishedAt:state.publishedAt||null};
};
E.pageExperience=()=>pageState(E.work());
E.register('attendee.page.save','page',(s,p,c)=>{
 const state=pageState(c.workspace),draft={...state.draft,accent:validAccent(p.accent),intro:E.require(p.intro,'행사 소개',160),showAnnouncements:!!p.showAnnouncements,showSchedule:!!p.showSchedule,showVenue:!!p.showVenue,showPrograms:!!p.showPrograms};
 if(p.clearLogo)draft.logo=null;else if(p.logo)draft.logo=p.logo;
 if(p.clearKeyvisual)draft.keyvisual=null;else if(p.keyvisual)draft.keyvisual=p.keyvisual;
 c.workspace.pageExperience={...state,draft};
});
E.register('attendee.page.publish','page',(s,p,c)=>{
 const state=pageState(c.workspace),draft={...state.draft};
 draft.accent=validAccent(draft.accent);draft.intro=E.require(draft.intro,'행사 소개',160);
 c.workspace.pageExperience={draft,published:E.copy(draft),publishedAt:c.now};
 c.workspace.branding={...c.workspace.branding,tagline:draft.intro,logo:draft.logo,keyvisual:draft.keyvisual};
});
E.views.page=()=>{
 const w=E.work(),state=pageState(w),d=state.draft,can=E.can('page',true),dirty=JSON.stringify(d)!==JSON.stringify(state.published),preview=E.aurl('home',{preview:'1'});
 const form='<form data-form="attendee-page" '+(can?'':'data-readonly="true"')+' novalidate class="od-stack attendee-page-form">'+F('행사 소개 *','intro',d.intro,'textarea','required maxlength="160"')+F('강조색','accent',d.accent,'color','required')+'<div class="form-grid">'+E.check('공지 메뉴와 홈 공지','showAnnouncements',d.showAnnouncements)+E.check('일정 메뉴와 홈 일정','showSchedule',d.showSchedule)+E.check('행사장 안내','showVenue',d.showVenue)+E.check('참여 프로그램','showPrograms',d.showPrograms)+'</div><div class="form-grid">'+F('로고 · PNG/JPEG/WebP, 600KB 이하','logo','','file','accept="image/png,image/jpeg,image/webp"')+E.check('기존 로고 제거','clearLogo',false)+F('대표 이미지 · PNG/JPEG/WebP, 600KB 이하','keyvisual','','file','accept="image/png,image/jpeg,image/webp"')+E.check('기존 대표 이미지 제거','clearKeyvisual',false)+'</div><p class="help">색은 이 행사 참가자 웹에만 적용됩니다. 이미지와 안내 변경은 저장 후에도 초안으로 남으며 게시하기 전까지 참가자에게 보이지 않습니다.</p>'+(can?E.submit('초안 저장'):'<p class="help">조회 전용 권한입니다. 수정 권한을 가진 운영사 구성원에게 요청하세요.</p>')+'</form>';
 const photos='<div class="image-list">'+(d.logo?'<figure>'+E.image(d.logo,'행사 로고')+'<figcaption>초안 로고</figcaption></figure>':'')+(d.keyvisual?'<figure>'+E.image(d.keyvisual,'행사 대표 이미지')+'<figcaption>초안 대표 이미지</figcaption></figure>':'')+(!d.logo&&!d.keyvisual?'<p class="muted">업로드한 이미지가 없습니다. 기본 행사명과 안내로 표시됩니다.</p>':'')+'</div>';
 const dirtyLabel=dirty?'저장한 초안이 게시본과 다릅니다.':'초안과 게시본이 같습니다.';
 const publish=can?B('참가자에게 게시','publish-attendee-page','','primary'):'<span class="help">게시 권한이 없습니다.</span>';
 return E.head('참가자 페이지','기본 화면을 행사별로 조정하고, 초안 미리보기 후 참가자에게 게시합니다.',L('게시 화면 열기',E.aurl('home'),'','arrow'),'참가자 경험')+E.eventTabs('page')+E.panel('기본 화면 편집',form)+E.panel('초안 이미지',photos)+E.panel('미리보기 · 게시',E.notice(dirtyLabel,dirty?'warning':'')+'<div class="attendee-preview"><iframe title="참가자 모바일 화면 미리보기" src="'+e(preview)+'" loading="lazy"></iframe></div><p class="help">미리보기에서 행사 홈 → 신청 → 신청 상태·티켓 QR까지 직접 이동할 수 있습니다. 테스트 신청은 이 브라우저의 샘플 데이터에 저장되므로 가상 정보를 사용하세요. 참가자에게는 게시된 설정만 보입니다.</p>',publish);
};
E.forms['attendee-page']=async(p,f)=>{
 for(const key of ['logo','keyvisual']){const file=f.elements[key]?.files?.[0];if(file)p[key]=await E.readImage(file);}
 await E.run('attendee.page.save',p);E.toast('참가자 페이지 초안을 저장했습니다. 미리보기 후 게시하세요.');
};
E.actions['publish-attendee-page']=()=>E.confirm('참가자 페이지 게시','저장된 초안의 소개, 강조색, 이미지와 메뉴 표시를 참가자에게 공개합니다.',async()=>{await E.run('attendee.page.publish');E.toast('참가자 페이지를 게시했습니다.');});

E.attendeeConfig=()=>E.activePageConfig||pageState(E.work()).published;
const baseFeatureLinks=E.mobileFeatureLinks;
E.mobileFeatureLinks=()=>E.attendeeConfig().showPrograms?baseFeatureLinks():'<p class="help">참여 프로그램 안내가 준비 중입니다.</p>';
E.mobileHome=()=>{
 const cfg=E.attendeeConfig(),ev=E.event(),w=E.work(),p=E.person(),notices=cfg.showAnnouncements?w.notices.filter(n=>n.published).sort((a,b)=>Number(b.pinned)-Number(a.pinned)):[],program=cfg.showSchedule?w.program.filter(x=>x.published):[];
 const register=p?L(p.status==='APPROVED'?'내 티켓 보기':'신청 상태 확인',E.aurl('ticket'),'primary','ticket'):L('참가 신청',E.aurl('register'),'primary','arrow');
 return '<section class="mobile-hero"><span class="eyebrow">'+e(ev.date)+' · '+e(ev.start)+'</span><h1>'+e(ev.name)+'</h1><p>'+e(cfg.intro)+'</p>'+(cfg.keyvisual?E.image(cfg.keyvisual,ev.name+' 대표 이미지'):'')+'<div class="hero-actions">'+register+'</div></section>'+(p?E.notice(p.name+'님 · '+E.registrationStates[p.status]+(p.inside?' · 입장 중':'')):'')+(ev.stage==='ENDED'?E.notice('행사는 종료되었습니다. 안내와 제출 가능한 만족도 평가를 확인하세요.'):'')+(cfg.showAnnouncements?'<h2 class="section-title">먼저 확인하세요</h2>'+(notices.length?notices.slice(0,2).map(n=>'<a class="mobile-card od-row" href="'+e(E.aurl('notice-detail',{id:n.id}))+'"><div class="od-field od-fill"><strong class="od-clamp-2">'+e(n.title)+'</strong><small class="muted">'+(n.pinned?'중요 공지':'행사 안내')+'</small></div>'+E.icon('arrow')+'</a>').join(''):E.empty('새 안내가 없습니다','운영자가 게시한 안내가 표시됩니다.')):'')+(cfg.showSchedule?'<h2 class="section-title">오늘의 일정</h2>'+(program.length?program.slice(0,2).map(s=>'<a class="mobile-card od-row" href="'+e(E.aurl('program-detail',{id:s.id}))+'"><div class="od-cell time-cell"><strong>'+e(s.start)+'</strong><small>'+e(s.end)+'</small></div><div class="od-field od-fill"><strong class="od-clamp-2">'+e(s.title)+'</strong><small class="muted">'+e(s.place)+'</small></div>'+E.icon('arrow')+'</a>').join(''):E.empty('일정 준비 중입니다','시간표가 게시되면 확인할 수 있습니다.')):'')+(cfg.showPrograms&&ev.features.some(k=>['poll','quiz','qa','draw','survey','stamp','photo','board'].includes(k))?'<h2 class="section-title">행사 참여</h2>'+E.mobileFeatureLinks():'')+(p&&cfg.showPrograms&&ev.features.includes('reward')?'<a class="mobile-card od-row" href="'+e(E.aurl('rewards'))+'"><div class="od-field od-fill"><strong>내 경품</strong><small class="muted">배정·수령 상태를 확인하세요.</small></div>'+E.icon('arrow')+'</a>':'')+(cfg.showVenue&&ev.features.includes('venue')?'<h2 class="section-title">오시는 길</h2><a class="mobile-card od-row" href="'+e(E.aurl('venue'))+'"><div class="od-field od-fill"><strong>'+e(w.venue.name||'행사장 안내')+'</strong><small class="muted od-clamp-2">'+e(w.venue.address||'상세 위치를 확인하세요.')+'</small></div>'+E.icon('arrow')+'</a>':'');
};
const baseNotices=E.mobileNotices,baseSchedule=E.mobileSchedule,baseAttendee=E.views.attendee;
E.mobileNotices=()=>E.attendeeConfig().showAnnouncements?baseNotices():E.mobileState('공지 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
E.mobileSchedule=()=>E.attendeeConfig().showSchedule?baseSchedule():E.mobileState('일정 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
E.mobileMore=()=>{
 const cfg=E.attendeeConfig(),items=[['신청 정보','info'],...(cfg.showAnnouncements?[['공지','notices']]:[]),...(cfg.showVenue&&E.event().features.includes('venue')?[['행사장 안내','venue']]:[]),...(cfg.showPrograms&&E.event().features.includes('reward')?[['내 경품','rewards']]:[]),['도움말','help']],hasPrograms=E.event().features.some(k=>['poll','quiz','qa','draw','survey','stamp','photo','board'].includes(k));
 return '<h1 class="mobile-title">행사 안내</h1><div class="od-stack">'+items.map(([title,page])=>'<a class="mobile-card od-row" href="'+e(E.aurl(page))+'"><span class="od-fill">'+e(title)+'</span>'+E.icon('arrow')+'</a>').join('')+'</div>'+(cfg.showPrograms&&hasPrograms?'<h2 class="section-title">참여 프로그램</h2>'+E.mobileFeatureLinks():'');
};
E.views.attendee=()=>{
 const w=E.work(),state=pageState(w),preview=E.route.params.get('preview')==='1'&&E.can('page',true),cfg=preview?state.draft:state.published,oldConfig=E.activePageConfig,oldBranding=w.branding;
 E.activePageConfig=cfg;w.branding={...w.branding,tagline:cfg.intro,logo:cfg.logo,keyvisual:cfg.keyvisual};
 let html;try{html=baseAttendee();}finally{w.branding=oldBranding;E.activePageConfig=oldConfig;}
 if(!cfg.showVenue&&E.route.page==='venue')return E.mobileState('행사장 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
 if(!cfg.showAnnouncements&&['notices','notice-detail'].includes(E.route.page))return E.mobileState('공지 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
 if(!cfg.showSchedule&&['schedule','program-detail'].includes(E.route.page))return E.mobileState('일정 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
 if(!cfg.showPrograms&&['poll','quiz','qa','draw','survey','stamp','photo','board','rewards'].includes(E.route.page))return E.mobileState('참여 프로그램 안내가 숨겨져 있습니다','운영자가 참가자 페이지 설정에서 공개할 수 있습니다.',L('행사 홈',E.aurl('home')));
 html=html.replace('<div class="mobile-app od-screen">','<div class="mobile-app od-screen" style="--attendee-accent:'+validAccent(cfg.accent)+';--attendee-accent-ink:'+contrastInk(validAccent(cfg.accent))+'">');
 if(preview)html=html.replace('<div class="od-scroll mobile-body" id="main-content">','<div class="od-scroll mobile-body" id="main-content"><div class="preview-ribbon" role="status">운영자 미리보기 · 저장한 초안 · 테스트 신청은 이 브라우저에 저장됩니다</div>');
 return html;
};
E.workflowVersion=17;
})(window.ET);
