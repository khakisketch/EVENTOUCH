---
name: EVENTOUCH
description: 흰 업무면에서 행사를 끝까지 운영하는 행사 운영 SaaS
colors:
  brand: "#F05A24"
  brand-hover: "#B83C10"
  brand-text: "#AA3A10"
  on-brand: "#171A1F"
  on-brand-hover: "#FFFFFF"
  brand-soft: "#FFF3EB"
  ink: "#252A34"
  muted: "#626B78"
  line: "#E6E8EC"
  line-strong: "#8A939F"
  paper: "#FFFFFF"
  ground: "#FFFFFF"
  surface-muted: "#F7F8FA"
  nav: "#FAFBFC"
  nav-hover: "#EFF1F4"
  nav-active: "#FFF0E6"
  nav-text: "#252A34"
  nav-muted: "#626B78"
  danger: "#B21E35"
  danger-soft: "#F7E4E7"
  danger-line: "#E0B4BA"
  success: "#2F6B4F"
  success-soft: "#E4EFE7"
  success-line: "#A8C3B3"
  warning: "#81520E"
  warning-soft: "#FFF4E1"
  warning-line: "#D9BB84"
  info: "#315B82"
  info-soft: "#EAF0F7"
  info-line: "#BDCEDF"
  message-kakao-header: "#FEE500"
  focus: "#AA3A10"
typography:
  display:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "clamp(48px, 3.4vw, 56px)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.05em"
  headline:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.006em"
  label:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
  s8: "64px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-brand-hover}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  pill:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  pill-active:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.nav-muted}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  ledger-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "12px 0"
  feedback-error:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  feedback-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  status-chip:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design System: EVENTOUCH

## Overview

**Creative North Star: "화이트 업무용 SaaS"**

흰 본문과 옅은 중성 내비게이션으로 행사 준비부터 현장·결과까지 하나의 조용한 업무면에 잇는다. 검은 크롬·명조·중첩 카드 장식은 쓰지 않고, 얇은 구분선과 열린 구획으로 목록·작성·검토 위계를 드러낸다. 오렌지는 주 행동과 선택에만 절제해 쓴다.

이전 CUE SHEET(검정·chalk·명조)와 고대비 C안은 폐기됐다. Attio·Linear·Mailchimp 실제 업무 화면을 참고한 흰 시안이 사용자 확정 방향이며, `apps/web` 제품 전체에 적용된 상태가 정본이다.

**Key Characteristics:**
- 흰 업무면·가벼운 내비·열린 구획, 중첩 카드 더미 금지
- Pretendard, 28px 제목과 14–16px 작업 데이터
- 오렌지는 작업·영역당 주 행동과 선택 표시에만, 면 전체는 중립 유지
- 모든 조작 44px 터치 바닥, 오류·복구는 가리지 않음
- 고객 확정 배너·게시된 참가자 스타일은 독립 콘텐츠로 보존

## Colors

흰 바탕에 중립 텍스트·얇은 선, 오렌지는 작업·영역당 주 행동과 선택 표시에만 절제해 쓴다.

