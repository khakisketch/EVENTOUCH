// Client navigation intent only. This is not a new event status, permission,
// report kind, or command. The API remains the authority for every write.
export function eventCloseHref(eventId: string, reportId?: string | null): string {
  const base = `/console/events/${encodeURIComponent(eventId)}/reports`;
  const query = reportId ? `?closeReport=${encodeURIComponent(reportId)}` : "";
  return `${base}${query}#event-close`;
}

export function readCloseReturn(raw: string | null, eventId: string): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\s]/.test(raw)) return null;
  try {
    const url = new URL(raw, "https://eventouch.invalid");
    if (url.origin !== "https://eventouch.invalid" || url.pathname !== `/console/events/${encodeURIComponent(eventId)}/reports` || url.hash !== "#event-close") return null;
    if ([...url.searchParams.keys()].some((key) => key !== "closeReport") || url.searchParams.getAll("closeReport").length > 1) return null;
    const reportId = url.searchParams.get("closeReport");
    if (reportId !== null && (!reportId || reportId.length > 200 || /[\s\\/]/.test(reportId))) return null;
    const canonical = eventCloseHref(eventId, reportId);
    return raw === canonical ? canonical : null;
  } catch {
    return null;
  }
}

export function closeHandoffHref(target: string, eventId: string, reportId?: string | null): string {
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const url = new URL(target, "https://eventouch.invalid");
  const allowed = ["settings", "participants", "programs", "draws", "messages", "reports"];
  if (url.origin !== "https://eventouch.invalid" || !allowed.some((page) => url.pathname === `${base}/${page}`)) throw new Error("Invalid event-close destination");
  url.searchParams.set("closeReturn", eventCloseHref(eventId, reportId));
  return `${url.pathname}${url.search}${url.hash}`;
}

export type CloseInputs = {
  stage: string;
  pending: number;
  registrationOpen: boolean;
  openModules: Array<{ name: string; type: string }>;
  features: string[];
};

export type CloseSnapshot = CloseInputs & {
  reports: Array<{ id: string; status: string }>;
};

// The workspace that already owns the page's bootstrap owns this read too.
// No second fetch, polling, local completion journal, or inferred delivery.
export function readCloseSnapshot(eventValue: unknown, workspaceValue: unknown): CloseSnapshot {
  const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const list = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
  const event = record(eventValue);
  const workspace = record(workspaceValue);
  return {
    stage: typeof event.stage === "string" ? event.stage.toUpperCase() : "",
    pending: list(workspace.participants).filter(person => person.status === "PENDING").length,
    registrationOpen: workspace.registrationOpen === true,
    openModules: list(workspace.modules).filter(module => module.status === "OPEN").map(module => ({ name: typeof module.title === "string" ? module.title : "이름 없는 프로그램", type: typeof module.type === "string" ? module.type : "" })),
    features: Array.isArray(event.features) ? event.features.filter((value): value is string => typeof value === "string") : [],
    reports: list(workspace.reports).flatMap(report => typeof report.id === "string" && typeof report.status === "string" ? [{ id: report.id, status: report.status }] : []),
  };
}

export type CloseLinearPage = "participants" | "programs" | "draws" | "settings" | "messages";
export type CloseLinearNext = { label: string; href: string; localStage?: boolean };

