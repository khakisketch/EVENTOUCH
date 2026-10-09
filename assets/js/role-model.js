(function(E){'use strict';
const e=E.esc,B=E.button,L=E.link,F=E.field,S=E.select;
const roleNames={AGENCY:'운영사 관리자',MANAGER:'행사 매니저',STAFF:'현장 스태프'};
E.roleNames=roleNames;

function upgrade(s,incrementRevision){
 if(!s||s.version===9)return s;
 if(s.version!==8)return s;
 const at=new Date().toISOString(),clientIds=new Set((s.accounts||[]).filter(a=>a.role==='CLIENT').map(a=>a.id));
 for(const account of s.accounts||[]){
  if(account.role==='DESK'||account.role==='BOOTH')account.role='STAFF';
  if(account.role==='CLIENT'){account.retiredRole='CLIENT';account.retiredAt=at;account.active=false;account.role='STAFF';delete account.clientId;}
  else delete account.clientId;
 }
 s.memberships=(s.memberships||[]).filter(m=>!clientIds.has(m.accountId)).map(m=>{
  const account=(s.accounts||[]).find(a=>a.id===m.accountId);
  if(account?.role==='STAFF')m.write=[];
  return m;
 });
 for(const client of s.clients||[])delete client.contactAccountId;
 const retired=(s.invitations||[]).filter(i=>i.role==='CLIENT'||i.clientId);
 s.retiredInvitations=(s.retiredInvitations||[]).concat(retired.map(i=>({...i,legacyRole:i.role,retiredAt:at,status:i.status==='PENDING'?'REVOKED':i.status})));
 s.invitations=(s.invitations||[]).filter(i=>i.role!=='CLIENT'&&!i.clientId);
 for(const [eventId,w] of Object.entries(s.workspaces||{})){
  w.reports=(w.reports||[]).map(r=>{delete r.shareToken;return r;});
  for(const assignment of w.assignments||[]){
   const account=(s.accounts||[]).find(a=>a.id===assignment.accountId);
   if(account?.role==='STAFF'&&account.active&&!s.memberships.some(m=>m.accountId===account.id&&m.eventId===eventId))s.memberships.push({accountId:account.id,eventId,write:[]});
  }
 }
 s.version=9;
 s.roleMigration={from:8,to:9,at,summary:'CLIENT login removed; DESK and BOOTH accounts converted to STAFF; assignment access retained; report links revoked.'};
 if(incrementRevision)s.revision=(Number(s.revision)||0)+1;
 return s;
}

const seed=E.seed,load=E.load;
E.seed=()=>upgrade(seed(),false);
E.load=()=>{
 try{
  if(!localStorage.getItem('eventouch.product.v9')){
   const raw=localStorage.getItem('eventouch.product.v8');
   if(raw){const old=JSON.parse(raw);if(old?.version===8&&Array.isArray(old.events)&&old.workspaces&&Array.isArray(old.accounts))localStorage.setItem('eventouch.product.v9',JSON.stringify(upgrade(old,true)));}
  }
 }catch{}
 return load();
};

E.activeAssignments=eventId=>{
 const account=E.session,workspace=E.state?.workspaces?.[eventId];
 if(!account||account.role!=='STAFF'||!account.active||!workspace)return [];
 if(E.state.events.find(a=>a.id===eventId)?.stage==='ARCHIVED')return [];
 return workspace.assignments.filter(a=>a.accountId===account.id&&((a.type==='DESK'&&workspace.desks.some(d=>d.id===a.targetId))||(a.type==='BOOTH'&&workspace.booths.some(b=>b.id===a.targetId))));
};
E.assignment=()=>E.route?.scope==='staff'?E.activeAssignments(E.route.eventId).find(a=>a.id===E.route.assignmentId)||null:null;
E.eventAllowed=id=>{
 const account=E.session;if(!account||!account.active)return false;
 if(account.role==='AGENCY')return true;
 if(account.role==='MANAGER')return !!E.state?.memberships?.some(m=>m.accountId===account.id&&m.eventId===id);
 return account.role==='STAFF'&&E.activeAssignments(id).length>0;
};
E.can=(group,write)=>{
 const account=E.session;if(!account||!account.active)return false;
 if(account.role==='AGENCY')return true;
 if(group==='agency')return account.role==='MANAGER'&&!write;
 const event=E.event();if(!event||!E.eventAllowed(event.id))return false;
 if(account.role==='MANAGER')return true;
 if(account.role!=='STAFF'||E.route?.scope!=='staff')return false;
 const assignment=E.assignment();if(!assignment)return false;
 if(!write&&group==='overview')return true;
 if(assignment.type==='DESK'&&['onsite','participants'].includes(group))return true;
 if(assignment.type==='BOOTH'&&group==='booth')return true;
 if(write&&assignment.type==='DESK'&&['onsite','participants'].includes(group))return true;
 return !!(write&&assignment.type==='BOOTH'&&group==='booth');
};
const priorReadiness=E.readiness;
E.readiness=()=>priorReadiness().map(row=>row[0]==='스태프 배정'?[
 row[0],E.work().assignments.some(a=>a.type==='DESK'&&E.state.accounts.some(u=>u.id===a.accountId&&u.active&&u.role==='STAFF')),row[2],row[3]
]:row);

const baseRun=E.run;
E.run=async(name,payload={})=>{
 if(E.session?.role==='STAFF'&&E.route?.scope!=='attendee'){
  const a=E.assignment();if(E.route?.scope!=='staff'||!a)throw Error('현장 스태프는 배정된 업무 링크에서만 작업할 수 있습니다.');
  const allowed=a.type==='DESK'?['check.scan','participant.create','check.correct']:['booth.visit'];
  if(!allowed.includes(name))throw Error('현재 배정된 현장 업무에서 허용되지 않는 작업입니다.');
 }
 return baseRun(name,payload);
};

E.register('member.invite','agency',(s,p,c)=>{
 const role=p.role;if(!['MANAGER','STAFF'].includes(role))throw Error('초대 역할은 행사 매니저 또는 현장 스태프만 선택할 수 있습니다.');
 const email=E.require(p.email,'이메일',120).toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email))throw Error('올바른 이메일 주소를 입력하세요.');
 if(s.accounts.some(a=>a.active&&a.email.toLowerCase()===email)||s.invitations.some(a=>a.email.toLowerCase()===email&&a.status==='PENDING'))throw Error('이미 등록되거나 초대된 계정입니다.');
 const eventId=p.eventId||null;if(eventId&&!s.events.some(a=>a.id===eventId))throw Error('초대에 연결할 행사를 찾을 수 없습니다.');
 s.invitations.push({id:E.id('invite'),token:E.id('accept'),name:E.require(p.name,'이름',60),email,role,status:'PENDING',eventId,expiresAt:new Date(Date.now()+7*86400000).toISOString(),at:c.now});
});
E.register('member.accept','agency',(s,p,c)=>{
 const invite=s.invitations.find(a=>a.token===p.token&&a.status==='PENDING');
 if(!invite||new Date(invite.expiresAt)<new Date())throw Error('초대가 만료되었거나 철회되었습니다. 운영사 관리자에게 새 초대를 요청하세요.');
 if(!['MANAGER','STAFF'].includes(invite.role))throw Error('현재 지원하지 않는 역할의 초대입니다. 새 팀 초대를 요청하세요.');
 if(invite.eventId&&!s.events.some(a=>a.id===invite.eventId))throw Error('초대에 연결된 행사가 없습니다. 운영사 관리자에게 새 초대를 요청하세요.');
 if(s.accounts.some(a=>a.active&&a.email.toLowerCase()===invite.email.toLowerCase()))throw Error('이 이메일 계정이 이미 등록되었습니다. 운영사 관리자에게 확인을 요청하세요.');
 const account={id:E.id('user'),name:invite.name,email:invite.email,role:invite.role,active:true};s.accounts.push(account);
 if(invite.eventId)s.memberships.push({accountId:account.id,eventId:invite.eventId,write:invite.role==='MANAGER'?['all']:[]});
 invite.status='ACCEPTED';return account.id;
},{guest:true});
E.register('member.assign','settings',(s,p,c)=>{
 const account=s.accounts.find(a=>a.id===p.accountId&&a.active&&a.role==='MANAGER');if(!account)throw Error('행사 권한은 활성 행사 매니저에게만 부여할 수 있습니다.');
 const index=s.memberships.findIndex(m=>m.accountId===account.id&&m.eventId===c.event.id);
 if(!p.enabled){if(index>=0)s.memberships.splice(index,1);return;}
 if(index>=0)s.memberships[index].write=['all'];else s.memberships.push({accountId:account.id,eventId:c.event.id,write:['all']});
});
E.register('staff.assign','onsite',(s,p,c)=>{
 const account=s.accounts.find(a=>a.id===p.accountId&&a.active&&a.role==='STAFF');if(!account)throw Error('활성 현장 스태프를 선택하세요.');
 if(!['DESK','BOOTH'].includes(p.type))throw Error('업무는 등록 데스크 또는 부스 중에서 선택하세요.');
 const workspace=c.workspace,target=p.type==='DESK'?workspace.desks.find(a=>a.id===p.targetId):workspace.booths.find(a=>a.id===p.targetId);
 if(!target)throw Error('선택한 업무 대상을 찾을 수 없습니다.');
 if(p.type==='BOOTH'&&!c.event.features.includes('stamp'))throw Error('이 행사에서 부스 인증 기능을 먼저 켜세요.');
 if(workspace.assignments.some(a=>a.accountId===account.id&&a.type===p.type&&a.targetId===p.targetId))throw Error('이미 같은 업무가 배정되어 있습니다.');
 workspace.assignments.push({id:E.id('assignment'),accountId:account.id,type:p.type,targetId:p.targetId});
 if(!s.memberships.some(m=>m.accountId===account.id&&m.eventId===c.event.id))s.memberships.push({accountId:account.id,eventId:c.event.id,write:[]});
});
E.register('staff.unassign','onsite',(s,p,c)=>{
 const assignment=c.workspace.assignments.find(a=>a.id===p.id);if(!assignment)throw Error('해제할 업무 배정을 찾을 수 없습니다.');
 c.workspace.assignments=c.workspace.assignments.filter(a=>a.id!==p.id);
 if(!c.workspace.assignments.some(a=>a.accountId===assignment.accountId))s.memberships=s.memberships.filter(m=>!(m.accountId===assignment.accountId&&m.eventId===c.event.id));
});

