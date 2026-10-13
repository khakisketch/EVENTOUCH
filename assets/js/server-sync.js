(function(E){'use strict';
const QUEUE_KEY='eventouch.checkin.outbox.v1';
const localLoad=E.load,localRun=E.run,localLogin=E.login,localLogout=E.logout,localPersist=E.persist;
const previewLoginForm=E.forms?.login;
const previewReadDisk=E.readDisk;
const uncertainCommands=new Map();
const uncertainUploads=new WeakMap();
const invitationLinks=new Map();
const emptyState=()=>({version:9,revision:0,activeEventId:null,events:[],workspaces:{},clients:[],accounts:[],memberships:[],invitations:[],globalAudit:[],commands:[]});
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
function setConnection(status,message=''){
 E.remote.status=status;E.remote.error=message;
 E.ui.connectionState={status,message};
 if(status==='offline'||status==='error'){if(message)E.storageWarning=message;}
 else if(status==='connected')E.storageWarning='';
}
function apiPath(path){
 const value=String(path||'');
 if(/^https?:\/\//i.test(value))throw Error('같은 출처의 API 경로만 사용할 수 있습니다.');
 return value.startsWith('/api/')?value:'/api'+(value.startsWith('/')?value:'/'+value);
}
async function request(method,path,body,options={}){
 const headers={accept:'application/json',...(options.headers||{})};
 const init={method,credentials:'same-origin',cache:'no-store',headers};
 if(body!==undefined){headers['content-type']='application/json';init.body=JSON.stringify(body);}
 let response;
 try{response=await window.fetch(apiPath(path),init);}
  catch(error){E.remote.statusCode=null;setConnection('offline',error&&error.message||'서버에 연결할 수 없습니다. 연결 상태를 확인한 뒤 다시 시도하세요.');throw error;}
 let data=null;
 try{data=await response.json();}catch{}
  if(!response.ok){E.remote.statusCode=response.status;const message=String(data?.error||data?.message||'요청을 처리하지 못했습니다.');const error=Error(message);error.status=response.status;if(data?.code)error.code=data.code;if(data?.field)error.field=data.field;setConnection(response.status>=500?'error':'denied',message);throw error;}
  E.remote.statusCode=response.status;
 setConnection('connected');
 return data;
}
function normalizedState(value){
 if(!value||value.version!==9||!Array.isArray(value.events)||!value.workspaces||typeof value.workspaces!=='object')throw Error('서버 행사 자료 형식이 올바르지 않습니다.');
 // Outbound messaging state is server-owned; keep whatever it reported.
 const next=clone(value);next.events=next.events.filter(Boolean);next.accounts=Array.isArray(next.accounts)?next.accounts:[];next.clients=Array.isArray(next.clients)?next.clients:[];next.memberships=Array.isArray(next.memberships)?next.memberships:[];next.invitations=Array.isArray(next.invitations)?next.invitations:[];next.commands=Array.isArray(next.commands)?next.commands:[];
 for(const event of next.events){if(!event.features||!Array.isArray(event.features))event.features=[];next.workspaces[event.id]={...(E.emptyWorkspace?E.emptyWorkspace():{}),...(next.workspaces[event.id]||{})};}
 return next;
}
function activateState(value,accountId){
 const next=normalizedState(value);E.state=next;E.storageMode='server';
 const id=accountId||E.session?.id;E.session=id?next.accounts.find(account=>account.id===id&&account.active)||null:null;
 E.state.activeEventId=next.activeEventId||next.events[0]?.id||null;
 return next;
}
async function postWithRetry(path,body,options={}){
 try{return await request('POST',path,body,options);}
 catch(error){if(error.status||window.navigator?.onLine===false)throw error;return request('POST',path,body,options);}
}
function readCheckinQueue(){
 try{const value=JSON.parse(window.localStorage.getItem(QUEUE_KEY)||'[]');return Array.isArray(value)?value.filter(item=>item&&item.commandId&&item.eventId&&item.payload):[];}catch{return [];}
}
function writeCheckinQueue(value){window.localStorage.setItem(QUEUE_KEY,JSON.stringify(value));}
function enqueueCheckin({eventId,assignmentId,payload,commandId}={}){
 if(!E.session?.id||!eventId||!assignmentId||!payload?.ticket||!payload?.deskId)throw Error('오프라인 입장 대기 자료가 부족합니다.');
 const queue=readCheckinQueue(),serialized=JSON.stringify(payload);
 const existing=queue.find(item=>item.accountId===E.session.id&&item.eventId===eventId&&item.assignmentId===assignmentId&&JSON.stringify(item.payload)===serialized);
 if(existing)return clone(existing);
 const item={accountId:E.session.id,eventId:String(eventId),assignmentId:String(assignmentId),commandId:String(commandId||E.id('cmd')),command:'check.scan',payload:clone(payload),queuedAt:new Date().toISOString()};
 queue.push(item);writeCheckinQueue(queue);setConnection('offline','입장 처리를 연결 복구 후 동기화하도록 대기열에 저장했습니다.');return clone(item);
}
async function refreshAuthenticated(){
 const response=await request('GET','/bootstrap');
 if(!response?.state)throw Error('서버에서 행사 상태를 받지 못했습니다.');
 return activateState(response.state,E.session?.id);
}
function publicState(response){
 if(!response?.event||!response?.workspace)throw Error('공개 행사 자료를 확인할 수 없습니다.');
 const event=response.event,workspace={...(E.emptyWorkspace?E.emptyWorkspace():{}),...response.workspace};
 if(response.participant&&!workspace.participants.some(person=>person.id===response.participant.id))workspace.participants=[response.participant];
 E.session=null;E.storageMode='server';E.state={...emptyState(),activeEventId:event.id,events:[event],workspaces:{[event.id]:workspace}};
 return E.state;
}
E.remote={
  status:'connecting',error:'',statusCode:null,
 invitationLink(id){const saved=invitationLinks.get(String(id||''));return saved&&saved.accountId===E.session?.id?saved.link:null;},
 async createInvitation(input={}){
  if(E.previewMode||E.storageMode!=='server'||!E.session?.id)throw Error('초대는 서버에 로그인한 운영자만 만들 수 있습니다.');
  const accountId=E.session.id;
  const legacy=String(input.role||'').trim().toUpperCase();
  const role=legacy==='OPERATOR'?'MANAGER':legacy;
  if(!['MANAGER','STAFF'].includes(role))throw Error('운영사 구성원 또는 현장 스태프만 초대할 수 있습니다.');
  if(role==='STAFF'&&input.eventId)throw Error('현장 스태프 초대에는 행사를 지정할 수 없습니다. 행사 배정은 수락 후 데스크·부스 배정으로 연결하세요.');
  const result=await postWithRetry('/auth/invitations',{
   name:input.name,email:input.email,role,eventId:input.eventId||null,commandId:input.commandId||E.id('invite'),
  });
  if(!result?.invitation?.id||typeof result.token!=='string'||!result.token)throw Error('생성된 초대 링크를 확인할 수 없습니다. 기존 초대를 철회한 뒤 다시 초대하세요.');
  if(E.session?.id===accountId)invitationLinks.set(result.invitation.id,{accountId,link:'#/invite/'+encodeURIComponent(result.token)});
  return clone(result.invitation);
 },
 async revokeInvitation(id,commandId){
  if(E.previewMode||E.storageMode!=='server'||!E.session?.id)throw Error('초대 철회는 서버에 로그인한 운영자만 할 수 있습니다.');
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(String(id||'')))throw Error('초대 ID를 확인하세요.');
  const result=await postWithRetry('/auth/invitations/'+encodeURIComponent(id)+'/revoke',{commandId:commandId||E.id('invite-revoke')});
  invitationLinks.delete(id);return clone(result?.invitation);
 },
 fileURL({eventId,fileId,slug,public:publicFile=false}={}){
  const id=/^[A-Za-z0-9_-]{1,160}$/;
  if(!id.test(String(fileId||''))||(!publicFile&&!id.test(String(eventId||'')))||(publicFile&&!/^[a-z0-9][a-z0-9-]{0,99}$/.test(String(slug||''))))throw Error('행사와 파일 ID를 확인하세요.');
  return publicFile?'/api/public/events/'+encodeURIComponent(slug)+'/files/'+encodeURIComponent(fileId):'/api/events/'+encodeURIComponent(eventId)+'/files/'+encodeURIComponent(fileId);
 },
 async uploadFile(file,{eventId,commandId}={}){
  if(E.previewMode||E.storageMode!=='server')throw Error('파일 업로드는 서버 연결 상태에서만 할 수 있습니다.');
  if(!file||!file.name||!file.type||!Number.isSafeInteger(file.size)||file.size<1||file.size>8*1024*1024||!/^[A-Za-z0-9_-]{1,160}$/.test(String(eventId||'')))throw Error('파일과 행사를 확인하세요.');
  let pending=uncertainUploads.get(file);
  if(!pending){pending=new Map();uncertainUploads.set(file,pending);}
  const id=String(commandId||pending.get(eventId)||E.id('cmd'));pending.set(eventId,id);
  const path='/api/events/'+encodeURIComponent(eventId)+'/files?name='+encodeURIComponent(file.name)+'&commandId='+encodeURIComponent(id);
  const send=async()=>{
   let response;
   try{response=await window.fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{accept:'application/json','content-type':file.type},body:file});}
   catch(error){setConnection('offline',error.message);throw error;}
   let data=null;try{data=await response.json();}catch{}
   if(!response.ok){const error=Error(data?.error||'파일을 저장하지 못했습니다.');error.status=response.status;setConnection(response.status>=500?'error':'denied',error.message);throw error;}
   const ref=data?.file;
   if(!ref||!/^[A-Za-z0-9_-]{1,160}$/.test(ref.fileId)||!Number.isSafeInteger(ref.size)||ref.size<1)throw Error('서버 파일 정보를 확인할 수 없습니다.');
   setConnection('connected');return {fileId:ref.fileId,name:ref.name,type:ref.type,size:ref.size,...(Number.isInteger(ref.width)&&Number.isInteger(ref.height)?{width:ref.width,height:ref.height}:{})};
  };
  try{
   let result;try{result=await send();}catch(error){if(error.status||window.navigator?.onLine===false)throw error;result=await send();}
   pending.delete(eventId);return result;
  }catch(error){if(error.status&&error.status<500)pending.delete(eventId);throw error;}
 },
 async uploadPublicFile(file,{slug,commandId}={}){
  if(E.previewMode||E.storageMode!=='server')throw Error('사진 업로드는 서버 연결 상태에서만 할 수 있습니다.');
  if(!file||!file.name||!file.type||!Number.isSafeInteger(file.size)||file.size<1||file.size>600000||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(String(slug||'')))throw Error('사진과 행사를 확인하세요.');
  const ticket=E.person?.()?.ticket||E.route?.params?.get('ticket')||'';
  if(!ticket)throw Error('티켓 링크를 확인하세요.');
  let pending=uncertainUploads.get(file);
  if(!pending){pending=new Map();uncertainUploads.set(file,pending);}
  const id=String(commandId||pending.get(slug)||E.id('cmd'));pending.set(slug,id);
  const path='/api/public/events/'+encodeURIComponent(slug)+'/files?name='+encodeURIComponent(file.name)+'&commandId='+encodeURIComponent(id);
  const send=async()=>{
   let response;
   try{response=await window.fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{accept:'application/json','content-type':file.type,authorization:'Bearer '+ticket},body:file});}
   catch(error){setConnection('offline',error.message);throw error;}
   let data=null;try{data=await response.json();}catch{}
   if(!response.ok){const error=Error(data?.error||'사진을 저장하지 못했습니다.');error.status=response.status;setConnection(response.status>=500?'error':'denied',error.message);throw error;}
   const ref=data?.file;
   if(!ref||!/^[A-Za-z0-9_-]{1,160}$/.test(ref.fileId)||!Number.isSafeInteger(ref.size)||ref.size<1)throw Error('서버 파일 정보를 확인할 수 없습니다.');
   setConnection('connected');return {fileId:ref.fileId,name:ref.name,type:ref.type,size:ref.size,...(Number.isInteger(ref.width)&&Number.isInteger(ref.height)?{width:ref.width,height:ref.height}:{})};
  };
  try{
   let result;try{result=await send();}catch(error){if(error.status||window.navigator?.onLine===false)throw error;result=await send();}
   pending.delete(slug);return result;
  }catch(error){if(error.status&&error.status<500)pending.delete(slug);throw error;}
 },
 get(path,options={}){return request('GET',path,undefined,options);},
 post(path,body,options={}){return request('POST',path,body,options);},
 async bootstrap(){return refreshAuthenticated();},
 async login(credentials={}){
  setConnection('connecting');
  try{const result=await postWithRetry('/auth/login',{email:String(credentials.email||'').trim(),password:String(credentials.password||'')});if(!result?.user?.id)throw Error('로그인 계정을 확인할 수 없습니다.');E.session=result.user;await refreshAuthenticated();return E.session;}
  catch(error){E.state=emptyState();E.session=null;E.storageMode='server';setConnection(error.status===401?'denied':'error',error.message);throw error;}
 },
 async restoreSession(){
  try{const result=await request('GET','/auth/me');if(!result?.user?.id)throw Error('로그인 세션을 확인할 수 없습니다.');E.session=result.user;await refreshAuthenticated();return true;}
  catch(error){E.state=emptyState();E.session=null;E.storageMode='server';if(error.status===401){setConnection('login-required','로그인이 필요합니다.');return false;}setConnection('error',error.message);throw error;}
 },
 async logout(){
  let failure=null;try{await request('POST','/auth/logout',{});}catch(error){failure=error;}
  E.state=emptyState();E.session=null;E.storageMode='server';E.ui.returnTo=null;
  invitationLinks.clear();
  if(failure)setConnection('error',failure.message);else setConnection('login-required','');
  if(window.location)window.location.hash='#/login';
  if(failure)throw failure;
  return true;
 },
 async loadPublic(slug,ticket=''){
  const suffix=ticket?'/ticket':'';
  const result=await request('GET','/public/events/'+encodeURIComponent(slug)+suffix,undefined,ticket?{headers:{authorization:'Bearer '+ticket}}:{});
  return publicState(result);
 },
 async loadInvitation(token){
  const result=await request('GET','/auth/invitations/'+encodeURIComponent(token));
  E.state=emptyState();E.state.invitations=result?.invitation?[result.invitation]:[];E.session=null;E.storageMode='server';return result?.invitation||null;
 },
 async acceptInvitation(token,password){
  const result=await postWithRetry('/auth/invitations/'+encodeURIComponent(token)+'/accept',{password});
  if(!result?.account?.email)throw Error('초대 계정을 확인할 수 없습니다.');
  return this.login({email:result.account.email,password});
 },
 readCheckinQueue,
 enqueueCheckin,
 async replayCheckins(){
  if(window.navigator?.onLine===false)return {applied:0,pending:readCheckinQueue().length};
   let applied=0,failure=null;
  for(const item of readCheckinQueue()){
   if(!E.session?.id||item.accountId!==E.session.id)continue;
   try{
    await postWithRetry('/events/'+encodeURIComponent(item.eventId)+'/commands',{commandId:item.commandId,command:item.command,payload:item.payload,assignmentId:item.assignmentId});
    writeCheckinQueue(readCheckinQueue().filter(row=>row.commandId!==item.commandId));applied+=1;
    }catch(error){failure=error;break;}
  }
   if(applied&&E.session){try{await refreshAuthenticated();}catch(error){setConnection('stale',error.message);}}
   if(failure)setConnection(failure.status>=500?'error':failure.status?'denied':'offline',failure.message);
   return {applied,pending:readCheckinQueue().length,...(failure?{error:failure}:{})};
 },
};

