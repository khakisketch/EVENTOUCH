const STAGE_LABELS: Record<string, string> = {
  DRAFT: "기획",
  READY: "운영 준비",
  LIVE: "진행 중",
  ENDED: "종료",
  ARCHIVED: "보관",
};

export function eventStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function eventStageClassName(stage: string): string {
  switch (stage) {
    case "LIVE":
      return "stage-badge stage-live";
    case "DRAFT":
    case "READY":
      return "stage-badge stage-planned";
    case "ENDED":
      return "stage-badge stage-ended";
    case "ARCHIVED":
      return "stage-badge stage-archived";
    default:
      return "stage-badge";
  }
}