for(const name of ['client.contact.invite','client.contact.link','client.access.save','client.contact.unlink'])delete E.handlers[name];
for(const name of ['client-contact-invite','client-contact-link','client-event-access','client-contact-unlink','share-report'])delete E.actions[name];

E.views['agency-clients']=()=>{const rows=E.state.clients.map(c=>'<tr><td><strong>'+e(c.name)+'</strong></td><td><div class="od-field"><span>'+e(c.contact||'미등록')+'</span><small class="muted">'+e(c.email||'연락처 없음')+'</small></div></td><td>'+E.state.events.filter(a=>a.clientId===c.id).length+'개</td><td>'+B('상세','client-detail','data-id="'+e(c.id)+'"')+'</td></tr>');const content=rows.length?E.table(['고객사','내부 연락처','행사','관리'],rows):E.empty('등록된 고객사가 없습니다','고객사를 추가하면 내부 담당자 정보와 연결된 행사가 여기에 표시됩니다.');return E.head('고객사','행사 의뢰 조직과 내부 담당자 정보를 관리합니다.',B('고객사 추가','edit-client','','primary'),'')+E.panel('고객사 목록',content);};
E.actions['client-detail']=d=>{
 const c=E.state.clients.find(a=>a.id===d.id);if(!c)throw Error('고객사를 찾을 수 없습니다.');
 const events=E.state.events.filter(a=>a.clientId===c.id);
 const rows=events.length?E.table(['행사','일정','상태','이동'],events.map(a=>'<tr><td><strong>'+e(a.name)+'</strong></td><td>'+e(a.date)+'</td><td>'+e(E.stages[a.stage]||a.stage)+'</td><td>'+L('운영 현황',E.consoleURL('overview',a.id),'','arrow')+'</td></tr>')):E.empty('연결된 행사가 없습니다','행사 설정에서 이 고객사를 연결하면 여기에 표시됩니다.');
 E.dialog('고객사 상세',E.detail([['고객사명',c.name],['내부 담당자',c.contact||'미등록'],['연락처 이메일',c.email||'미등록'],['연결 행사',events.length+'개']])+'<h3 class="section-title">연결된 행사</h3>'+rows+E.notice('고객사 정보는 운영사의 내부 관리 기록입니다. 고객사 계정, 로그인, 행사 권한 또는 보고서 포털은 제공하지 않습니다.')+B('정보 수정','edit-client','data-id="'+e(c.id)+'" data-return-detail="true"'));
};