E.load=()=>{
 if(E.previewMode)return localLoad();
 E.storageMode='server';E.state=E.state||emptyState();E.session=null;return E.state;
};
E.readDisk=()=>E.previewMode?previewReadDisk():null;
E.persist=value=>{
 if(E.storageMode==='server')throw Error('공유 행사 자료는 서버 저장 명령으로 변경해야 합니다.');
 return localPersist(value);
};
E.login=id=>{
 if(E.previewMode)return localLogin(id);
 throw Error('계정 이메일과 비밀번호로 로그인하세요.');
};
E.logout=()=>E.previewMode?localLogout():E.remote.logout();
if(E.forms)E.forms.login=async credentials=>{
 if(E.previewMode)return previewLoginForm(credentials);
 const account=await E.remote.login(credentials);
 let hash=E.ui.returnTo;E.ui.returnTo=null;
 if(!hash||!hash.startsWith('#/')){
  const event=account.role==='STAFF'?E.state.events.find(item=>E.state.workspaces[item.id]?.assignments.some(assignment=>assignment.accountId===account.id)):null;
  const assignment=event&&E.state.workspaces[event.id].assignments.find(item=>item.accountId===account.id);
  hash=assignment?'#/staff/'+event.id+'/'+assignment.id:'#/console/agency/events';
 }
 E.close?.();E.navigate?.(hash);
};

