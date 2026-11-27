'use strict';

// Source contract only; rendered ordering and interaction require the isolated build audit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'apps/web/app/console/events/[id]');
const source = fs.readFileSync(path.join(root, 'EventOverview.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'event-overview.module.css'), 'utf8');

test('operator reading order puts work and actual metrics before the schedule', () => {
  const render = source.slice(source.indexOf('<div className={overview.canManageEvent ?'));
  const queue = render.indexOf('{!preparing && currentStage !== "ARCHIVED" ? nowSection : null}');
  const metrics = render.indexOf('headingId="event-metrics-heading"');
  const schedule = render.lastIndexOf('headingId="event-runbook-heading"');
  assert.ok(queue >= 0 && queue < metrics && metrics < schedule, 'active queue precedes metrics and schedule');
  assert.match(render, /!preparing && currentStage !== "ARCHIVED" \? nowSection : null/u, 'archived stage suppresses only the queue section');
  // Reopened 2026-11-27: before the event the queue is an exception strip above the board, shown only with items.
  assert.ok(render.indexOf('{preparing && nowItems.length ? nowSection : null}') < render.indexOf('{prepHero}'));
  assert.match(css, /"queue metrics" "runbook runbook"/);
  assert.match(css, /"queue" "metrics" "runbook"/);
});

test('finished and preparation priorities precede the schedule without an archived empty queue', () => {
  const render = source.slice(source.indexOf('<div className={overview.canManageEvent ?'));
  const status = render.indexOf('headingId="event-close-status-heading"');
  const queue = render.indexOf('{!preparing && currentStage !== "ARCHIVED" ? nowSection : null}');
  const metrics = render.indexOf('headingId="event-metrics-heading"');
  const schedule = render.lastIndexOf('headingId="event-runbook-heading"');
  assert.ok(status >= 0 && status < queue && queue < metrics && metrics < schedule);
  assert.match(render, /!preparing && currentStage !== "ARCHIVED" \? nowSection : null/u, 'archived events omit the active queue');
  assert.ok(schedule > metrics, 'schedule follows the metrics in JSX');
  assert.match(source, /preparing \? \(/u, 'preparation branch remains explicit');
  assert.match(source, /id="event-readiness-heading"/u, 'preparation keeps its readiness section');
  assert.match(render, /href=\{eventCloseHref\(eventId\)\}/);
  assert.match(render, /href=\{`\$\{base\}\/reports`\}/);
  assert.match(css, /"status status" "metrics metrics" "runbook runbook"/);
  assert.match(css, /"status" "metrics" "runbook"/);
});

test('overview retains accurate filters, counts and recovery surfaces', () => {
  assert.match(source, /status=PENDING/);
  assert.match(source, /const notEnteredRosterHref = `\$\{approvedRosterHref\}&attendance=NOT_ENTERED`;/);
  assert.match(source, /approvedRosterHref = `\$\{base\}\/participants\?status=APPROVED`/);
  assert.match(source, /overview\.everIn/);
  assert.match(source, /overview\.approved/);
  assert.match(source, /overview\.confirmedNotEntered/);
  for (const marker of ['기간 분석', '현재·다음 일정', '최근 입퇴장', '참가자 페이지 링크 복사', '이전에 불러온 내용은 유지됩니다']) {
    assert.ok(source.includes(marker), marker);
  }
});

// Overview design: approved 2026-11-13, reopened and redesigned by the owner on 2026-11-19 (readiness board before the event, entry board during it). See DESIGN.md "운영 현황 확정 구성"; change only with a new user decision.
test('approved overview design stays locked', () => {
  // Stage boards (2026-11-19): preparing = ring + counts + cards, live = dark entry card + four KPI cards.
  const boardCss = fs.readFileSync(path.join(root, 'event-overview-board.module.css'), 'utf8');
  // Reopened 2026-11-27 (owner: 화살표가 너무 많고 아래 영역이 쓸모없다): the readiness card holds the stage
  // steps, ring, go-live action and checklist; the count card holds counts, capacity bar and 14-day trend.
  assert.match(source, /\{prepHero\}\s*\{liveBoard\}/u);
  assert.doesNotMatch(source, /prepCards/u, 'no separate readiness section under the board');
  assert.match(source, /<ol className=\{board\.steps\} aria-label="진행 단계">/u, 'stage reads as steps, not an arrow sentence');
  assert.doesNotMatch(source, /<span aria-hidden="true"> → <\/span>/u);
  assert.match(source, /<Link variant="secondary" href=\{`\$\{base\}\/settings#settings-stage`\}>\{goLiveReady \? "진행 중으로 전환"/u, 'one go-live action in the board');
  assert.doesNotMatch(source, /ArrowRightIcon/u, 'no arrow glyphs on the overview');
  assert.match(boardCss, /\.ring \{[^}]*conic-gradient\(var\(--brand\)/su, 'readiness reads as a ring');
  assert.match(boardCss, /\.liveDark \{[^}]*var\(--ink\)/su, 'the live card is ink');
  assert.match(boardCss, /\.boardLayout\.boardLayout \{[^}]*align-items: stretch/su, 'the board stretches across the page');
  const queue = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/ConsoleTaskQueue.tsx'), 'utf8');
  // Entry: ink bar, one legend, one roster link, shared by live and finished summaries.
  assert.equal((source.match(/\{entryLegend\((true|currentStage !== "ARCHIVED")\)\}/g) || []).length, 2, 'live and finished share the legend');
  assert.equal((source.match(/className=\{styles\.liveRosterLinks\}/g) || []).length, 1, 'one legend block');
  assert.doesNotMatch(source, /styles\.(entryFoot|notEntered)\b/u, 'no roster tiles');
  assert.match(css, /\.entryFill \{[^}]*background: var\(--ink\)/su, 'progress reads in ink');
  assert.match(css, /\.entryRate \{\s*color: var\(--ink\)/u);
  // Header: one stage pill; intake and D-day are text.
  assert.match(css, /\.intakeBadge,\s*\.dDay \{[^}]*border: 0;[^}]*background: none/su);
  // Recent activity: Reopened 2026-11-20 (디자인 시스템 적용) — shared ListRow rows: avatar, name + action pill, desk, clock.
  for (const marker of ['styles.checkTime', 'styles.checkLine', '<ConsoleAvatar', '<StatusPill', '<ListRow']) assert.ok(source.includes(marker), marker);
  // Exactly one primary on live: the hero owns it, so the queue never adds another.
  // Reopened 2026-11-20: while live, the one orange action opens 현장 모드; before that it opens 입장 관리.
  assert.match(source, /<Link variant=\{live \? "primary" : "ghost"\} href=\{live \? `\$\{base\}\/live` : `\$\{base\}\/operations`\}>/u);
  assert.match(queue, /variant=\{index === 0 && !liveOverview \? "primary" : "ghost"\}/u);
  // Reopened 2026-11-27: each readiness row is one link (whole row), the destination name sits muted at the end.
  assert.match(source, /href=\{item\.href\}\s*data-state=\{item\.state\}/u);
  assert.match(source, /trailing=\{<span className=\{board\.checkGo\}>\{item\.action\}<\/span>\}/u);
  assert.equal((source.match(/key: "(intake|desk|program|page|message)"/g) || []).length, 5, 'five readiness cards');
  // The day schedule is a time bar on both board stages.
  assert.match(source, /<OverviewTimeline programs=\{overview\.programs\}/u);
});

test('compact work rows and mobile page action retain readable names and controls', () => {
  const queue = fs.readFileSync(path.join(__dirname, "..", "apps/web/app/console/console-ui/ConsoleTaskQueue.tsx"), "utf8");
  const queueCss = fs.readFileSync(path.join(__dirname, "..", "apps/web/app/console/console-ui/console-task-queue.module.css"), "utf8");
  assert.match(source, /<ConsoleTaskQueue items=\{nowItems\}/);
  assert.match(queue, /item\.hint \? <p className=\{styles\.hint\}>/);
  assert.match(source, /aria-label="참가자 페이지 열기"/);
  assert.match(source, /<ExternalLinkIcon className=\{styles\.pageLinkIcon\} \/>/);
  assert.match(source, /참가자 페이지 링크 복사/);
  assert.match(source, /href=\{eventCloseHref\(eventId\)\}/);
  assert.match(queueCss, /\.queue > li \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(queueCss, /\.action\s*\{[^}]*min-height: var\(--control-min-size\)/s);
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/tokens.css'), 'utf8');
  assert.match(tokens, /--control-min-size:\s*44px/u, 'shared control token retains the 44px floor');
  assert.match(css, /\.pageLinkIcon \{ display: inline-block; \}/);
  const shared = fs.readFileSync(path.join(__dirname, "..", "apps/web/app/console/console-ui/console-ui.module.css"), "utf8");
  assert.match(shared, /grid-template-areas: "back back" "context context" "title actions" "meta meta" "badges updated";/, "phone overview header keeps actions beside the title and the check time in the badge row");
});

// 2026-11-19: below the stage board each stage keeps only its own companions, as cards.
test('stage decks split the lower overview by event stage', () => {
  assert.match(source, /data-stage=\{preparing \? "prep" : live \? "live" : "done"\}/u, 'the canvas names its stage');
  assert.match(source, /preparing && overview\.canManageEvent && overview\.checksAvailable && overview\.recent\.length === 0 \? null/u, 'no empty entry log before the event');
  assert.match(source, /className=\{styles\.periodStat\}><small>오늘 신청<\/small>/u, 'the signup flow is number tiles');
  assert.match(source, /aria-label=\{`최종 입장률 \$\{overview\.entryRate\}%`\}/u, 'the final summary leads with the result ring');
  assert.match(css, /\.cardDeck\[data-stage="live"\] > \.regionRecent \{ grid-column: 2; grid-row: span 3; \}/u, 'live feed sits beside the schedule on desktop');
  assert.match(css, /@media \(min-width: 1101px\) \{\s*\.cardDeck\[data-stage="prep"\] > \.regionRunbook/u, 'two-column placement is desktop-only');
});

// Reopened 2026-11-24 (owner: 경품 대기 한 줄, 링 필수 기준). See DESIGN.md "운영 현황 확정 구성".
test('live "지금 할 일" counts 경품 지급 대기 with the same definition as 현장 모드', () => {
  const rewardStatus = fs.readFileSync(path.join(__dirname, '..', 'apps/web/lib/reward-status.ts'), 'utf8');
  const liveModel = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/events/[id]/live/live-model.ts'), 'utf8');
  // One bucket definition feeds both screens: 현장 모드 buckets rewards with rewardBucket === "waiting".
  assert.match(liveModel, /rewardBucket\(text\(reward\.status\), rewardParticipantIssue\(owner\)\)/u);
  assert.match(liveModel, /if \(bucket !== "waiting"\) continue;/u);
  assert.match(rewardStatus, /else if \(bucket === "waiting"\) counts\.waiting \+= 1;/u);
  assert.match(source, /rewardWaiting: Array\.isArray\(event\.features\) && event\.features\.includes\("reward"\)\s*\? countRewardAttention\(workspace\)\?\.waiting \?\? null : null,/u, 'off or unreadable 경품 stays null');
  // Only while live, only above zero, and as a ghost link row, never a new primary.
  assert.match(source, /if \(live && overview\.rewardWaiting !== null && overview\.rewardWaiting > 0\) \{\s*nowItems\.push\(\{\s*key: "reward-waiting",\s*title: "경품 지급 대기",\s*count: `\$\{overview\.rewardWaiting\}건`,/u);
  const rowAt = source.indexOf('key: "reward-waiting"');
  const row = source.slice(rowAt, source.indexOf('});', rowAt));
  assert.match(row, /action: "경품 지급"/u);
  assert.match(row, /href: `\$\{base\}\/rewards`/u);
  assert.ok(source.indexOf('key: "approval"') < rowAt && source.indexOf('key: "message-attention"') < rowAt, 'it joins the same list after the existing 확인 필요 rows');
  // A lone waiting row reads as one amber line "지금 할 일 N"; otherwise the existing list and green idle line stay.
  assert.match(source, /const nowWarnLine = live && nowItems\.length === 1 && nowItems\[0\]\.key === "reward-waiting";/u);
  assert.match(source, /title=\{nowWarnLine \? `지금 할 일 \$\{nowItems\.length\}` : "지금 할 일"\}/u);
  assert.match(source, /"지금 확인할 운영 항목이 없습니다\."/u, 'no items keeps the green all-clear line');
  assert.match(css, /\.liveOverview \.queueWarn \{[^}]*border: 1px solid var\(--warning-line\)[^}]*background: var\(--warning-soft\)/su, 'amber line uses warning tokens');
  assert.match(css, /\.liveOverview \.queueIdle \{[^}]*background: var\(--success-soft\)/su, 'all-clear stays green');
  const queue = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/console-ui/ConsoleTaskQueue.tsx'), 'utf8');
  assert.match(queue, /variant=\{index === 0 && !liveOverview \? "primary" : "ghost"\}/u, 'the link is ghost on live');
});

test('preparation ring counts required items and says so in its name and sub line', () => {
  assert.match(source, /const requiredKeys = currentStage === "READY" \? \["intake", "desk"\] : \["intake"\];/u, 'required = 접수, plus 현장 준비 from 운영 준비');
  assert.match(source, /<div><strong>\{requiredDone\}<\/strong><span>\/\{requiredItems\.length\} 필수<\/span><\/div>/u);
  assert.match(source, /aria-label=\{`필수 항목 \$\{requiredItems\.length\}개 중 \$\{requiredDone\}개 완료, 선택 항목 \$\{optionalItems\.length\}개 중 \$\{optionalDone\}개 완료`\}/u);
  assert.match(source, /`필수 \$\{requiredDone\}\/\$\{requiredItems\.length\} · 선택 \$\{optionalDone\}\/\$\{optionalItems\.length\}\.\$\{optionalDone < optionalItems\.length \? " 선택 항목은 나중에 해도 됩니다\." : ""\}`/u);
  assert.match(source, /const readyPercent = requiredItems\.length \? Math\.round\(\(requiredDone \/ requiredItems\.length\) \* 100\) : 0;/u);
  assert.doesNotMatch(source, /준비 완료<\/span>|readyItems\.length\}<\/strong>/u, 'the old whole-list 0/5 ring is gone');
  assert.equal((source.match(/key: "(intake|desk|program|page|message)"/g) || []).length, 5, 'the five check cards stay');
});