E.actions['choose-assignment']=()=>{
 const items=E.state.events.flatMap(ev=>E.activeAssignments(ev.id).map(a=>{const w=E.state.workspaces[ev.id];return {ev,a,target:(a.type==='DESK'?w.desks:w.booths).find(t=>t.id===a.targetId)};})).filter(x=>x.target);
 const current=E.assignment();
 E.dialog('배정된 현장 업무',items.length?'<div class="od-stack">'+items.map(x=>'<a class="btn" aria-current="'+(x.a.id===current?.id&&x.ev.id===E.route.eventId?'page':'false')+'" href="#/staff/'+e(x.ev.id)+'/'+e(x.a.id)+'"><span class="od-field"><strong>'+e(x.ev.name)+'</strong><small>'+e(x.a.type==='DESK'?'등록 데스크 · '+(x.target.action==='IN'?'입장':'퇴장'):'부스 인증')+'</small><span>'+e(x.target.name)+'</span></span>'+(x.a.id===current?.id&&x.ev.id===E.route.eventId?'<span class="badge good">현재 업무</span>':'')+'</a>').join('')+'</div>':E.notice('활성 배정이 없습니다. 행사 매니저에게 문의하세요.'));
};
const staffViewWithChooser=E.views.staff;
const assignedStaffTasks=()=>E.state.events.flatMap(ev=>E.activeAssignments(ev.id).map(a=>{const w=E.state.workspaces[ev.id],target=(a.type==='DESK'?w.desks:w.booths).find(t=>t.id===a.targetId);return target?{ev,a,target}:null;})).filter(Boolean);
const staffTaskLabel=x=>x.a.type==='DESK'?'등록 데스크 · '+(x.target.action==='IN'?'입장':'퇴장')+' 처리':'부스 인증';
E.views.staff=()=>{
 const body=staffViewWithChooser(),current=E.assignment();
 if(!current)return body;
 const items=assignedStaffTasks().sort((a,b)=>{
  const aCurrent=a.ev.id===E.route.eventId&&a.a.id===current.id,bCurrent=b.ev.id===E.route.eventId&&b.a.id===current.id;
  if(aCurrent!==bCurrent)return aCurrent?-1:1;
  const aSame=a.ev.id===E.route.eventId,bSame=b.ev.id===E.route.eventId;
  if(aSame!==bSame)return aSame?-1:1;
  return (a.a.type==='DESK'?0:1)-(b.a.type==='DESK'?0:1);
 });
 const switcher=items.length<2?'':'<section class="staff-assignment-switcher" aria-labelledby="staff-assignment-heading"><div class="od-field"><h3 id="staff-assignment-heading">배정 업무</h3><p>다른 데스크나 부스를 누르면 해당 업무로 바로 전환됩니다.</p></div><nav class="od-stack staff-assignment-list" aria-label="배정된 현장 업무">'+items.map(x=>{
  const active=x.ev.id===E.route.eventId&&x.a.id===current.id,label='<span class="od-field"><strong>'+e(x.ev.name)+'</strong><small>'+e(staffTaskLabel(x))+'</small><span>'+e(x.target.name)+'</span></span>';
  return active?'<div class="staff-assignment-link is-current" aria-current="page">'+label+'<span class="staff-current-label">현재 업무</span></div>':'<a class="staff-assignment-link" href="#/staff/'+e(x.ev.id)+'/'+e(x.a.id)+'">'+label+'<span class="staff-switch-label">전환</span></a>';
 }).join('')+'</nav></section>';
 return body.replace(B('배정 업무 변경','choose-assignment'),'').replace('<div class="od-scroll mobile-body" id="main-content">','<div class="od-scroll mobile-body" id="main-content">'+switcher);
};
E.actions['assign-staff']=()=>{
 const workspace=E.work(),staff=E.state.accounts.filter(a=>a.active&&a.role==='STAFF');
 if(!staff.length){E.dialog('현장 스태프가 없습니다',E.notice('운영사 관리자에게 현장 스태프 초대를 요청하세요.')+L('팀·권한 열기','#/console/agency/team'));return;}
 const targets=[...workspace.desks.map(d=>['DESK:'+d.id,'등록 데스크 · '+d.name]),...(E.event().features.includes('stamp')?workspace.booths.map(b=>['BOOTH:'+b.id,'부스 인증 · '+b.name]):[])];
 if(!targets.length){E.dialog('배정할 업무가 없습니다',E.notice('먼저 데스크를 설정하세요. 부스는 행사 설정에서 인증 기능을 켜면 배정할 수 있습니다.')+L('데스크 설정',E.consoleURL('desks')));return;}
 E.dialog('현장 스태프 업무 배정',S('현장 스태프','accountId',staff.map(a=>[a.id,a.name+' · '+a.email]),staff[0].id,'required')+S('담당 업무','assignment',[['','선택하세요'],...targets],'','required')+E.notice('현장 스태프 역할 하나로 등록 데스크와 부스를 모두 맡을 수 있습니다. 계정에는 선택한 행사·업무만 연결됩니다.'),async p=>{if(!p.assignment)throw Error('담당 업무를 선택하세요.');const split=p.assignment.indexOf(':');await E.run('staff.assign',{accountId:p.accountId,type:p.assignment.slice(0,split),targetId:p.assignment.slice(split+1)});E.close();E.toast('현장 업무를 배정했습니다. 업무 링크를 전달하세요.');},'업무 배정');
};

