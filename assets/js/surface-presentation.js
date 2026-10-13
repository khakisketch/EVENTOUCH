(function(E){
 'use strict';

 const originalAttendee=E.views.attendee;
 if(originalAttendee)E.views.attendee=()=>{
  const route=E.route||E.parseRoute?.();
  if(route?.scope!=='attendee'||route.eventId)return originalAttendee();
  const home='#/event/'+encodeURIComponent(route.slug||'')+'/home';
  if(route.page==='cancelled')return E.mobileState(
   '신청이 취소되었습니다',
   '기존 티켓으로 입장할 수 없습니다. 신청 상태에 관한 문의는 행사 운영자에게 연락하세요.',
   E.link('행사 홈',home,'primary')
  );
  if(route.params?.get('ticket')){
   const unavailable=E.remote?.statusCode!==404&&(window.navigator?.onLine===false||['offline','error','stale','connecting'].includes(E.remote?.status));
   if(unavailable)return E.mobileState(
    '티켓 정보를 불러오지 못했습니다',
    '인터넷 연결을 확인한 뒤 다시 시도하세요.',
    '<button class="btn primary" type="button" data-reload-entry>다시 시도</button>'+E.link('행사 홈',home)
   );
   return E.mobileState(
    '티켓 링크를 사용할 수 없습니다',
    '이 티켓은 취소·만료·재발급되었거나 주소가 올바르지 않을 수 있습니다. 최신 티켓 링크를 행사 운영자에게 요청하세요.',
    E.link('행사 홈',home,'primary')
   );
  }
  return E.mobileState(
   '행사 주소를 확인하세요',
   '올바른 초대 링크로 다시 접속하세요.',
   E.link('행사 홈',home,'primary')
  );
 };

 const originalStaff=E.views.staff;
 if(originalStaff)E.views.staff=()=>{
  let html=originalStaff();
  const assignment=E.assignment?.();
  if(assignment?.type!=='BOOTH')return html;
  const booth=(E.work?.()?.booths||[]).find(item=>item.id===assignment.targetId);
  if(!booth)return html;
  const metrics=[];
  if(Number.isFinite(booth.used))metrics.push('사용 '+(E.number?E.number(booth.used):booth.used));
  if(Number.isFinite(booth.capacity)&&Number.isFinite(booth.used))metrics.push(booth.capacity?'잔여 '+(E.number?E.number(Math.max(0,booth.capacity-booth.used)):Math.max(0,booth.capacity-booth.used)):'잔여 제한 없음');
  if(Number.isFinite(booth.limit))metrics.push('1인 '+(E.number?E.number(booth.limit):booth.limit)+'회');
  if(!Number.isFinite(booth.capacity)){
   const state={OPEN:'진행',WAITING:'대기',CLOSED:'종료'}[booth.status]||'정보 없음';
   html=html.replace('<div class="od-stat"><strong>무제한</strong><small>남은 수량</small></div>','<div class="od-stat"><strong>'+state+'</strong><small>부스 상태</small></div>');
  }
  if(metrics.length===3)return html;
  const message=metrics.length?metrics.join(' · '):'인증이 완료되면 최근 처리에서 확인할 수 있습니다.';
  const badValue=html.indexOf('undefined');
  if(badValue<0)return html;
  const start=html.lastIndexOf('<div',badValue);
  if(start<0)return html;
  const end=html.indexOf('</div>',badValue);
  if(end<0)return html;
  return html.slice(0,start)+E.notice(message)+html.slice(end+6);
 };

 const originalDisplay=E.views.display;
 if(originalDisplay)E.views.display=()=>{
  let html=originalDisplay();
  const snapshot=E.publicSnapshot?.();
  if(!snapshot||!html.includes('class="display-content'))return html;
  const type=snapshot.display?.type;
  if(type==='idle'&&String(snapshot.event?.name||'').length>36){
   html=html.replace('class="display-content display-content--idle"','class="display-content display-content--idle is-long"');
  }
  if(type==='notice'&&snapshot.notice){
   const title=String(snapshot.notice.title||''),body=String(snapshot.notice.body||'');
   if(title.length>42||body.length>500){
    html=html.replace('class="display-content display-content--notice"','class="display-content display-content--notice is-long"');
    if(body.length>850)html=html.replace('</div></main>','<p class="display-content-hint">전체 안내는 참가자 화면의 공지 메뉴에서 확인하세요.</p></div></main>');
   }
  }
  return html;
 };
})(window.ET);
