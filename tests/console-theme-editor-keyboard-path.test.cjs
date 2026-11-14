// 참가자 페이지 편집기 키보드 경로 (사용성 감사 후속):
// 편집 필드가 저장·게시 동작보다 앞에 몰려 있어 키보드로 초안 저장이
// 25 Tab 이상 걸렸다. 편집 폼 앞단의 보이는 이동 수단이 실제 저장
// 조작으로 포커스를 옮긴다. 기능 추가가 아니라 이동 수단만 늘리므로
// 서버 계약·커맨드·문구·정보량은 그대로다.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const theme = read('apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx');
const themeCss = read('apps/web/app/console/events/[id]/page/page.module.css');

function cssBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} styles exist`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `${selector} block closes`);
  return css.slice(open + 1, close);
}

// 2026-11-14 스튜디오 구성: 긴 폼 앞의 "저장 건너뛰기" 링크와 점프 탭을 없앴다.
// 설정은 짧은 목록(레이아웃·배경·행 4개)이고 행을 누르면 같은 자리에서 하위 패널이
// 열리므로, 저장 영역은 항상 그 아래 한 화면 안에 있다. 키보드 경로는 목록 → 행 →
// 하위 패널 → 크럼으로 돌아오기 → 저장 영역이다.
test('settings are a short list whose rows open sub-panels in place, never a long form', () => {
  const panelAt = theme.indexOf('<div className={studio.panel} id="theme-edit" tabIndex={-1}>');
  assert.ok(panelAt >= 0, 'the edit region keeps its anchor');
  assert.doesNotMatch(theme, /ConsoleSectionNav|data-skip-to="theme-save-draft"|jumpToSaveActions|IntersectionObserver/u, 'no jump nav or skip link');
  assert.match(theme, /const \[panel, setPanel\] = useState<null \| "banner" \| "text" \| "menus" \| "exposure">\(null\)/u);
  for (const row of ['"banner", "배너"', '"text", "제목과 문구"', '"menus", "홈 메뉴"', '"exposure", "소개와 공개 범위"']) {
    assert.ok(theme.includes(`studioRow(${row}`), `${row} is a settings row`);
  }
  assert.match(theme, /<button type="button" className=\{studio\.crumb\} onClick=\{\(\) => setPanel\(null\)\}>/u, 'a crumb returns to the list');
  assert.match(theme, /document\.getElementById\("theme-panel-title"\)\?\.focus\(\)/u, 'opening a panel moves focus to its heading');
});

test('the save region follows the settings in normal flow and the primary moves with the next step', () => {
  const regionAt = theme.indexOf('<div id="theme-save" tabIndex={-1} className={`${styles.saveAnchor} ${styles.saveBar}`}>');
  assert.ok(regionAt > theme.indexOf('<div className={studio.panel}'), 'the save region lives in the settings column');
  // Never a sticky overlay: the audit measured an overlay covering the last control on a phone.
  assert.match(themeCss, /\.saveBar\s*\{[^}]*position:\s*static/su);
  const saveButtonAt = theme.indexOf('초안 저장', regionAt);
  const publishButtonAt = theme.indexOf(': "게시 검토"', regionAt);
  assert.ok(saveButtonAt > regionAt && publishButtonAt > saveButtonAt, 'publish still follows save');
  assert.match(theme, /id="theme-save-draft" variant=\{dirty \|\| !canPublish \? "primary" : "secondary"\}/u, 'save is primary while there is something to save');
  assert.match(theme, /variant=\{!dirty && canPublish \? "primary" : "secondary"\} type="button" onClick=\{\(\) => void requestPublishDraft\(\)\}/u, 'publish review is primary once saved');
  assert.match(theme.slice(theme.indexOf('id="theme-save-draft"'), theme.indexOf('</ProductButton>', theme.indexOf('id="theme-save-draft"'))), /disabled=\{!canSave\}/u);
  assert.match(themeCss, /\.saveAnchor:focus \{/u, 'the programmatic focus target shows its outline');
  assert.doesNotMatch(cssBlock(themeCss, '.saveAnchor'), /#[0-9a-fA-F]{3,8}/u, 'landing target styles use tokens only');
});

test('editor controls remain discoverable and publication uses the reviewed command', () => {
  // Each sub-panel keeps a named fieldset (sr-only legend) so a screen reader hears the group.
  for (const name of ['배너', '제목과 문구', '메뉴 표시와 순서', '소개와 공개 범위']) {
    assert.match(theme, new RegExp(`<legend className="sr-only">${name}</legend>`, 'u'), `${name} remains a fieldset legend`);
  }
  for (const copy of ['되돌리기', '초안 저장', '게시하기']) {
    assert.ok(theme.includes(copy), `existing copy survives: ${copy}`);
  }
  // The only editor commands are draft save and guarded reviewed publication.
  const commands = [...theme.matchAll(/command: "(attendee\.[^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(commands, ['attendee.page.publish-reviewed', 'attendee.page.save']);
  // All reads go through the shared transport; the event read is the scoped
  // event bootstrap. The file upload builds its URL into a variable first
  // (consoleFetch(url, …)), so only the literal auth/scoped/command fetches
  // appear here.
  const fetches = [...theme.matchAll(/(?:consoleFetch|fetch)\(\s*[`"']([^`"']+)/gu)].map((match) => match[1]);
  assert.deepEqual(fetches, [
    '/api/auth/me',
    '/api/events/${encodeURIComponent(eventId)}/bootstrap',
    '/api/events/${encodeURIComponent(eventId)}/commands',
    '/api/events/${encodeURIComponent(eventId)}/commands',
  ]);
  assert.doesNotMatch(theme, /postCommand\(/u, 'no new command plumbing added');
  // Page-scoped denial names its own grant; the generic denial stays for
  // non-members.
  assert.match(theme, /참가자 화면 쓰기 권한이 없습니다/u);
  assert.match(theme, /이 행사의 참가자 화면을 관리할 권한이 없습니다/u);
});

test("the save control keeps the id the audits measure", () => {
  assert.match(theme, /id="theme-save-draft"/u);
  assert.match(theme, /tabIndex=\{-1\}/u);
});
