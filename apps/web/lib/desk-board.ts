// 진행 중 데스크 보드: 데스크마다 처리 수와 마지막 처리 시각을 출입 기록에서 계산한다.
// 입장을 세는 기존 규칙과 같은 기준이다. 정정된 기록은 빼고, 같은 사람이 한 데스크에서
// 여러 번 처리돼도 한 명으로 세며(기간 분석의 고유 입장 정의), 취소된 참가자는 뺀다
// (운영 현황의 누적 입장이 취소를 빼는 것과 같다). 읽을 수 없는 기록은 숫자를 만들지 않는다.
// 이 모듈은 계산만 하고 화면·네트워크를 모른다.

export type DeskTally = { count: number; lastAt: string | null };

export type DeskBoardStats =
  | { available: false }
  | { available: true; byDesk: Record<string, DeskTally> };

type Desk = { id: string; action: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 취소된 참가자 id. 명단을 읽을 수 없으면 빈 집합이다(그때는 출입 기록만으로 센다). */
export function cancelledParticipantIds(participants: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(participants)) return ids;
  for (const person of participants) {
    if (!isRecord(person)) continue;
    const id = str(person.id);
    if (id && (str(person.status).toUpperCase() === "CANCELLED" || person.cancelled === true)) ids.add(id);
  }
  return ids;
}

/**
 * 데스크별 처리 수와 마지막 처리 시각.
 * - 처리 수: 그 데스크 방향(입장 데스크는 IN, 퇴장 데스크는 OUT)의 정정되지 않은 기록을 사람 기준으로 센다.
 * - 마지막 처리: 그 데스크의 정정되지 않은 기록 중 가장 늦은 시각(방향 무관).
 * `available`이 false이면 호출한 쪽이 숫자 대신 "확인 불가"를 보여야 한다.
 */
export function deskBoardStats(
  checks: unknown,
  available: boolean,
  desks: Desk[],
  cancelled: Set<string> = new Set(),
): DeskBoardStats {
  if (!available || !Array.isArray(checks) || !checks.every(isRecord)) return { available: false };
  const byDesk: Record<string, DeskTally> = {};
  const people = new Map<string, Set<string>>();
  const direction = new Map(desks.map((desk) => [desk.id, desk.action === "OUT" ? "OUT" : "IN"]));
  for (const desk of desks) {
    byDesk[desk.id] = { count: 0, lastAt: null };
    people.set(desk.id, new Set());
  }
  for (const check of checks) {
    const id = str(check.id);
    const deskId = str(check.deskId);
    if (!id || check.corrected === true || !byDesk[deskId]) continue;
    const at = str(check.at);
    const time = Date.parse(at);
    const tally = byDesk[deskId];
    if (Number.isFinite(time) && (tally.lastAt === null || time > Date.parse(tally.lastAt))) tally.lastAt = at;
    if (str(check.action) !== direction.get(deskId)) continue;
    const participantId = str(check.participantId);
    if (participantId && cancelled.has(participantId)) continue;
    people.get(deskId)!.add(participantId || id);
  }
  for (const desk of desks) byDesk[desk.id].count = people.get(desk.id)!.size;
  return { available: true, byDesk };
}

const CLOCK = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });

/** "방금", "N분 전", "N시간 전"; 6시간이 넘으면 시각. 시각을 읽을 수 없으면 null. */
export function processedAgo(at: string | null, now: number): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 6) return `${hours}시간 전`;
  const clock = CLOCK.format(new Date(time));
  return DAY.format(new Date(now)) === DAY.format(new Date(time)) ? clock : `${DAY.format(new Date(time))} ${clock}`;
}
