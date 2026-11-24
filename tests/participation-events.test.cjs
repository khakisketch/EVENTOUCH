'use strict';

// 참여 이벤트 (2026-11-20): one list for every participation content and stage draw. The life cycle is derived
// only from data that exists; a type without a reward path reports "na" instead of an invented state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lifecycleSegments, lifecycleSteps, eventPill, drawEventsSnapshot, EVENT_TEMPLATES, TEMPLATE_GROUPS } = require('../apps/web/lib/participation-events.ts');

const states = (segments) => segments.map((segment) => `${segment.key}:${segment.state}`).join(' ');

test('life cycle segments follow configured, run state, results and reward links', () => {
  assert.equal(states(lifecycleSegments({ status: 'DRAFT', configured: false, hasResult: false, rewardCount: null })), 'prepare:current run:todo result:todo reward:na');
  assert.equal(states(lifecycleSegments({ status: 'DRAFT', configured: true, hasResult: false, rewardCount: null })), 'prepare:done run:todo result:todo reward:na');
  assert.equal(states(lifecycleSegments({ status: 'OPEN', configured: true, hasResult: false, rewardCount: null })), 'prepare:done run:current result:todo reward:na');
  assert.equal(states(lifecycleSegments({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: 0 })), 'prepare:done run:done result:done reward:current');
  assert.equal(states(lifecycleSegments({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: 3 })), 'prepare:done run:done result:done reward:done');
  assert.equal(lifecycleSegments({ status: 'OPEN', configured: true, hasResult: false, rewardCount: 0 })[3].state, 'todo', 'a running event is not yet waiting on its reward');
});

test('the five-step header highlights the real current step', () => {
  const current = (facts) => lifecycleSteps(facts).find((step) => step.state === 'current')?.key ?? null;
  assert.equal(current({ status: 'DRAFT', configured: false, hasResult: false, rewardCount: null }), 'prepare');
  assert.equal(current({ status: 'DRAFT', configured: true, hasResult: false, rewardCount: null }), 'expose');
  assert.equal(current({ status: 'OPEN', configured: true, hasResult: false, rewardCount: 0 }), 'run');
  assert.equal(current({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: 0 }), 'reward');
  assert.equal(current({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: 2 }), null);
  assert.equal(current({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: null }), null, 'no reward path never waits on 경품');
  assert.equal(lifecycleSteps({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: null })[4].state, 'na');
  // Reopened 2026-11-24 (H5): step names match the row meter (준비 · 진행 · 결과 · 경품).
  assert.deepEqual(lifecycleSteps({ status: 'OPEN', configured: true, hasResult: false, rewardCount: 0 }).map((step) => step.label), ['준비', '공개', '진행', '결과', '경품']);
});

test('status pill: review beats run state, ready needs a saved configuration', () => {
  assert.deepEqual(eventPill({ status: 'OPEN', configured: true, hasResult: false, rewardCount: null }, 4), { tone: 'review', label: '검토 4' });
  assert.deepEqual(eventPill({ status: 'OPEN', configured: true, hasResult: false, rewardCount: null }), { tone: 'live', label: '진행 중' });
  assert.deepEqual(eventPill({ status: 'DRAFT', configured: true, hasResult: false, rewardCount: null }), { tone: 'ready', label: '준비 완료' });
  assert.deepEqual(eventPill({ status: 'DRAFT', configured: false, hasResult: false, rewardCount: null }), { tone: 'prep', label: '준비 중' });
  assert.deepEqual(eventPill({ status: 'CLOSED', configured: true, hasResult: true, rewardCount: 0 }), { tone: 'done', label: '종료' });
  assert.equal(eventPill({ status: 'WEIRD', configured: true, hasResult: false, rewardCount: null }).tone, 'check');
});

test('draw events list only what is configured and link rewards by source', () => {
  const empty = drawEventsSnapshot({});
  assert.deepEqual(empty.events, [], 'an empty workspace invents no draw rows');
  const snapshot = drawEventsSnapshot({
    drawPrograms: [{ id: 'dp1', name: '경품 추첨', quota: 5, moduleId: 'm-draw', status: 'CLOSED', winners: [{ name: 'a' }, { name: 'b', luckyNumber: 7 }], prizeTiers: [{ name: '1등', count: 1 }] }],
    teams: [{ id: 't1' }, { id: 't2' }],
    votes: [{ picks: ['t1'] }, { picks: ['t2'] }, { nothing: true }],
    voteConfig: { status: 'CLOSED', pickCount: 1, resultsPublished: true },
    rouletteConfig: { status: 'OPEN', startsAt: '2026-11-27T13:00:00+09:00', endsAt: null, prizes: [{ id: 'p1', label: '커피' }] },
    rouletteResults: [{ prizeId: 'p1' }],
    luckyNumbers: [{ participantId: 'x', number: 7 }],
    luckyConfig: { min: 1, max: 100 },
    rewards: [
      { id: 'r1', source: { kind: 'draw', programId: 'dp1', winnerIndex: 0 } },
      { id: 'r2', source: { kind: 'draw', programId: 'dp1', winnerIndex: 1 } },
      { id: 'r3', source: { kind: 'roulette', prizeId: 'p1' } },
    ],
  });
  const byKey = Object.fromEntries(snapshot.events.map((event) => [event.key, event]));
  assert.deepEqual(Object.keys(byKey).sort(), ['lucky', 'roulette', 'stage:dp1', 'vote']);
  assert.equal(byKey['stage:dp1'].rewardCount, 2);
  assert.equal(byKey['stage:dp1'].hash, '#draw-program-dp1', 'draws keeps its #draw-program-<id> handoff');
  assert.equal(byKey.vote.status, 'CLOSED');
  assert.equal(byKey.vote.count, 2, 'a vote record without picks is not counted');
  assert.equal(byKey.vote.rewardCount, null);
  assert.equal(byKey.roulette.status, 'OPEN');
  assert.equal(byKey.roulette.rewardCount, 1);
  assert.match(byKey.roulette.schedule, /11/u);
  assert.equal(byKey.lucky.hasResult, true, 'a stage draw with a lucky-number winner counts as the lucky result');
  assert.equal(byKey.lucky.rewardCount, 2);
  assert.equal(snapshot.moduleRewards['m-draw'], 2);
  assert.equal(snapshot.rewardTotal, 3);
});

test('template chooser offers only types that exist today, in three groups', () => {
  assert.deepEqual(TEMPLATE_GROUPS.map((group) => group.label), ['참여형', '추첨형', '미션형']);
  const labels = (group) => EVENT_TEMPLATES.filter((template) => template.group === group).map((template) => template.label);
  assert.deepEqual(labels('participate'), ['투표', '퀴즈', 'Q&A', '설문']);
  assert.deepEqual(labels('draw'), ['룰렛', '럭키번호', '간단 추첨', '무대 추첨', '순위 투표']);
  assert.deepEqual(labels('mission'), ['참여 사진', '참여 게시판']);
  for (const template of EVENT_TEMPLATES) assert.ok(template.description.endsWith('.'), `${template.label} has a one-line description`);
  assert.doesNotMatch(JSON.stringify(EVENT_TEMPLATES), /스탬프|빙고/u, 'unbuilt game types get no tile');
});
