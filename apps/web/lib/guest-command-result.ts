// Response proof for participant submissions. The request stays in memory;
// only a scoped command identifier is persisted for status-only recovery.
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function hasStrings(value: Record<string, unknown> | null, ...keys: string[]): boolean {
  return Boolean(value && keys.every((key) => typeof value[key] === "string" && value[key]));
}

export function confirmsGuestPhotoUpload(value: unknown, file: Pick<File, "name" | "type" | "size">): boolean {
  const uploaded = record(record(value)?.file);
  return Boolean(uploaded && typeof uploaded.fileId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(uploaded.fileId) &&
    uploaded.name === file.name && uploaded.type === file.type && uploaded.size === file.size &&
    Number.isSafeInteger(uploaded.width) && Number(uploaded.width) > 0 &&
    Number.isSafeInteger(uploaded.height) && Number(uploaded.height) > 0);
}

export function confirmsGuestCommand(command: string, value: Record<string, unknown>, payload: Record<string, unknown>, commandId: string): boolean {
  const payloadImage = record(payload.image);
  switch (command) {
    case "response.submit": {
      const response = record(value.response);
      if (!hasStrings(response, "id", "moduleId") || response?.id !== commandId || response.moduleId !== payload.moduleId) return false;
      if (payload.expectedContentVersion !== undefined && response.contentVersion !== payload.expectedContentVersion) return false;
      if (typeof payload.answer === "string" && response.answer !== payload.answer.trim()) return false;
      const expectedRatings = record(payload.ratings);
      if (expectedRatings) {
        const actualRatings = record(response.ratings);
        if (response.answer !== "SUBMITTED" || !actualRatings ||
            Object.keys(expectedRatings).length !== Object.keys(actualRatings).length ||
            !Object.keys(expectedRatings).every((key) => actualRatings[key] === expectedRatings[key]) ||
            response.comment !== (typeof payload.comment === "string" ? payload.comment.trim() : "")) return false;
      }
      return typeof payload.answer === "string" || Boolean(expectedRatings);
    }
    case "question.submit": {
      const question = record(value.question);
      return hasStrings(question, "id", "moduleId", "text") && question?.id === commandId &&
        question.moduleId === payload.moduleId && typeof payload.text === "string" &&
        question.text === payload.text.trim() && question.approved === false &&
        (payload.expectedContentVersion === undefined || question.contentVersion === payload.expectedContentVersion);
    }
    case "question.edit": return value.questionId === payload.id && value.editId === commandId;
    case "question.like": return typeof value.questionId === "string" && Boolean(value.questionId) &&
      value.questionId === payload.id && typeof value.liked === "boolean" &&
      (payload.liked === undefined || value.liked === payload.liked) &&
      (payload.expectedQuestionText === undefined || value.confirmedQuestionText === payload.expectedQuestionText) &&
      Number.isInteger(value.likes) && Number(value.likes) >= 0;
    case "photo.submit": {
      const photo = record(value.photo);
      const image = record(photo?.image);
      return Boolean(photo && image && hasStrings(photo, "id", "caption", "status") && photo.id === commandId &&
        typeof payload.caption === "string" && photo.caption === payload.caption.trim() && photo.status === "PENDING" &&
        typeof payloadImage?.fileId === "string" && image.fileId === payloadImage.fileId);
    }
    case "post.submit": {
      const post = record(value.post);
      return Boolean(hasStrings(post, "id", "body", "status") && post?.id === commandId &&
        typeof payload.body === "string" && post.body === payload.body.trim() && post.status === "PENDING");
    }
    default: return false;
  }
}
