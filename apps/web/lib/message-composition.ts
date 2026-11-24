/** The displayed count is the source text; the provider checks substituted text. */
export function measureMessage(body: string) {
  let bytes = 0;
  for (const character of body) bytes += (character.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
  return { bytes, characters: Array.from(body).length, personalized: /\{\{[^{}]*\}\}/.test(body) };
}

export function messageContentIssue(
  draft: { channel: string; body: string; imageFileId: string },
  template?: { channel: string; body: string; archived: boolean; solapiTemplateId: string },
): { field: string; message: string } | null {
  if (template?.archived) return { field: "templateId", message: "보관된 템플릿입니다. 복원하거나 다른 템플릿을 선택하세요." };
  if (draft.channel === "ALIMTALK") {
    if (!template || template.channel !== "ALIMTALK" || !template.solapiTemplateId) return { field: "templateId", message: "알림톡을 쓰려면 승인된 템플릿을 선택해야 합니다." };
    if (draft.body.trim() !== template.body.trim()) return { field: "templateId", message: "알림톡 문구가 선택한 템플릿과 다릅니다. 최신 템플릿을 다시 선택하세요." };
  }
  const tokens = draft.body.match(/\{\{[^{}]*\}\}/g) ?? [];
  const supported = new Set(["이름", "행사명", "행사일", "티켓링크", "럭키번호"]);
  if (tokens.some(token => !supported.has(token.slice(2, -2)))) return { field: "body", message: "지원하지 않는 개인화 정보가 있습니다. 제공된 개인화 정보를 사용하세요." };
  const measure = measureMessage(draft.body);
  // A token can shrink or expand. Never reject a variable-bearing message on
  // its raw size; the provider validates the final text for each recipient.
  if (!measure.personalized && (draft.channel === "ALIMTALK" ? measure.characters > 1000 : measure.bytes > 2000)) return { field: "body", message: draft.channel === "ALIMTALK" ? "알림톡은 1,000자 이내로 작성된 승인 템플릿을 선택하세요." : "문자 내용이 2,000byte를 넘었습니다. 내용을 줄여 주세요. 한글은 보통 1자에 2byte입니다." };
  if (draft.channel === "MMS" && !draft.imageFileId) return { field: "imageFileId", message: "사진 문자는 사진을 첨부해야 합니다." };
  return null;
}
