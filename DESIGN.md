---
name: EVENTOUCH
description: 밝은 작업면에서 행사를 끝까지 운영하는 행사 운영 SaaS
colors:
  brand: "#EA552E"
  brand-hover: "#C7441C"
  brand-pressed: "#A93917"
  brand-text: "#8E351F"
  on-brand: "#19191C"
  on-brand-hover: "#FFFFFF"
  brand-soft: "#FFF1E8"
  brand-tint: "#FDEEE4"
  ink: "#1E2026"
  muted: "#61656C"
  line: "#E5E5E7"
  line-strong: "#8A939F"
  paper: "#FFFFFF"
  ground: "#FFFFFF"
  workspace-ground: "#FFFFFF"
  surface-muted: "#FAFAFB"
  nav: "#FAFBFC"
  nav-hover: "#EFF1F4"
  nav-active: "#FFF0E6"
  nav-text: "#1E2026"
  nav-muted: "#61656C"
  side: "#101114"
  side-line: "#34363B"
  side-text: "#FFFFFF"
  side-muted: "#A9AEB6"
  side-hover: "#FFFFFF14"
  side-active: "#FFFFFF1F"
  side-scroll: "#FFFFFF33"
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
  focus: "#2453A6"
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
  console-headline:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  console-headline-mobile:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  console-section-title:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.4
  console-context:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
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
  lg: "12px"
  xl: "16px"
  card: "18px"
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
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-brand-hover}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-pressed}"
    textColor: "{colors.on-brand-hover}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  pill:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  pill-active:
    backgroundColor: "{colors.brand-tint}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.side-muted}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "{colors.side-active}"
    textColor: "{colors.side-text}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  ledger-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "12px 0"
  feedback-error:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  feedback-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  status-chip:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# EVENTOUCH design direction

The YAML frontmatter is the design-tool input; `apps/web/app/tokens.css` is the runtime token source. Keep those inputs aligned when token values change.

Use a light, calm operations-service vocabulary with restrained orange accents as a reference. The console's ink command rail contrasts with the white workspace; mobile navigation and account popovers use legible dark text on white. A screen's task, role, current user request, and feedback determine its structure and density; this reference does not prescribe a shared layout for every screen. A pattern proven on one screen is a reference, not a rollout mandate — do not propagate one screen's accent, density, or card treatment to all surfaces.

Preserve EVENTOUCH's Korean-language identity and customer-approved banners and published attendee styles. Do not flatten event-specific content into shared defaults. Keep keyboard access, focus, readable status, and recovery visible. Check real device behavior with [the device checklist](scripts/device-checklist.md).

Stable interaction and data-safety behavior belongs in [UX-CONTRACT.md](UX-CONTRACT.md); proposal-specific acceptance belongs in [docs/CONTRACT-SCOPE.md](docs/CONTRACT-SCOPE.md).

## Action role rules (read before any UI work)

The owner's recurring complaint is a screen full of identical white bordered buttons and boxes. Astryx templates and the "Badge = counts only" rule in `apps/web/AGENTS.md` describe structure and token use; they do not decide visual role. Visual role follows this table, which wins on conflict.

| Role | Variant | Use | Limit |
|---|---|---|---|
| Main action | `primary` (orange) | The one thing the operator must do on this screen or step | One per screen or dialog section |
| Supporting action | `secondary` (white, bordered) | Real alternatives of similar weight | Never the default for everything |
| Utility / disclosure | `ghost` (text, no box) | Show/hide, reset, filters, "more", contextual navigation | Keep a 44px touch target |
| Destructive | `destructive` | Cancel, delete, withdraw | Always behind a confirm |
| Status | chip with color plus shape | Stage, readiness, counts with context | Not a button |
| Row data | ledger row | Lists of records | Not card-wrapped lists |

Every `ProductButton` states its role with `variant`; the `button-*` legacy classes are not a role. When a screen has more than a few secondary buttons, ask which are really utilities and move them to `ghost`. `tests/web-button-roles.test.cjs` holds the per-file secondary ceiling.

## 운영 현황 확정 구성

The owner approved this composition on 2026-11-13 (`apps/web/app/console/events/[id]/EventOverview.tsx`). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-event-overview-priority.test.cjs` ("approved overview design stays locked") guards it.

- Header: one stage pill. Intake state and D-day read as plain text, not chips.
- 기간 분석 (owner decision 2026-11-18, option A): the collapsible period block is gone. The bottom of the page keeps one line (today's applications and entries, last-7-day applications, "기간 분석 보기 →"); the analysis itself is its own screen in the 결과 group (`analysis/PeriodAnalysisWorkspace.tsx`): period buttons (오늘·어제·최근 7일·행사 전체·직접 선택), three totals, one bar chart, a daily table, and a "집계 기준" note behind a button. The date inputs appear only under 직접 선택.
- Phone header (owner decision 2026-11-18): the open-page link and copy are icons on the title row, and the check time (prefix dropped) sits at the right end of the stage row, so the header stays three rows tall instead of adding an action row under it.
- Entry progress: the bar and the rate are ink, not orange. Below the bar sit one legend (입장 / 확정자 중 미입장) and one "명단 보기" link. The live and finished summaries share this block. The default basis lives in the bar's accessible name; visible basis copy appears only during cancellation review. Archived events link to the confirmed roster.
- One primary per page. During live, "현장 운영 열기" owns it and the task queue adds none. Archived pages have none.
- Utilities are ghost links: the stage band's "진행 단계 설정" and the four readiness links. The stage band and readiness rows are not white boxes.
- An empty schedule slot keeps the height of its sibling card.
- 최근 입퇴장 is a timeline: time, then a rail dot (in = green, out = ink outline, other = muted), then details.

## 참가자 명단 확정 구성

The owner approved this composition on 2026-11-13 (`apps/web/app/console/events/[id]/participants/ParticipantList.tsx`, option A "조용한 명단"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-participant-roster-presets.test.cjs` guards it.

- One flat ledger: no card box around the controls or the list. Hairlines divide; the header row and pagination share the page surface.
- Status views are ink-underline tabs. The active tab is ink, not orange.
- "참가자 추가" is the only orange action. 명단 가져오기, 명단 도구 and pagination are ghost.
- The scope action "필터 결과 전체 N명 선택" lives only inside the ink selection bar, so no caption row sits above the list.
- A whole row opens the detail dialog; a chevron replaces the "상세" text. Checkbox, "승인" and other inline buttons never trigger it. "승인" appears only on PENDING and WAITLIST rows.
- Mobile rows are two lines: name, then company, group and presence. The phone number stays in the detail dialog.

## 현장 사진 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/photos/`, option A with a Google-Photos-style gallery). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-photos-composition.test.cjs` guards it. This is the agency's own evidence archive (8 shooting sections, per-section ZIP), separate from attendee photos.

