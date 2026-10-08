const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

globalThis.ETKO = undefined;
require('../features/agency.js');
require('../features/booths.js');

function resetWorkspace() {
  ETKO.switchEvent('evt-1');
  const ws = ETKO.workspace();
  ws.boothMode = 'SELF';
  ws.booths = [];
  ws.visits = [];
  if (typeof ETKO.setBoothMode === 'function') ETKO.setBoothMode('SELF');
  return ws;
}

describe('booths lifecycle', () => {
  beforeEach(resetWorkspace);

  it('brief snippet: payload format and acknowledge refusal', () => {
    assert.equal(ETKO.boothPayload('evt-1', 'b1'), 'ET:BOOTH:evt-1:b1');
    assert.throws(() => ETKO.setEventBoothMode('STAFF', {}), /확인하세요/);
  });

  it('mode switch requires acknowledge and locks after visits', () => {
    assert.equal(ETKO.setEventBoothMode('STAFF', { acknowledge: true }), 'STAFF');
    assert.equal(ETKO.workspace().boothMode, 'STAFF');
    const booth = ETKO.saveBooth({ name: '체험부스', capacity: 10, limit: 1, status: 'OPEN' });
    const participant = ETKO.workspace().participants[0];
    ETKO.stamp({ boothId: booth.id, participantId: participant.id });
    assert.throws(
      () => ETKO.setEventBoothMode('SELF', { acknowledge: true }),
      /인증 기록이 있는 행사는 방식을 변경할 수 없습니다/
    );
  });

  it('saveBooth refuses capacity below issued count', () => {
    const booth = ETKO.saveBooth({ name: '체험부스', capacity: 5, limit: 2, status: 'OPEN' });
    const ws = ETKO.workspace();
    const p = ws.participants[0];
    ETKO.stamp({ boothId: booth.id, participantId: p.id });
    ETKO.stamp({ boothId: booth.id, participantId: p.id });
    assert.throws(() => ETKO.saveBooth({ id: booth.id, name: '체험부스', capacity: 1, limit: 2, status: 'OPEN' }), /발급/);
  });

  it('stamp validates status, time window, capacity and per-person limit', () => {
    const ws = ETKO.workspace();
    const p = ws.participants[0];
    const waiting = ETKO.saveBooth({ name: '대기부스', capacity: 5, limit: 2, status: 'WAITING' });
    assert.throws(() => ETKO.stamp({ boothId: waiting.id, participantId: p.id }), /운영/);
    ETKO.setBoothStatus(waiting.id, 'OPEN');
    const timed = ETKO.saveBooth({
      name: '시간부스', capacity: 5, limit: 2, status: 'OPEN',
      startsAt: '2026-10-01T10:00:00', endsAt: '2026-10-01T12:00:00',
    });
    assert.throws(
      () => ETKO.stamp({ boothId: timed.id, participantId: p.id, at: '2026-10-01T09:00:00' }),
      /운영 시간/
    );
    const one = ETKO.saveBooth({ name: '소진부스', capacity: 1, limit: 5, status: 'OPEN' });
    const visit = ETKO.stamp({ boothId: one.id, participantId: p.id });
    assert.equal(visit.boothId, one.id);
    assert.equal(visit.participantId, p.id);
    const q = ws.participants[1] || ws.participants[0];
    assert.throws(() => ETKO.stamp({ boothId: one.id, participantId: q.id }), /마감/);
    const limited = ETKO.saveBooth({ name: '제한부스', capacity: 10, limit: 1, status: 'OPEN' });
    ETKO.stamp({ boothId: limited.id, participantId: p.id });
    assert.throws(() => ETKO.stamp({ boothId: limited.id, participantId: p.id }), /1인/);
  });

  it('setBoothStatus rejects unknown booth and status', () => {
    assert.throws(() => ETKO.setBoothStatus('nope', 'OPEN'), /부스를 찾을 수 없습니다/);
    const booth = ETKO.saveBooth({ name: '상태부스', capacity: 5, limit: 1, status: 'OPEN' });
    assert.throws(() => ETKO.setBoothStatus(booth.id, 'BROKEN'), /부스 상태/);
  });
});
