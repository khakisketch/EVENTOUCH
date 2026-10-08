(function(E){'use strict';
const originalLoginPage=E.loginPage;
const esc=E.esc||((value)=>String(value??''));

function connectionNotice(){
 const state=E.ui?.connectionState||{};
 const status=state.status||E.remote?.status||'',message=String(state.message||E.remote?.error||'');
 if(!status||['connected','login-required','preview'].includes(status))return '';
 const labels={connecting:'서버에 연결하고 있습니다.',offline:'서버 연결이 끊겼습니다.',error:'서버와 통신하는 중 문제가 발생했습니다.',denied:'서버에서 요청을 허용하지 않았습니다.',stale:'서버의 최신 자료를 확인하지 못했습니다.'};
 const label=labels[status]||'서버 연결 상태를 확인할 수 없습니다.';
 const role=status==='connecting'?'status':'alert';
 const detail=message&&message!==label?'<span class="server-connection-detail">'+esc(message)+'</span>':'';
 const retry=status==='connecting'?'':E.button('연결 다시 시도','retry-server-connection','','quiet');
 return '<div class="server-connection-state '+esc(status)+'" role="'+role+'" aria-live="'+(role==='alert'?'assertive':'polite')+'"><div class="server-connection-copy"><strong>'+label+'</strong>'+detail+'</div>'+retry+'</div>';
}
function serverLoginPage(){
 if(E.previewMode)return originalLoginPage();
 const previous=String(originalLoginPage());
 const story=previous.match(/<section class="login-story">[\s\S]*?<\/section>/)?.[0]||'<section class="login-story"><div class="wordmark">EVENTOUCH</div><span class="eyebrow">행사 준비부터 결과까지</span><h1>운영의 흐름을<br>한곳에서.</h1><p>행사를 준비하고, 현장에서 처리하고, 결과를 전달합니다.</p></section>';
 return '<main class="login-layout">'+story+'<section class="login-form"><span class="eyebrow">운영사 로그인</span><h2>워크스페이스 시작</h2><p class="muted">운영사 계정으로 로그인해 권한이 있는 행사와 업무를 확인하세요.</p>'+connectionNotice()+'<form data-form="login" novalidate class="od-stack" style="--od-gap:16px"><div class="error-summary" role="alert"></div>'+E.field('이메일','email','','email','required autocomplete="username"')+E.field('비밀번호','password','','password','required autocomplete="current-password"')+E.submit('로그인')+'</form><p class="help" id="dev-quick-login" hidden>개발 환경 전용 · <button type="button" class="btn" data-action="dev-quick-login">빠른 로그인</button></p><p class="help">계정은 운영사 구성원이 초대합니다. 참가자는 로그인 없이 행사 링크를 사용합니다.</p></section></main>';
}
E.loginPage=()=>{const html=serverLoginPage();revealDevQuickLogin();return html;};

function revealDevQuickLogin(){
 if(E.previewMode||typeof fetch!=='function')return;
 setTimeout(()=>{
  fetch('/api/health',{credentials:'same-origin',cache:'no-store'}).then(response=>response.json()).then(data=>{
   const slot=document.getElementById('dev-quick-login');
   if(slot&&data&&data.devQuickLogin)slot.hidden=false;
  }).catch(()=>{});
 },0);
}

E.actions=E.actions||{};
E.actions['dev-quick-login']=async()=>{
 if(E.previewMode)return;
 try{
  const response=await fetch('/api/auth/dev/quick-login',{method:'POST',credentials:'same-origin',headers:{accept:'application/json'}});
  let data=null;try{data=await response.json();}catch(error){}
  if(!response.ok)throw Object.assign(new Error((data&&data.error)||'빠른 로그인을 사용할 수 없습니다.'),{status:response.status});
  if(E.remote?.restoreSession)await E.remote.restoreSession();
  E.toast?.((data&&data.user&&data.user.name?data.user.name+' 계정으로':'')+' 빠른 로그인으로 접속했습니다.');
  E.navigate?.('#/console/agency/events');
 }catch(error){E.toast?.(error.message||'빠른 로그인을 사용할 수 없습니다.');}
};

E.actions=E.actions||{};
E.actions['retry-server-connection']=async()=>{
 if(E.previewMode)return;
 if(E.session&&E.remote?.bootstrap){try{await E.remote.bootstrap();}finally{E.render?.();}return;}
 if(E.startup){await E.startup();return;}
 if(E.remote?.bootstrap){try{await E.remote.bootstrap();}finally{E.render?.();}}
};

const originalAdminShell=E.adminShell;
if(originalAdminShell)E.adminShell=function(){
 let html=originalAdminShell.apply(this,arguments);
 if(!E.previewMode&&E.storageMode==='server'){
  const warning=E.storageWarning?E.notice(E.storageWarning,'warning'):'';
  if(warning)html=html.replace(warning,connectionNotice()||warning);
  html=html.replace('<span class="environment-label">브라우저 체험</span>','<span class="environment-label">서버 모드</span>');
  html=html.replace(/<footer class="workspace-footer">[\s\S]*?<\/footer>/,'<footer class="workspace-footer">EVENTOUCH · 행사 정보는 서버에 저장되며 행사 권한에 따라 팀원과 공유됩니다.</footer>');
 }
 return html;
};

const originalAttendeeView=E.views?.attendee;
if(originalAttendeeView)E.views.attendee=function(){
 let html=originalAttendeeView.apply(this,arguments);
 if(E.previewMode||E.storageMode!=='server')return html;
 html=html.replace('이 티켓은 현재 브라우저의 프로토타입 데이터입니다. 다른 기기와 동기화되지 않습니다.','이 티켓은 행사 서버의 참가 정보와 연결되어 있습니다. 개인 티켓 링크를 보관해 주세요.');
 html=html.replaceAll('가상 정보를 사용하세요. 실제 개인정보를 입력하지 마세요.','참가 신청 정보는 행사 운영 서버에 저장됩니다. 필요한 항목을 입력하세요.');
 return html;
};

const originalInviteLinkAction=E.actions['invite-link'];
E.actions['invite-link']=data=>{
 if(E.previewMode)return originalInviteLinkAction?originalInviteLinkAction(data):undefined;
 const link=data&&data.id&&E.remote?.invitationLink?E.remote.invitationLink(data.id):null;
 if(link)return E.copyLink(E.url(link));
 return E.toast('보안을 위해 수락 링크는 초대를 만든 탭에서만 복사할 수 있습니다. 링크를 잃었다면 초대를 철회하고 다시 초대하세요.');
};

const originalInvitePage=E.invitePage;
if(typeof originalInvitePage==='function')E.invitePage=()=>{
 if(E.previewMode)return originalInvitePage();
 const invitation=(E.state?.invitations||[])[0];
 if(!invitation){
  const state=E.ui?.connectionState||{};
  const message=state.message&&!['connected','login-required','preview','connecting'].includes(state.status||'')?state.message:'';
  return E.accessPage('초대를 사용할 수 없습니다',(message||'링크가 만료되었거나 철회되었습니다.')+' 운영사 구성원에게 새 초대를 요청하세요.');
 }
 const role=invitation.role==='STAFF'?'현장 스태프':'운영사 구성원';
 const access=invitation.eventId?'초대에 지정된 행사':'행사는 수락 후 배정됩니다';
 return '<main class="access-page">'+E.head('팀 초대 수락','초대 역할과 접근 범위를 확인하세요.','','EVENTOUCH')+E.panel('초대 정보','<div class="invite-identity">'+E.detail([['이름',invitation.name],['제품 역할',role]])+'</div>'+'<form data-form="accept-invite-server" novalidate class="od-stack invite-accept-form"><div class="error-summary" role="alert"></div>'+E.field('비밀번호 설정 *','password','','password','required minlength="8" autocomplete="new-password"')+E.submit('초대 수락')+'</form>'+'<div class="invite-access">'+E.detail([['이메일',invitation.email],['접근 범위',access],['만료',E.date(invitation.expiresAt)]])+'</div>'+E.notice('비밀번호를 8자 이상으로 설정하면 초대가 수락되고 이 계정으로 로그인합니다. 실제 이메일은 발송되지 않습니다.'))+'</main>';
};

E.forms=E.forms||{};
E.forms['accept-invite-server']=async input=>{
 if(E.previewMode)throw Error('미리보기에서는 초대를 수락할 수 없습니다.');
 const token=E.route?.token||'';
 const password=String(input?.password||'');
 if(password.length<8)throw Error('비밀번호를 8자 이상 입력하세요.');
 await E.remote.acceptInvitation(token,password);
 E.toast('초대를 수락했습니다. 이 계정으로 로그인했습니다.');
 const account=E.session||{};
 let assignment=null;
 if(account.role==='STAFF'){
  for(const [eventId,workspace] of Object.entries(E.state?.workspaces||{})){
   const found=(workspace?.assignments||[]).find(item=>item&&item.accountId===account.id);
   if(found){assignment={eventId,id:found.id};break;}
  }
 }
 E.navigate?.(assignment?'#/staff/'+assignment.eventId+'/'+assignment.id:'#/console/agency/events');
};
})(window.ET);
