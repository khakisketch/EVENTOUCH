'use client';

import {useState} from 'react';
import {Theme} from '@astryxdesign/core/theme';
import {Button} from '@astryxdesign/core/Button';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {Badge} from '@astryxdesign/core/Badge';
import {eventouchPilotTheme} from '../eventouch-pilot';

const preparation = {
  state: '행사 준비 중', title: '준비할 일을 확인하세요', description: '행사를 열기 전에 필요한 항목을 정리했습니다.',
  tasks: [
    {title: '참가 신청을 받을 준비가 필요해요', description: '신청 항목과 개인정보 동의를 확인해 주세요.', action: '신청 설정 보기', icon: 'wrench'},
    {title: '행사 안내를 게시해 주세요', description: '참가자가 볼 일정과 장소를 확인할 수 있어요.', action: '안내 확인하기', icon: 'calendar'},
    {title: '운영 스태프를 초대해 주세요', description: '현장에서 함께 일할 담당자를 배정해 주세요.', action: '팀 살펴보기', icon: 'info'},
  ],
  stats: [['신청 완료', '0', '명'], ['현장 입장', '0', '명'], ['운영 데스크', '0', '곳']],
};
const live = {
  state: '행사 진행 중', title: '현장 운영을 이어가세요', description: '지금 확인이 필요한 현장 상황을 모았습니다.',
  tasks: [
    {title: '아직 배정되지 않은 데스크가 있어요', description: '스태프 배정을 확인하고 현장 준비를 마쳐 주세요.', action: '배정 확인하기', icon: 'warning'},
    {title: '참가자 입장 현황을 확인하세요', description: '접수 현황과 현장 처리 내역을 볼 수 있어요.', action: '입장 현황 보기', icon: 'info'},
    {title: '오늘의 프로그램을 점검하세요', description: '진행 순서와 공개 상태를 확인할 수 있어요.', action: '프로그램 보기', icon: 'calendar'},
  ],
  stats: [['신청 완료', '1,248', '명'], ['현장 입장', '836', '명'], ['운영 데스크', '4', '곳']],
};
function RefreshIcon(props) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.4 9a7 7 0 0 1 12.1-2L20 12M4 12l2.5 5A7 7 0 0 0 18.6 15"/></svg>;
}
export default function Page() {
  const [phase, setPhase] = useState('preparation');
  const [notice, setNotice] = useState({text: '', revision: 0});
  const data = phase === 'preparation' ? preparation : live;
  const showNotice = text => setNotice(current => ({text, revision: current.revision + 1}));
  const clearNotice = () => setNotice(current => ({...current, text: ''}));
  const demo = action => showNotice(`${action}: 시범 화면입니다. 실제 작업은 실행되지 않습니다.`);
  return <Theme theme={eventouchPilotTheme} mode="light">
    <div className="pilot">
      <aside className="rail" aria-label="시범 메뉴">
        <div className="brand">EVENTOUCH<span className="brandDot">.</span></div>
        <p className="railCaption">행사 운영 워크스페이스</p>
        <div className="railEvent"><span className="railMark">E</span><div><strong>2026 브랜드 컨퍼런스</strong><small>행사 운영</small></div></div>
        <p className="railGroup">행사 관리</p>
        <nav aria-label="행사 관리 메뉴"><div className="railCurrent"><Icon icon="viewColumns" /> 운영 현황</div><div>참가자</div><div>참가자 페이지</div><div>프로그램</div></nav>
        <p className="railGroup">현장 운영</p><nav aria-label="현장 운영 메뉴"><div>운영 설정</div><div>스태프</div><div>결과 및 보고서</div></nav>
        <p className="railFoot">시범 화면 <span>·</span> 합성 데이터</p>
      </aside>
      <main className="workspace">
        <div className="previewNotice"><strong>Astryx 시범</strong><span>실제 행사와 연결되지 않은 화면입니다.</span></div>
        <header className="topbar"><div className="breadcrumb">행사 관리 <Icon icon="chevronRight" size="sm" /> <strong>운영 현황</strong></div><div className="topActions"><span>합성 데이터</span><IconButton label="시범 현황 새로고침" tooltip="시범 현황 새로고침" size="lg" variant="ghost" icon={<RefreshIcon />} onClick={() => showNotice('시범 현황을 다시 확인했습니다. 실제 조회는 실행되지 않았습니다.')} /></div></header>
        <div className="content">
          <div className="context"><div><div className="titleLine"><h1>운영 현황</h1><Badge variant={phase === 'preparation' ? 'orange' : 'success'} label={data.state} /></div><p className="eventName">2026 브랜드 컨퍼런스</p><p className="eventMeta"><Icon icon="calendar" size="sm" /> 2026. 11. 20. 금요일 <span>·</span> 서울</p></div><div className="statePicker" aria-label="시범 상황"><span>시범 상황</span><div className="stateControls"><Button label="준비 중" aria-pressed={phase === 'preparation'} variant={phase === 'preparation' ? 'primary' : 'ghost'} size="sm" onClick={() => {setPhase('preparation'); clearNotice();}} /><Button label="진행 중" aria-pressed={phase === 'live'} variant={phase === 'live' ? 'primary' : 'ghost'} size="sm" onClick={() => {setPhase('live'); clearNotice();}} /></div></div></div>
          <div className="overviewGrid">
            <section className="priority" aria-labelledby="priority-title"><div className="priorityHeader"><div><h2 id="priority-title">{data.title}</h2><p>{data.description}</p></div><span className="count">{data.tasks.length}개 확인</span></div><div className="taskList">{data.tasks.map((task) => <article className="task" key={task.title}><div className="taskIcon"><Icon icon={task.icon} size="md" /></div><div className="taskBody"><h3>{task.title}</h3><p>{task.description}</p><Button label={task.action} variant="ghost" size="sm" endContent={<Icon icon="chevronRight" />} onClick={() => demo(task.action)} /></div></article>)}</div></section>
            <aside className="sideColumn"><section className="snapshot" aria-labelledby="snapshot-title"><div className="sectionTop"><div><h2 id="snapshot-title">한눈에 보는 현황</h2><p>현재 행사 기준</p></div><Icon icon="viewColumns" size="md" /></div><dl className="stats">{data.stats.map(([name, value, unit]) => <div key={name}><dt>{name}</dt><dd>{value}<small>{unit}</small></dd></div>)}</dl><p className="snapshotNote">표시된 수치는 예시입니다.</p></section><section className="quick" aria-labelledby="quick-title"><h2 id="quick-title">자주 찾는 작업</h2><p>필요한 작업으로 바로 이동하세요.</p><div className="quickActions"><Button label="참가자 관리" variant="secondary" icon={<Icon icon="search" />} onClick={() => demo("참가자 관리")} /><Button label="행사 설정" variant="ghost" icon={<Icon icon="wrench" />} onClick={() => demo("행사 설정")} /></div></section></aside>
          </div>
          <section className="bottomBand"><div><h2>현장을 함께 준비하세요</h2><p>운영 데스크와 스태프 배정을 확인할 수 있습니다.</p></div><Button label="현장 운영 살펴보기" variant="secondary" endContent={<Icon icon="chevronRight" />} onClick={() => demo("현장 운영 살펴보기")} /></section>
          <div className="feedback" hidden={!notice.text}><p role="status" aria-atomic="true"><span key={notice.revision}>{notice.text}</span></p><Button label="안내 닫기" variant="ghost" size="sm" onClick={clearNotice} /></div>
        </div>
      </main>
    </div>
  </Theme>;
}
