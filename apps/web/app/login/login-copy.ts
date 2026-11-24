import { safeNextPath } from "../auth-redirect";

// Reopened 2026-11-24 (owner: 스태프 진입 시 현장 문구): the login speaks in
// field words only when the return destination is a staff area. The decision
// reuses safeNextPath, so an unsafe or foreign `next` never counts as staff
// and never opens a new redirect path; every other entry keeps the operator
// copy exactly.
export function isStaffReturn(next: unknown): boolean {
  const safe = safeNextPath(next);
  return safe === "/staff" || (safe !== null && safe.startsWith("/staff/"));
}

export type LoginCopy = {
  sectionLabel: string;
  bandLabel: string;
  promise: string;
  title: string;
};

export function loginCopy(next: unknown): LoginCopy {
  if (isStaffReturn(next)) {
    return {
      sectionLabel: "스태프 로그인",
      bandLabel: "스태프 로그인",
      promise: "오늘 배정받은 입장 업무를 열어요.",
      title: "스태프 로그인",
    };
  }
  return {
    sectionLabel: "운영 로그인",
    bandLabel: "운영 로그인",
    promise: "모집부터 결과까지, 행사 운영을 한곳에서.",
    title: "로그인",
  };
}

// The line under the title when a destination was requested (not shown when
// the session expired; that notice keeps its own wording).
export function returnNotice(next: unknown): string {
  return isStaffReturn(next)
    ? "운영자에게 받은 이메일과 비밀번호로 로그인하면 내 업무가 열립니다."
    : "로그인하면 요청하신 화면으로 돌아갑니다.";
}
