'use strict';

// Multi-org messaging display contract: the current org's scoped
// integrations are the display authority. The process-shared /api/health
// messaging state belongs to the legacy org deployment and must never read
// as a new org's connection; health.verification is likewise server-global.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const STATE = read('server/state.js');
const PANELS = read('apps/web/app/console/team/OperationsPanels.tsx');
const MESSAGES = read('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx');

function loadParseOrgIntegrations() {
  const begin = '// __PARSE_ORG_INTEGRATIONS_BEGIN__';
  const end = '// __PARSE_ORG_INTEGRATIONS_END__';
  const from = MESSAGES.indexOf(begin);
  const to = MESSAGES.indexOf(end);
  assert.notEqual(from, -1, 'missing parse helper begin marker');
  assert.notEqual(to, -1, 'missing parse helper end marker');
  let helper = MESSAGES.slice(from + begin.length, to);
  helper = helper
    .replace(/export function parseOrgIntegrations/, 'function parseOrgIntegrations')
    .replace(/\(value: unknown\)/, '(value)')
    .replace(/\)\s*:\s*\{[^}]*\}\s*\{/, ') {')
    .replace(/\s+as Record<string, unknown> \| null/, '');
  const factory = new Function(`${helper}; return parseOrgIntegrations;`);
  const fn = factory();
  assert.equal(typeof fn, 'function', 'helper must evaluate to a function');
  return fn;
}

function loadIsNewOrgSimOnly() {
  const begin = '// __ORG_SIM_ONLY_BEGIN__';
  const end = '// __ORG_SIM_ONLY_END__';
  const from = MESSAGES.indexOf(begin);
  const to = MESSAGES.indexOf(end);
  assert.notEqual(from, -1, 'missing sim-only begin marker');
  assert.notEqual(to, -1, 'missing sim-only end marker');
  let helper = MESSAGES.slice(from + begin.length, to);
  helper = helper
    .replace(/export function isNewOrgSimOnly/, 'function isNewOrgSimOnly')
    .replace(/\(integrations: \{[^}]*\}\)/, '(integrations)')
    .replace(/\)\s*:\s*boolean/, ')');
  const factory = new Function(`${helper}; return isNewOrgSimOnly;`);
  const fn = factory();
  assert.equal(typeof fn, 'function', 'helper must evaluate to a function');
  return fn;
}

test('server keeps provider credentials on the legacy org only', () => {
  assert.match(
    STATE,
    /function integrationsForOrg\(orgId\)[\s\S]*?LEGACY_ORG_ID[\s\S]*?activeMessagingState\(\)/,
    'legacy org reports the deployment provider state'
  );
  assert.match(
    STATE,
    /\{ connected: false, sender: null, orgIsolated: true \}/,
    'new orgs report disconnected with no inheritance'
  );
  const scoped = STATE.match(/integrations: integrationsForOrg\(org\.orgId\)/g) ?? [];
  assert.ok(scoped.length >= 3, `directory, full, and scoped bootstraps carry per-org integrations (found ${scoped.length})`);
});

