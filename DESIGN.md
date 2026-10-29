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
**The Whitewash Ban.** 고객 확정 배너와 게시된 참가자 홈스타일을 공통 화이트로 덮지 않는다. 참가자 홈 기본 배경(#B9DEF0)과 대표·보조 문구·배치·덮개 선택은 `server/attendee-home-style.js`가 정본이며 이벤트별 독립 콘텐츠다.
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

콘솔 셸은 232px 고정 사이드바 + 유동 작업면(`232px minmax(0,1fr)`), ≤1024px에서 216px로 좁아진다(`globals.css:3534-3538`). 본문 최대 1200px 중앙 정렬이다. 섹션은 공유 `ConsolePage`·`ConsoleSection` API로만 쌓고, 감싸는 카드 안에 카드를 중첩하지 않는다. 편집 단위는 폼 폭(읽기 760px·입력 640px)으로 스스로 좁히고, 목록·테이블은 전체 폭을 쓴다.

모바일(≤768px)에서는 사이드바가 상단 레일로 접히고(메뉴·브랜드·프로필), 작업면은 단일 열로 쌓인다. 툴바는 필터와 관련 액션을 구분하고 좁은 폭에서는 자연스럽게 줄바꿈한다. 터치 바닥 44px, 입력 최소 높이 44px은 모든 폭에서 유지한다.

폭 토큰: 내용 1200px·읽기 760px·폼 640px·티켓 480px·전광판 1800px. 간격 리듬 s1–s8(4·8·12·16·24·32·48·64px).

예외 모듈: 명단은 행 선택+툴바(검색·필터 좌, 액션 우, 선택 요약 별도 행), 메시지는 이력·작성·검토 분리 워크스페이스, 개요는 운영 숫자·할 일·일정, 설정은 폼 스택, 페이지 편집기는 초안/게시+휴대폰 미리보기, 보고서는 동결 스냅샷+인쇄, 스태프는 단일 열+카메라 보조, 초대·로그인은 380px 중앙 단일 열, 랜딩은 읽기폭 히어로+3/2열 그리드다.

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
- **익숙한 도구 아이콘:** 공통 선형 SVG를 쓰고, 모바일 메뉴와 참가자 페이지 옆 복사처럼 맥락이 명확한 곳에만 아이콘 전용 버튼을 둔다. 동작별 접근 가능한 이름·44px 터치 면적·포커스를 제공하고, 복사는 성공과 실패 및 복구를 글자로 알린다. 맥락이 모호한 도구와 발송·삭제 등 중요한 동작은 이름을 눈에 보이게 둔다.

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
