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

## 경품 수령 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/rewards/`, option V1). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-rewards-composition.test.cjs` guards it. This is the operator oversight list (blocked prizes, missing recipients, uncertain outcomes); handing a prize to a person at the venue belongs to the staff exit desk.

- One bordered summary card: a progress ring (지급 완료 / 취소 제외 전체) and three tinted status tiles (확인 필요 red, 지급 대기 amber, 수령 완료 green). Tiles filter the list; underline tabs with counts carry the same filter. Search appears only when there are more than 8 prizes or a query.
- The ledger reads by urgency: 확인 필요 → 지급 대기 → 완료·취소. A row leads with the recipient's initial in a circle (a dashed "?" while a company win has no recipient); a small corner badge carries the state by shape (alert, clock, check, x). Reasons are icon pills (수령자 지정 필요, 참가 취소, 연결 필요, 지급 실패), the method is an icon.
- 수령 처리 is an ink pill on clean 지급 대기 rows only; a blocked prize shows its reason and a soft link (추첨에서 수령자 지정, 참가자 명단에서 확인) instead. 경품 취소 sits in the expanded row, behind the existing confirmation.
- The page title and rail label stay "경품 수령"; renaming it (for example 경품 지급 현황) is a separate decision.

## 추첨·투표 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/draws/`, "미리보기 무대"). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-draws-composition.test.cjs` guards it.

- One stage card, then a flat picker ("무대 선택") of the four jobs: each stage draw program, 순위 투표, 모바일 룰렛, 럭키번호. No jump tabs, no stack of section panels. Pressing a row swaps the card; `#draws-vote`, `#draws-roulette`, `#draws-lucky` and `#draw-program-<id>` select that item.
- The card's top is a preview of what the audience really sees: stage draws show the venue-screen scene (violet and gold, from `screen/[slug]/draw-stage.module.css`); vote, roulette and lucky show the attendee phone card. The preview (`StagePreview.tsx`) is a decorative redraw: it loads nothing, runs nothing and must be updated when the real screens change. The venue screen has no vote, roulette or lucky scene today, so those use the phone.
- Under the preview: facts (state kicker, name, one meta line, big number and gauge) on the left, actions on the right. The single orange action is the run button ("N명 추첨 실행") beside a large stepper; 무대 터치 실행 is secondary; 결과 공개 is a switch; 설정 수정, 운영 시작·종료·다시 열기 are ghost.
- Program create/edit settings open in a dialog (`추첨 프로그램 만들기` in the page header); vote, roulette and lucky settings stay as their existing forms folded under the card. Every blocker line, confirmation, recovery notice and permission lock is unchanged.

## 참여 콘텐츠 확정 구성

The owner approved this composition on 2026-11-14 (`apps/web/app/console/events/[id]/programs/`, review drawer with the merged answer card). Change it only on a new owner decision; a redesign pass on another screen is not one. `tests/web-programs-composition.test.cjs` guards it.

- One flat ledger grouped 진행 중 / 준비 중 / 종료. A row is a type tile (own glyph and tint, state dot on its corner), the name, one quiet line, an optional thin meter (poll shares, quiz rate, Q&A/photo public ratio) and one number. No type or state pills, no per-row hairlines.
- "콘텐츠 만들기" is the only orange action. 시작 / 다시 열기 sit at the row end; 종료 and 편집 live in the expanded row, which shows results inline (no second fold).
- Everything attendees sent that needs a decision (questions without an answer or approval, pending photos and posts) sits behind one amber line, "검토할 것 N", that opens a modal drawer (right edge on wide screens, bottom sheet on phones; `ConsoleDialog presentation="drawer"`). A question needing both counts once. Pending question edits are decided in the content's own list.
- Answer card: asker, question bubble, one reply field with an ink send circle ("답변하고 공개"), quiet "답변만 저장". Questions have no reject action. No nested bordered boxes beyond bubble and field.
- Drawer rows use `review-*` ids; list rows keep `moderation-*`. Recovery banners close the drawer so they are never behind the scrim.
- Search and status tabs appear only for long lists (more than 8) or while a filter is active.

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

## Product component boundary

Astryx supplies the production theme, actions, icon actions, links, labeled text fields, headings, sections and feedback. `app/ui/ProductButton`, `ProductLink`, `ProductInput` and `ProductNotice` keep the product-facing contract small. The production theme in `apps/web/src/themes/eventouch/` aliases `tokens.css`; generated theme files are rebuilt, not edited. The product explicitly uses light mode and Pretendard. The isolated design-review pilot is not a runtime dependency.

Primary actions use the contrast-safe orange fill with white text. Secondary actions remain neutral; ghost actions handle quiet utilities and contextual navigation. Destructive intent uses the Astryx destructive variant. Refresh is an icon action with an accessible name, a persistent touch target and loading feedback that retains focus. State foreground/background pairs switch together rather than interpolate through low contrast.

Native disabled and ARIA-only disabled are different contracts. A native disabled control retains its HTML semantics; a busy action stays focusable and rejects repeat activation. Keep original request gates, form payloads, receipts and unknown-outcome recovery in the existing domain owner. Shared components do not add automatic writes or a second async controller.

Native controls remain where browser semantics matter: file/date/number inputs, select/checkbox/custom submitted values, compound password controls, camera/canvas/QR, file downloads and print output. Explicitly labeled controlled text inputs use Astryx where compatible. External labels and native form associations are not replaced with hidden synthetic submissions. Customer-published attendee colors and menus remain a separate theme boundary.

The console uses task-specific workspaces, not a uniform card grid. The overview places actionable work before supporting metrics; roster controls stay beside selection; reviewed sends and publication remain separate from composition. Tab and dialog controllers preserve mounted state, keyboard behavior and guarded exits.

CSS layer order is declared before vendor imports. Native document/form base rules precede Astryx; legacy layout rules and product adapters have explicit later layers. CSS Modules own domain layout. Do not revive global button paint rules for migrated components or load an unused default theme font.
