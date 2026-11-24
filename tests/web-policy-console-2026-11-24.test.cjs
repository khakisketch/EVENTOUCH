'use strict';

// 2026-11-24 policy backlog, console side (decisions 2, 3, 4, 10, 11, 12, 13).
// Source assertions plus one executed proof check; rendering and browser
// exercise belong to main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SETTINGS = read('apps/web/app/console/events/[id]/settings/SettingsWorkspace.tsx');
const SETTINGS_CSS = read('apps/web/app/console/events/[id]/settings/settings.module.css');
const LIST = read('apps/web/app/console/events/[id]/participants/ParticipantList.tsx');
const ERASE = read('apps/web/app/console/events/[id]/participants/PersonErase.tsx');
const MESSAGES = read('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx');

function operatorContext() {
  const ts = require(path.join(ROOT, 'apps/web/node_modules/typescript'));
  const output = ts.transpileModule(read('apps/web/lib/operator-context.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module_ = { exports: {} };
  vm.runInNewContext(output, {
    module: module_, exports: module_.exports, require: () => new Proxy({}, { get: () => () => undefined }),
    window: undefined, console, URL, JSON, Object, Array, Number, String, Math, Date, Set, Map, Promise, RegExp, Error, TypeError,
  });
  return module_.exports;
}

test('contact.save is proven by the stored value and cannot confirm a different one', () => {
  const { confirmsSettingsCommand } = operatorContext();
  assert.equal(confirmsSettingsCommand('contact.save', 'e1', { participantContact: ' 02-1  23 ' }, { participantContact: '02-1 23' }), true);
  assert.equal(confirmsSettingsCommand('contact.save', 'e1', { participantContact: '' }, { participantContact: '' }), true);
  assert.equal(confirmsSettingsCommand('contact.save', 'e1', { participantContact: '가' }, { participantContact: '나' }), false);
  assert.equal(confirmsSettingsCommand('contact.save', 'e1', { participantContact: 1 }, { participantContact: '' }), false);
  assert.equal(confirmsSettingsCommand('contact.save', 'e1', { participantContact: '가' }, null), false);
});

test('receipt recovery knows contact.save and participant.erase', () => {
  const lib = read('apps/web/lib/operator-context.ts');
  assert.match(lib, /"form\.close", "event\.stage", "contact\.save"\]\.includes\(pointer\.command\)/u);
  assert.match(lib, /pointer\.command === "participant\.erase"[\s\S]{0,400}erased\.erased === true/u);
});

test('settings: 참가자 문의처 sits at the top of 참가 접수 and saves through contact.save', () => {
  const intake = SETTINGS.slice(SETTINGS.indexOf('<ConsoleSection headingId="settings-intake"'));
  const contactAt = intake.indexOf('id="settings-contact"');
  assert.ok(contactAt > 0 && contactAt < intake.indexOf('styles.intakeBand'), 'the contact block precedes the intake band');
  assert.match(intake, /<label htmlFor="set-contact">참가자 문의처<\/label>/u);
  assert.match(SETTINGS, /runCommand\("contact\.save", \{ participantContact: next \}/u);
  assert.match(SETTINGS, /canWriteEvent\(capabilities, "contact\.save"\)/u);
  assert.match(SETTINGS, /const CONTACT_MAX = 200;/u);
  assert.match(SETTINGS, /"contact\.save": "참가자 문의처 저장"/u);
  assert.match(SETTINGS, /new Set\(\[[^\]]*"contact\.save"/u, 'an unconfirmed contact save is recoverable like the other settings commands');
  assert.match(SETTINGS, /failure\?\.field === "participantContact"/u);
  assert.match(SETTINGS_CSS, /\.contactBlock/u);
});

test('settings: the two preparation warnings use the confirmed wording and never block intake', () => {
  assert.match(SETTINGS, /참가자 문의처가 없습니다\. 티켓을 잃은 참가자가 연락할 곳이 없습니다\./u);
  assert.match(SETTINGS, /동의 안내가 기본 한 줄입니다\. 기본 동의 안내를 불러와 확인하세요\./u);
  assert.match(SETTINGS, /isLegacyDefaultConsentText\(consentText\)/u, 'the old one-liner is judged by the shared helper');
  // A venue contact that is really shown is not "no contact": the warning says so only when nothing is shown.
  assert.match(SETTINGS, /!state\.participantContact && !state\.recoveryContact/u);
  const publishAt = SETTINGS.indexOf('onClick={requestFormPublish}');
  const around = SETTINGS.slice(publishAt - 900, publishAt);
  assert.doesNotMatch(around, /participantContact|isLegacyDefaultConsentText/u, 'the publish button is not gated by the warnings');
});

test('settings: 기본 동의 안내 불러오기 fills the textarea from the shared template and publishes nothing', () => {
  assert.match(SETTINGS, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/consent-template"/u);
  assert.match(SETTINGS, /기본 동의 안내 불러오기/u);
  const fill = SETTINGS.slice(SETTINGS.indexOf('function fillDefaultConsent()'), SETTINGS.indexOf('function requestDefaultConsent()'));
  assert.match(fill, /consentTemplate\(state\.basics\.name, normalizeContact\(contactDraft\)\)/u);
  assert.match(fill, /setConsentText\(filled\)/u);
  assert.doesNotMatch(fill, /runCommand|consoleFetch/u, 'loading the template never sends a command');
  assert.match(SETTINGS, /기본 동의 안내는 법무 검토 전 초안입니다/u);
  assert.match(SETTINGS, /자동으로 파기하지는 않으니/u, 'no promise of automatic deletion');
  // A written notice is replaced only after a confirmation.
  assert.match(SETTINGS, /setTemplateConfirm\(true\)/u);
});

test('roster: 개인정보 삭제 is a separate bottom area behind a typed-name confirmation', () => {
  assert.match(LIST, /import PersonErase from "\.\/PersonErase"/u);
  assert.match(LIST, /canWriteEvent\(capabilities, "participant\.erase"\)/u);
  assert.match(LIST, /\|\| canEraseParticipant;/u, 'the details sheet opens after the event too');
  const sheet = LIST.slice(LIST.indexOf('className={styles.eraseZone}') - 200);
  assert.match(sheet, /aria-label="개인정보 삭제"/u);
  assert.match(sheet, /variant="destructive"/u);
  assert.ok(LIST.indexOf('id="roster-cancel-confirm"') < LIST.indexOf('className={styles.eraseZone}'), 'the erase area comes last in the sheet');
  assert.match(LIST, /selectedPerson\.erased \? <p role="note">개인정보가 삭제된 참가자입니다/u, 'edit, ticket and status actions are hidden once erased');
  assert.match(ERASE, /command: "participant\.erase", payload: attempt\.payload/u);
  assert.match(ERASE, /payload: \{ id: person\.id, expectedName: person\.name \}/u);
  assert.match(ERASE, /disabled=\{!matches \|\| busy/u, 'the destructive button waits for the typed name');
  assert.match(ERASE, /erased\.erased !== true/u, 'the response is proven before the receipt is released');
  assert.match(ERASE, /PARTICIPANT_ALREADY_ERASED/u);
  assert.doesNotMatch(ERASE, /button-secondary/u, 'no secondary buttons beyond the per-file ceiling');
});

test('roster: the status select is gone and the tabs reach every status', () => {
  assert.doesNotMatch(LIST, /전체 상태/u);
  assert.doesNotMatch(LIST, /roster-status-label/u);
  assert.match(LIST, /key: "cancelled", label: "취소된 신청", status: "CANCELLED"/u);
  assert.match(LIST, /key: "waitlist", label: "대기 명단", status: "WAITLIST"/u);
  assert.match(LIST, /waitlist: presetBase\.filter\(\(person\) => person\.status === "WAITLIST"\)\.length/u);
  assert.match(LIST, /cancelled: presetBase\.filter\(\(person\) => person\.status === "CANCELLED"\)\.length/u);
  // 승인 대기 + 참가 확정 + 대기 명단 + 신청 취소 cover every status, so the tab counts add up to 전체.
  assert.deepEqual(LIST.match(/const STATUSES = \[[^\]]*\]/u)[0].match(/"[A-Z]+"/gu), ['"PENDING"', '"APPROVED"', '"WAITLIST"', '"CANCELLED"']);
  assert.match(LIST, /const advancedActiveCount = \[groupFilter, attendanceFilter, ticketFilter\]/u, 'the filter badge counts only what the panel holds');
});

test('messages: the mock-send default follows the connection and respects what the operator chose', () => {
  assert.match(MESSAGES, /const simulateTouchedRef = useRef\(false\)/u);
  assert.match(MESSAGES, /else if \(!simulateTouchedRef\.current\) \{[\s\S]{0,400}const simulateByDefault = scopedIntegrations\.connected !== true;/u);
  assert.match(MESSAGES, /simulateTouchedRef\.current = true; setCampaignDraft\(\{ \.\.\.campaignDraft, simulate: event\.target\.checked/u, 'the checkbox marks the choice as the operator\'s');
  assert.match(MESSAGES, /campaignDraft\.simulate !== \(state\.kind === "ready" && state\.integrations\.connected !== true\)/u, 'the default alone is not unsaved work');
  assert.match(MESSAGES, /발송이 연결되지 않아 기본으로 켜져 있습니다/u);
});

test('terminology: 운영사 no longer appears in console screen copy', () => {
  const files = [
    'apps/web/app/OrganizationSwitcher.tsx',
    'apps/web/app/console/ConsoleShell.tsx',
    'apps/web/app/console/team/TeamWorkspace.tsx',
    'apps/web/app/console/team/OperationsPanels.tsx',
    'apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx',
    'apps/web/app/console/events/[id]/rewards/RewardsWorkspace.tsx',
    'apps/web/app/console/events/[id]/photos/EvidencePhotosWorkspace.tsx',
    'apps/web/app/invite/[token]/InviteAccept.tsx',
    'apps/web/app/ui/OperatorReceiptRecovery.tsx',
    'apps/web/lib/organization-selection.ts',
  ];
  for (const file of files) assert.doesNotMatch(read(file), /운영사/u, file);
  assert.match(read('apps/web/app/OrganizationSwitcher.tsx'), /조직을 추가했습니다/u);
});
