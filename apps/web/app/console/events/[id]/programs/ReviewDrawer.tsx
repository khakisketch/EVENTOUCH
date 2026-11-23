"use client";

import { useEffect, useRef, useState } from "react";
import ProductButton from "../../../../ui/ProductButton";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleAvatar from "../../../console-ui/ConsoleAvatar";
import CountTabs from "../../../console-ui/CountTabs";
import { ArrowUpIcon } from "../../../console-ui/ConsoleIcons";
import ProgramTypeIcon from "./ProgramIcons";
import type { Module, Photo, Post, Question } from "./ProgramsWorkspace";
import styles from "./programs.module.css";

// One place to clear what attendees sent: questions that still need an answer
// or approval, photos and posts waiting for a decision. It owns no state that
// matters beyond which item is open — every write goes through the same
// handlers (and confirmations) as the per-content lists, so drafts, receipts,
// conflict and recovery rules stay in one implementation.

export type ReviewTab = "all" | "question" | "photo" | "post";
type Moderation = { id: string; status: "APPROVED" | "HIDDEN" } | null;

const PAGE = 30;

export function questionNeedsReview(question: Question): boolean {
  return !question.answer.trim() || !question.approved || Boolean(question.pendingEdit);
}

function questionState(question: Question): string {
  return [
    question.answer.trim() ? "" : "미답변",
    question.approved ? "" : "승인 대기",
    question.pendingEdit ? "수정안 대기" : "",
  ].filter(Boolean).join(" · ");
}