export function linearCloseProgress(eventId: string, page: CloseLinearPage, snapshot: CloseSnapshot, reportId: string | null, intent: string | null, hash: string, noticeStatus?: string, archiveOpen = false) {
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const ended = ["ENDED", "ARCHIVED"].includes(snapshot.stage);
  const published = snapshot.reports.some(report => report.id === reportId && report.status === "PUBLISHED");
  const disabledOpen = snapshot.openModules.some(module => !snapshot.features.includes(module.type));
  const link = (path: string, label: string): CloseLinearNext => ({ label, href: closeHandoffHref(`${base}${path}`, eventId, reportId) });
  const after = (step: number): CloseLinearNext | null => {
    if (step < 2 && snapshot.openModules.length) return disabledOpen
      ? link('/settings?closeStep=programs#settings-features', '프로그램 기능 설정 확인')
      : link('/programs', '진행 중 프로그램 닫기');
    if (step < 3 && snapshot.registrationOpen) return link('/settings?closeStep=intake#settings-intake', '참가 접수 닫기');
    // The current step is step 4 (stage) whenever settings shows position 4.
    // Offering the report here would let the operator skip the transition the
    // strip is asking for, so the same-screen stage control stays until ENDED.
    if (step <= 4 && !ended) return page === "settings"
      ? { label: '진행 단계 ENDED', href: '#settings-stage', localStage: true }
      : link('/settings?closeStep=end#settings-stage', '진행 단계 ENDED');
    if (step < 5 && !published) return link('/reports?closeFlow=1#event-close', '보고서 만들기/동결');
    if (step < 6) return link('/messages', '결과 안내');
    if (step < 7) return link('/settings?closeStep=archive#settings-stage', '보관');
    return null;
  };
  let position = page === "participants" ? 1 : page === "programs" || page === "draws" ? 2 : page === "messages" ? archiveOpen ? 7 : 6
    : intent === "archive" ? 7 : intent === "programs" ? 2
      : (!ended || snapshot.registrationOpen) && (intent === "intake" || !intent && hash === "#settings-intake") && hash !== "#settings-stage" ? 3 : 4;
  if (snapshot.stage === "ARCHIVED") position = 7;
  const labels = ['', '승인 대기 처리', '진행 프로그램 닫기', '참가 접수 닫기', '행사 종료', '보고서 검토·동결', '결과 안내', '보관'];
  const complete = position === 1 ? snapshot.pending === 0 : position === 2 ? snapshot.openModules.length === 0
    : position === 3 ? !snapshot.registrationOpen : position === 4 ? ended : position === 6 ? Boolean(noticeStatus) : snapshot.stage === "ARCHIVED";
  const warnings: string[] = [];
  if (position > 1 && snapshot.pending) warnings.push(`승인 대기 ${snapshot.pending}명 미처리${ended ? ' · 종료 이후 참가자 변경 불가' : ''}`);
  if (position > 2 && snapshot.openModules.length) warnings.push(`진행 프로그램 ${snapshot.openModules.length}개 남음`);
  if (position > 3 && snapshot.registrationOpen) warnings.push('참가 접수 열림');
  if (position > 4 && !ended) warnings.push('행사 종료 미확인');
  if (position > 5 && !published) warnings.push('선택한 마감 보고서 동결 미확인');
  const next = snapshot.stage === "ARCHIVED" ? null : page === "settings" && intent === "programs" && snapshot.openModules.length
    ? link('/programs', '진행 중 프로그램 닫기')
    : position === 2 && disabledOpen ? link('/settings?closeStep=programs#settings-features', '프로그램 기능 설정 확인')
      : after(position);
  const detail = position === 1 ? (complete ? '승인 대기 없음' : ended ? `승인 대기 ${snapshot.pending}명 · 종료 이후에는 참가자를 변경할 수 없습니다. 상태를 확인하고 다음 단계로 이어갈 수 있습니다.` : `승인 대기 ${snapshot.pending}명 · 종료 전 필요한 처리를 마치세요.`)
    : position === 2 ? (complete ? '진행 중 프로그램 없음' : page === 'settings' && intent === 'programs' ? `진행 프로그램 ${snapshot.openModules.length}개 · 필요한 기능을 켜서 저장한 뒤 참여 프로그램에서 닫으세요.` : disabledOpen ? `진행 프로그램 ${snapshot.openModules.length}개 · 사용 중인 기능이 꺼져 있습니다. 기능 설정을 확인한 뒤 닫으세요.` : `진행 프로그램 ${snapshot.openModules.length}개 · 이 화면에서 닫으세요.`)
      : position === 3 ? (complete ? '참가 접수 닫힘 · 진행 단계도 같은 화면에서 처리할 수 있습니다.' : '기존 접수 닫기 동작으로 새 신청을 중단하세요.')
        : position === 4 ? (complete ? '행사 종료 확인 · 다음은 보고서입니다.' : '기존 진행 단계 확인을 거쳐 종료로 전환하세요. 자동 전환하지 않습니다.')
          : position === 6 ? (noticeStatus === 'SIMULATED' ? '모의 안내 기록 확인 · 실제로 전달되지 않았습니다.' : noticeStatus === 'SCHEDULED' ? '예약 안내 등록됨 · 자동 발송되지 않습니다. 이 화면에서 실행을 확인한 뒤 보관하세요.' : noticeStatus ? '안내 기록 생성 확인 · 실제 발송 결과는 이 화면에서 확인하세요.' : '새 안내를 작성하거나 기존 안내의 대상·내용·발송 상태를 확인하세요.')
            : snapshot.stage === "ARCHIVED" ? '보관 완료 · 읽기 전용입니다.' : '보관 확인을 거쳐 확정하세요. 보관 후에는 메시지를 포함한 모든 쓰기가 잠깁니다.';
  return { position, label: labels[position], complete, detail, warnings, next };
}

export function closePrerequisite(inputs: CloseInputs): "archived" | "pending" | "features" | "programs" | "intake" | "stage" | "report" {
  if (inputs.stage === "ARCHIVED") return "archived";
  // ENDED participants are immutable. Keep the warning/count, never offer
  // an impossible approval loop or pretend their exclusion from total.
  if (inputs.pending > 0 && inputs.stage !== "ENDED") return "pending";
  if (inputs.openModules.some((module) => !inputs.features.includes(module.type))) return "features";
  if (inputs.openModules.length > 0) return "programs";
  if (inputs.registrationOpen) return "intake";
  if (inputs.stage !== "ENDED") return "stage";
  return "report";
}
