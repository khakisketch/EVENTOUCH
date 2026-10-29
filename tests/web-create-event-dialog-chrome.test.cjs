'use strict';

// Event create/duplicate sticky chrome: long forms keep an always-visible
// exit (header 닫기 + sticky footer) without touching shared CSS or other
// ConsoleDialog callers. Source-only pins; behavior proof stays with the
// parent integration audit (build/DB/browser owned by parent).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('ConsoleDialog sticky chrome is opt-in and shares the guarded close path', () => {
  const shell = read('app/console/console-ui/ConsoleDialog.tsx');
  assert.match(shell, /stickyChrome\?: boolean/u);
  assert.match(shell, /stickyChrome = false/u, 'default keeps existing callers identical');
  assert.match(shell, /closeLabel = "닫기"/u);
  // Non-sticky path stays byte-identical for all other callers.
  assert.match(shell, /<h2 id=\{headingId\}>\{title\}<\/h2>/u);
  assert.match(shell, /<div className="dialog-actions">\{footer\}<\/div>/u);
  // Sticky header exposes a visible close on the same gate as Escape/backdrop.
  assert.match(shell, /position: "sticky"/u);
  assert.match(shell, /top: "calc\(var\(--s5\) \* -1\)"/u);
  assert.match(shell, /bottom: "calc\(var\(--s5\) \* -1\)"/u);
  assert.match(shell, /background: "var\(--paper\)"/u);
  assert.match(shell, /padding: "var\(--s5\) clamp\(var\(--s3\), 4vw, var\(--s5\)\) var\(--s3\)"/u);
  assert.match(shell, /padding: "var\(--s3\) clamp\(var\(--s3\), 4vw, var\(--s5\)\) var\(--s5\)"/u);
  assert.match(shell, /borderBottom: "1px solid var\(--line\)"/u);
  assert.match(shell, /borderTop: "1px solid var\(--line\)"/u);
  assert.match(shell, /onClick=\{\(\) => requestClose\(\)\}/u, 'header close reuses busy+canClose gate');
  assert.match(shell, /disabled=\{busy\}/u);
  assert.match(shell, /\{closeLabel\}/u);
  assert.doesNotMatch(shell, /#[0-9a-fA-F]{3,8}\b/u, 'sticky chrome uses tokens only');
});