- Top: total photos and an 8-segment coverage bar ("8구간 중 N구간") with the empty sections named in amber. Below it the 8 sections are tiles that show a cover photo (dashed with a "비어 있음" note when empty); one pressed tile group picks the section on every width (no mobile-only select).
- The gallery is justified rows (`EvidenceGallery.tsx`, `planRows`): every row has the same height and every photo keeps its own ratio (no crop, no letterbox); the last row keeps the target height and a lone panorama is capped. Stored `width`/`height` lay the rows out first; a photo with no stored size holds a 4:3 slot. Phone portrait JPEGs carry an EXIF rotation flag: since 2026-11-18 the server reads it at upload (`server/image-metadata.js`, Orientation 5-8 swaps the stored width and height; a damaged EXIF block is ignored), so new uploads are stored at the size the browser shows. Photos stored earlier are not rewritten, so the gallery still lets the ratio the browser really shows replace the stored one when an image loads.
- A photo is a button that opens a viewer drawer (`ConsoleDialog presentation="drawer"`): large photo, 이전/다음 (and arrow keys), file name and time, 원본 다운로드, 보관 구간 변경, 보관함에서 제외, each behind the existing confirmation. After a move or removal the viewer shows the neighbour or closes.
- "사진 올리기" is the one orange action; "＋ 사진 추가" ends the gallery; dropping files anywhere on the gallery works. Upload preview, upload history and retry notices keep their existing places and rules.

## 경품 지급 현황 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/rewards/`, option V1). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-rewards-composition.test.cjs` guards it. This is the operator oversight list (blocked prizes, missing recipients, uncertain outcomes); handing a prize to a person at the venue belongs to the staff exit desk.

- One bordered summary card: a progress ring (지급 완료 / 취소 제외 전체) and three tinted status tiles (확인 필요 red, 지급 대기 amber, 수령 완료 green). Tiles filter the list; underline tabs with counts carry the same filter. Search appears only when there are more than 8 prizes or a query.
- The ledger reads by urgency: 확인 필요 → 지급 대기 → 완료·취소. A row leads with the recipient's initial in a circle (a dashed "?" while a company win has no recipient); a small corner badge carries the state by shape (alert, clock, check, x). Reasons are icon pills (수령자 지정 필요, 참가 취소, 연결 필요, 지급 실패), the method is an icon.
- 수령 처리 is an ink pill on clean 지급 대기 rows only; a blocked prize shows its reason and a soft link (추첨에서 수령자 지정, 참가자 명단에서 확인) instead. 경품 취소 sits in the expanded row, behind the existing confirmation.
- The page title and rail label are "경품 지급 현황" (owner decision 2026-11-18, renamed from "경품 수령" because this is an oversight screen, not the handout desk). The in-page list region is named "경품 지급 목록" so the heading and region never share a name. 수령 처리 stays the name of the action.
- 운영 현황 shows one quiet task-queue row, "경품 확인 필요 N건", only while the 경품 feature is on and the count is above zero. It is appended after the other rows so it never takes the single orange action, and it links here. The count comes from the same `lib/reward-status.ts` rule as this screen. The 운영 현황 composition otherwise does not change.

Reopened 2026-11-19 (owner: 얇은 선·작은 글씨·필터가 다른 버튼과 같아 보임). 구성(요약 카드 → 긴급도 순 원장)은 그대로, 표현을 보강했다. 이 항목이 위 설명과 다르면 이 항목이 우선한다.
- 상태 타일은 큰 숫자(40px)와 전체(취소 제외) 대비 비율 막대를 가진다. 선택하면 같은 색 외곽선, 0건이면 회색.
- 상태 탭의 건수는 알약 칩이고 선택된 탭의 칩은 잉크 채움이다. 검색창은 돋보기 글리프가 있는 둥근 입력이다.
- 그룹 제목은 상태색 원형 마크, 굵은 제목, 오른쪽 큰 건수와 상태색 2px 밑줄이다. 행은 헤어라인으로 나뉘고 경품명이 18px로 커졌다.

## 추첨·투표 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/draws/`, "미리보기 무대"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-draws-composition.test.cjs` guards it.

- One stage card, then a flat picker ("무대 선택") of the four jobs: each stage draw program, 순위 투표, 모바일 룰렛, 럭키번호. No jump tabs, no stack of section panels. Pressing a row swaps the card; `#draws-vote`, `#draws-roulette`, `#draws-lucky` and `#draw-program-<id>` select that item.
- The card's top is a preview of what the audience really sees: stage draws show the venue-screen scene (violet and gold, from `screen/[slug]/draw-stage.module.css`); vote, roulette and lucky show the attendee phone card. The preview (`StagePreview.tsx`) is a decorative redraw: it loads nothing, runs nothing and must be updated when the real screens change. The venue screen has no vote, roulette or lucky scene today, so those use the phone.
- Under the preview: facts (state kicker, name, one meta line, big number and gauge) on the left, actions on the right. The single orange action is the run button ("N명 추첨 실행") beside a large stepper; 무대 터치 실행 is secondary; 결과 공개 is a switch; 설정 수정, 운영 시작·종료·다시 열기 are ghost.
- Program create/edit settings open in a dialog (`추첨 프로그램 만들기` in the page header); vote, roulette and lucky settings stay as their existing forms folded under the card. Every blocker line, confirmation, recovery notice and permission lock is unchanged.

Reopened 2026-11-19 (owner: 같은 흰 버튼·얇은 선, 무대 선택이 화면 맨 아래). 이 항목이 위 설명과 다르면 이 항목이 우선한다.
- "무대 선택"이 카드 위로 올라왔다: 잡 하나가 아이콘·이름·진행 막대·큰 숫자를 가진 카드이고 선택된 카드는 잉크 2px 외곽선이다. 폰에서는 옆으로 스크롤한다. 카드를 누르면 아래 무대 카드가 바뀌는 동작과 앵커(`#draws-vote` 등)는 그대로.
- 1200px 이상에서는 무대 카드가 왼쪽 청중 화면 미리보기(스크롤 시 고정)와 오른쪽 "지금 할 일"로 나뉜다. 실행 영역은 옅은 회색 패널 안에 있고 실행 버튼이 유일한 오렌지다.
- 실행 전제·무대 터치 전제는 흰 버튼 모양이 아니라 앰버 왼쪽 띠 알림이고, 연결 링크는 밑줄 텍스트다. 당첨자는 잉크 원 순번과 함께 카드 행으로 보인다.

## 참여 콘텐츠 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/programs/`, review drawer with the merged answer card). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-programs-composition.test.cjs` guards it.

- One flat ledger grouped 진행 중 / 준비 중 / 종료. A row is a type tile (own glyph and tint, state dot on its corner), the name, one quiet line, an optional thin meter (poll shares, quiz rate, Q&A/photo public ratio) and one number. No type or state pills, no per-row hairlines.
- "콘텐츠 만들기" is the only orange action. 시작 / 다시 열기 sit at the row end; 종료 and 편집 live in the expanded row, which shows results inline (no second fold).
- Everything attendees sent that needs a decision (questions without an answer or approval, pending photos and posts) sits behind one amber line, "검토할 것 N", that opens a modal drawer (right edge on wide screens, bottom sheet on phones; `ConsoleDialog presentation="drawer"`). A question needing both counts once. Pending question edits are decided in the content's own list.
- Answer card: asker, question bubble, one reply field with an ink send circle ("답변하고 공개"), quiet "답변만 저장". Questions have no reject action. No nested bordered boxes beyond bubble and field.
- Drawer rows use `review-*` ids; list rows keep `moderation-*`. Recovery banners close the drawer so they are never behind the scrim.
- Search and status tabs appear only for long lists (more than 8) or while a filter is active.