const createReport=E.handlers['report.create'];
if(createReport)E.register('report.create','results',(s,p,c)=>{const id=createReport.fn(s,p,c);const report=c.workspace.reports.find(a=>a.id===id);if(report)delete report.shareToken;return id;});
E.register('report.successor','results',(s,p,c)=>{
 const old=c.workspace.reports.find(a=>a.id===p.id);if(!old||old.status!=='PUBLISHED')throw Error('확정된 보고서를 선택하세요.');
 const family=old.familyId||old.id,version=Math.max(...c.workspace.reports.filter(a=>(a.familyId||a.id)===family).map(a=>a.version))+1;
 const row={...E.copy(old),id:c.id,familyId:family,parentId:old.id,version,status:'DRAFT',snapshot:p.source==='current'?E.reportData():E.copy(old.snapshot),createdAt:c.now,publishedAt:null};delete row.shareToken;c.workspace.reports.unshift(row);return row.id;
});
const reportUpdate=E.handlers['report.update'];
if(reportUpdate)E.register('report.update','results',(s,p,c)=>{const r=c.workspace.reports.find(a=>a.id===p.id);if(r?.status==='PUBLISHED')throw Error('확정된 보고서는 수정할 수 없습니다. 새 버전을 만드세요.');return reportUpdate.fn(s,p,c);});
E.views.reports=()=>{
 if(E.route.params.has('share'))return E.empty('외부 보고서 링크는 제공하지 않습니다','행사 보고서는 운영사 내부 계정으로 로그인해 확인하세요.');
 const reports=E.work().reports||[];
 return E.head('결과 보고서','행사 기록을 고정한 내부 운영 문서입니다. 고객사 계정이나 공개 링크는 제공하지 않습니다.',E.can('results',true)?B('보고서 만들기','new-report','','primary'):'')+E.eventTabs('results')+E.panel('보고서 목록',reports.length?E.table(['보고서','생성 시점','버전','상태','작업'],reports.map(r=>'<tr><td>'+e(r.title)+'</td><td>'+e(E.date(r.createdAt))+'</td><td>v'+r.version+' · data '+r.snapshot.revision+'</td><td>'+E.badge(r.status==='PUBLISHED'?'확정':'초안',r.status==='PUBLISHED'?'good':'')+'</td><td>'+B('보고서 보기','report-detail','data-id="'+e(r.id)+'"')+'</td></tr>')):E.empty('작성한 보고서가 없습니다','현재 데이터를 기준으로 내부 결과 보고서를 만드세요.'));
};
E.actions['report-detail']=d=>{
 const r=E.work().reports.find(a=>a.id===d.id);if(!r)throw Error('보고서를 찾을 수 없습니다.');
 E.dialog(r.title,E.reportMarkup(r)+'<div class="actions">'+B('인쇄','print-report','data-id="'+e(r.id)+'"')+B('데이터 JSON','export-report','data-id="'+e(r.id)+'"')+(E.can('results',true)&&r.status==='DRAFT'?B('내용 편집','edit-report','data-id="'+e(r.id)+'"')+B('보고서 확정','publish-report','data-id="'+e(r.id)+'"'):'')+(r.status==='PUBLISHED'?B('새 버전 만들기','report-successor','data-id="'+e(r.id)+'"'):'')+'</div>',null,'',true);
};
E.actions['publish-report']=d=>E.confirm('내부 보고서 확정','이 시점의 보고서 내용을 잠급니다. 수정이 필요하면 후속 버전을 만드세요. 고객사 공유 링크는 생성하지 않습니다.',()=>E.run('report.publish',{id:d.id}));
E.actions['report-successor']=d=>E.dialog('새 보고서 버전',S('집계 기준','source',[['current','현재 운영 기록으로 갱신'],['previous','이전 확정본의 집계 유지']],'current')+E.notice('이전 확정본은 그대로 보존됩니다. 새 초안은 내부에서 편집·확정할 수 있습니다.'),async p=>{await E.run('report.successor',{id:d.id,source:p.source});E.close();E.navigate(E.consoleURL('reports'));E.toast('새 보고서 초안을 만들었습니다.');});
E.workflowVersion=16;
})(window.ET);