function validateLocally(name,input,commandId){
 const handler=E.handlers[name];if(!handler)throw Error('지원하지 않는 작업입니다.');
 let payload={...(input||{})};const scope=E.route?.scope;
 if(scope==='attendee'){
  if(!handler.options?.participant)throw Error('참가자 화면에서는 이 작업을 실행할 수 없습니다.');
  if(!handler.options?.guest){const person=E.person?.();if(!person||!E.ticketValid?.(person))throw Error('티켓을 확인한 뒤 다시 참여하세요.');if(payload.participantId&&payload.participantId!==person.id)throw Error('본인의 정보만 변경할 수 있습니다.');payload={...payload,participantId:person.id};}
 }else if(!handler.options?.guest&&!(name==='participant.create'?(E.can?.('participants',true)||E.can?.('onsite',true)):(E.authorizeCommand?E.authorizeCommand(name,handler.group):E.can?.(handler.group,true))))throw Error('이 작업을 변경할 권한이 없습니다.');
 if(scope==='staff'&&!['check.scan','participant.create','check.correct','booth.visit'].includes(name))throw Error('배정된 현장 업무만 처리할 수 있습니다.');
 const event=E.event?.();if(handler.group!=='agency'&&(!event||!E.state?.workspaces?.[event.id]))throw Error('행사를 찾을 수 없습니다. 올바른 행사 링크로 다시 접속하세요.');
 return payload;
}
async function syncCommand(name,payload,commandId){
  const scope=E.route?.scope,event=E.event?.();
  if(name==='member.invite'||name==='member.revoke'){
   const result=name==='member.invite'?await E.remote.createInvitation({...payload,commandId}):await E.remote.revokeInvitation(payload.id,commandId);
   try{await refreshAuthenticated();}catch(error){setConnection('stale',error.message);}
   return result;
  }
 if(name==='event.create'){
  const result=await postWithRetry('/events',{...payload,commandId});
  try{await refreshAuthenticated();}catch(error){setConnection('stale',error.message);}
  if(result?.event?.id&&E.state?.workspaces?.[result.event.id])E.state.activeEventId=result.event.id;
  return result?.event?.id;
 }
 if(name==='participant.create'&&scope==='attendee'){
  const slug=E.route?.slug;if(!slug)throw Error('행사 주소를 확인할 수 없습니다.');
  const result=await postWithRetry('/events/'+encodeURIComponent(slug)+'/signup',{...payload,formVersion:Number(E.work()?.publishedVersion)||0,commandId});
  const participant=result?.participant;
  try{await E.remote.loadPublic(slug,participant?.ticket||'');}catch(error){setConnection('stale',error.message);}
  return participant;
 }
 if(!event?.id)throw Error('행사를 찾을 수 없습니다.');
 const bodyPayload={...payload};delete bodyPayload.commandId;
 const body={commandId,command:name,payload:bodyPayload};
 if(scope==='staff')body.assignmentId=E.route.assignmentId;
 const person=E.person?.(),ticket=scope==='attendee'?(person?.ticket||E.route?.params?.get('ticket')||''):'';
 const options=ticket?{headers:{authorization:'Bearer '+ticket}}:{};
 const result=await postWithRetry('/events/'+encodeURIComponent(event.id)+'/commands',body,options);
 if(scope==='attendee'){
  try{await E.remote.loadPublic(E.route.slug,ticket);}catch(error){setConnection('stale',error.message);}
 }else{
  try{await refreshAuthenticated();}catch(error){setConnection('stale',error.message);}
 }
 if(name==='draw.run')return result?.winners||result?.result?.winners||[];
 if(name.startsWith('participant.')||name==='ticket.reissue')return result?.participant||result;
 return result;
}
E.storeFile=async(file,{commandId,kind='image'}={})=>{
 if(E.previewMode||E.storageMode!=='server'){
  if(kind==='image')return E.readImage(file);
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('파일을 읽지 못했습니다.'));reader.readAsDataURL(file);});
  return {name:file.name,data};
 }
 const eventId=E.route?.eventId||E.event?.()?.id;
 return E.remote.uploadFile(file,{eventId,commandId});
};
E.run=async(name,payload={})=>{
 if(E.previewMode)return localRun(name,payload);
 // A preview must not create real participants or submissions.
 if(E.route?.scope==='attendee'&&E.route.params?.get('preview')==='1'&&E.can?.('page',true))throw Error('운영자 미리보기에서는 신청·제출을 저장하지 않습니다. 실제 참가자 링크에서 확인하세요.');
 if(E.storageMode!=='server')throw Error('서버 연결을 확인할 수 없습니다. 미리보기로 자동 전환하지 않았습니다.');
 if(E.ui.commandBusy)throw Error('앞선 작업을 저장하고 있습니다. 완료 후 다시 시도하세요.');
 E.ui.commandBusy=true;
 const retryKey=JSON.stringify([name,name==='event.create'?null:E.event?.()?.id,E.session?.id||E.route?.params?.get('ticket')||'guest',E.route?.assignmentId||null,payload]);
 try{
  const commandId=payload.commandId||uncertainCommands.get(retryKey)||E.id('cmd');
  if(name==='check.scan'&&window.navigator?.onLine===false){
   if(!E.session||E.route?.scope!=='staff')throw Error('오프라인 입장 처리는 로그인한 스태프 화면에서만 대기할 수 있습니다.');
   const item=enqueueCheckin({eventId:E.route.eventId,assignmentId:E.route.assignmentId,payload:{...payload},commandId});
   return {queued:true,commandId:item.commandId,action:E.work()?.desks.find(desk=>desk.id===payload.deskId)?.action||'IN'};
  }
  const validated=validateLocally(name,payload,commandId);
  uncertainCommands.set(retryKey,commandId);
   try{const result=await syncCommand(name,validated,commandId);uncertainCommands.delete(retryKey);E.dirty=true;return result;}
  catch(error){if(error.status&&error.status<500)uncertainCommands.delete(retryKey);if(name==='check.scan'&&!error.status){const item=enqueueCheckin({eventId:E.route.eventId,assignmentId:E.route.assignmentId,payload:{...validated},commandId});uncertainCommands.delete(retryKey);return {queued:true,commandId:item.commandId,action:E.work()?.desks.find(desk=>desk.id===payload.deskId)?.action||'IN'};}throw error;}
 }finally{E.ui.commandBusy=false;}
};

