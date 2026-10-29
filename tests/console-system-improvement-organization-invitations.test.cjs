'use strict';

// Organization join/safety unit: existing-account invitations join with their
// own login (no password overwrite), null-role sessions route once to the
// explicit org picker, invite returns accept only validated /invite/<token>
// paths, shared-account resets fail closed with a self-recovery pointer, and
// the per-org membership write is owner-only, idempotent, and role-free.

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
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function loadSafeNextPath() {
  const source = read('apps/web/app/auth-redirect.ts');
  const begin = '// __SAFE_NEXT_PATH_BEGIN__';
  const end = '// __SAFE_NEXT_PATH_END__';
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  assert.notEqual(from, -1, 'missing safeNextPath begin marker');
  assert.notEqual(to, -1, 'missing safeNextPath end marker');
  let helper = source.slice(from + begin.length, to);
  helper = helper
    .replace(/export function safeNextPath/, 'function safeNextPath')
    .replace(/\(value: unknown\)/, '(value)')
    .replace(/\)\s*:\s*string \| null/, ')');
  const factory = new Function(`${helper}; return safeNextPath;`);
  const fn = factory();
  assert.equal(typeof fn, 'function', 'helper must evaluate to a function');
  return fn;
}

const TOKEN_40 = 'a'.repeat(40);
const TOKEN_128 = 'A'.repeat(128);

test('invite returns accept only validated bearer paths', () => {
  const safeNextPath = loadSafeNextPath();
  assert.equal(safeNextPath(`/invite/${TOKEN_40}`), `/invite/${TOKEN_40}`);
  assert.equal(safeNextPath(`/invite/${TOKEN_128}`), `/invite/${TOKEN_128}`);
  assert.equal(safeNextPath('/invite/'), null, 'bare prefix is not a token');
  assert.equal(safeNextPath('/invite'), null, 'prefix alone is not a token');
  assert.equal(safeNextPath(`/invite/${'a'.repeat(39)}`), null, 'short tokens rejected');
  assert.equal(safeNextPath(`/invite/${'a'.repeat(129)}`), null, 'long tokens rejected');
  assert.equal(safeNextPath(`/invite/${TOKEN_40}?next=/console`), null, 'query tails rejected');
  assert.equal(safeNextPath(`/invite/${TOKEN_40}#x`), null, 'hash tails rejected');
  assert.equal(safeNextPath(`/invite/${TOKEN_40}/extra`), null, 'extra segments rejected');
  assert.equal(safeNextPath('/invite/%2e%2e%2fadmin'), null, 'encoded tricks rejected');
  assert.equal(safeNextPath('/invite/..%2f..%2fetc'), null, 'encoded traversal rejected');
  assert.equal(safeNextPath('/invite/abc\\def'), null, 'backslashes rejected');
  assert.equal(safeNextPath(`//invite/${TOKEN_40}`), null, 'protocol-relative rejected');
  assert.equal(safeNextPath(`https://example.com/invite/${TOKEN_40}`), null, 'external rejected');
  assert.equal(safeNextPath('/console'), '/console');
  assert.equal(safeNextPath('/console/events/e1'), '/console/events/e1');
  assert.equal(safeNextPath('/staff'), '/staff');
  assert.equal(safeNextPath('/login'), null);
  assert.equal(safeNextPath('/api/bootstrap'), null);
});

test('null-role sessions route once to the picker, never back to login', () => {
  const guard = read('apps/web/app/auth-redirect.ts');
  assert.match(guard, /\/console\?chooseOrganization=1/, 'picker destination is exact');
  const chooser = bodyBetween(guard, 'export function chooseOrganizationHref', '}\n');
  assert.match(chooser, /safe\.startsWith\("\/invite\/"\)/, 'only invite returns survive the handoff');
  const form = read('apps/web/app/login/LoginForm.tsx');
  assert.match(form, /from "\.\.\/\.\.\/lib\/operator-context"/, 'reset comes from the published context module');
  assert.match(form, /resetOperatorContext\(\);[\s\S]*?router\.replace\(chooseOrganizationHref\(safeRequested\)\)/, 'restore drops pinned context before handing off');
  assert.match(form, /loginEpochRef\.current !== epochAtStart[\s\S]*?resetOperatorContext\(\);[\s\S]*?router\.replace\(destination\)/, 'restore epoch guard runs before the reset, so stale reads cannot clear a fresh sign-in');
  assert.match(form, /loginEpochRef\.current \+= 1;[\s\S]*?resetOperatorContext\(\);[\s\S]*?router\.push\(destination\)/, 'submit moves the epoch before reset and push: single sign-in POST, no duplicate');
  assert.match(form, /chooseOrganizationHref\(safeRequested\)/, 'submit hands off the same way');
  assert.match(form, /if \(user && !role\)/, 'only the authenticated-but-unselected branch diverts');
  assert.match(form, /\/api\/auth\/login/);
  assert.match(form, /safeNextPath/);
  assert.match(form, /조직 관리자에게 재설정을 요청/);
  assert.doesNotMatch(form, /localStorage|sessionStorage/);
  assert.equal((form.match(/from "\.\.\/\.\.\/lib\/operator-context"/g) ?? []).length, 1, 'single operator-context import, no duplicate wiring');
});

