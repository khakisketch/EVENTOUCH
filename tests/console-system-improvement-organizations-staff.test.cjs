'use strict';

// Staff multi-organization unit: shared operator context on the staff
// surface only. Static source assertions pin the seams (the shared adapter
// and switcher land from the parent); pure staff rules execute at runtime.
// Rendered two-tab verification happens outside the suite (main owns
// DB/browser/servers once the server side lands).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const STAFF = path.join(WEB, 'app', 'staff');

function readStaff(rel) {
  return fs.readFileSync(path.join(STAFF, rel), 'utf8');
}

test('staff-reads-and-writes-go-through-the-shared-adapter', () => {
  for (const rel of ['StaffHub.tsx', 'StaffEventWork.tsx']) {
    const source = readStaff(rel);
    // Every operator read/write uses the shared context adapter — including
    // the bootstrap and the event command posts — so context headers and
    // the frozen request organization apply uniformly.
    assert.match(source, /operatorFetch\(/);
    assert.doesNotMatch(source, /(?<!operator)fetch\(/);
    // The adapter contract is imported from the shared lib path; the
    // context is seeded where the screens load their scopes.
    assert.match(source, /from "\.\.\/\.\.\/lib\/operator-context"/);
    assert.match(source, /ensureOperatorContext/);
    assert.match(source, /void ensureOperatorContext\(\)\.catch\(\(\) => \{\}\);/, 'snapshot-published initialization failures never become unhandled page errors');
  }
  const work = readStaff('StaffEventWork.tsx');
  // Writes carry the frozen request context verbatim: the retry replays the
  // stored event/assignment/record/payload/id and must never switch an
  // uncertain old receipt into another organization.
  assert.match(work, /encodeURIComponent\(pending\.eventId\)/);
  assert.match(work, /assignmentId: pending\.assignmentId/);
  assert.match(work, /payload: \{ id: pending\.checkId, reason: pending\.reason \}/);
  // Prior correction-retry identity locks are preserved, not redefined.
  assert.match(work, /buildCorrectionPending\(\{/);
  assert.match(work, /pendingCorrectRef\.current = pending;/);
  assert.match(work, /correctingRef = useRef\(false\)/);
});

test('staff-subscribes-to-context-with-a-stable-server-snapshot', () => {
  const hook = readStaff('use-operator-context.ts');
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /subscribeOperatorContext/);
  assert.match(hook, /getOperatorContextSnapshot/);
  assert.match(hook, /SERVER_SNAPSHOT/);
  assert.match(hook, /getServerSnapshot/);
  assert.match(hook, /OperatorContext/);
  // Consumers read exactly the contracted view: active context, changed
  // flag, loading/error, and in-flight/uncertain write counters.
  for (const field of ['context', 'changed', 'loading', 'error', 'inFlightWrites', 'uncertainWrites']) {
    assert.match(hook, new RegExp(`\\b${field}\\b`));
  }
});

test('staff-account-menu-keeps-switcher-mounted-and-focus-honest', () => {
  const menu = readStaff('StaffAccountMenu.tsx');
  // The panel stays mounted while closed: an unsaved new-organization name
  // or a pending creation nonce inside the parent switcher must not be
  // silently lost by Escape or an outside press.
  assert.match(menu, /hidden=\{!open\}/);
  assert.doesNotMatch(menu, /\{open \? \(\s*\n?\s*<div/);
  const css = readStaff('staff-account-menu.module.css');
  assert.match(css, /\.menuPanel\[hidden\] \{\s*display: none;/);
  // Only Escape and the explicit close button return focus to the trigger;
  // an outside press keeps whatever the operator actually pressed.
  assert.match(menu, /requestClose\("escape"\)/);
  assert.match(menu, /requestClose\("explicit"\)/);
  assert.match(menu, /requestClose\("outside"\)/);
  assert.match(menu, /closeModeRef\.current !== "outside"/);
});

test('staff-account-menu-shows-account-and-expands-the-parent-switcher', () => {
  const menu = readStaff('StaffAccountMenu.tsx');
  // The actual parent switcher, imported from the shared path — no local
  // organization settings menu is introduced here.
  assert.match(menu, /import OrganizationSwitcher from "\.\.\/OrganizationSwitcher"/);
  assert.match(menu, /<OrganizationSwitcher confirmLeave=\{confirmLeave\} \/>/);
  assert.doesNotMatch(menu, /조직 설정|새 조직|organization settings/i);
  assert.doesNotMatch(menu, /\/console\/settings/);
  // Account, current operating organization, and role stay visible.
  assert.match(menu, /context\.userName/);
  assert.match(menu, /context\.organizationName/);
  assert.match(menu, /staffRoleLabel\(context\.role\)/);
  // The holder's own recovery entry lives beside the account facts: a plain
  // same-origin link to the signed-in account page — no org scope, role, or
  // membership read, and no organization settings surface.
  assert.match(menu, /href="\/account\/email"/);
  assert.match(menu, /내 계정 이메일 인증/);
  assert.doesNotMatch(menu, /\/console\/team|\/console\/settings/);
  // Leaving for the account page consults the account gate (never a bare
  // navigation that would strand retained receipts and drafts); the shared
  // switch gate stays the fallback.
  assert.match(menu, /confirmLeaveAccount\?:/);
  assert.match(menu, /onClick=\{handleAccountNavigate\}/);
  assert.match(menu, /const gate = confirmLeaveAccount \?\? confirmLeave;/);
  // Context failures surface with an explicit recheck, not a dead panel.
  // Authenticated-but-unselected is a selection prompt, never a failure.
  assert.match(menu, /refreshOperatorContext/);
  assert.match(menu, /다시 확인/);
  assert.match(menu, /운영사 선택 필요/);
  assert.match(menu, /isSelectionRequiredError\(snapshot\.error\)/);
  // Disclosure quality: 44px target, Escape, outside press, focus return
  // and focus-into-panel — without hijacking the primary scan flow.
  assert.match(menu, /aria-expanded/);
  assert.match(menu, /aria-haspopup="dialog"/);
  assert.match(menu, /role="dialog"/);
  assert.match(menu, /Escape/);
  assert.match(menu, /mousedown/);
  assert.match(menu, /triggerRef\.current\?\.focus\(\)/);
  const css = readStaff('staff-account-menu.module.css');
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /\.menuButton/);
  assert.match(css, /\.menuPanel/);
  // Token-only styling: no new hex colors, no new surfaces.
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}/);
});

test('staff-hub-keeps-chrome-and-never-auto-routes-on-changed-context', () => {
  const hub = readStaff('StaffHub.tsx');
  assert.match(hub, /useOperatorContextSnapshot/);
  assert.match(hub, /orgChanged/);
  assert.match(hub, /<StaffAccountMenu confirmLeave=\{confirmLeaveHub\} confirmLeaveAccount=\{confirmLeaveHub\} \/>/);
  assert.match(hub, /orgLineText/);
  assert.match(hub, /<OrganizationContextNotice confirmLeave=\{confirmLeaveHub\} \/>/);
  assert.match(hub, /from "\.\.\/OrganizationSwitcher"/);
  // The single-assignment shortcut fires at most once and never on a
  // changed context, when the loaded scopes may belong to the old org.
  assert.match(hub, /shouldAutoRouteStaffHub\(\{/);
  assert.match(hub, /contextChanged: orgChanged/);
  assert.match(hub, /autoRoutedRef/);
  assert.match(hub, /scopeCount: state\.kind === "ready" \? state\.scopes\.length : 0/);
  // Event links stand down while changed; reads (reload) stay enabled.
  assert.match(hub, /다른 탭에서 조직이 전환됐습니다\. 위 안내에서 전환을 먼저 확인하세요\./);
  assert.match(hub, /다시 불러오기/);
  // The hub holds no drafts and issues no writes: only an in-flight
  // bootstrap blocks the switch gate.
  assert.match(hub, /function confirmLeaveHub/);
  assert.match(hub, /state\.kind !== "loading"/);
  // Selection-required is not a failure and never a logout: the org line
  // prompts for selection, and the only login redirect stays on 401, so no
  // redirect loop can form around an unselected organization.
  assert.match(hub, /describeWorkingOrg\(null, false, true\)/);
  assert.match(hub, /isSelectionRequiredError\(orgSnapshot\.error\)/);
  assert.strictEqual((hub.match(/router\.push/g) || []).length, 1);
  assert.match(hub, /if \(res\.status === 401\)[\s\S]{0,300}?router\.push/);
  assert.strictEqual((hub.match(/\{chrome\}/g) || []).length, 5);
});

test('staff-event-work-locks-writes-retains-state-and-warns-explicitly', () => {
  const work = readStaff('StaffEventWork.tsx');
  assert.match(work, /useOperatorContextSnapshot/);
  // Fixed current-org line near the risk work region, in every branch.
  // The menu also consults the account gate: leaving for the holder's own
  // recovery page must not strand retained receipts and drafts.
  assert.match(work, /<StaffAccountMenu confirmLeave=\{confirmLeaveStaff\} confirmLeaveAccount=\{confirmLeaveAccountPage\} \/>/);
  assert.match(work, /orgLineText\(\)/);
  assert.match(work, /describeWorkingOrg\(\s*orgSnapshot\.context,\s*orgSnapshot\.loading,/);
  assert.match(work, /isSelectionRequiredError\(orgSnapshot\.error\)/);
  // The shared notice sits above the disabled work body on other-tab change.
  assert.match(work, /<OrganizationContextNotice confirmLeave=\{confirmLeaveStaff\} \/>/);
  // One lock covers correction-unresolved AND organization-changed; only
  // the same-request correction retry stays enabled through it.
  assert.match(work, /const writeLocked = correctionLocked \|\| orgChanged;/);
  assert.match(work, /disabled=\{writeLocked\}/);
  assert.match(work, /disabled=\{submitting \|\| writeLocked/);
  // Camera remains gated by readiness and organization/correction locks, and
  // also cannot replace the ticket while another scan is in flight.
  assert.match(work, /disabled=\{!ready \|\| writeLocked \|\| submitting\}/);
  assert.match(work, /다른 탭에서 조직이 전환됐습니다\. 입력한 티켓·사유와 선택·기록은 그대로 유지됩니다/);
  // No new correction starts after a change; the retry replays frozen context.
  assert.match(work, /if \(orgChanged\) return;/);
  assert.match(work, /disabled=\{correcting \|\| orgChanged \|\| !correctReason\.trim\(\)\}/);
  // Synchronous handler-level guards back every disabled attribute.
  assert.match(work, /submitting \|\| writeLocked \|\| !activeAssignment/);
  assert.match(work, /if \(orgChanged\) \{\s*\n\s*throw new Error\("다른 탭에서 조직이 전환됐습니다/);
  assert.match(work, /\{cameraOpen && ready && !orgChanged/);
  // Handlers never clear drafts, selections, records, or retained ids on a
  // context change; navigation stays manual everywhere.
  assert.doesNotMatch(work, /if \(orgChanged\)[\s\S]{0,200}?router\.(push|replace)/);
  // Leaving warns: the existing correction confirm is kept, and an
  // organization change with work at risk gets its own confirm. Staff-local
  // native dialogs are retained; console draft guards stay separate.
  assert.match(work, /staffWorkAtRisk\(\)/);
  assert.match(work, /떠나면 확인 중인 정정·입력을 잃을 수 있습니다/);
  assert.match(work, /beforeunload/);
  // After an explicitly confirmed, successful switch the shared UI owns the
  // exit: both native warnings stand down so the browser never double
  // prompts. The passive change itself erases nothing — no retained receipt,
  // draft, or selection is cleared before its own result is known.
  assert.match(work, /eventouch:organization-confirmed-exit/);
  assert.match(work, /confirmedExitRef = useRef\(false\)/);
  assert.strictEqual((work.match(/if \(confirmedExitRef\.current\) return;/g) || []).length, 2);
  assert.doesNotMatch(work, /if \(orgChanged\)[\s\S]{0,300}?pendingCorrectRef\.current = null/);
  assert.doesNotMatch(work, /if \(orgChanged\)[\s\S]{0,300}?setTicket\(""\)/);
  assert.doesNotMatch(work, /if \(orgChanged\)[\s\S]{0,300}?pendingScanIdRef/);
  // The changed-org retry replays the stored command id verbatim, so the
  // shared adapter's cross-version rebind guard can recognize and block a
  // stale-version replay; staff never mints a fresh id or a new org around
  // it. After an explicit return-to-A plus accept, the renewed version
  // re-enables the same stored id while every form ref stays intact.
  assert.match(work, /commandId: pending\.commandId/);
  // The switch gate blocks busy/uncertain writes even if the operator would
  // confirm; unsaved input asks once with existing wording and cancel
  // preserves everything.
  assert.match(work, /function confirmLeaveStaff/);
  assert.match(work, /const verdict = resolveStaffLeave\(staffLeaveState\(\)\);/);
  assert.match(work, /if \(!verdict\.allow\) return false;/);
  assert.match(work, /if \(verdict\.needsConfirm\)/);
  assert.match(work, /입력 중인 내용이 있습니다\. 조직을 전환하면/);
});

test('staff-account-navigation-uses-the-account-gate-not-the-switch-copy', () => {
  const work = readStaff('StaffEventWork.tsx');
  // The work screen owns one verdict input set read by both gates: the
  // switch keeps its pinned organization wording, the account gate names the
  // account page instead — never a cross-org switch for leaving to recovery.
  assert.match(work, /function staffLeaveState\(\): {/);
  assert.match(work, /const verdict = resolveStaffLeave\(staffLeaveState\(\)\);/);
  assert.match(work, /function confirmLeaveAccountPage\(\): boolean/);
  assert.match(work, /내 계정 페이지로 이동하면 이 화면의 입력이 유지되지 않을 수 있습니다\. 그래도 이동하시겠습니까\?/);
  assert.doesNotMatch(work, /내 계정 페이지로 이동하면[\s\S]{0,80}조직을 전환/);
  // All four menu mounts consult the account gate alongside the switch gate.
  assert.equal((work.match(/confirmLeaveAccount=\{confirmLeaveAccountPage\}/g) ?? []).length, 4);
  assert.match(work, /confirmLeave=\{confirmLeaveStaff\} confirmLeaveAccount=\{confirmLeaveAccountPage\}/);
});

test('staff-org-guard-executes-at-runtime', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(STAFF, 'staff-org-guard.ts')).href);
  const { resolveStaffLeave, shouldAutoRouteStaffHub, staffRoleLabel, describeWorkingOrg } = mod;
  // Role wording never leaks internal keys: unknown roles get Korean.
  assert.strictEqual(staffRoleLabel('STAFF'), '스태프');
  assert.strictEqual(staffRoleLabel('AGENCY'), '운영자');
  assert.strictEqual(staffRoleLabel('MANAGER'), '역할 확인 필요');
  assert.strictEqual(staffRoleLabel('SUPER'), '역할 확인 필요');
  assert.strictEqual(staffRoleLabel(null), '역할 확인 필요');
  assert.strictEqual(staffRoleLabel(''), '역할 확인 필요');
  // Busy or uncertain writes block even if the operator would confirm.
  assert.deepStrictEqual(
    resolveStaffLeave({ busyWrites: true, uncertainWrites: false, unsavedDraft: false }),
    { allow: false, needsConfirm: false }
  );
  assert.deepStrictEqual(
    resolveStaffLeave({ busyWrites: false, uncertainWrites: true, unsavedDraft: false }),
    { allow: false, needsConfirm: false }
  );
  assert.deepStrictEqual(
    resolveStaffLeave({ busyWrites: true, uncertainWrites: true, unsavedDraft: true }),
    { allow: false, needsConfirm: false }
  );
  // Unsaved drafts ask once; cancel preserves everything.
  assert.deepStrictEqual(
    resolveStaffLeave({ busyWrites: false, uncertainWrites: false, unsavedDraft: true }),
    { allow: true, needsConfirm: true }
  );
  // Clean screens switch without friction.
  assert.deepStrictEqual(
    resolveStaffLeave({ busyWrites: false, uncertainWrites: false, unsavedDraft: false }),
    { allow: true, needsConfirm: false }
  );
  // Auto-route only for a single ready scope on an unchanged context, once.
  assert.strictEqual(
    shouldAutoRouteStaffHub({ ready: true, scopeCount: 1, contextChanged: false, alreadyRouted: false }),
    true
  );
  assert.strictEqual(
    shouldAutoRouteStaffHub({ ready: true, scopeCount: 1, contextChanged: true, alreadyRouted: false }),
    false
  );
  assert.strictEqual(
    shouldAutoRouteStaffHub({ ready: true, scopeCount: 1, contextChanged: false, alreadyRouted: true }),
    false
  );
  assert.strictEqual(
    shouldAutoRouteStaffHub({ ready: true, scopeCount: 2, contextChanged: false, alreadyRouted: false }),
    false
  );
  assert.strictEqual(
    shouldAutoRouteStaffHub({ ready: false, scopeCount: 0, contextChanged: false, alreadyRouted: false }),
    false
  );
  // Fixed org line copy in all states, including selection-required.
  assert.strictEqual(
    describeWorkingOrg({ organizationName: '봄 행사', role: 'STAFF' }, false, false),
    '현재 작업 조직: 봄 행사 · 스태프'
  );
  assert.strictEqual(
    describeWorkingOrg({ organizationName: '봄 행사', role: 'AGENCY' }, true, false),
    '현재 작업 조직: 봄 행사 · 운영자'
  );
  assert.strictEqual(describeWorkingOrg(null, true, false), '현재 작업 조직을 확인하고 있습니다.');
  assert.strictEqual(
    describeWorkingOrg(null, false, false),
    '현재 작업 조직을 불러오지 못했습니다. 계정 메뉴에서 다시 확인하세요.'
  );
  assert.strictEqual(describeWorkingOrg(null, false, true), '운영사 선택 필요');
  assert.strictEqual(describeWorkingOrg(null, true, true), '운영사 선택 필요');
  // Selection-required signal mirrors the shared adapter contract.
  const { isSelectionRequiredError } = mod;
  assert.strictEqual(isSelectionRequiredError('조직을 선택하세요'), true);
  assert.strictEqual(isSelectionRequiredError(null), false);
  assert.strictEqual(isSelectionRequiredError('작업자 정보를 불러오지 못했습니다'), false);
  assert.strictEqual(isSelectionRequiredError(''), false);
});
