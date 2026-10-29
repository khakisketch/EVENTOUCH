'use strict';

// Org role writes freeze the projected target-row revision on fresh intents
// and never overwrite a pending body: role-only bodies never carry `active`,
// retries replay the identical frozen body, stale context distinguishes an
// uncertain retry (keep id, point back at the original org) from a fresh
// stale attempt (clear id, keep draft), self demotion/role change is blocked
// while foreign work is pending, and a committed self change leaves only
// through an explicit fresh-me recheck.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function bodyBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

const team = () => read('apps/web/app/console/team/TeamWorkspace.tsx');
const roleOf = () => bodyBetween(team(), 'function OrgRoleEditorPanel(', 'function ResetDialog({');
const reactivateOf = () => bodyBetween(team(), 'function OrgMembershipReactivateButton(', '\n// Owner-only per-org role change.');
const disableOf = () => bodyBetween(team(), 'function OrgMembershipDisableButton(', 'function OrgRoleEditorPanel(');

test('fresh intents freeze projected target-row revision; never overwrite a pending body', () => {
  const role = roleOf();
  assert.match(role, /const pendingRef = useRef<FrozenMembershipAttempt \| null>\(null\)/, 'pending id and body travel together');
  assert.match(role, /const isRetry = stored !== null && stored\.fingerprint === fingerprint/, 'retries are detected, not re-minted');
  assert.match(role, /body: JSON\.stringify\(attempt\.body\)/, 'the frozen body is what travels');
  assert.match(role, /typeof account\.membershipVersion === "number"/, 'fresh intents freeze the projected target-row revision, not the actor session revision');
  assert.doesNotMatch(role, /freshExpectedVersion\(/, 'no actor-context fallback overwrites the target revision');
  assert.doesNotMatch(role, /body\.expectedContextVersion = contextVersion/, 'no stale prop version is written over a pending body');
  assert.match(role, /const freshBody: Record<string, unknown> = \{ role: roleDraft, commandId \};/, 'role-only body carries no active flag');
  assert.match(role, /if \(version !== null\) freshBody\.expectedContextVersion = version;/, 'projected target revision rides a fresh body only, omitted when absent');
  assert.doesNotMatch(role, /\bactive\b\s*:\s*(true|false)/, 'role writes never set the active flag');
});

test('pre-transmit context blocks retain only earlier unknown attempts, never a new unsent CAS body', () => {
  const source = team();
  for (const name of ['OrgMembershipDisableButton', 'OrgMembershipReactivateButton', 'OrgRoleEditorPanel', 'RevokeInviteButton']) {
    const from = source.indexOf(`function ${name}(`);
    assert.notEqual(from, -1);
    const next = source.indexOf('\nfunction ', from + 1);
    const body = source.slice(from, next === -1 ? undefined : next);
    assert.match(body, /const hadUncertainAttempt = retryable && pendingRef\.current !== null/);
    const block = body.slice(body.indexOf('if (isOrganizationContextBlock(error))'));
    assert.match(block, /if \(!hadUncertainAttempt\) \{\s*pendingRef\.current = null;\s*setRetryable\(false\)/);
    assert.match(block, /요청을 보내지 않았습니다/);
    assert.match(block, /원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요/);
  }
  assert.match(source, /setSelfDeparted\(true\);\s*noteCommittedOperatorRoleChange\(\)/, 'known self-role success locks the old authority synchronously, before any failed refresh');
});

test('stale context keeps an uncertain retry but clears a fresh stale attempt', () => {
  const role = roleOf();
  const stale = bodyBetween(role, 'if (data?.code === "ORGANIZATION_CONTEXT_CHANGED")', 'if (isDefinitiveClientError(res.status)) {');
  assert.match(stale, /if \(isRetry\)/, 'uncertain retry is told apart from a fresh stale attempt');
  assert.match(stale, /원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요/, 'uncertain retry points back at the original org');
  assert.match(stale, /최신 정보를 확인한 뒤 다시 시도하세요/, 'fresh stale asks for a fresh try, not a replay');
  assert.match(stale, /pendingRef\.current = null/, 'a fresh stale attempt clears its unused id');
  assert.doesNotMatch(stale, /onStaleContext/, 'no auto reload or unmount on drift');
});

test('pre-transmit drift never claims a network failure or mints a key', () => {
  const role = roleOf();
  assert.match(role, /if \(isOrganizationContextBlock\(error\)\)/, 'the shared adapter block is named');
  const blocked = bodyBetween(role, 'if (isOrganizationContextBlock(error)) {', '} finally {');
  assert.match(blocked, /원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요/, 'drift copy names the recovery, not the network');
  assert.match(blocked, /setRetryable\(true\)/, 'the stored id survives for the same-key retry');
  assert.doesNotMatch(blocked, /randomCommandId/, 'no new id is minted on a blocked write');
});

test('self demotion is blocked while foreign work is pending', () => {
  const role = roleOf();
  assert.match(role, /const foreign = foreignPendingWork\(\);/, 'a fresh snapshot is read before every self submit');
  assert.match(role, /if \(foreign > 0\) \{/, 'unrelated work blocks the transmission');
  assert.match(role, /진행 중이거나 결과 미확인인 작업을 먼저 확인한 뒤 본인 역할을 바꾸세요/, 'the block reason is exact');
  assert.match(role, /confirmForeignRef\.current = foreignPendingWork\(\)/, 'pre-confirm also snapshots for the warning');
  assert.match(
    role,
    /현재 진행 중이거나 결과 미확인인 작업 \$\{confirmForeignRef\.current\}건이 있습니다/,
    'the confirm warning names the pending count when known'
  );
  assert.doesNotMatch(role, /\/api\/auth\/logout|signOut/, 'no logout semantics anywhere in the self flow');
});

test('a committed self change locks drift immediately and defers to the central notice', () => {
  const role = roleOf();
  assert.match(role, /setSelfDeparted\(true\)/, 'success stages the departed state, never navigates');
  assert.match(role, /void refreshOperatorContext\(\)/, 'the lock engages immediately on the known commit');
  assert.match(
    role,
    /위의 운영사 문맥 안내에서 현재 역할을 확인/,
    'the departed panel points above at the central banner instead of its own button'
  );
  assert.doesNotMatch(role, /현재 역할 다시 확인/, 'no in-panel retry button that a lock could strand');
  assert.doesNotMatch(role, /async function recheckSelfRole/, 'no panel-local recheck: the central notice owns the GET-only retry');
  assert.doesNotMatch(role, /window\.location\.href/, 'no native navigation from the panel itself');
  assert.doesNotMatch(role, /observeSelectedOrganization/, 'no silent view swap from the panel');
  assert.doesNotMatch(role, /organization-confirmed-exit/, 'the confirmed exit is announced centrally, not here');
  assert.doesNotMatch(role, /\/api\/auth\/logout|signOut/, 'no logout semantics anywhere in the self flow');
});

test('role confirmation names target, from/to, and org scope without global effects', () => {
  const role = roleOf();
  assert.match(role, /이 운영사\(\$\{orgName \|\| orgId\}\)에만 적용/, 'org scope is explicit, not global');
  assert.match(role, /다른 조직·로그인·비밀번호에는 영향이 없습니다/, 'no cross-org effect is promised');
  assert.match(role, /본인 계정입니다/, 'self changes warn explicitly');
  assert.match(role, /\["AGENCY", "MANAGER", "STAFF"\]/, 'all three roles are selectable, including inactive rows');
  assert.match(role, /행사별 쓰기 권한은 바뀌지 않습니다/, 'MANAGER promotion grants no event access here');
  assert.match(role, /href="#team-event-permissions"/, 'the permission editor is linked, not bypassed');
  assert.match(role, /행사 배정/, 'STAFF keeps the existing assignment workflow');
  assert.match(role, /사용 중지 상태는 그대로 유지됩니다/, 'inactive rows stay inactive on role change');
});

test('reactivation is active-only, scoped, and frozen like deactivation', () => {
  const reactivate = reactivateOf();
  assert.match(reactivate, /이 운영사 소속 다시 활성화/, 'explicit row action for the inactive case');
  assert.match(reactivate, /const freshBody: Record<string, unknown> = \{ active: true, commandId \};/, 'active-only body carries no role');
  assert.doesNotMatch(reactivate, /\brole\b/, 'reactivation cannot change the role');
  assert.match(reactivate, /membership\.active !== true/, 'proven success echoes an active membership');
  assert.match(reactivate, /ORGANIZATION_CONTEXT_CHANGED/, 'same frozen stale handling as deactivation');
  assert.match(reactivate, /isOrganizationContextBlock\(error\)/, 'same pre-transmit drift handling as deactivation');
  assert.match(reactivate, /이 운영사에만 적용됩니다/, 'org scope is explicit, never global');
  assert.match(team(), /account\.id !== state\.userId && !account\.active/, 'reactivation shows only for inactive others');
});

test('known shared accounts get no password reset affordance', () => {
  const panels = team();
  assert.match(panels, /sharedAccount: boolean/, 'the Team DTO retains the shared-account flag');
  assert.match(panels, /sharedAccount: account\.sharedAccount === true/, 'the directory projection is kept verbatim');
  assert.match(panels, /account\.sharedAccount \?/, 'shared rows diverge before any reset affordance');
  assert.match(
    panels,
    /여러 조직에서 함께 사용 중이라 이 운영사에서 비밀번호를 재설정할 수 없습니다/,
    'the upfront note explains the boundary instead of offering a reset'
  );
  assert.match(panels, /SHARED_ACCOUNT_GLOBAL_EFFECT/, 'the authoritative 403 fallback stays for races');
});

test('last-owner denial preserves the operator’s inputs', () => {
  const role = roleOf();
  assert.equal((role.match(/setRoleDraft\(/g) || []).length, 1, 'the draft is set only by the radio input — failures never reset the choice');
});

test('role editor owns no cross-org or global side effects', () => {
  const role = roleOf();
  assert.doesNotMatch(role, /write_permissions|participants\.write/, 'no event-grant writes ride along');
  assert.doesNotMatch(role, /\/api\/events\//, 'no event command is issued from the role editor');
  assert.doesNotMatch(role, /조직 (만들기|추가|생성)/, 'no org creation UI here');
  assert.doesNotMatch(team(), /onStaleContext/, 'no auto reload or unmount wiring remains on the membership flows');
});

test('shared org directory is the projection of record', () => {
  const state = read('server/state.js');
  assert.match(state, /EXISTS \(SELECT 1 FROM organization_memberships m2 WHERE m2\.account_id = a\.id AND m2\.org_id <> \$1\) AS shared_account/, 'shared means any other-org membership, names never leak');
  assert.match(state, /sharedAccount: row\.shared_account === true/, 'the projection carries the boolean only');
  assert.match(state, /m\.active AS active/, 'row active is the org membership flag, not the global account flag');
});

test('invite dialog confirms org-wide grants before sending', () => {
  const panels = team();
  assert.match(panels, /<option value="AGENCY">조직 소유자<\/option>/, 'AGENCY is invitable by the owner');
  assert.match(panels, /조직 소유자는 이 운영사의 모든 행사·팀·설정을 관리할 수 있습니다/, 'org-wide scope is warned up front');
  assert.match(panels, /setAgencyStaged\(/, 'AGENCY invites stage a confirm instead of sending');
  assert.match(panels, /초대한다/, 'the staged confirm names the send');
});
