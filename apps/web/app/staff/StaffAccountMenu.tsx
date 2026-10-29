"use client";

import { useEffect, useRef, useState } from "react";
import OrganizationSwitcher from "../OrganizationSwitcher";
import { refreshOperatorContext } from "../../lib/operator-context";
import { useOperatorContextSnapshot } from "./use-operator-context";
import { isSelectionRequiredError, staffRoleLabel } from "./staff-org-guard";
import styles from "./staff-account-menu.module.css";

// Staff account access: who is signed in, which organization is operating,
// and with what role — plus the holder's own email-verification entry and
// the shared organization switcher behind a disclosure. The panel never grows
// organization management links: switching is the only org action here, the
// recovery entry is account-global (no org scope, role, or membership read),
// and the parent switcher renders its selector only when more than one
// organization exists. Leaving for the account page consults
// confirmLeaveAccount (the work screen's in-flight/unknown-verdict/draft
// gate with account wording, or the hub's loading gate) — a plain hard
// navigation would silently strand retained receipts and drafts that only
// the narrow beforeunload conditions catch.
//
// The panel stays mounted while closed (hidden attribute): an unsaved new
// organization name or a pending creation nonce inside the parent switcher
// must not be silently lost by Escape or an outside press. Closing only
// hides; nothing unmounts.
export default function StaffAccountMenu({
  confirmLeave,
  confirmLeaveAccount,
}: {
  confirmLeave?: () => boolean;
  confirmLeaveAccount?: () => boolean;
}) {
  const snapshot = useOperatorContextSnapshot();
  const [open, setOpen] = useState(false);
  const [accountNotice, setAccountNotice] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Only Escape and the explicit close button return focus to the trigger.
  // An outside press hands focus to wherever the operator actually pressed.
  const closeModeRef = useRef<"escape" | "explicit" | "outside">("explicit");

  function requestClose(mode: "escape" | "explicit" | "outside") {
    closeModeRef.current = mode;
    setOpen(false);
  }

  // Leaving for the account page is a real navigation away from this tab's
  // work: consult the account gate first (the work screen blocks in-flight
  // and unknown-verdict work and confirms drafts with account wording; the
  // hub gates loading). A cancelled leave keeps the menu, focus, and work
  // exactly where they are.
  function handleAccountNavigate(event: React.MouseEvent) {
    const gate = confirmLeaveAccount ?? confirmLeave;
    if (gate && !gate()) {
      event.preventDefault();
      setAccountNotice("이 화면을 떠나지 않았습니다. 진행 중인 작업이 있다면 결과를 확인한 뒤 다시 이동하세요.");
    } else {
      setAccountNotice("");
    }
  }

  // Close on Escape and on outside press; return focus to the trigger only
  // for Escape/explicit close so an outside press keeps its own target.
  useEffect(() => {
    if (!open) return;
    const closeButton = panelRef.current?.querySelector("button");
    if (closeButton instanceof HTMLButtonElement) closeButton.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose("escape");
    }
    function onPointer(event: MouseEvent) {
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      if (
        event.target instanceof Node &&
        panel &&
        trigger &&
        !panel.contains(event.target) &&
        !trigger.contains(event.target)
      ) {
        requestClose("outside");
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      if (closeModeRef.current !== "outside") triggerRef.current?.focus();
    };
  }, [open ]);

  const context = snapshot.context;
  const selectionRequired =
    !context && !snapshot.loading && isSelectionRequiredError(snapshot.error);
  const summary = context
    ? `${context.userName} · ${context.organizationName} · ${staffRoleLabel(context.role)}`
    : selectionRequired
      ? "운영사 선택 필요"
      : snapshot.loading
        ? "계정 정보를 확인하고 있습니다."
        : "계정 정보를 불러오지 못했습니다.";

  return (
    <div className={styles.accountMenu}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setAccountNotice("");
          setOpen((value) => !value);
        }}
      >
        <span className={styles.menuLabel}>{summary}</span>
        <span className={styles.menuCaret} aria-hidden="true" />
      </button>
      <div ref={panelRef} className={styles.menuPanel} role="dialog" aria-label="계정 및 조직 전환" hidden={!open}>
        {context ? (
          <dl className={styles.accountFacts}>
            <div>
              <dt>계정</dt>
              <dd>{context.userName}</dd>
            </div>
            <div>
              <dt>현재 작업 조직</dt>
              <dd>{context.organizationName}</dd>
            </div>
            <div>
              <dt>역할</dt>
              <dd>{staffRoleLabel(context.role)}</dd>
            </div>
          </dl>
        ) : (
          <p className={styles.menuNote} role="status">
            {selectionRequired
              ? "운영사 선택 필요: 아래 운영사 선택에서 작업할 운영사를 고르세요."
              : snapshot.loading
                ? "계정 정보를 확인하고 있습니다."
                : "계정 정보를 불러오지 못했습니다."}
          </p>
        )}
        {snapshot.error && !snapshot.loading && !selectionRequired ? (
          <p className={styles.menuNote}>
            <span role="alert">{snapshot.error}</span>{" "}
            <button
              type="button"
              className={styles.menuRetry}
              onClick={() => {
                void refreshOperatorContext();
              }}
            >
              다시 확인
            </button>
          </p>
        ) : null}
        <OrganizationSwitcher confirmLeave={confirmLeave} />
        <a className={styles.menuLink} href="/account/email" onClick={handleAccountNavigate}>
          내 계정 이메일 인증
        </a>
        {accountNotice ? <p className={styles.menuNote} role="status">{accountNotice}</p> : null}
        <button
          type="button"
          className={styles.menuClose}
          onClick={() => requestClose("explicit")}
        >
          닫기
        </button>
      </div>
    </div>
  );
}