/* Fold agency-admin and event-manager accounts into one operator role. */
(function(E){'use strict';
const grants=['events.all','events.create','clients.manage','team.manage','integrations.manage'];
const baseSeed=E.seed,baseLoad=E.load,baseAccept=E.acceptState;
function migrate(state){
 if(!state||state.operatorPermissionVersion>=2)return state;
 const formerManagers=new Set();
 for(const account of state.accounts||[]){
  if(account.role==='AGENCY'){
   account.role='OPERATOR';account.orgOwner=true;account.orgPermissions=grants.slice();
  }else if(account.role==='MANAGER'){
   formerManagers.add(account.id);account.role='OPERATOR';account.orgOwner=false;account.orgPermissions=Array.isArray(account.orgPermissions)?account.orgPermissions:[];
  }else if(account.role==='OPERATOR'){
   account.orgOwner=!!account.orgOwner;account.orgPermissions=Array.isArray(account.orgPermissions)?account.orgPermissions:[];
  }
 }
 for(const membership of state.memberships||[]){
  if(formerManagers.has(membership.accountId)&&(!Array.isArray(membership.write)||!membership.write.length))membership.write=['all'];
 }
 for(const invite of state.invitations||[]){
  if(invite.role==='AGENCY'){invite.role='OPERATOR';invite.orgPermissions=Array.from(new Set([...(invite.orgPermissions||[]),...grants]));}
  else if(invite.role==='MANAGER'){invite.role='OPERATOR';if(!Array.isArray(invite.write)||!invite.write.length)invite.write=['all'];}
 }
 state.operatorPermissionVersion=2;
 return state;
}
E.migrateOperatorState=migrate;
E.seed=()=>migrate(baseSeed());
E.load=()=>migrate(baseLoad());
E.acceptState=state=>baseAccept(migrate(state));
if(E.state)migrate(E.state);
if(E.session&&E.state)E.session=E.state.accounts.find(a=>a.id===E.session.id&&a.active)||null;
})(window.ET);