test('zero-membership sessions are distinguishable and never loop to login', () => {
  const server = read('server/auth.js');
  assert.match(server, /code: 'NO_ORGANIZATION_MEMBERSHIP'/, 'stable machine code for the org-less identity');
  assert.match(server, /Login never mints a session for this state/, 'login cannot succeed without a membership');
  assert.match(server, /user: \{ id: user\.id, email: user\.email, name: user\.name \}/, '403 carries the identity for matching');
  const invite = read('apps/web/app/invite/[token]/InviteAccept.tsx');
  assert.match(invite, /denied\?\.code === "NO_ORGANIZATION_MEMBERSHIP"/, '403 is told apart from anonymous 401');
  assert.match(invite, /현재 계정에 소속된 조직이 없습니다/, 'org-less identity is named, not hidden');
  assert.match(invite, /서버에서 확인하므로, 수락하면 이 초대 조직에 소속됩니다/, 'server-authoritative matching is promised, not a login loop');
  assert.match(invite, /계정 정보를 읽지 못했습니다/, 'unreadable identity still attempts the server check');
  const login = read('apps/web/app/login/LoginForm.tsx');
  assert.match(login, /res\.status === 403/, 'restore reads the denial status, not just ok-ness');
  assert.match(login, /denied\?\.code === "NO_ORGANIZATION_MEMBERSHIP"/, 'restore distinguishes org-less from anonymous');
  assert.match(login, /router\.replace\(chooseOrganizationHref\(safeRequested\)\)/, 'org-less restores hand off once, never loop');
  assert.equal((login.match(/resetOperatorContext\(\);/g) ?? []).length, 4, 'reset runs before every login navigation: submit push, restore replace, null-role replace, 403 picker replace');
});