### Primary
- **절제된 오렌지 행동** (#F05A24): 작업·영역당 주 행동(제출·주 버튼·선택 표시). 호버는 #B83C10, 텍스트형 링크·강조는 #AA3A10, 연한 바탕은 #FFF3EB. 같은 화면의 독립 작업(편집 단위·다이얼로그)은 각자 주 행동을 갖는다. 예외: 내비 카운트 뱃지는 채움 브랜드+버튼 글자(`.nav-badge`, `globals.css:2006-2019`), 사이드바 선택은 오렌지 잉크+연한 바탕이다.
- **검정에 가까운 버튼 글자** (#171A1F): 주 버튼 기본 글자색. 호버에서만 흰색(#FFFFFF)으로 반전한다.

### Neutral
- **잉크** (#252A34): 본문·제목.
- **뮤티드** (#626B78): 보조 설명·메타·플레이스홀더.
- **헤어라인** (#E6E8EC): 구분선·목록 경계. 강한 선(#8A939F)은 입력 테두리·위험 확인에만.
- **종이·바탕** (#FFFFFF): 본문과 작업면 모두 흰색. 2차 면은 #F7F8FA.
- **내비** (#FAFBFC): 사이드바·옅은 패널. 호버 #EFF1F4, 활성 #FFF0E6, 글자는 잉크/뮤티드와 동일.
- **포커스** (#AA3A10): 3px 아웃라인. 입력 캐럿과 동일 색.

### 피드백 4색 (soft 배경 + line 테두리 + 진한 글자)
- **위험** (#B21E35 / #F7E4E7 / #E0B4BA): 삭제·취소 불가, 폼 오류.
- **성공** (#2F6B4F / #E4EFE7 / #A8C3B3): 승인·게시·입장 가능.
- **경고** (#81520E / #FFF4E1 / #D9BB84): 대기·중요 알림 스트립.
- **정보** (#315B82 / #EAF0F7 / #BDCEDF): 단계·안내·초안 상태.

### Named Rules
**The Primary-Per-Task Rule.** 주 행동 위계는 작업·영역 단위다. 같은 화면의 독립 작업(편집 단위·다이얼로그·모바일 행)은 각자 주 행동을 갖는다. 예외: 내비 카운트 뱃지는 채움 브랜드(`.nav-badge`), 사이드바 선택은 오렌지 잉크+연한 바탕이다.
**The Whitewash Ban.** 고객 확정 배너와 게시된 참가자 홈스타일을 공통 화이트로 덮지 않는다. 참가자 홈 기본 배경(#B9DEF0)과 대표·보조 문구·배치·덮개 선택은 `server/attendee-home-style.js`가 정본이며 이벤트별 독립 콘텐츠다. 신규 행사의 이미지 미설정 배너는 제목을 읽을 수 있는 중립 단색을 사용하고, 기존 행사는 기존 기본 이미지와 고객 게시 콘텐츠를 보존한다. 이미지 로드 실패는 기존 콘텐츠를 바꾸지 않고 제목과 오류 안내를 보여 준다.
**The Retained Tokens Rule.** `--stage-*`, `--ref-*` 토큰은 전광판 투영·참가자 홈·고객 레퍼런스 전용이다. 콘솔 설계 근거로 쓰지 않는다.

## Typography

**Display Font:** Pretendard Variable (with Noto Sans KR, Segoe UI, Malgun Gothic, system-ui fallback)
**Body Font:** 동일 (display와 분리 없음)
**Label/Mono Font:** Noto Sans Mono, ui-monospace, Consolas, monospace (코드·토큰 표기만)

**Character:** 화면을 읽히는 조용한 고딕. 크기·굵기·자간으로 위계를 만들고 장식 서체는 쓰지 않는다. 한국어 문구는 어절 단위 줄바꿈(`keep-all`)을 기본으로 한다.

### Hierarchy
- **Display:** 랜딩 히어로만. `clamp(48px, 3.4vw, 56px)`(800, 1.12, -0.05em, `landing.module.css:111-119`). ≤768px `clamp(36px, 9.2vw, 48px)`, ≤360px 28px. 전광판 보드는 별도 대형(`clamp(56px, 5.4vw, 88px)`)으로 합치지 않는다.
- **Headline** (700, 28px, 1.3, -0.025em): 콘솔 페이지 H1(`console-ui.module.css:20-28`). 모바일에서도 28px 유지.
- **Title** (650, 18px, 1.35): 섹션 제목(`console-ui.module.css:95-104`, 자간 별도 지정 없음).
- **Body** (400, 15–16px, 1.6, -0.006em): 작업 데이터는 15px(콘솔), 읽기 본문은 16px. 단락 최대 72ch.
- **Label** (650–800, 12–14px): 필터·메타·상태 칩.

## Layout

콘솔 셸은 208px 사이드바 + 유동 작업면(`208px minmax(0,1fr)`)을 사용한다. 본문 최대 1200px 중앙 정렬이다. 섹션은 공유 `ConsolePage`·`ConsoleSection` API로만 쌓고, 감싸는 카드 안에 카드를 중첩하지 않는다. 편집 단위는 폼 폭(읽기 760px·입력 640px)으로 스스로 좁히고, 목록·테이블은 전체 폭을 쓴다.

모바일(≤768px)에서는 사이드바가 상단 레일로 접히고(메뉴·브랜드·프로필), 작업면은 단일 열로 쌓인다. 툴바는 필터와 관련 액션을 구분하고 좁은 폭에서는 자연스럽게 줄바꿈한다. 터치 바닥 44px, 입력 최소 높이 44px은 모든 폭에서 유지한다.

폭 토큰: 내용 1200px·읽기 760px·폼 640px·티켓 480px·전광판 1800px. 간격 리듬 s1–s8(4·8·12·16·24·32·48·64px).

예외 모듈: 명단은 행 선택+툴바(검색·필터 좌, 액션 우, 선택 요약 별도 행), 메시지는 이력·작성·검토 분리 워크스페이스, 개요는 상단 숫자 띠 아래 할 일과 일정의 2열 작업면, 설정은 폼 스택, 페이지 편집기는 초안/게시+휴대폰 미리보기, 보고서는 동결 스냅샷+인쇄, 스태프는 단일 열+카메라 보조, 초대·로그인은 380px 중앙 단일 열, 랜딩은 읽기폭 히어로+3/2열 그리드다.

### Named Rules
**The No Nesting Rule.** 섹션 안에 장식 카드를 중첩하지 않는다. 들어올림이 필요하면 패널 상단선(`sectionPanel`) 하나만 쓴다.

## Elevation & Depth

기본은 평면이다. 작업면의 깊이는 그림자가 아니라 흰 바탕 위 얇은 선(`--line`)과 옅은 2차 면(`--surface-muted`)으로 표현한다. 팝오버·랜딩 증거물은 아래 확정 값을 쓴다.

### Shadow Vocabulary
- **운영자 메뉴** (`box-shadow: 0 14px 34px #252A3412`, `globals.css:3493` 최종 오버라이드): 데스크톱 운영자·조직 메뉴.
- **모바일 전역 메뉴** (`box-shadow: 0 8px 24px #10111480`, `globals.css:2848` 유지): 이후 테두리·배경 오버라이드(`globals.css:3556-3560`)는 그림자를 바꾸지 않는다.
- **범용 다이얼로그** (`.dialog`, `globals.css:2433-2443`): 그림자 없음. 흰 바탕+1px 선으로만 구분한다.
- **랜딩 증거물**: 콘솔 캡처 `0 10px 30px`(`landing.module.css:192`), 휴대폰 프레임 `0 20px 40px`(`landing.module.css:409`), 보고서 증거 `0 12px 32px`(`landing.module.css:478`), 모두 `var(--shadow-color)` 기준. 참가자 페이지 썸네일은 `0 5px 18px rgb(23 37 43 / 16%)`(`page.module.css:474`) 별도 예외다.
- **포커스 표시** (`outline: 3px solid #AA3A10`, offset 2–3px): `box-shadow`가 아니라 outline이다. 모든 대화형 요소 공통.
- **쓰지 않는 것**: 카드·타일·행의 resting 그림자, 그라디언트·글래스·네오브루탈 오프셋.

### Named Rules
**The Flat-Work-Surface Rule.** 작업면 카드·타일·행은 resting 그림자 없이 선으로 구분한다. 팝오버·랜딩 증거물은 위 확정 값을 그대로 쓴다.

## Shapes

둥근 모서리는 작고 일정하다: 기본 8px, 작은 요소 6px, 필·상태 칩만 알약(999px)이다. 입력·버튼·카드·다이얼로그 모두 직선 테두리+8px를 공유하고, 티켓 절취선·폴 바 같은 기능적 절단은 예외로 둔다. 테두리는 1px `--line`, 위험 확인만 `--line-strong`이다.

## Components

공통 셸 `ConsolePage`·`ConsoleSection` API는 그대로 두고, 그 안에 아래 패턴을 쓴다. 중첩 카드 금지.

### Buttons
- **Shape:** 둥글게(8px), 최소 높이 44px, 패딩 8px 16px, 굵기 600.
- **Primary:** 채움 #F05A24 + #171A1F 글자. 호버에서 #B83C10 + 흰색. 작업·영역당 하나(독립 작업은 각자 주 행동).
- **Hover / Focus:** 160ms ease-out 배경·테두리 전환, 눌림 1px 하강. 포커스는 3px 링.
- **Secondary / Quiet / Danger:** Secondary는 흰 바탕+강한 테두리, 호버에서 옅은 면. Quiet는 무테·투명(새로고침·공개 같은 비확정 동작). Danger 기본형은 투명 바탕+빨간 글자+무테, 호버에서 연한 빨강(`globals.css:285-295`), 행 끝 배치. 운영 `dangerGhost` 변형은 빨간 외곽선+투명(`operations.module.css:51-55`), 가동 중지/시작은 경고·성공 토큰 분리. 비활성은 투명도 0.55–0.6.
- **첫 작업의 위계:** 항목이 없어 첫 생성이 해당 영역의 다음 작업이면 채움 버튼을 쓰고, 이미 목록이 있는 영역에서 추가 생성은 보조 버튼으로 둔다. 독립된 다른 주 작업이 있으면 그 업무 맥락에서 판단한다.
- **익숙한 도구 아이콘:** 공통 선형 SVG를 사용한다. 현재 목록을 읽는 새로고침, 바로 옆 링크를 복사하는 도구, 모바일 메뉴는 44px 아이콘 버튼으로 표시한다. 접근 가능한 이름·포커스와 실행 상태를 제공한다. 승인·게시·발송·서버 집계와 오류 복구는 화면에 행동 이름을 표시한다. 화면 이동은 목적지가 드러나는 링크, 현재 목록의 빠른 필터는 선택 표시가 있는 컨트롤로 구분한다.

### Pills (필터·전환 전용)
- **Style:** 알약, 흰 바탕, 14px·650, 최소 44px. 버튼과 섞어 쓰지 않는다.
- **State:** 선택은 연한 오렌지 바탕(#FFF3EB)+진한 오렌지 글자·테두리. 네이티브 컨트롤 동작 유지.

### Cards / Tiles / Rows
- **Corner Style:** 타일·독립 카드는 8px, 1px `--line`, 흰 바탕. 목록 행은 둥글게 하지 않는다.
- **Background:** 평상시 흰색(또는 투명 행), 호버에서 옅은 면. 작업 행에 resting 그림자 없음.
- **목록 어휘 (실제 구현):** 행사 디렉토리 `eventCard`는 플랫 행이다(radius 0·하단선, 좌측 identity 영역 + 8px 도트 `::before`, `console-home.module.css:650-661/761-770`). 프로그램 `moduleCard`도 플랫 행이다(border-bottom·radius 0·투명, `programs.module.css:10-18`). 데이터(명단·보고서·활동)는 헤어라인 행(`recordRow`, `console-ui.module.css:733-744`)으로 읽는다. 모든 화면을 카드 더미로 만들지 않는다.

### Inputs / Fields
- **Style:** 흰 바탕, 1px `--line-strong` 테두리, 8px, 최소 44px, 패딩 8px 12px. 체크박스 시각 20px+오렌지 악센트(`globals.css:121-127`); 실효 타깃 44px는 라벨 행이 보장한다(`checkRow`·동의 라벨 `globals.css:943-949`).
- **Focus:** 3px 링 + 캐럿 `#AA3A10`. 오류는 빨간 테두리+빨간 도움말.
- **Error / Disabled:** 오류 패널은 soft 배경+line 테두리. 비활성 0.55–0.6.
- **수신자 일괄 선택:** 명단의 선택 체크박스는 현재 표시된 대상만 더하거나 해제하고, 일부만 선택된 상태를 표시한다. 다른 필터에서 고른 대상은 유지하며, 전체 선택 해제는 별도 행동으로 둔다.
- **선택 방식과 범위:** 한 번의 발송에서 채널 하나를 고르는 곳은 라디오, 여러 참가자를 고르는 곳은 체크박스를 쓴다. 일괄 행동마다 현재 필터와 필터 밖 선택을 포함한 실제 대상 수를 행동 바로 옆과 발송 전 검토에 표시한다.

### Navigation
사이드바 옅은 면(#FAFBFC), 항목 14px·550, 20px 선형 아이콘, 호버 옅은 면, 활성은 연한 오렌지(#FFF0E6)+진한 오렌지 글자. 활성 표시 막대·굵은 외곽선은 쓰지 않는다. 모바일은 상단 레일+320px 이내 드롭다운 메뉴, 44px 바닥 유지.

### Feedback / Status
폼 피드백·상태 칩·알림 스트립은 4색 soft/light/진한 글자 조합을 그대로 쓴다. 칩은 알약+700, 스트립은 8px+도트. 조용한 도움말은 패널로 올리지 않는다.

### Dialog / Print
다이얼로그는 최대 640px(넓게 960px), 흰 바탕+1px 선, 그림자 없음(`globals.css:2433-2443`), 포커스 트랩·Escape·스크롤 잠금은 컴포넌트 소유. 인쇄는 편집 크롬·툴바·내비를 숨기고 보고서 스냅샷·표·명찰만 남긴다.

## Do's and Don'ts

### Do:
- **Do** 흰 바탕·얇은 선·열린 구획으로 목록/작성/검토 위계를 만든다.
- **Do** 작업·영역당 주 행동에만 채움 오렌지를 쓰고 나머지는 Secondary·Quiet로 낮춘다.
- **Do** 모든 폭에서 44px 터치 바닥과 포커스 링을 지킨다.
- **Do** 고객 배너·게시된 참가자 스타일(#B9DEF0 기본)은 이벤트 독립 콘텐츠로 보존한다.
- **Do** 움직임은 120–200ms ease-out 상태 전환으로만 쓴다(`prefers-reduced-motion` 전체 차단 포함).
- **Do** 출처: `apps/web/app/tokens.css`, `apps/web/app/globals.css`, `apps/web/app/console/console-ui/console-ui.module.css`, `server/attendee-home-style.js`, 참고 패턴 Attio/Linear/Mailchimp(브랜드 자산 복제 금지).

### Don't:
- **Don't** 검정 크롬·명조·2px 반경 카드·그라디언트·글래스를 부활시키지 않는다.
- **Don't** `--stage-*`·`--ref-*`를 콘솔 근거로 쓰지 않는다(전광판·참가자·고객 레퍼런스 전용).
- **Don't** 섹션·카드를 중첩하거나 resting 그림자를 얹지 않는다.
- **Don't** 필(pill)과 버튼을 같은 행에서 같은 말로 쓰지 않는다(조회 vs 확정 구분).
- **Don't** 오프라인 캐싱·체크인 큐·실발송·실기기 검증을 약속하지 않는다(미지원·미검증).

## Workflow surfaces

행사 메뉴는 운영 / 현장·참여 / 행사 준비 / 결과의 네 그룹으로 항상 펼친다.
추첨·투표와 경품 수령은 현장·참여에 둔다. 같은 화면에서 탐색을 위해 다른 허브를
먼저 열게 하지 않는다. 모바일 전역 메뉴는 같은 목적지를 모두 표시한다.

공지·일정·장소, 데스크·전광판·부스·배정, 추첨 유형, 보고서·마감은 실제 작업 탭이다.
표시하지 않는 패널은 마운트 상태를 유지해 작성 값·미확인 요청을 보존한다.
참가자 페이지 편집처럼 동시 비교가 필요한 곳은 섹션 앵커를 유지한다. 앵커는 밑줄과 목차 안내로 구역 이동임을 드러내며, 탭의 패널 전환과 구분한다. 이동한 제목의 포커스와 복사 가능한 주소 조각은 보존한다.
명단 상세는 1200px 이상에서 비모달 우측 패널, 좁은 화면에서는 포커스를 가둔 모달이다.

참가자 홈의 티켓은 전체 폭의 첫 행동이며 안내와 참여를 구분한다. 고객이 게시한
배너·배경·문구는 그대로 사용한다. 참여 콘텐츠는 제목과 제출 상태를 먼저 보여 주고
필요한 폼을 펼친다. 5점 척도는 320px에서도 한 줄의 44px 목표를 유지한다.
스태프 화면은 처리 위치·스캔·코드 입력을 우선하고 계정과 조직은 짧은 문맥으로 둔다.
기본 제약 오류는 공통 ValidatedForm이 한국어로 설명하고 첫 오류에 초점을 보낸다.
세부 동작과 컨트롤의 소유자는 UX-CONTRACT.md를 따른다.

운영 현황은 입장 진행과 지금 할 일을 첫 줄에 두고, 행사 일정·최근 입퇴장·접힌 기간 분석 순으로 읽는다. 지표의 분모를 짧게 설명하고 중복 상태·갱신 버튼·보고서 링크는 줄인다. 당일 큐시트와 다른 행사일의 예정 일정을 중복 표시하지 않는다.

진행 중 개요는 입장 진행과 지금 할 일을 같은 폭과 제목 높이로 시작한다. 입장 지표는 옅은 중립 면에 누적 입장 인원과 입장률을 나란히 놓고, 그 아래에 진행 막대와 집계 기준을 표시한다. 현장 운영 링크는 입장 제목 옆에 둔다. 지표 아래에서는 확정자 중 미입장 명단, 참가 확정 명단 순으로 행 전체를 링크로 제공한다. 넓은 화면에서는 입장 지표와 첫 업무에 같은 최소 높이를 주고, 긴 업무 설명은 필요한 만큼 펼친다. 할 일 제목 옆에는 항목 수를 표시한다. 첫 업무가 승인 대기나 지연된 예약 확인이면 그 이동 링크에 오렌지를 쓴다. 좁은 화면에서는 입장 진행 아래에 할 일을 배치한다.
명단의 데스크톱 행은 44px 컨트롤을 유지하면서 셀의 수직 여백을 줄여 비교할 수 있는 기록 수를 확보한다.

행사 생성은 행사명·날짜로 먼저 시작한다. 주소는 자동 제안하고 고객사·시간·정원·진행 형태·주소 편집은 ‘추가 설정’에 둔다. 기존 시간 기본값을 접힌 요약에도 표시하며, 오류가 접힌 필드에 있으면 펼쳐 초점을 이동한다. 복제·고객사 등록과 미확인 요청의 보호는 같은 다이얼로그에 유지한다.

저장할 소수의 고정된 단일 값은 native radio로 펼쳐 비교하고, 복수 선택은 체크박스로 구별한다. 동적이고 긴 목록은 기존 select, 작업 이동은 탭·링크, 실행은 버튼을 유지한다. ConsoleChoiceGroup을 재사용하며 상세한 업무별 기준은 UX-CONTRACT.md가 정본이다.

모바일 목록 도구는 충분한 폭에서 짧은 상태 필터와 검색을 한 줄에 두고, 같은 작업의 만들기·새로고침을 나란히 둔다. 좁은 폭에서는 자연스럽게 줄바꿈하되 44px 조작 높이를 지킨다.
브라우저 기본 표시가 가려지는 접이식 작업 영역은 공통 펼침 표시로 열림·닫힘을 드러내고, 실제 동작과 키보드는 네이티브 details가 소유한다.

명단의 선택 작업은 별도 펼침 없이 짧은 버튼 행으로 표시한다. 명단 가져오기는 참가자 명단에서 여는 모달이며 파일·열 연결·검토의 현재 단계만 보인다. 메시지 작성도 수신자·내용·검토와 발송의 세 단계로 나눈다. 데스크톱의 내용 입력과 수신 예시는 나란히 두고 좁은 화면은 위아래로 쌓는다. 단계가 바뀌어도 마운트된 입력을 보존한다.

메시지의 발송 기록과 템플릿 관리는 공통 작업 탭으로 분리한다. 작성 중 템플릿 관리로 이동해도 본문·수신자·사진을 유지한다. 보내는 방법은 문자와 카카오 알림톡의 두 계열로 비교한다. 문자 유형은 치환 후 길이와 첨부 사진에 따라 결정하며 SMS/LMS/MMS를 직접 고르게 하지 않는다. 알림톡 예시는 별도 채널 토큰 `message-kakao-header`를 사용한 노란 머리와 흰 본문으로 구분하며 콘솔의 주 행동색은 오렌지를 유지한다. 예시는 가상 수신 정보만 사용한다.

템플릿 목록과 편집기는 넓은 화면에서 나란히, 좁은 화면에서는 목록 다음 편집기로 쌓는다. 작성한 본문을 다른 템플릿으로 교체할 때는 적용과 현재 내용 유지 중 선택한다. 개인화 정보는 입력 위치에 넣는 짧은 행동 버튼으로 제공하며 길이 제한을 넘으면 본문을 자르지 않는다. 직접 본 화면의 작업 구분 참고: [Klaviyo 작성 영역](https://mobbin.com/screens/3d1f5b33-f01c-4abc-bd9a-7cdee2509095). 문자 유형 기준은 [SOLAPI 안내](https://solapi.com/guides/sms)와 현재 서버의 치환 후 분류를 따른다. 참고 제품의 이메일 기능이나 외형을 복제하지 않는다.

템플릿 목록은 이름·내용 검색과 사용 중/보관됨/전체 필터를 같은 도구 행에 둔다. 본문 편집과 검색 상태를 분리하고, 다른 템플릿 편집이나 새 작성으로 초안을 비울 때 확인한다. 사용·편집·보관은 각 행에 드러내고 보관된 문구는 복원한 뒤 사용한다. 목록이 스크롤될 때는 목록 자체에도 키보드로 진입할 수 있다. 검색 행과 조밀한 목록은 직접 본 [Customer.io 메시지 라이브러리](https://mobbin.com/screens/91cc29d4-4304-4dc7-a1fd-c5988c287505), [HubSpot 템플릿 목록](https://mobbin.com/screens/0e0c23a9-330a-46fa-a7ac-0711788b7b1b)을 참고했다. 보관·예약 보존 규칙은 EVENTOUCH의 이력 보존 계약에 따른 설계이며, 참고 화면에서 확인한 기능으로 주장하지 않는다.


### 콘텐츠의 초안과 게시 검토

공지·프로그램 일정·장소 안내는 작성 → 초안 저장 → 게시 검토 → 게시의 순서로 진행한다.
현재 게시본은 초안 저장으로 바뀌지 않는다. 목록은 저장된 초안을 보여 주고, 게시 중인
항목에 수정 초안이 있으면 그 차이를 표시한다. 상단 고정도 초안에서 편집하고 함께 게시한다.

최종 검토는 공통 `PublicationReview`가 맡는다. 현재 게시본과 반영할 내용을 같은 표에서
비교하며 바뀌는 항목을 먼저 보여 주고 변경 없는 항목은 펼쳐서 확인한다. 바뀐 값은 브랜드 텍스트 색과 굵기로 강조한다. 반영 위치는 한 개의 연한 면에
모으고 각 위치의 현재 화면을 새 창으로 열 수 있게 한다. 표시 설정이나 홈 메뉴가 숨김이면
게시 후에도 보이지 않는 이유를 안내한다. 이미 선택된 전광판 공지는 게시 시 출력 내용도
바뀐다는 점을 표시한다. 게시 내리기는 별도 검토이며 초안을 지우지 않는다.

참가자 페이지의 디자인도 같은 검토를 사용하되, 홈의 배너·제목·메뉴와 행사 안내의 소개·
표시 설정을 구분한다. 공지·일정의 내용 게시와 페이지 디자인 게시를 혼동하지 않게 한다.
좁은 화면에서는 비교값 두 열을 유지하고 제목과 확정 버튼을 고정해 긴 본문을 스크롤한다.

직접 본 [Kajabi 게시 확인](https://mobbin.com/screens/e1f914d5-3f7c-4509-b4c4-0fa58fceabda)과
[beehiiv 검토·게시](https://mobbin.com/screens/2db03188-943e-4176-bf6c-ef9e761e9ccd)에서
게시 직전 반영 위치·대상을 드러내는 구성을 참고했다. 해당 서비스의 발송·예약 기능을
추가하는 근거로 삼지 않는다. 현재 적용·검증은 `docs/STATUS.md`를 따른다.


### 참여 콘텐츠의 준비와 현장 진행

운영자 메뉴의 **공지·안내**는 공지·프로그램 일정·장소 안내를, **참여 콘텐츠**는
투표·퀴즈·Q&A·사진·게시판을 소유한다. 참여 콘텐츠는 행사 준비 그룹에 둔다.
현장 운영의 **참여 진행**은 검토할 응답과 진행 중인 콘텐츠를 보여 주고 기존 관리
화면으로 연결한다. 별도 편집기나 두 번째 처리 경로를 만들지 않는다. 무대 추첨·순위
투표·룰렛은 기존 추첨·투표 화면에서 관리하며, 선택형 투표·간단 추첨과 명칭을 구분한다.

운영 현황의 ‘지금 할 일’은 실제 미처리 항목을 표시한다. 답변과 승인이 모두 필요한
질문은 전체 질문 수에서 한 번만 센 뒤 미답변·승인 대기·수정안을 설명한다. 기능을
끄면 작업 링크를 숨기되 데이터를 지우지 않는다. 항목 사이에만 구분선을 둔 공통
업무 목록을 사용하며 할 일이 없을 때 빈 상태를 명확히 표시한다.

검토 링크는 최신 작업공간을 읽은 뒤 해당 목록·필터를 열고 실제 항목에 포커스를
옮긴다. 앞 페이지 뒤에 있는 콘텐츠도 찾아갈 수 있으며 작성 중인 답변을 지우지 않는다.
목적지는 허용한 읽기 조건만 받아 한 번 소비하고, 없거나 잘못된 대상은 최신 목록으로
안내한다. 이동만으로 저장·승인·시작하지 않는다. 처리 후 원래 운영 현황이나 참여
진행으로 돌아갈 수 있게 한다.

직접 본 [Eventbrite 행사 홈](https://mobbin.com/screens/944144ab-7283-47b6-be15-bee973984035)의
행사 맥락과 할 일 구분, [Sweatpals 체크인](https://mobbin.com/screens/a12748ab-e2c1-407b-8625-8b1ba6f1db0b)의
준비와 현장 진입 구분을 구조 참고로 삼았다. 과금 지표나 해당 서비스의 실제 처리
성능을 EVENTOUCH에 대한 근거로 사용하지 않는다. 현재 검증 결과는 `docs/STATUS.md`를 따른다.


### 메시지의 대상과 승인 문구

수신자 상태와 기존 참가자 그룹을 함께 고른다. 표시된 대상 전체 선택은 현재 조건에만
작용하며 다른 그룹에서 선택한 사람을 지우지 않는다. ‘선택 대상만 보기’는 조건에 관계없이
선택한 전원을 검토하는 모드라고 설명한다. 작성·검토 단계에서는 현재 필터 대신 실제
선택한 수신자의 이름 또는 그룹·인원·상태를 명확한 한 줄과 보조 줄로 보여 준다.
‘수신자 변경’은 이 선택을 유지하고 대상 단계로 돌아간다.

알림톡은 선택한 등록 템플릿의 문구를 읽기 전용으로 쓰며 개인화 정보만 자동 치환한다.
이전 발송의 문구가 현재 템플릿과 다르면 현재 승인으로 간주하지 않고 다시 선택해
명시적으로 적용하도록 한다. 템플릿의 승인 ID·내용은 외부 승인본과 맞춰 관리한다.
받는 화면은 문구 예시이며 실제 채널명·버튼·이미지를 추정해 그리지 않는다.
기존 알림톡의 문자 대체 발송 동작은 보내는 방법과 실제 발송·예약 실행·재시도 검토에서
함께 설명한다. 모의 기록을 실제 대체 발송이나 요금 발생으로 안내하지 않는다.

본문 옆에는 원문 길이를 표시한다. 개인화가 있으면 수신자별 최종 길이와 유형이 달라짐을
알린다. 공급사는 치환이 끝난 텍스트로 단문·장문과 제한을 판단하며, 본문을 조용히
자르지 않는다. 사진 없는 이전 MMS를 불러오면 문자 자동 분류로 전환하고 사진 재첨부를
안내한다. 사진이 있는 MMS와 기존 예약의 원래 내용은 보존한다.

기준: [SOLAPI 문자 계산](https://solapi.com/developers/api/messages-sms),
[메시지별 제한](https://solapi.com/developers/api/messages),
[템플릿 내용 불일치 안내](https://guide.solapi.com/e8af535f-f3ca-4573-bdd3-be41a1d37f70).
외부 승인·실제 수신 검증과 격리 모의 기록을 구분한다.


### 상태 전환의 글자 대비

주요 버튼은 배경과 글자색을 같은 순간에 바꾼다. 밝은 주황 위의 진한 글자와 어두운
주황 위의 흰 글자 사이에서 배경만 보간하지 않는다. 콘솔 버튼과 공개 첫 화면의 시작
버튼에 같은 규칙을 적용한다. 누름 이동과 테두리 전환은 유지할 수 있으며 실제 호버
진입·이탈 프레임의 글자 대비를 확인한다. reduced motion에서도 동작 의미를 보존한다.

좁은 화면의 명단 도구 팝업은 전체 작업 줄을 기준으로 화면 안에 배치한다. 가운데의
작은 요약 버튼에 우측 정렬해 메뉴의 왼쪽이 잘리지 않도록 한다. 열린 상태에서 항목
각각의 위치와 터치 영역을 확인하며, 페이지 가로 넘침 검사만으로 대신하지 않는다.

보관 행사와 쓰기 권한이 없는 메시지 화면은 새 작성·템플릿 적용·저장을 비활성화한다.
현재 화면에 남은 초안은 ‘작성 내용 보기’로 구분하고 수신자·내용·검토를 읽기 전용으로
살펴볼 수 있게 한다. 템플릿도 ‘내용 보기’를 제공하며 단계 이동까지 잠그지 않는다.
보관 완료와 읽기 전용 설명을 한 상태 안내로 모아 같은 상태를 여러 배너로 반복하지 않는다.