test('health stays a process-shared liveness signal, not an org truth', () => {
  const health = read('server/fastify/health.ts');
  assert.match(health, /getMessaging: \(\) =>/, 'messaging health is an injected process value');
  assert.match(health, /getVerificationMode: \(\) =>/, 'verification health is an injected process value');
  const server = read('server/server.js');
  assert.match(server, /getMessaging: \(\) => \(\{\s*\n?\s*connected: messagingStatus\.connected/, 'health wires the legacy deployment status');
});

test('team panel sources messaging display from the current-org directory', () => {
  assert.match(PANELS, /consoleFetch\("\/api\/console\/directory"/, 'directory is the org authority read');
  assert.match(PANELS, /dirData\?\.directory/, 'directory payload is read defensively');
  assert.match(PANELS, /dir\.integrations/, 'integrations come from the directory, not health');
  assert.match(PANELS, /문자·알림톡\(현재 조직\)/, 'messaging row names its org scope');
  assert.match(PANELS, /현재 조직의 연동 상태를 확인할 수 없습니다/, 'directory failure degrades explicitly');
  assert.doesNotMatch(PANELS, /health\.messaging \? `연결됨/, 'legacy health state never renders as the org connection');
  assert.match(PANELS, /참가자 인증번호\(서버 전역\)/, 'verification row names its global scope');
  assert.match(PANELS, /consoleFetch\("\/api\/bootstrap"/, 'organization-wide audit context read is kept');
  assert.match(PANELS, /자격증명·발신번호·승인 템플릿은 서버 환경에서 관리하며 화면에 입력하지 않습니다/, 'credential note is kept');
  assert.doesNotMatch(PANELS, /method: "POST"/, 'panels stay read-only: no org settings writes');
});

test('own-org send queue comes from owner-only diagnostics, never the global health count', () => {
  assert.doesNotMatch(PANELS, /healthData\.outboxPending/, 'removed global health count is never read');
  assert.doesNotMatch(PANELS, /health\.outboxPending/, 'removed global health count is never rendered');
  assert.match(PANELS, /viewerRole === "AGENCY"/, 'diagnostics is attempted for the AGENCY viewer only');
  assert.match(PANELS, /await fetch\("\/api\/diagnostics", \{ cache: "no-store" \}\)/, 'diagnostics uses a fenced plain fetch, never the drift-marking guarded transport');
  assert.doesNotMatch(PANELS, /consoleFetch\("\/api\/diagnostics"/, 'diagnostics denials cannot lock the screen as context drift');
  assert.match(PANELS, /diagData\?\.outboxPending/, 'only the own-org pending count renders');
  assert.match(PANELS, /현재 운영사 발송 대기/, 'queue row names its own-org scope');
  assert.match(PANELS, /소유자에게만 제공됩니다/, 'non-owners get an explicit unprovided state, not a global substitute');
  assert.match(PANELS, /확인할 수 없습니다/, 'owner-side denial or failure stays explicitly unknown');
});

test('message composer reads the scoped org integrations, never health', () => {
  assert.doesNotMatch(MESSAGES, /fetch\("\/api\/health"|consoleFetch\("\/api\/health"/, 'no health read in the composer');
  assert.match(MESSAGES, /const scopedIntegrations = parseOrgIntegrations\(bootstrap\.integrations\)/, 'scoped integrations land in state');
  assert.match(MESSAGES, /state\.integrations\.connected/, 'send-path display keys off scoped state');
  assert.match(MESSAGES, /현재 조직 발송 연결/, 'composer names the org scope of the connection line');
  assert.match(MESSAGES, /자동 발송은 지원하지 않습니다/, 'manual-execution copy is preserved');
  const simLock = MESSAGES.slice(MESSAGES.indexOf('const scopedIntegrations = parseOrgIntegrations'), MESSAGES.indexOf('canManage,', MESSAGES.indexOf('const scopedIntegrations = parseOrgIntegrations')));
  assert.match(simLock, /\{ \.\.\.current, simulate: true \}/, 'the lock only ever forces the flag on');
  assert.doesNotMatch(simLock, /channel/, 'the lock never rewrites the draft channel');
  assert.doesNotMatch(simLock, /selectedIds|selectedTemplateId/, 'the lock never touches selection');
  assert.match(MESSAGES, /channel: "SMS"/, 'default channel is untouched');
  assert.match(MESSAGES, /consoleFetch\("\/api\/auth\/me"/, 'effective role is re-read per load, never cached globally');
  assert.doesNotMatch(MESSAGES, /^let (cached|global|current)Role/m, 'no module-level role cache');
});

test('new orgs compose simulation-only; legacy disconnects keep NEEDS_CONNECTION', () => {
  assert.match(MESSAGES, /isNewOrgSimOnly\(scopedIntegrations\)/, 'refresh gates the lock on the scoped value');
  assert.match(MESSAGES, /\{ \.\.\.current, simulate: true \}/, 'the lock only ever forces the flag on');
  assert.equal((MESSAGES.match(/simulate: false/g) ?? []).length, 1, 'no other write ever clears the flag (single EMPTY_CAMPAIGN default)');
  assert.match(MESSAGES, /disabled=\{newOrgSimOnly\}/, 'the simulate toggle locks with the gate');
  assert.match(MESSAGES, /연결돼도 자동으로 바뀌지 않습니다/, 'no auto-enable on later connection');
  assert.match(MESSAGES, /새 운영사에는 발송 수단이 없으므로 모의 기록만 남습니다/, 'new-org mock-only copy is explicit');
  assert.match(MESSAGES, /연결 필요 상태로 기록됩니다\(모의 기록이 아닙니다\)/, 'legacy disconnects stay honest NEEDS_CONNECTION, not mock-only');
  const retry = MESSAGES.slice(MESSAGES.indexOf('async function executeRetry'), MESSAGES.indexOf('async function syncCampaign'));
  assert.match(retry, /storedSimulate = campaign\.simulate/, 'retries key off the stored campaign mode');
  assert.doesNotMatch(retry, /campaignDraft\.simulate/, 'retries never read the composer override');
  const simOnly = loadIsNewOrgSimOnly();
  assert.equal(simOnly({ orgIsolated: true, connected: false }), true, 'fresh disconnected org is simulation-only');
  assert.equal(simOnly({ orgIsolated: true, connected: true }), false, 'a connected org leaves the composer alone');
  assert.equal(simOnly({ orgIsolated: false, connected: false }), false, 'legacy disconnect keeps the attempt path');
  assert.equal(simOnly({ orgIsolated: false, connected: true }), false, 'legacy connected is untouched');
  assert.equal(simOnly({}), false, 'missing flags default to the legacy path, never the lock');
});

test('parseOrgIntegrations treats unknown shapes as disconnected', () => {
  const parseOrgIntegrations = loadParseOrgIntegrations();
  assert.deepEqual(
    parseOrgIntegrations({ connected: true, sender: '010-1234-5678', provider: 'solapi', alimtalkReady: true }),
    { connected: true, sender: '010-1234-5678', provider: 'solapi', orgIsolated: false }
  );
  assert.deepEqual(
    parseOrgIntegrations({ connected: false, sender: null }),
    { connected: false, sender: '', provider: '', orgIsolated: false }
  );
  assert.deepEqual(
    parseOrgIntegrations({ connected: false, sender: null, orgIsolated: true }),
    { connected: false, sender: '', provider: '', orgIsolated: true }
  );
  assert.deepEqual(parseOrgIntegrations(null), { connected: false, sender: '', provider: '', orgIsolated: false });
  assert.deepEqual(parseOrgIntegrations('solapi'), { connected: false, sender: '', provider: '', orgIsolated: false });
  assert.deepEqual(parseOrgIntegrations([]), { connected: false, sender: '', provider: '', orgIsolated: false });
  // A truthy non-true connected never upgrades the display.
  assert.equal(parseOrgIntegrations({ connected: 'yes' }).connected, false);
});