## 공지·안내 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/content/`, option C: an always-on attendee phone). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-content-composition.test.cjs` guards it. This is where notices, the schedule and the venue guide that attendees read are written; draft, publish review and unpublish rules are unchanged.

- Every attendee-facing authoring screen keeps a live phone beside the work. Here the phone is the page's one framed object (`ContentPhonePreview.tsx`, sticky on wide screens; "크게 보기" and, on narrow screens, "폰으로 보기" open a full-view stage on a dark scrim, fitted to the room, and on a real phone the screen fills the viewport edge to edge with no frame; there is no bottom sheet). Its tabs (홈 · 공지 · 일정 · 장소) follow the active tab and can look at any screen. It is laid out at a real 390px phone width and scaled as a whole.
- The phone reads the published 참가자 페이지 design: 홈 is the real `AttendeeHomeLanding` (background, banner, menu order), 일정 uses the public program timeline and its date filter. 공지 and 장소 share the public event page’s presentation styles. It shows what attendees see (published items) plus the item being edited, drawn from the live draft and outlined; an unpublished edit says "게시 전 · 초안 미리보기"; a section hidden in 참가자 페이지 says so. "바꾸기" links to 참가자 페이지.
- Ink tabs 공지 · 일정 · 장소 안내 (the schedule tab was "프로그램 일정", which collided with 참여 콘텐츠) over one flat ledger per type: state dot (green 게시 중, amber 수정본 있음, hollow 비공개), title with a one-line summary, quiet meta (★ 고정, PDF, status text). The row opens the editor; rows carry no buttons. Old `#content-notices`, `#content-program`, `#content-venue` links select the matching tab.
- Editors open in place of the ledger (not a modal): a quiet crumb (‹ 공지 / ‹ 일정; pressing the open tab again does the same), the item's title as the heading with its state dot, fields, then actions. The editor stays open after 초안 저장 on the saved item. The one orange action moves between 초안 저장 (unsaved or new) and 게시 검토 (saved with changes); 게시 검토 and 게시 내리기 need a saved draft; 전광판 출력 and 삭제 keep their confirmations. The venue tab is one always-open form.
- The notice body is a rich editor (Tiptap in `RichEditor.tsx`, external library, not hand-built) on a deliberately small schema: bold, italic, bullet and numbered lists, links, pictures. It is stored as Markdown in the existing `body` field (3000 characters including marks), so an old plain-text notice opens and reads unchanged. A picture is an uploaded event file written `![alt](file:<id>)`; phone photos shrink in the browser to the 600KB limit before upload; the server checks every reference is this event's image (6 per notice) and the public file route serves exactly the pictures in published notices. `lib/rich-text.ts` parses the subset to data and `ui/RichText.tsx` renders it with no HTML injection (links only http(s)/mail/phone); the event page and attendee home render it, the venue board shows words only. The 게시 검토 comparison still shows the raw Markdown text.
- The header carries one orange add action for the open tab (공지 작성 / 일정 추가) and hides it while that tab's editor is open.

## 참가자 페이지 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/page/`, the studio; `apps/web/app/event/[slug]/home/`, the compositions). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-home-layouts.test.cjs` guards it. This is the core product screen for event agencies: they pick how the attendee home looks.