// Whether this install has an administrator at all. On a fresh deployment
// the login form must say so, otherwise an operator is told their password
// is wrong when in fact no account has been created yet.
async function loadSetupState(){
  if(E.previewMode)return;
  const result=await request('GET','/auth/setup-state');
  E.ui.setupRequired=!result?.ready;
}

// Register the offline shell. Registration is best effort by design: the
// product is fully usable online without it, so a failure here must never
// surface as an error to the operator.
function registerServiceWorker(){
  if(E.previewMode)return;
  if(typeof navigator==='undefined'||!('serviceWorker' in navigator))return;
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{
     // Offline shell unavailable; the product still works while online.
    });
  });
}

// The participant-page preview (operator-experience.js) frames the attendee
// route with ?preview=1. It must render the saved draft, which the public
// projection does not carry — and a DRAFT event has no public projection at
// all. With an operator session the console workspace already has it.
function isOperatorPreview(route){return route?.scope==='attendee'&&route.params?.get('preview')==='1';}
async function restoreOperatorPreview(){
 try{await E.remote.restoreSession();}catch(error){return false;}
 return Boolean(E.session&&E.can?.('page',true));
}

E.startup=async()=>{
 const query=new URLSearchParams(window.location?.search||'');
 E.previewMode=query.get('mode')==='preview';
 if(E.previewMode){E.storageMode='local';const state=localLoad();E.previewMode=true;E.ui.previewMode=true;E.remote.status='preview';E.render?.();return state;}
 registerServiceWorker();
 E.previewMode=false;E.ui.previewMode=false;E.storageMode='server';E.state=emptyState();E.session=null;setConnection('connecting','서버에 연결하고 있습니다.');
 try{await loadSetupState();}catch(error){/* a missing probe must not block startup */}
 try{
  const route=E.parseRoute?.();
  if(route?.scope==='attendee'){
   if(isOperatorPreview(route)&&await restoreOperatorPreview()){/* the operator workspace is already loaded */}
   else await E.remote.loadPublic(route.slug,route.params?.get('ticket')||'');
  }
  else if(route?.scope==='invite')await E.remote.loadInvitation(route.token);
  else await E.remote.restoreSession();
 }catch(error){setConnection('error',error.message);E.state=E.state||emptyState();}
 E.render?.();return E.state;
};
E.handleRouteChange=async()=>{
 if(E.previewMode){E.render?.();return;}
 try{
  const route=E.parseRoute?.();
   if(route?.scope==='attendee'){
    if(!(isOperatorPreview(route)&&E.session&&E.can?.('page',true)))await E.remote.loadPublic(route.slug,route.params?.get('ticket')||'');
   }
   else if(route?.scope==='invite')await E.remote.loadInvitation(route.token);
   else if(!E.session&&route?.scope!=='login')await E.remote.restoreSession();
   else if(E.session&&['agency','console','staff','display'].includes(route?.scope))await refreshAuthenticated();
   E.render?.();
 }catch(error){setConnection(error.status===403?'denied':'error',error.message);E.render?.();}
};
window.addEventListener?.('online',async()=>{
 if(E.previewMode)return;
 setConnection('connecting');
 try{
  const result=await E.remote.replayCheckins();
  if(result.applied&&E.remote.status==='connected'&&!readCheckinQueue().some(item=>item.accountId===E.session?.id)&&E.ui.scanResult?.pendingSync)E.ui.scanResult=null;
 }catch(error){setConnection('error',error.message);}
 finally{E.render?.();}
});
})(window.ET);