test('CreateEventDialog moves long-form actions to the sticky footer with exact form linkage', () => {
  const dialog = read('app/console/CreateEventDialog.tsx');
  assert.match(dialog, /stickyChrome/u, 'long form opts in');
  assert.match(dialog, /const isClientCreate = clientMode === "create" && !effectiveDuplicate/u);
  assert.match(dialog, /const isCopyView = duplicateOf !== null \|\| mode === "copy"/u, 'chrome name follows the chosen mode, not the resolved source');
  assert.match(dialog, /title=\{isClientCreate \? "새 고객사 등록" : isCopyView \? "행사 복제" : "새 행사 만들기"\}/u);
  assert.match(dialog, /<div className=\{styles\.createFooter\}>/u, 'sticky footer stays in owned wrapper');
  assert.match(dialog, /<span className=\{styles\.createWrap\}>새 고객사를 등록하면 이 행사의 고객사로 바로 선택됩니다/u, 'customer copy wraps locally, text unchanged');
  assert.match(dialog, /\$\{styles\.slugHint\} \$\{styles\.createWrap\}/u, 'address hint wraps locally, text unchanged');
  assert.match(dialog, /closest\("\.dialog"\)/u, 'subview switch finds the shared scroller');
  assert.match(dialog, /newClientNameRef\.current\?\.focus\(\)/u, 'first field keeps keyboard focus');
  assert.match(dialog, /scrollTo\(\{ top: 0 \}\)/u, 'subview switch returns to top so the description stays visible');
  assert.match(dialog, /\? isCopyView \? "복제하는 중입니다" : "만드는 중입니다"/u);
  assert.match(dialog, /: isCopyView \? "행사 복제" : "행사 만들기"/u);
  // Payload, endpoint, receipts and source guards stay on the resolved source.
  assert.match(dialog, /if \(mode === "copy" && duplicateOf === null && !selectedSource\)/u, 'copy without source stays a local error');
  assert.match(dialog, /effectiveDuplicate \? \{\} : \{ clientId/u);
  assert.match(dialog, /\/api\/events\/\$\{encodeURIComponent\(effectiveDuplicate\.id\)\}\/duplicate/u);
  assert.match(dialog, /JSON\.stringify\(\[effectiveDuplicate\?\.id \?\? null, payload\]\)/u);
  assert.match(dialog, /const eventFormId = "create-event-form"/u);
  assert.match(dialog, /const clientFormId = "create-client-form"/u);
  assert.match(dialog, /<form id=\{clientFormId\} onSubmit=\{saveNewClient\}/u);
  assert.match(dialog, /<form id=\{eventFormId\} onSubmit=\{onSubmit\}/u);
  assert.match(dialog, /<button type="submit" form=\{clientFormId\}/u, 'footer submit stays wired to its form');
  assert.match(dialog, /<button type="submit" form=\{eventFormId\}/u);
  assert.match(dialog, /onClick=\{cancelClientCreate\}/u);
  assert.match(dialog, /onClick=\{close\}/u, 'footer cancel keeps the canClose gate');
  // No in-form action rows remain: the footer owns the only actions.
  const formBodies = dialog.split(/<form id=\{/).slice(1);
  for (const body of formBodies) {
    const chunk = body.slice(0, body.indexOf('</form>'));
    assert.doesNotMatch(chunk, /<ConsoleFormActions/u, 'actions live in footer, not in scroll content');
  }
  // Guards, receipts, focus and copy stay untouched.
  assert.match(dialog, /<ConsoleDialog/u);
  assert.match(dialog, /canClose=\{canClose\}/u);
  assert.match(dialog, /busy=\{submitting\}/u);
  assert.match(dialog, /initialFocusRef=\{nameRef\}/u);
  assert.match(dialog, /submitGateRef\.current/u);
  assert.match(dialog, /clientWriteRef\.current/u);
  assert.match(dialog, /commandIdRef\.current/u);
  assert.match(dialog, /pendingClientRef\.current/u);
  assert.match(dialog, /newClientNameRef\.current\?\.focus/u);
  assert.match(dialog, /clientSelectRef\.current\?\.focus/u);
  assert.match(dialog, /sourceSelectRef\.current\?\.focus/u);
  assert.match(dialog, /같은 요청으로 다시 시도/u);
  assert.match(dialog, /같은 요청으로 다시 시도해 결과를 확인한 뒤에 바꾸세요/u);
  assert.doesNotMatch(dialog, /#[0-9a-fA-F]{3,8}\b/u, 'dialog adds no color literals');
});

test('create form keeps scroll margin under the fixed bars with tokens only', () => {
  const css = read('app/console/console-home.module.css');
  assert.match(css, /\.createForm\s*\{[^}]*min-width:\s*0/su);
  assert.match(css, /\.createForm :where\(input, select, textarea, button/u);
  assert.match(css, /scroll-margin-top:\s*calc\(var\(--s5\) \* 2 \+ var\(--s7\)\)/u);
  assert.match(css, /scroll-margin-bottom:\s*calc\(var\(--s5\) \* 2 \+ var\(--s7\) \+ var\(--s8\)\)/u);
  assert.match(css, /\.createFooter\s*\{[^}]*min-width:\s*0/su);
  assert.match(css, /\.createWrap\s*\{[^}]*word-break:\s*keep-all/su, 'local copy keeps syllables together');
  assert.match(css, /\.createWrap\s*\{[^}]*overflow-wrap:\s*break-word/su);
  assert.match(css, /@media \(max-width: 480px\)/u);
  assert.match(css, /\.createFooter\s*\{[^}]*flex:\s*1 1 auto[^}]*width:\s*100%/su, 'narrow parent flex item takes the full footer width');
  assert.match(css, /\.createFooter > div\s*\{[^}]*width:\s*100%/su, 'narrow buttons container fills the footer');
  assert.match(css, /\.createFooter > div > div\s*\{[^}]*flex:\s*1 1 auto/su);
  assert.match(css, /\.createFooter > div > div\s*\{[^}]*width:\s*100%/su);
  assert.match(css, /\.createFooter\.createFooter :global\(\.button\)/u, 'narrow override wins without touching shared CSS');
  assert.match(css, /flex:\s*1 1 0/u);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'chrome helper uses tokens only');
  assert.doesNotMatch(css, /!important/u, 'no important; specificity wins');
});

test('event-card-a2 audit proves sticky chrome in an isolated browser without weakening guards', () => {
  const root = path.join(__dirname, '..');
  const audit = fs.readFileSync(path.join(root, 'scripts', 'web-event-card-a2-audit.cjs'), 'utf8');
  // Matrix covers new/duplicate, client subview, error and keyboard at 4 sizes.
  assert.match(audit, /stickyViewports/u);
  assert.match(audit, /width: 1280, height: 900/u);
  assert.match(audit, /width: 1280, height: 600/u);
  assert.match(audit, /width: 390, height: 844/u);
  assert.match(audit, /width: 320, height: 568/u);
  assert.match(audit, /stickyHitOk/u, 'center hit-test proves chrome does not cover the target');
  assert.match(audit, /elementFromPoint/u);
  assert.match(audit, /header close at /u);
  assert.match(audit, /footer cancel at /u);
  assert.match(audit, /footer submit at /u);
  assert.match(audit, /last field reachable at /u);
  assert.match(audit, /copy-without-source error at /u);
  assert.match(audit, /copy mode names itself before a source is chosen/u);
  assert.match(audit, /복제할 원본 행사를 선택하세요/u, 'error path stays local (no event created)');
  assert.match(audit, /dirty copy-error Escape asks at /u);
  assert.match(audit, /#create-date'\)\.fill\('2027-02-10'\)/u, 'required date filled through real UI past native validation');
  assert.match(audit, /client subview header close at /u);
  assert.match(audit, /client subview titles the actual task at /u);
  assert.match(audit, /client subview description stays readable at /u);
  assert.match(audit, /client subview first field stays reachable at /u);
  assert.match(audit, /narrow client footer does not over-occupy at /u);
  assert.match(audit, /narrow client actions share one row at /u);
  assert.match(audit, /narrow event footer does not over-occupy at /u);
  assert.match(audit, /narrow event actions share one row at /u);
  assert.match(audit, /narrow event actions use the footer width at /u);
  assert.match(audit, /narrow event buttons keep usable widths at /u);
  assert.match(audit, /narrow event button text renders without clipping at /u);
  assert.match(audit, /narrow event buttons stay height-balanced at /u);
  assert.match(audit, /wordRects/u, 'word Range rects prove no mid-syllable break');
  assert.match(audit, /address hint keeps keep-all wrapping at 320/u);
  assert.match(audit, /하이픈 stays on one line at 320/u);
  assert.match(audit, /customer description keeps keep-all wrapping at 320/u);
  assert.match(audit, /#create-event-title-description span/u, 'computed style read from the actual text span, not the shared wrapper');
  assert.match(audit, /stays on one line at 320/u);
  assert.match(audit, /narrow client actions use the footer width at /u);
  assert.match(audit, /narrow client button text renders without clipping at /u);
  assert.match(audit, /client subview back at /u);
  assert.match(audit, /client subview submit at /u);
  assert.match(audit, /Tab from client submit wraps to header close/u, 'single trap wrap kept');
  assert.match(audit, /Shift\+Tab from header close wraps to client submit/u);
  assert.match(audit, /dirty header close asks first/u, 'dirty confirm kept on the new header close');
  assert.match(audit, /저장하지 않고 닫을까요/u);
  assert.match(audit, /dialog-sticky-new-/u);
  assert.match(audit, /dialog-sticky-new-scrolled-/u);
  assert.match(audit, /dialog-sticky-copy-error-/u);
  assert.match(audit, /dialog-sticky-client-/u);
  assert.match(audit, /EVENTOUCH_CAPTURE_ROOT/u, 'captures stay under the existing capture root');
  // Existing behavior guards stay intact.
  assert.match(audit, /delayed duplicate still saves exactly one event/u);
  assert.match(audit, /lost response retried with the identical command id/u);
  assert.match(audit, /same-id retry replays exactly one record/u);
  assert.match(audit, /mode switch on an unresolved receipt/u);
  assert.match(audit, /console-390-final\.png/u, 'existing 390 capture kept');
  assert.match(audit, /no page errors through the audit/u);
});