- The attendee home takes one of three compositions (`homeStyle.layout`): 타일형 (default: compact banner, ticket card, square two-column tiles), 포스터형 (tall banner with a quiet bottom scrim, ticket card, menus as round icons) and the photo-first 인스타형 (owner decision 2026-11-18, mockup `home-instagram-options.html` option B): a slim banner, the ticket card, a feed of approved participant photos (one large photo per card with its caption and "이름 · 시각"), then list menus. The first release offers these three only (owner decision 2026-11-19): the typography layout and the poster list-menu shape were retired from the studio, the home and the server. Stored pages are never rewritten: a stored 타이포형 reads, publishes and saves as 타일형, and the stored `menuShape` key is ignored. The feed lists approved photos only (`workspace.photos` of the public projection, newest first, at most the latest 12 with a quiet note when there are more) and only while the 사진 feature is on; a pending or hidden photo, and the agency's private evidence archive (which the public projection never carries), are never shown. A public page with no approved photo reads as the tile home instead of an empty feed, while the console preview keeps the layout and shows where the photos will go. Entries, ticket gating (티켓 필요), group labels, links and the disabled preview are the same in every composition.
- The event guide (`/event/<slug>`, reached from the QR and the home's "행사 안내 보기") wears the same published design (owner decision 2026-11-19): the same banner (`HomeHero`: picture, gradient or solid, tone, focus, overlay), the same ground color and ink (`homeSurfaceStyle`), and the layout's own hero, so a layout change in 참가자 페이지 changes the guide too. A photo-first home with no approved photo reads as the tile home here as well. See "참가 신청과 입장 티켓 확정 구성" for the guide's blocks.
- The banner is a picture, a gradient or a solid color (`bannerKind`, `bannerColor`, `bannerColor2`, `bannerAngle`). A color banner picks its own text tone from its colors; a picture follows the chosen tone, focus and readability wash. Existing events read as 타일형 with the picture banner, so their pages change shape (square tiles) when this ships.
- The studio is a live phone (sticky, "크게 보기" opens a full view; on narrow screens the inline phone yields to that view) beside a short flat list: 레이아웃 cards (the real home, scaled, in the event's own colors), 배경 (curated swatches, then a real picker: saturation/brightness field, hue bar, hex, eyedropper where the browser has one, recent colors and colors taken from the banner picture), then four rows (배너, 제목과 문구, 홈 메뉴, 소개와 공개 범위). A row opens in place with a ‹ settings crumb, never a modal, so the phone stays live. Choices that used to be selects are picture cards or segmented controls; public visibility is four switches.
- The one orange action follows the next step: 초안 저장 while there are unsaved changes, 게시 검토 once saved. Save, publish review, conflict recovery, uploads, reset/discard confirmations and permission locks are unchanged. The old jump nav (편집 · 저장·게시 · 미리보기) and the in-form skip link are gone.

## 행사 설정 확정 구성

The owner approved this composition on 2026-11-15 (`apps/web/app/console/events/[id]/settings/`, option A5: one workbench page). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-settings-composition.test.cjs` guards it. This is the only place that changes stage transitions, intake open/close and form publication, feature toggles, and basic information; 운영 현황·종료 흐름·결과 보고서는 모두 이 화면의 `#settings-stage`·`#settings-intake` 등으로 사람을 보낸다. The menu position (end of the 행사 준비 hub) stays.

- One workbench page, no tabs: the top event card holds the event identity (calendar block, name, meta, saved policy flags, 수정 button) and the stage block (five-step timeline, precondition, two-step transition with `StageTransitionConfirmation`). Below it two panels side by side (stacked on narrow screens): 참가 접수 and 운영 기능. `#settings-basics` opens the basics drawer; `#settings-intake`, `#settings-features`, `#settings-stage` scroll to their section with a brief highlight. A hash deep link never steals focus except for closeStep returns and linear-next handoffs, which focus the section heading.
- 참가 접수 reads as a status band (접수 중 green, 접수 닫힘 gray) with the version and the 접수 닫기 button beside it, then the application as attendees see it (field names from the workspace, required marked, 동의 문구 editable in place), then the single orange action: "양식 게시·접수 열기" when clean or closed, "변경 게시" when open with unpublished edits. 신청 항목 편집 goes to the separate 신청 항목 page. The honest-publicity notes (DRAFT/ENDED gating, ENDED publish block with close still available) are unchanged.
- 운영 기능 is eleven always-visible toggle tiles (checkboxes kept for keyboard and screen readers; checked tiles read selected with a dark inset ring). Changing a tile shows "저장 안 된 변경" with 되돌리기 beside the orange 운영 기능 저장. A changed tile carries an amber ring until saved.
- 기본 정보 editing lives in a right-edge drawer (`ConsoleDialog presentation="drawer"`, bottom sheet on phones): 행사명·주소 코드·고객사 / 날짜·시작·종료·정원 / 접수 정책 3개. 참가비 and 진행 형태 have no inputs: the price only matters with the payment feature this product never offers, and the format is display-only metadata shown nowhere (stored values are preserved verbatim in saves and conflict baselines).
- A published event (READY and beyond) that saves with a changed address code confirms first: 이전/새 주소를 나란히 보여 주고 확인은 검정 ("주소 바꾸고 저장"), never orange. Draft-stage saves skip the confirm. Existing duplicate-address and change-conflict handling is unchanged.
- Save, publish review, close confirm, conflict recovery, receipt recovery, permission locks and the draft guard (naming its dirty sections) are unchanged; recovery banners close the drawer so they are never behind the scrim, and the basics drawer reopens read-frozen while a request is unconfirmed.

## 메시지 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx`, option B with a widened writing column). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-messages-composer-contract.test.cjs` guards it.

- The composer is one flat sheet: no card panel around it, and no boxed recipient summary, preview-of-selection, attachment, simulate option or review list. Hairlines divide.
- Steps are a horizontal ink-underline row with numbered dots. The active step is ink, not orange. Once past step 1 the chosen recipients stay as one hairline row with a ghost "수신자 변경".
- The writing column keeps the width. Step 2 is the writing column plus one narrow preview column (about 300px) on the right; the preview is a quiet bubble on the neutral surface. Do not put a step rail or any other column back beside the writing column.
- "발송 검토로" (and "내용 작성" on step 1) is the only orange action in the composer, left-aligned with the hint beside it. 이전, 수신자 변경, 발송 기록 보기, 내용 수정 and the header 참가자 명단 are ghost. Variable chips are neutral pills, never orange text.
- 발송 기록 / 템플릿 관리 tabs use the same ink underline. On the template tab the save button is the one orange action.
- Review stays a separate step. Scheduling, mock send and the send confirmation live there and keep the existing request gates and receipts.

## 현장 운영 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/operations/OperationsWorkspace.tsx`, mockup scene A3). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-operations-composition.test.cjs` ("approved operations design stays locked") guards it.

- One page, no sidebar nav. Section anchors (`ops-desks`, `ops-booths`, `ops-staff`, `ops-display`, `ops-participation`, `ops-booth-mode`, `ops-booth-map`) stay for deep links and the team handoff.
- Desks are the only bordered card: the running count as the figure ("2 / 3 가동") with an ink bar. Booths, display and participation are plain; the staff gap list is a soft surface, like the overview's queue.
- A location row is a name, one quiet line, who is on duty as initials (an empty place is a dashed plus), and one control. The whole row opens its detail dialog. Desks carry a switch; stopping one asks first. Booths follow their schedule and show a dot plus word, never a switch. A stopped row dims by muted text, never by opacity.
- No secondary buttons inside rows. Edit, add and release (`staff.unassign`) live in the detail dialog.
- The page owns one assignment entry in the header. It is the only primary while some place has no one on duty and a ghost otherwise; gap rows name the place with a ghost "배정".
- Text budget: a row says its name, one line of facts and its state in words. No panel subtitles, no repeated links, no standing explanations.

### 화면 구성 규칙 (every screen)
- One bordered card per page, the figure that matters most; other regions take the form of their role (soft surface, plain list, flat line).
- A state is shown by its control or one word, not by a chip beside a button that says the same thing.
- A link or action appears once per page unless two entry points do different jobs.
- Rows are not wrapped in cards, and dimming never lowers text contrast.

## 행사 목록 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/ConsoleHome.tsx`, mockup B2). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-console-events-composition.test.cjs` ("approved event list design stays locked") guards it.

- No card around the list and no column header. The page title already says "행사"; the section title and count stay for assistive technology only.
- The running event is the page's one card: name large, date and place, and a text link "운영 현황 열기". With several running events only the first leads; the rest stay in the list.
- Stage filters are ink-underline tabs with counts, not a dropdown. The approval-only toggle and the 콜시트/달력 switch are quiet text, selected in ink, never orange. The create button is the page's only orange.
- Rows are grouped "다가오는 행사" then "지난 행사". A row is a stage dot (running green, preparing amber, done hollow), the name, one date line with the date in strong type ("11월 26일 (목)", the year only when it is not the current one), the countdown and an arrow. The stage word lives in the accessible name, not in the line.
- The next action sits at the row's end as amber text only when one exists (today: "승인 대기 n명 처리"). It is a sibling link, never nested in the row link.
- The directory carries no progress numbers; showing live entry counts here needs a server change first.

## 결과 보고서 확정 구성

The owner approved this composition on 2026-11-15 (`apps/web/app/console/events/[id]/reports/`, option "최종안": 탭 + 문서 카드 + PPTX 내보내기). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-reports-composition.test.cjs` guards it; `tests/web-reports-presentation.test.cjs` and `tests/web-reports-archive-checklist.test.cjs` keep pinning the A4/16:9 toggle and the print-clone/checklist mechanics those files describe.

- 마감 지도와 결과 분석·보고서 내용의 세 구역은 하나의 항상 보이는 "보고서" 패널로 합쳐졌다. 결과 분석(입장률·집계)과 보고서 내용(선택한 보고서)은 더 이상 따로 클릭해서 열어야 하는 탭이 아니다. 공유 섹션 내비게이션은 "행사 마감"·"보고서" 두 개만 남았다; 선택한 보고서는 그 "보고서" 탭 자체의 `fragment`(`#report-<id>`)로 계속 주소를 갖는다.
- 마감 지도(`EventCloseFlow.tsx`)는 점 + "마감 N/7 · 다음 할 일" 한 줄과 그 줄 끝의 이어가기 링크/버튼으로 줄었다. 승인 대기·접수·단계 사실 표(`closeFacts`)를 포함한 전체 7단계 체크리스트는 지우지 않고 그 아래 `<details>`("전체 마감 단계와 전제 확인")에 그대로 접어 넣었다.
- 보고서 선택은 잉크 밑줄 탭 전환기(제목 + 공유 완료/초안 점·글자)로 바뀌었다. "보고서 만들기" 버튼은 기존 접근성 이름과 권한 게이트를 그대로 유지한다.
- 선택된 보고서는 회색 "책상"(`.pageDesk`) 위에 A4/16:9 측정값을 유지하는 카드(`.reportDoc`, 위쪽 `.cardBand`가 `report.color`를 띠로 표시)로 보인다. 카드 안 참가·입장 섹션에는 등록 그룹 구성비 막대+범례가, 참여 콘텐츠에는 같은 색 막대 리스트가, 만족도에는 평균 미터가 추가됐다 — 모두 저장된 텍스트 설명에 얹힌 시각 레이어일 뿐이며, 숫자가 검증되지 않으면(결측·비정수·음수·합계 0) 차트를 그리지 않고 기존 "확인할 수 없습니다" 문구만 남는다.
- 보고서-최근 집계 차이는 덤벨(저장값 ↔ 최근값, 선으로 연결)로 먼저 보이고, 정확한 숫자 표는 그 아래 `<details>`("보고서-최근 집계 비교표 보기")에 접혀 있다.
- 오른쪽 고정폭(300px) 레일: "결과 분석" 박스(항상 보임, 입장률 미터 + 기존 KPI 그리드 + 경고 + 그룹·부스·프로그램 상세 — 부스 표 아래 정원 대비 이용률 막대 추가)와 "실행" 박스(보고서가 열려 있을 때만: A4/16:9 보기 전환, 편집/공유 완료 또는 새 버전 만들기, 내보내기 묶음, 마감 핸드오프 링크). "조회된 집계 보기" 핸드오프 버튼은 분석이 항상 보이므로 제거했다.
- 등록 그룹 막대만 쓰는 전용 3색(`--series-blue #2a78d6`, `--series-orange #eb6834`, `--series-aqua #1baf7a`, `apps/web/app/tokens.css`)은 dataviz 스킬 `validate_palette.js`로 라이트모드 검증됨(인접 CVD ΔE 9.2, 일반 ΔE 27.6). 이 화면의 다른 곳과 제품의 나머지 전부는 여전히 잉크+브랜드 오렌지.
- PPTX 내보내기는 `pptxgenjs`를 클라이언트에서 동적 import해 표지(어두운 배경 + 오렌지 킥커 + 큰 제목) + 핵심 숫자 + 참여 콘텐츠 + 만족도 + 사진 슬라이드를 한 번 채워 내려준다(xlsx export와 같은 패턴, 새 서버 커맨드 없음). 사진은 `/api/events/:id/files/:fileId`를 fetch해 base64로 넣고, 한 장이 실패해도 나머지 내보내기는 계속된다. 버튼 옆에 "꾸미기는 파워포인트·키노트·캔바에서" 안내 문구가 있다.
- 내보내기 묶음(PPTX/JSON/인쇄)은 ghost 역할로 낮췄다(보조 버튼 수를 줄이는 Action role rules 판단); 내용 편집·취소·닫기 같은 실제 대안 행동은 secondary로 남았다.

Reopened 2026-11-19 (owner: 실제 화면이 밋밋하다 — 작은 회색 글씨·얇은 선, 숫자가 글씨로만 있다). 구성(탭·문서 카드·레일, PPTX/JSON/인쇄)은 그대로, 표현만 도형 중심으로 바꿨다. 이 항목이 위 설명과 다르면 이 항목이 우선한다.
- 보고서 전환기는 보고서 고유색 막대+제목+상태 칩(점+글자, 초안은 앰버·공유 완료는 초록)을 담은 카드 탭이다. 선택된 카드는 잉크 외곽선. 마감 지도 줄에는 7칸 진행 막대(`StepBar`)가 붙고 "행사 마감" 탭에서는 줄 전체 폭으로 펼쳐진다.
- 문서 표지는 큰 제목, 상태·집계 기준 시각 알약. 섹션 제목 앞에는 보고서 색 세로 막대. 참가·입장은 입장률 링(`RateRing`)+등록·누적 입장·현재 입장 숫자 타일을 먼저 보여 주고, 기존 한 줄 텍스트는 접근성용(`sr-only`)으로 남긴다. 숫자가 검증되지 않으면 타일 없이 기존 문장을 그대로 보인다.
- 그룹 구성 막대의 전용 3색(series 토큰)은 폐기했다. 범주는 잉크 농도(진함→연함)와 비율(%)로 구분하며, 이 화면의 도형은 잉크+중립 하나의 색조다(`--series-*` 토큰은 tokens.css에 남아 있으나 화면에서 쓰지 않는다).
- 참여 콘텐츠는 행마다 이름·막대·건수(0건은 흐리게), 만족도는 큰 평균 점수+5칸 게이지, 항목마다 평균 막대. 원래 텍스트 줄은 그대로 있다.
- 오른쪽 레일의 결과 분석은 입장률 링+큰 숫자, 3칸 숫자 타일(승인 대기만 앰버)이다. 실행 영역은 주 동작 하나(오렌지)+내용 편집(secondary, 연필 아이콘)+닫기(ghost)이고, 내보내기는 구분선 행 목록, A4/발표용 전환은 잉크 세그먼트 컨트롤(오렌지 아님)이다. 긴 안내문은 `<details>`로 접었다(JSON 원본 범위 안내만 항상 보임).

## 고객사 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/console/clients/ClientsList.tsx`, mockup option A). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-clients-composition.test.cjs` guards it.

- A flat list under the toolbar: no card, hairline rows. The page title already says "고객사"; the section title stays for assistive technology only and a quiet count ("전체 N개", "검색 결과 n개 / 전체 N개") stays visible. There is no 검색 지우기 button; the search input clears itself.
- A row is the logo (or the name's first letter in a soft square), the name, contact and email, two file states, and an arrow. File state is a dot plus the word (로고 / 사업자등록증; green dot = registered, hollow dot = none) with the state spelled out for screen readers. A row holds no buttons: the name button's `::after` makes the whole row one entry into the drawer. "행사 N건" is not shown; the directory has no such count.
- Tapping a row opens one right-edge drawer (bottom sheet on phones). Managers edit name, contact and email there and manage 로고 and 사업자등록증 beneath the form as quiet text rows (올리기/교체/보기/제거). 제거 stays behind the in-place confirm that names the client. Members without write permission open the same row into a read-only drawer with a 문서 보기 link.
- The page's orange actions are 고객사 등록 and the drawer's 저장. Cancel, 파일 확인 그만두기 and 제거 are ghost; the secondary ceiling for the screen is 2 (서버 처리 확인, 같은 파일 요청 다시 확인).
- Files wait for a saved form: while fields differ from their opening values the file rows are disabled with a one-line note. Starting an upload or confirming a removal closes the drawer first so that the recovery panel and result messages are on the page, never behind the scrim.
- Save, upload, link, removal, receipt recovery, same-request retry, the write locks and the draft guard are unchanged.

## 팀·권한 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/console/team/TeamWorkspace.tsx`, mockup `team-options-b4.html` option A: the three-bar gauge). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-team-composition.test.cjs` guards it.

- Three tabs on the shared `ConsoleSectionNav` (panels stay mounted): 구성원, 행사별 권한 (owners only) and 연동·활동. The toolbar holds only the page's one orange action, 구성원 초대; there is no toolbar label and no standing sentence above the list.
- 구성원 is a flat list, pending invitations first. A row is an initial, name and contact, role (with "쓰기 권한 N개 행사" for 조직 구성원 when the viewer is the owner), a state word (대기 중 / 사용 중지) and an arrow. A row holds no buttons: the name button's `::after` makes the whole row one entry into a drawer. An unknown invitation queue reads "대기 중인 초대를 확인할 수 없습니다.", never "없습니다".
- The member drawer is docked beside the list on wide screens (a sheet on phones), so the shell's recovery notice stays reachable while a role request is unsettled. It holds 조직 역할 (each role with one line on what it can do, plus the existing confirm/retry panel), 현장 배정 for active staff, and 계정: 비밀번호 재설정 (closes the drawer, then opens its own dialog) and 소속 사용 중지/다시 활성화 with their inline confirms. Closing or choosing another row goes through the role panel; an in-flight request blocks it, an unknown one asks first.
- 행사별 권한 shows one gauge row per 조직 구성원 for the chosen event: a name for the level plus one plain sentence, with three bars repeating it. Levels: 전체 (3 bars, stored as `["all"]`), 설정 제외 (2, every scope but `settings`), 직접 설정 (1, "N개 범위만 바꿀 수 있어요") and 읽기 전용 (0, `[]`). A person not yet on the event reads 배정 전.
- Tapping a row opens a drawer with the levels as cards (each with an eight-segment preview), 설정 제외 marked 추천 as guidance only, and 직접 선택 which unfolds the eight scopes in three groups. One orange 권한 저장. Pending saves freeze the event picker, the levels and the scopes, keep the drawer open and replay the same request; unsaved edits ask before closing.
- Server permission model, command ids, receipts, retry replay, last-owner rules and the draft guard are unchanged; only the presentation moved.

## 명단 가져오기 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/console/events/[id]/participants/import/ImportWizard.tsx`, mockups `import-simple.html` and `import-simple2.html`). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-import-composition.test.cjs` guards it. It opens as a wide dialog from the roster and also stands as the `/participants/import` page.

- Two screens, no step line. First a drop area (one dashed region around the real file input, 파일 선택 as its mirror, 양식 CSV 받기 as a quiet link beside the format line). Then one review screen. The section titles stay for assistive technology only.
- The review answers in one sentence of numbers: a green card with "등록할 수 있어요", the big count, a distribution bar (바로 등록 / 확인 필요 / 제외) and its legend, then the first three people as initial, name, company and phone ("이렇게 등록돼요", 외 N명). Phones show as 010-1234-5678 for display; the stored value stays the digits.
- Problems are tinted cards, not table rows: a warning card names the 연락처 확인 rows (chips, the rest folded) and holds the confirmation checkbox that gates the commit; a danger card says "N행은 등록하지 않아요" and unfolds the file row and reason of each excluded row (first 50) in place. Excluded rows are not imported; the operator fixes the original file and imports again.
- Columns are matched without a step. Header words (성명, 휴대폰, 회사/부서 and the English equivalents) and, for phone and email, what the first rows look like, pick the file column; a name column is never guessed from values. The match is one line of chips, each a select that changes the column in place (TXT keeps its fixed order). The event's own extra form fields (식사 선택, 요청 사항 ...) join the same chip line when the file has a column titled like the field (owner decision 2026-11-18): they are found only among the columns the four standard fields did not take, a bad answer is a row error by file row, a required field with no column never blocks the rows (a quiet info line says its answers stay empty), and TXT offers none. When a required column (이름 or 연락처) cannot be matched, the review is replaced by "어느 열이 이름인가요?": the unused file columns with sample values as a radio list, chosen once.
- The only orange action is "N명 등록" (the footer of the dialog; below the content on the page). An uncertain write turns it into 같은 요청 다시 시도 beside a secondary 서버 처리 확인; 파일 바꾸기 and the chips lock while a write is pending or uncertain. After a commit the success notice stays and the stage offers 다른 파일 가져오기 and 참가자 명단 보기 (the page: 참가자 목록으로).
- Parsing limits (1MB, 1,000 rows, first sheet, 256 columns), the consent line (승인 검토 없이 참가 확정, 동의 기록은 생성하지 않음), command id reuse, receipts, the draft guard and the permission and stage gates are unchanged; only the presentation and the column match moved.

## 스태프 현장 화면 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/staff/StaffEventWork.tsx`, mockups `staff-viewfinder.html` for the look and `staff-field2.html` for the flow). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-staff-field-composition.test.cjs` guards it. It is the phone screen for desk check-in and booth stamping.

- A dark column: a quiet top bar (back, event name, one ⋯ menu), the desk or booth select as the title, the camera as the stage, and a short white bar under it. Nothing is fixed or sticky; the bar is in normal flow.
- The camera is `CameraScan variant="field"`: it fills the stage, stays open after a detection (the next person is scanned without restarting it), keeps the screen awake and offers the torch where the device has one; sound and vibration have a round toggle beside it. While a result shows or a request is in flight the scanner is suspended; the code that was just read is ignored while it stays in front of the lens and for 3 seconds after. The attendee booth camera keeps its one-shot behavior.
- The bottom bar holds three quiet buttons (코드 입력, 명단 찾기, 최근 처리; 경품 조회 on an exit desk) and no orange. The only orange is "카메라 켜기" while the camera is off, or the one button a result needs. There is no standing recent list or form under the scan.
- A result is the stage's colored face with a round badge by shape, a kicker, and the name at 40px. A plain success has no panel: it hands itself back after 1.5 seconds or on a tap, with a sound and vibration, and keeps only "잘못 스캔했어요" and 네임택 인쇄 as quiet links. 결과 자동 넘김 can be turned off in the menu.
- Information is not an error: an already-entered ticket (server code `ALREADY_CHECKED_IN`) and a booth limit are a blue face that hands itself back after 3 seconds. The already-entered face adds one quiet line under the message, "이름 · 오후 02:13 입장" (owner decision 2026-11-18): the server sends `details: { name, firstCheckedInAt }` with the refusal, the time is the earliest entry that was not corrected away, and a response without details keeps the plain notice. It is information only: no new control, and the 3-second hand-back is unchanged. A definitive failure (cancelled, not eligible, not found) is red and waits for 확인; "다시 시도" is only for an uncertain or unreadable result. Anything that needs a decision holds: an uncertain result (same-request recheck), attendance or eligibility review, a correction in flight, a direction review, an exit with prizes to hand over (the prize list sits in the bar until each 수령 확인), and an open nametag.
- Lists and forms are sheets (`ConsoleDialog presentation="drawer" stickyChrome`) opened on demand: 티켓 코드 입력, 명단에서 찾기 (the name search with its identity confirmation), 최근 처리, 기록 정정 (reason chips plus the free text) and 경품 조회. The last scan stays correctable after it hands back: 최근 처리 offers "잘못 처리했어요". A device with no camera says so on the stage and offers the name search.
- A result's buttons live inside its own region (the white bar at the bottom of the colored face: 다음 참가자, 확인, 같은 요청 재확인 with its server check, the prize list), never in the scan bar. The code or name-search sheet stays open while its request is in flight (read-only code, "처리 중입니다") and closes when the result arrives. A plain success or an already-entered notice is one big tap target (its text lets the tap through); every other result takes taps normally. The shared 처리 결과 확인 panel (another window's unconfirmed request) shows in the page flow above the stage, never only inside the ⋯ menu. A rejected prize handout keeps its message and the lookup form open.
- The SELF booth shows its QR on a light stage with one 최근 처리 button. Request ids, same-request recovery, frozen receipts, the draft and leave guards, correction, direction review and the prize contracts are unchanged; only the presentation and the scan loop moved.

## Product component boundary

Astryx supplies the production theme, actions, icon actions, links, labeled text fields, headings, sections and feedback. `app/ui/ProductButton`, `ProductLink`, `ProductInput` and `ProductNotice` keep the product-facing contract small. The production theme in `apps/web/src/themes/eventouch/` aliases `tokens.css`; generated theme files are rebuilt, not edited. The product explicitly uses light mode and Pretendard. The isolated design-review pilot is not a runtime dependency.

Primary actions use the contrast-safe orange fill with white text. Secondary actions remain neutral; ghost actions handle quiet utilities and contextual navigation. Destructive intent uses the Astryx destructive variant. Refresh is an icon action with an accessible name, a persistent touch target and loading feedback that retains focus. State foreground/background pairs switch together rather than interpolate through low contrast.

Native disabled and ARIA-only disabled are different contracts. A native disabled control retains its HTML semantics; a busy action stays focusable and rejects repeat activation. Keep original request gates, form payloads, receipts and unknown-outcome recovery in the existing domain owner. Shared components do not add automatic writes or a second async controller.

Native controls remain where browser semantics matter: file/date/number inputs, select/checkbox/custom submitted values, compound password controls, camera/canvas/QR, file downloads and print output. Explicitly labeled controlled text inputs use Astryx where compatible. External labels and native form associations are not replaced with hidden synthetic submissions. Customer-published attendee colors and menus remain a separate theme boundary.

The console uses task-specific workspaces, not a uniform card grid. The overview places actionable work before supporting metrics; roster controls stay beside selection; reviewed sends and publication remain separate from composition. Tab and dialog controllers preserve mounted state, keyboard behavior and guarded exits.

CSS layer order is declared before vendor imports. Native document/form base rules precede Astryx; legacy layout rules and product adapters have explicit later layers. CSS Modules own domain layout. Do not revive global button paint rules for migrated components or load an unused default theme font.

## 참가 신청과 입장 티켓 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/event/[slug]/` page, `register/`, `ticket/` and `ticket/recover/`, mockup `attendee-ticket-b2.html`, direction "입장 패스 B"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-attendee-entry-composition.test.cjs` guards it.

- The ticket is a pass held up at the desk. Its band carries the state by color (참가 확정 green, 입장 중 blue, 승인 대기 and 확인 필요 amber, 신청 취소 red) and the name at up to 40px; the QR below is the largest object (up to 340px wide, with the four-module quiet zone kept), then the event name and date, then two quiet utilities (참여 콘텐츠 보기, 상태 다시 확인). The recheck is orange only when there is no QR to show.
- A fresh signup shows one dark receipt line above the pass ("신청이 완료되었습니다. 이 화면이 입장권입니다.") once; reload or a shared link never replays it. The screen stays awake while the QR is shown (`useScreenWakeLock`, where the browser supports it) and a line asks to brighten it; a browser cannot set brightness itself. A connection failure keeps the QR visible with its notice, as before.
- The registration form is a short sheet: a lead line under the event name (the outcome copy is unchanged), large 52px fields with a quiet (필수)/(선택), only the field to fix turns red with its message beneath, and a sticky submit that stays in reach with the keyboard up. The "신청하면 어떻게 되나요" and "누가 참가하나요" headings stay for screen readers. A focused field keeps room below it for its hint and error. The phone is not reformatted while typing: the value is also the verification grant and is sent as typed.
- The event guide is the attendee home's own design with the registration card in the ticket-card slot (owner decision 2026-11-19; `apps/web/app/event/[slug]/page.tsx`, mock `public-event-layouts.html`, shared parts `HomeHero`, `home-layouts.module.css`). When and where are icon blocks (calendar with the date, time and a "D-n" chip for an upcoming day; pin with the venue name and address), each only when the page publishes it; the page's intro line follows them. The card is a link, as the home's ticket card is a button: an open event offers "참가 신청하기" with the stage and "접수 중"; a tab holding a ticket for this event offers "내 티켓 열기" first, and another participant can apply in a separate tab. When intake is closed the same slot reads "이미 신청했다면 내 티켓 찾기" with "현재 신청을 받지 않습니다" (a quiet closed card where recovery is unavailable). The poster layout keeps the home's own composition (the ticket-card slot, two icon tiles, round shortcuts to the published sections); the tile and photo layouts read as plain cards instead (owner decision 2026-11-19): under the banner one white summary card holds when and where as icon rows and the one full-width primary action with its status, with no floating ticket card, tiles or shortcuts, and the sections follow as plain cards. every layout then lists 공지 (an icon beside each notice, a filled icon for a pinned one), 프로그램 (date tabs; each session is a card with a tinted time block, a place pin and a speaker icon), 부스 지도 and 오시는 길 (a large pin, the place, the copyable address and a "지도에서 보기" button to a map search) as white cards, and ends with quiet link rows (참가자 홈, 이미 신청했다면 내 티켓 찾기). A tab that holds someone else's ticket still reaches recovery from those rows.
- Finding a ticket again (연락처 → 인증번호) is one large field and one primary action; the rest are quiet. Registration, ticket, recovery and verification contracts (same-request retry, bearer in memory and one navigation, cleaned address, unconfirmed result recovery, 404 and transport-failure rules) are unchanged; only the presentation and the pass order changed.

## 신청 항목 편집 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/console/events/[id]/settings/fields/`, mockup `fields-options.html`, option A "폰 미리보기 + 평면 목록"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-fields-composition.test.cjs` guards it.

- A flat ledger of fields beside a redraw of what the attendee will see (`FieldsPhonePreview.tsx`, sticky on wide screens, below the editor on narrow ones). The preview is decorative (`aria-hidden`, `inert`): it follows the draft as typed, so a new or renamed field shows before it is saved; it must be updated when the real form (`event/[slug]/register`) changes.
- A row is its name as the one button (its hit area covers the row, so its accessible name still contains its visible text), a quiet type line, a 필수/선택 dot and two icon-only move buttons. Exclusion no longer repeats on every row: it is "이 항목 제외" inside the editor, with its confirm directly under the editor. 이름 and 연락처 stay required and cannot be excluded.
- One orange at a time: "항목 추가" while idle, "항목 저장" while editing (add is blocked then); the preview's button is grey. The draft state is one pill ("게시 안 된 변경 있음", "아직 게시 전", "게시된 양식과 같음"); publishing stays in 참가 접수. The input type is a choice group, not a select.
- Moves stay one step at a time and every save, move and exclusion is its own command, as before. The same-request recovery, conflict notice, receipt check and abandon flow, and their copy, are unchanged.

## 참여하기 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/event/[slug]/engage/`, mockup `engage-options.html`, option B "행사 색 위의 탭과 카드"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-engage-composition.test.cjs` guards it.

- The page sits on the event's own home color (`pageExperience.published.homeStyle.backgroundColor`, the same source as the attendee home) with the readable ink (`readableInk`) for the header; program cards stay white so they read on any ground.
- Programs are grouped by kind (투표, 퀴즈, 만족도, Q&A, 사진 공유, 게시판, 추첨) under pill tabs shown only for kinds the event has and only when there is more than one. An unfinished poll, quiz or survey is an orange dot on its tab. A `?program=` link opens the tab of that program. Within a tab the first program is open and the others stay collapsed, as before.
- A program's state is a chip in its header (참여 가능 blue, 제출 완료 green, 제출 확인 필요 amber, 종료 grey). Choices are hairline rows with the radio on the text line (the card's label rule used to stack it above the text); score choices turn ink when picked; the submit is the one orange. The one-time notice is a dark line and clears when the tab changes.
- A voted poll shows the counts it already publishes as bars with its own choice marked (the choice is known only in the session that voted); the counts before voting are shown as before.
- Submit, same-request recovery, content-version conflict, receipt check, question edit and like, photo upload and the approval-pending note are unchanged. The footer links are quiet text links.

## 행사장 대형 화면 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/screen/[slug]/`, mockup `screen-options.html`, option A "어두운 무대"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-venue-screen-composition.test.cjs` guards it.

- Every scene except the draw sits on the product's stage ink (`board-stage.module.css`, fixed full screen like the draw stage); the draw keeps its violet and gold stage (see 추첨·투표 확정 구성). Type is sized for a room: the title at up to 116px and body at up to 67px on a 1920 screen, with the event name, date and venue as the only small lines. The footer shows the venue only.
- A poll is one row per option (name, bar, count); the leading option's bar is orange and the others white, with a "투표 진행 중" pill and the total. Counts are the public aggregates, as before.
- The program lists time, title and place. The session in progress is orange with "진행 중": it needs a start and an end on a known day (a missing day takes the event's date) and is read as the venue's local time against the server's clock (the offset from the response's `Date` header, refreshed on every poll and re-evaluated every 30 seconds), so a screen with a drifting clock highlights the right line. Row size follows the number of sessions shown so ten still fit.
- Selection rules (the operator's choice first, otherwise a rotation of what exists), quiz answers only after reveal, four questions and six photos at most, words only for notices, the "연결 확인 중 · 마지막 화면입니다" notice and reduced-motion handling are unchanged, and so are the class names the audits read (`.display-frame h2`).

## 스태프 목록과 로그인 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/staff/StaffHub.tsx` and `apps/web/app/login/`, mockups `staff-entry-a3.html` for the hub and `staff-entry-a2.html` for the login). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-staff-entry-composition.test.cjs` guards it.

- The assignment hub (shown only for two or more assignments; one goes straight to its event, none shows the empty state) is the field screen's dark column. A top bar holds the EVENTOUCH wordmark (orange E) and the account menu as a quiet pill; the title is "오늘 처리할 행사 N곳" with N in orange.
- The event that is `LIVE` is one card with the hub's only orange: a "지금 진행 중" chip, the name, the start to end time at 38px, "내 배정 · 데스크 N곳", and "업무 열기". The rest are flat rows that open as a whole (initial tile, name, start label, kind and count, a status dot, a chevron). Names of desks and booths are not listed; they are the work screen's title. A start label is day-level: "09:00 시작", "내일 10:00 시작", "12.20 09:30 시작". With no live event the title is followed by "지금 진행 중인 행사는 없어요."
- Empty and failed states are an icon tile, the unchanged sentence ("배정된 업무가 없습니다. 운영자에게 문의하세요."), and one outlined "다시 불러오기". Organization line, the changed-organization notice (the rows and card stand down) and the single-assignment shortcut are unchanged.
- The login keeps its markup and copy: a dark band with the wordmark (orange E, from `::first-letter`) and the promise line over a white sheet with 56px fields; the error line and the submit sit at the bottom of the sheet, the error directly above the submit. On wide screens the band and sheet are one framed card. The submit is docked at the bottom of the sheet, not fixed to the screen. Everything after sign-in (staff to 내 업무, operators to the console), the session notice, first-operator setup and the reset help are unchanged.

## 계정·첫 화면 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/auth-entry.module.css`, `apps/web/app/landing.module.css`, mockup `account-landing-options.html`; the landing hero is option B "어두운 히어로"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-account-landing-composition.test.cjs` guards it.

- 비밀번호 재설정, 내 계정 이메일 인증 and 팀 초대 수락 share one frame (`styles.entry`): the login's dark brand band (orange E wordmark from `::first-letter`, the screen's name, the promise line) over a white sheet with 56px fields. On wide screens the band and sheet are one framed card. Forms fill the sheet; an error that leads into a submit sits directly above it with the submit at the bottom, while a lone notice (an unavailable mailer, say) stays in the flow. Inputs, verification and recovery flows, single-use tokens, step copy and focus order are unchanged.
- The landing's header and hero share one full-width ink band (`box-shadow` plus `clip-path` bleed); the product window stays white. The fact strip, tabs, calls to action and the inquiry rules (email only, example figures disclosed) are unchanged, and every section below the hero stays white. Print keeps its plain frame. The hero's glow bleeds past the container only from 1025px up, where it cannot cause a sideways scroll.

## 새 행사 만들기 확정 구성

The owner approved this composition on 2026-11-16 (`apps/web/app/console/CreateEventDialog.tsx`, `console-home.module.css`, mockup `create-event-a3.html`, "A3"; the time bar of the mock was dropped on purpose). Change it only on a new owner decision.

- 이름, 날짜, 시간, 고객사 are all visible on open; 추가 설정 holds only exact start/end, 정원 and 주소 코드. 진행 형태 is no longer offered or sent (the settings screen already removed it; stored values stay).
- Each field gets the control that fits it instead of one white box: the name is a title input without a box with the 참가자 주소 line under it ("바꾸기" opens 주소 코드), the date is a large soft field with 내일/1주 뒤/1개월 뒤 chips and a plain "선택한 날짜 … · N일 뒤" line, the time is 종일/오전/오후/저녁 chips with a "09:00–18:00 · 9시간" line, 정원 has 50/100/300/500 chips, and the create mode is a two-way segmented bar.
- Chips are native radios that only set values the form already holds (date, start/end, capacity); the payload and the write path (receipts, retry, duplicate, customer registration) are unchanged. Selected chips are ink, so the one orange action stays "행사 만들기".
- Guidance never blocks the write: a same-name event, a past date, a duplicate that keeps the source date, and an end that is not after the start (the server's own rule) show as a one-line notice. With no customers the select is replaced by a one-line explanation and the register action.
