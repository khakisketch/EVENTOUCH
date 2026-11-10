/** Read-only work summaries and navigation. Event commands still own changes. */
export const PARTICIPATION_TYPES = [
  { id: "poll", label: "선택형 투표" },
  { id: "quiz", label: "퀴즈" },
  { id: "qa", label: "Q&A" },
  { id: "draw", label: "간단 추첨" },
  { id: "survey", label: "만족도 조사" },
  { id: "photo", label: "참여 사진" },
  { id: "board", label: "참여 게시판" },
] as const;

export type ParticipationReview = "qa-unanswered" | "qa-pending" | "qa-edits" | "photo" | "post";
export type ParticipationHandoff =
  | { kind: "review"; target: ParticipationReview }
  | { kind: "module"; id: string }
  | { kind: "status"; status: "DRAFT" | "OPEN" | "CLOSED" }
  | { kind: "invalid" };
export type ParticipationTask = { key: string; title: string; count: string; hint: string; action: string; review: ParticipationReview };
export type ParticipationSnapshot = {
  tasks: ParticipationTask[];
  open: Array<{ id: string; title: string; type: string }>;
};

const REVIEWS = new Set<string>(["qa-unanswered", "qa-pending", "qa-edits", "photo", "post"]);

export function readParticipationHandoff(params: URLSearchParams): ParticipationHandoff | null {
  const supplied = ["review", "module", "status"].filter(key => params.has(key));
  if (!supplied.length) return null;
  if (supplied.length !== 1 || params.getAll(supplied[0]).length !== 1) return { kind: "invalid" };
  const key = supplied[0], value = params.get(key) || "";
  if (key === "review" && REVIEWS.has(value)) return { kind: "review", target: value as ParticipationReview };
  if (key === "module" && /^[A-Za-z0-9_-]{1,120}$/.test(value)) return { kind: "module", id: value };
  if (key === "status" && (value === "DRAFT" || value === "OPEN" || value === "CLOSED")) return { kind: "status", status: value };
  return { kind: "invalid" };
}

export function participationTypeLabel(type: string): string {
  return PARTICIPATION_TYPES.find(item => item.id === type)?.label ?? "형식 확인 필요";
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

export function participationSnapshot(workspace: Record<string, unknown>, features: readonly string[]): ParticipationSnapshot {
  const enabled = new Set(features);
  const modules = rows(workspace.modules).filter(module => typeof module.id === "string" && module.id !== "" && enabled.has(String(module.type)));
  const qaIds = new Set(modules.filter(module => module.type === "qa").map(module => module.id));
  const questionIds = new Set<string>();
  const questions = rows(workspace.questions).filter(question => {
    if (typeof question.id !== "string" || !question.id || !qaIds.has(question.moduleId) || questionIds.has(question.id)) return false;
    questionIds.add(question.id);
    return true;
  });
  const unanswered = (question: Record<string, unknown>) => typeof question.answer !== "string" || !question.answer.trim();
  const pending = (question: Record<string, unknown>) => question.approved !== true;
  const edited = (question: Record<string, unknown>) => {
    const edit = rows([question.pendingEdit])[0];
    return Boolean(edit && typeof edit.id === "string" && edit.id && typeof edit.text === "string");
  };
  const unansweredCount = questions.filter(unanswered).length;
  const pendingCount = questions.filter(pending).length;
  const editCount = questions.filter(edited).length;
  // One question can need both approval and an answer. Count unique questions,
  // then name overlapping classes instead of adding them into a false total.
  const qaCount = questions.filter(question => unanswered(question) || pending(question) || edited(question)).length;
  const tasks: ParticipationTask[] = [];
  if (qaCount) tasks.push({ key: "qa", title: "Q&A 확인", count: `질문 ${qaCount}개`,
    hint: [unansweredCount ? `미답변 ${unansweredCount}건` : "", pendingCount ? `승인 대기 ${pendingCount}건` : "", editCount ? `수정안 ${editCount}건` : ""].filter(Boolean).join(" · "),
    action: editCount ? "수정안 검토" : pendingCount ? "질문 승인 검토" : "미답변 확인", review: editCount ? "qa-edits" : pendingCount ? "qa-pending" : "qa-unanswered" });
  const photoCount = modules.some(module => module.type === "photo") ? rows(workspace.photos).filter(photo => photo.status === "PENDING").length : 0;
  const postCount = modules.some(module => module.type === "board") ? rows(workspace.posts).filter(post => post.status === "PENDING").length : 0;
  if (photoCount) tasks.push({ key: "photo", title: "참여 사진 검토", count: `${photoCount}건`, hint: "참가자가 올린 사진의 공개 여부를 확인하세요.", action: "사진 검토", review: "photo" });
  if (postCount) tasks.push({ key: "post", title: "게시글 검토", count: `${postCount}건`, hint: "참여 게시판에 공개할 글을 확인하세요.", action: "게시글 검토", review: "post" });
  return { tasks, open: modules.filter(module => module.status === "OPEN" && module.published === true).map(module => ({ id: String(module.id), title: typeof module.title === "string" ? module.title : "이름 없는 콘텐츠", type: String(module.type) })) };
}