test('existing-account invitations join with their own login, never a password', () => {
  const invite = read('apps/web/app/invite/[token]/InviteAccept.tsx');
  assert.match(invite, /requiresSignIn === true/, 'existing-account branch is explicit');
  assert.match(invite, /새 비밀번호를 만들지 않고/, 'no password signup is promised');
  assert.match(invite, /기존 비밀번호는 그대로 유지됩니다/, 'no overwrite is promised');
  assert.match(invite, /body: JSON\.stringify\(\{\}\)/, 'accept carries no password for existing accounts');
  assert.match(invite, /INVITATION_LOGIN_REQUIRED/, 'unauthenticated accept recovers through login');
  assert.match(invite, /loginHref\(`\/invite\/\$\{token\}`\)/, 'recovery returns to the same token');
  assert.match(invite, /from "\.\.\/\.\.\/OrganizationSwitcher"/, 'post-accept selection embeds the parent switcher');
  assert.match(invite, /suggestedOrganizationId=\{/, 'target org is preselected, never auto-selected');
  assert.match(invite, /자동으로 이동하지 않습니다/, 'no automatic move is promised');
  assert.doesNotMatch(invite, /router\.(push|replace)|useRouter/, 'no programmatic navigation sneaks past the explicit select');
  assert.doesNotMatch(invite, /href="\/login"/, 'every login link keeps its return');
  // New-account password flow is preserved verbatim.
  assert.match(invite, /loginHref\(loginNextForRole\(invitation\.role, invitation\.eventId\)\)/);
  assert.match(invite, /if \(role === "STAFF"\) return "\/staff"/);
  assert.match(invite, /비밀번호가 일치하지 않습니다/);
  assert.match(invite, /팀 초대 수락/);
  assert.doesNotMatch(invite, /#[0-9a-fA-F]{3,8}\b/, 'invite adds no color literals');
  assert.doesNotMatch(invite, /localStorage|sessionStorage/);
  const page = read('apps/web/app/invite/[token]/page.tsx');
  assert.match(page, /requiresSignIn: invitation\.requiresSignIn === true/, 'public flag rides through to the client');
});

test('org membership disable is owner-only, idempotent, and role-free', () => {
  const team = read('apps/web/app/console/team/TeamWorkspace.tsx');
  assert.match(team, /이 운영사 소속 사용 중지/, 'explicit row action names the org scope');
  assert.match(
    team,
    /\/api\/auth\/organizations\/\$\{encodeURIComponent\(orgId\)\}\/members\/\$\{encodeURIComponent\(account\.id\)\}/,
    'member-only endpoint with both ids in the path'
  );
  const action = bodyBetween(team, 'function OrgMembershipDisableButton', '\n// Owner-only per-org membership reactivation.');
  assert.match(action, /active: false/, 'deactivation only');
  assert.match(action, /const attempt: FrozenMembershipAttempt = isRetry/, 'frozen id plus frozen body, reused on retry');
  assert.match(action, /body: JSON\.stringify\(attempt\.body\)/, 'retries replay the identical frozen body');
  assert.match(action, /expectedContextVersion/, 'optimistic org version rides along');
  assert.match(action, /ORGANIZATION_CONTEXT_CHANGED/, 'stale context is named');
  const stale = bodyBetween(action, 'data?.code === "ORGANIZATION_CONTEXT_CHANGED"', 'if (isDefinitiveClientError(res.status)) {');
  assert.match(stale, /if \(isRetry\)/, 'an uncertain retry is told apart from a fresh stale attempt');
  assert.match(stale, /원래 조직으로 되돌린 뒤 같은 요청으로 다시 시도하세요/, 'uncertain retry points back at the original org');
  assert.match(stale, /pendingRef\.current = null/, 'a fresh stale attempt clears its unused id');
  assert.doesNotMatch(action, /onStaleContext/, 'no auto reload or unmount on drift');
  assert.match(action, /ConsoleConfirm/, 'outward change confirms in place');
  assert.match(action, /다른 조직의 소속과 로그인에는 영향이 없습니다/, 'no cross-org effect is promised');
  assert.match(action, /현재 조직 정보를 확인할 수 없어/, 'unscoped shape explains instead of faking a button');
  assert.doesNotMatch(action, /\brole\b/, 'role change is impossible through this action');
  assert.match(team, /account\.id !== state\.userId && account\.active/, 'self rows and inactive rows offer no disable');
  assert.match(team, /organizationId/, 'org id comes from the directory viewer');
  assert.match(team, /const isOwner = role === "AGENCY" \|\| mine\?\.orgOwner === true;/u, 'owner gate is unchanged');
  assert.doesNotMatch(team, /x-eventouch-organization-id|x-eventouch-context-version/, 'no hand-rolled org headers; the parent guard owns transport');
  assert.doesNotMatch(team, /조직 (만들기|추가|생성)/, 'no org creation UI here');
});

test('shared-account resets fail closed and point at verified-email self-service', () => {
  const team = read('apps/web/app/console/team/TeamWorkspace.tsx');
  const dialog = bodyBetween(team, 'function ResetDialog({', 'function InviteDialog({');
  // Fail-closed task UI: once the shared effect is known, the reset task
  // itself closes off — no fields, no submit, footer 닫기 only.
  assert.match(dialog, /const \[sharedEffectBlocked, setSharedEffectBlocked\] = useState\(false\)/, 'blocked task state exists, default off');
  assert.match(dialog, /setPassword\(""\);\s*setConfirm\(""\);/, 'typed values are cleared with the block, nothing committed');
  assert.match(dialog, /setSharedEffectBlocked\(true\)/, 'definitive 403 arms the block exactly once');
  assert.match(dialog, /if \(submitGateRef\.current \|\| submitting \|\| sharedEffectBlocked\) return;/, 'submitter is dead once blocked');
  assert.match(dialog, /이 계정은 여기서 재설정할 수 없습니다/, 'blocked description promises no reset');
  assert.match(dialog, /재설정이 허용되는 계정은 성공하면 다른 기기에서 로그아웃됩니다/, 'pre-block wording scopes the logout promise to allowed accounts');
  assert.match(dialog, /sharedEffectBlocked \? \(/, 'blocked branch replaces fields and footer');
  assert.match(dialog, /<button type="button" className="button button-secondary" onClick=\{onClose\}>\s*닫기\s*<\/button>/, 'blocked footer is 닫기 only');
  assert.match(dialog, /\{sharedEffectBlocked \? \(\s*failure \? <ConsoleFeedback kind="error">\{failure\}<\/ConsoleFeedback> : null\s*\) : \(/, 'blocked body shows only the failure note — no fields, no submit');
  assert.doesNotMatch(dialog, /OrgMembershipDisableButton|setCampaignDraft|members\//, 'blocking never auto-disables a membership');
  const reset = bodyBetween(team, 'SHARED_ACCOUNT_GLOBAL_EFFECT', 'if (isDefinitiveClientError(res.status)) {');
  assert.match(reset, /pendingResetRef\.current = null/, 'definitive refusal clears the id, nothing stays ambiguous');
  // Approved direction ("이메일+수동 예외"): the blocked owner task points at
  // the holder's verified-email self-service on the login screen — never an
  // owner reset on their behalf — and names the manual-process limitation for
  // unverified locked accounts instead of promising a reset.
  assert.match(reset, /로그인 화면의 '이메일로 직접 재설정'으로 본인이 바꿀 수 있습니다/, 'verified-email self-service is pointed at');
  assert.match(reset, /별도 본인확인 절차가 정해질 때까지 재설정을 약속할 수 없습니다/, 'unverified locked accounts get the limitation, not a promise');
  assert.match(reset, /이 운영사에서만 사용 중지/, 'org-only disable names its scope');
  assert.match(reset, /팀 목록의 .이 운영사 소속 사용 중지./, 'the existing row action is pointed at, not duplicated');
  assert.doesNotMatch(reset, /재설정해 드립니다/, 'no owner reset on their behalf is promised');
  assert.match(team, /const isOwner = role === "AGENCY" \|\| mine\?\.orgOwner === true;/u, 'reset stays owner-only');
});