export default function ReviewDrawer(props: {
  eventId: string;
  modules: Module[];
  questions: Question[];
  photos: Photo[];
  posts: Post[];
  tab: ReviewTab;
  onTab: (tab: ReviewTab) => void;
  busy: string | null;
  locked: boolean;
  conflict: boolean;
  answerDrafts: Record<string, string>;
  onAnswerChange: (question: Question, value: string) => void;
  answerFailure: { id: string; message: string; field: string | null } | null;
  onManage: (question: Question, approved: boolean) => void;
  onOpenEdit: (question: Question) => void;
  photoPending: Moderation;
  onRequestPhoto: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onConfirmPhoto: (photo: Photo, status: "APPROVED" | "HIDDEN") => void;
  onCancelPhoto: () => void;
  postPending: Moderation;
  onRequestPost: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onConfirmPost: (post: Post, status: "APPROVED" | "HIDDEN") => void;
  onCancelPost: () => void;
  onClose: () => void;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // Opening a question lands the cursor in its reply field; closing it
  // returns to the item so keyboard users keep their place.
  const lastOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (openId) {
      lastOpenRef.current = openId;
      document.getElementById(`review-answer-${openId}`)?.focus();
    } else if (lastOpenRef.current) {
      document.getElementById(`review-question-${lastOpenRef.current}`)?.focus();
      lastOpenRef.current = null;
    }
  }, [openId]);

  const questions = props.questions.filter(questionNeedsReview);
  const photos = props.photos.filter((photo) => photo.status === "PENDING");
  const posts = props.posts.filter((post) => post.status === "PENDING");
  const total = questions.length + photos.length + posts.length;
  const counts = { all: total, question: questions.length, photo: photos.length, post: posts.length };
  const tabs = (["all", "question", "photo", "post"] as const).filter((tab) =>
    tab === "all" ? counts.all > 0 && [counts.question, counts.photo, counts.post].filter(Boolean).length > 1 : counts[tab] > 0);
  const active: ReviewTab = props.tab !== "all" && counts[props.tab] === 0 ? "all" : props.tab;
  const show = (kind: ReviewTab) => active === "all" || active === kind;
  const disabled = props.busy !== null || props.locked || props.conflict;

  const titleOf = (type: string, fallback: string) => props.modules.find((module) => module.type === type)?.title ?? fallback;
  const questionGroups = props.modules
    .filter((module) => module.type === "qa")
    .map((module) => ({ module, items: questions.filter((question) => question.moduleId === module.id) }))
    .filter((group) => group.items.length);
  let remaining = Math.max(0, limit);
  const take = <T,>(items: T[]): T[] => {
    const part = items.slice(0, remaining);
    remaining -= part.length;
    return part;
  };
  const hidden = (show("question") ? questions.length : 0) + (show("photo") ? photos.length : 0) + (show("post") ? posts.length : 0);

  return (
    <ConsoleDialog
      title={`검토할 것 ${total}`}
      titleId="review-drawer-title"
      presentation="drawer"
      onClose={props.onClose}
      initialFocusRef={statusRef}
      closeLabel="닫기"
    >
      <ProductButton type="button" variant="ghost" className={styles.drawerClose} onClick={props.onClose}>닫기</ProductButton>
      <p className={styles.drawerStatus} id="review-drawer-status" role="status" tabIndex={-1} ref={statusRef}>
        {total ? "" : "검토할 항목을 모두 처리했습니다."}
      </p>
      {tabs.length > 1 ? (
        <CountTabs
          className={styles.drawerTabs}
          ariaLabel="검토 종류"
          value={active}
          onChange={(key) => { props.onTab(key as ReviewTab); setLimit(PAGE); }}
          items={tabs.map((tab) => ({
            key: tab,
            label: tab === "all" ? "전체" : tab === "question" ? "질문" : tab === "photo" ? "사진" : "글",
            count: counts[tab],
          }))}
        />
      ) : null}

      {show("question") && questionGroups.length ? questionGroups.map(({ module, items }) => {
        const shown = take(items);
        if (!shown.length) return null;
        return (
          <section key={module.id} className={styles.drawerGroup} aria-label={module.title}>
            <h3 className={styles.drawerGroupTitle}><ProgramTypeIcon type="qa" small />{module.title}</h3>
            <ul className={styles.drawerList}>
              {shown.map((question) => {
                const open = openId === question.id;
                const failure = props.answerFailure?.id === question.id ? props.answerFailure : null;
                const draft = props.answerDrafts[question.id] ?? question.answer;
                const empty = !draft.trim();
                return (
                  <li key={question.id} id={`review-question-${question.id}`} tabIndex={-1} className={styles.drawerItem} data-open={open || undefined}>
                    {!open ? (
                      <div className={styles.drawerItemHead}>
                        <button type="button" className={styles.drawerItemMain} aria-expanded={false} onClick={() => setOpenId(question.id)}>
                          <b>{question.text}</b>
                          <small>{question.name} · 좋아요 {question.likes} · {questionState(question)}</small>
                        </button>
                        {question.pendingEdit ? (
                          <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onOpenEdit(question)}>수정안 확인</ProductButton>
                        ) : question.answer.trim() ? (
                          <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onManage(question, true)}>승인</ProductButton>
                        ) : (
                          <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => setOpenId(question.id)}>답변</ProductButton>
                        )}
                      </div>
                    ) : null}
                    {open ? (
                      <div className={styles.answerCard}>
                        <div className={styles.asker}>
                          <ConsoleAvatar name={question.name} tone="info" size="md" />
                          <span className={styles.askerName}>{question.name}<small>좋아요 {question.likes}</small></span>
                        </div>
                        <p className={styles.bubble}>{question.text}</p>
                        <div className={styles.replyRow}>
                          <label className="sr-only" htmlFor={`review-answer-${question.id}`}>{question.name} 질문에 답변</label>
                          <textarea
                            id={`review-answer-${question.id}`}
                            className={styles.replyField}
                            data-resize-none="true"
                            rows={1}
                            maxLength={500}
                            placeholder="답변 입력…"
                            disabled={disabled}
                            value={draft}
                            aria-invalid={failure?.field === "answer"}
                            aria-describedby={failure ? `review-answer-${question.id}-error` : undefined}
                            onChange={(event) => props.onAnswerChange(question, event.target.value)}
                          />
                          <ProductButton
                            type="button"
                            variant="primary"
                            className={styles.sendButton}
                            data-empty={empty || undefined}
                            aria-label={question.approved ? "답변 저장" : "답변하고 공개"}
                            icon={<ArrowUpIcon />}
                            disabled={disabled}
                            onClick={() => props.onManage(question, true)}
                          />
                        </div>
                        {failure ? <p className={styles.fieldError} id={`review-answer-${question.id}-error`} role="alert">{failure.message}</p> : null}
                        <div className={styles.answerFoot}>
                          {!question.approved ? (
                            <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onManage(question, false)}>답변만 저장</ProductButton>
                          ) : null}
                          <ProductButton type="button" variant="ghost" onClick={() => setOpenId(null)}>접기</ProductButton>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      }) : null}

      {show("photo") && photos.length ? (() => {
        const shown = take(photos);
        if (!shown.length) return null;
        return (
          <section className={styles.drawerGroup} aria-label="참여 사진">
            <h3 className={styles.drawerGroupTitle}><ProgramTypeIcon type="photo" small />{titleOf("photo", "참여 사진")}</h3>
            <ul className={styles.drawerList}>
              {shown.map((photo) => (
                <li key={photo.id} id={`review-photo-${photo.id}`} tabIndex={-1} className={styles.drawerItem}>
                  <div className={styles.drawerItemHead}>
                    <div className={styles.drawerPhoto}>
                      {photo.fileId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/events/${encodeURIComponent(props.eventId)}/files/${encodeURIComponent(photo.fileId)}`}
                          alt={photo.caption || "참가자가 공유한 사진"}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : <span aria-hidden="true" />}
                      <span className={styles.drawerItemMain}>
                        <b>{photo.caption || "설명 없음"}</b>
                        <small>{photo.name}</small>
                      </span>
                    </div>
                    <span className={styles.drawerVerbs}>
                      <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onRequestPhoto(photo, "HIDDEN")}>반려</ProductButton>
                      <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onRequestPhoto(photo, "APPROVED")}>승인</ProductButton>
                    </span>
                  </div>
                  {props.photoPending?.id === photo.id ? (
                    <ConsoleConfirm
                      summary={`이 사진을 ${props.photoPending.status === "APPROVED" ? "승인" : "반려"}할까요?`}
                      confirmLabel={`${props.photoPending.status === "APPROVED" ? "승인" : "반려"}한다`}
                      busy={props.busy !== null}
                      onConfirm={() => props.onConfirmPhoto(photo, props.photoPending?.status ?? "APPROVED")}
                      onCancel={props.onCancelPhoto}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })() : null}

      {show("post") && posts.length ? (() => {
        const shown = take(posts);
        if (!shown.length) return null;
        return (
          <section className={styles.drawerGroup} aria-label="참여 게시판">
            <h3 className={styles.drawerGroupTitle}><ProgramTypeIcon type="board" small />{titleOf("board", "참여 게시판")}</h3>
            <ul className={styles.drawerList}>
              {shown.map((post) => (
                <li key={post.id} id={`review-post-${post.id}`} tabIndex={-1} className={styles.drawerItem}>
                  <div className={styles.drawerItemHead}>
                    <span className={styles.drawerItemMain}>
                      <b>{post.body}</b>
                      <small>{post.name}</small>
                    </span>
                    <span className={styles.drawerVerbs}>
                      <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onRequestPost(post, "HIDDEN")}>반려</ProductButton>
                      <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => props.onRequestPost(post, "APPROVED")}>승인</ProductButton>
                    </span>
                  </div>
                  {props.postPending?.id === post.id ? (
                    <ConsoleConfirm
                      summary={`이 게시글을 ${props.postPending.status === "APPROVED" ? "승인" : "반려"}할까요?`}
                      confirmLabel={`${props.postPending.status === "APPROVED" ? "승인" : "반려"}한다`}
                      busy={props.busy !== null}
                      onConfirm={() => props.onConfirmPost(post, props.postPending?.status ?? "APPROVED")}
                      onCancel={props.onCancelPost}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })() : null}

      {hidden > limit ? (
        <p className={styles.drawerMore}>
          <ProductButton type="button" variant="ghost" onClick={() => setLimit((current) => current + PAGE)}>나머지 {hidden - limit}건</ProductButton>
        </p>
      ) : null}
    </ConsoleDialog>
  );
}
