"use client";

import ValidatedForm from "../../../../ui/ValidatedForm";


import { useEffect, useRef, useState } from "react";
import ProductLink from "../../../../ui/ProductLink";
import ProductButton from "../../../../ui/ProductButton";
import { useRouter } from "next/navigation";
import ticketStyles from "../ticket.module.css";
import { useUnsavedNavigationGuard } from "../../../../../lib/use-unsaved-navigation-guard";
import { postAttendeeRequest } from "../../attendee-request";
import { holdRecoveredTicket } from "../recovered-ticket";
import AttendeeStateMessage from "../../ui/AttendeeStateMessage";
import BottomAction from "../../ui/BottomAction";
import { organizerContactLine } from "../../attendee-guidance";

type Failure = { message: string; field?: string };

const ERROR_ID = "recover-error";

export default function RecoverForm({ slug, contact = "" }: { slug: string; contact?: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [requestUncertain, setRequestUncertain] = useState(false);
  const [confirmationUncertain, setConfirmationUncertain] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [working, setWorking] = useState(false);
  const workRef = useRef(false);
  const currentPhone = useRef(phone); currentPhone.current = phone;
  useUnsavedNavigationGuard(Boolean(phone.trim() || code.trim() || working), working
    ? "인증 요청이 처리 중입니다. 이동해도 서버의 처리는 취소되지 않습니다."
    : "입력 중인 인증 정보가 있습니다. 이동하면 다시 입력해야 합니다.");

  // A refused value takes focus once its field is editable again. A step that
  // does not show that field keeps focus where it is.
  useEffect(() => {
    if (!working && failure?.field) document.getElementById(`recover-${failure.field}`)?.focus();
  }, [failure, working]);

  async function sendCode() {
    if (workRef.current) return;
    const requestedPhone = phone;
    workRef.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const { res, data } = await postAttendeeRequest<{ ok?: unknown; error?: unknown; field?: unknown }>(
        `/api/public/events/${encodeURIComponent(slug)}/verification/request`, { phone: requestedPhone, purpose: "RECOVER" }
      );
      if (currentPhone.current !== requestedPhone) { setFailure({ message: "연락처가 바뀌었습니다. 현재 번호를 확인한 뒤 다시 요청하세요." }); return; }
      if (!res.ok) {
        if (res.status >= 500 || [408, 425].includes(res.status)) {
          setSent(true); setRequestUncertain(true);
          return;
        }
        setFailure({
          message: requestUncertain
            ? `이전 요청의 발송 여부는 아직 확인되지 않았습니다. ${typeof data?.error === "string" ? data.error : "잠시 후 다시 시도하세요."}`
            : typeof data?.error === "string" ? data.error : "인증번호를 보내지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      if (data?.ok !== true) {
        setSent(true); setRequestUncertain(true);
        return;
      }
      setSent(true);
      setRequestUncertain(false);
      setConfirmationUncertain(false);
      setCode("");
    } catch {
      if (currentPhone.current === requestedPhone) {
        setSent(true); setRequestUncertain(true);
      }
    } finally {
      workRef.current = false;
      setWorking(false);
    }
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    await sendCode();
  }

  async function confirmCode(event: React.FormEvent) {
    event.preventDefault();
    if (workRef.current) return;
    const requestedPhone = phone;
    workRef.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const { res, data } = await postAttendeeRequest<{ ok?: unknown; expiresAt?: unknown; ticket?: unknown; error?: unknown; field?: unknown }>(
        `/api/public/events/${encodeURIComponent(slug)}/verification/confirm`, { phone: requestedPhone, code }
      );
      if (currentPhone.current !== requestedPhone) { setFailure({ message: "연락처가 바뀌었습니다. 현재 번호를 다시 인증하세요." }); return; }
      if (!res.ok || data?.ok !== true || typeof data.expiresAt !== "string" || !data.expiresAt || typeof data.ticket !== "string" || !data.ticket) {
        if (confirmationUncertain || res.ok || res.status >= 500 || [408, 425, 429].includes(res.status)) {
          setConfirmationUncertain(true);
          setFailure({ message: "인증 결과를 확인하지 못했습니다. 번호가 이미 사용됐을 수 있습니다. 연결된 티켓을 확인하거나 새 인증번호를 받으세요." });
          return;
        }
        setFailure({
          message: typeof data?.error === "string" ? data.error : "인증번호를 확인하세요.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      openRecoveredTicket(data.ticket);
    } catch {
      if (currentPhone.current === requestedPhone) {
        setConfirmationUncertain(true);
        setFailure({ message: "인증 결과를 확인하지 못했습니다. 번호가 이미 사용됐을 수 있습니다. 연결된 티켓을 확인하거나 새 인증번호를 받으세요." });
      }
    } finally {
      workRef.current = false;
      setWorking(false);
    }
  }

  function openRecoveredTicket(ticket: string) {
    const location = holdRecoveredTicket(slug, ticket);
    router.push(`/event/${encodeURIComponent(slug)}/ticket?recovered=${location}`);
    router.refresh();
  }

  async function checkConnectedTicket() {
    if (workRef.current) return;
    const requestedPhone = phone;
    workRef.current = true;
    setWorking(true);
    setFailure(null);
    try {
      const { res, data } = await postAttendeeRequest<{ ok?: unknown; ticket?: unknown }>(
        `/api/public/events/${encodeURIComponent(slug)}/verification/session`, { phone: requestedPhone }
      );
      if (currentPhone.current !== requestedPhone) {
        setFailure({ message: "연락처가 바뀌었습니다. 현재 번호를 다시 인증하세요." });
      } else if (!res.ok || data?.ok !== true || typeof data.ticket !== "string" || !data.ticket) {
        setFailure({ message: "이 연락처로 연결된 티켓을 확인하지 못했습니다. 새 인증번호를 받아 다시 인증하세요." });
      } else {
        openRecoveredTicket(data.ticket);
      }
    } catch {
      setFailure({ message: "연결된 티켓을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요." });
    } finally {
      workRef.current = false;
      setWorking(false);
    }
  }

  return (
    <div className={`recover-flow ${ticketStyles.recover}`}>
      <p className="recover-lead" role="status">
        {sent
          ? "2. 문자로 받은 인증번호를 입력해 주세요."
          : "1. 신청할 때 입력한 연락처로 인증번호를 받으세요."}
      </p>
      {!sent ? (
        <ValidatedForm className="registration-form" onSubmit={requestCode}>
          <div className="form-field">
            <label htmlFor="recover-phone">신청할 때 입력한 연락처</label>
            <input
              id="recover-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="01012345678"
              value={phone}
              disabled={working}
              onChange={(event) => setPhone(event.target.value)}
              aria-invalid={failure?.field === "phone" || undefined}
              aria-describedby={failure?.field === "phone" ? ERROR_ID : undefined}
              required
            />
          </div>
          {failure ? <AttendeeStateMessage kind="error" id={ERROR_ID} title={failure.message} /> : null}
          <BottomAction
            label="다음 행동"
            primary={{ label: working ? "보내는 중입니다" : "인증번호 받기", type: "submit", disabled: working }}
            secondary={{
              label: "이미 받은 인증번호 입력",
              disabled: working,
              onClick: () => {
                if (!phone.trim()) { setFailure({ field: "phone", message: "연락처를 먼저 입력하세요." }); document.getElementById("recover-phone")?.focus(); return; }
                setSent(true); setRequestUncertain(true); setFailure(null);
              },
            }}
          />
        </ValidatedForm>
      ) : (
        <ValidatedForm className="registration-form" onSubmit={confirmCode}>
          <p className="notice" role="status">
            {requestUncertain ? `${phone} 번호로 보낸 요청의 결과는 미확인입니다. 문자가 오면 가장 최근 번호를 입력하세요.` : `${phone} 번호로 인증번호 요청을 접수했습니다. 10분 안에 입력해 주세요.`}
          </p>
          <p className="recover-note">
            문자가 오지 않으면 아래에서 다시 받으세요. 새 번호를 요청하면 이전 번호를 사용할 수 없을 수 있습니다.
          </p>
          {/* Said for every number: it never tells whether a number is registered. */}
          <p className="recover-note">
            문자가 오지 않거나 티켓이 열리지 않으면 신청할 때 쓴 번호가 맞는지 확인해 주세요. {organizerContactLine(contact)}
          </p>
          <div className="form-field">
            <label htmlFor="recover-code">인증번호 6자리</label>
            <input
              id="recover-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6자리 숫자"
              value={code}
              disabled={working}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={failure?.field === "code" || undefined}
              aria-describedby={failure?.field === "code" ? ERROR_ID : undefined}
              required
            />
          </div>
          {failure ? <AttendeeStateMessage kind="error" id={ERROR_ID} title={failure.message} /> : null}
          <p className={ticketStyles.ticketMessageActions}>
            <ProductButton type="button" variant="ghost" disabled={working} onClick={sendCode}>
              {working ? "보내는 중입니다" : "인증번호 다시 받기"}
            </ProductButton>
            <ProductButton
              type="button"
              variant="ghost"
              disabled={working}
              onClick={() => {
                setSent(false);
                setCode("");
                setRequestUncertain(false);
                setConfirmationUncertain(false);
                setFailure(null);
              }}
            >
              연락처 바꾸기
            </ProductButton>
          </p>
          {/* The strong action is fixed to the bottom; after an unclear result the
              check of the connected ticket leads and the code re-check sits beside it. */}
          <BottomAction
            label="다음 행동"
            primary={confirmationUncertain
              ? { label: "연결된 티켓 확인", disabled: working, onClick: () => void checkConnectedTicket() }
              : { label: working ? "확인 중입니다" : "내 티켓 열기", type: "submit", disabled: working }}
            secondary={confirmationUncertain
              ? { label: working ? "확인 중입니다" : "인증번호 다시 확인", type: "submit", disabled: working }
              : undefined}
          />
        </ValidatedForm>
      )}
      <p className={ticketStyles.ticketMessageActions}>
        <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>행사 안내 보기</ProductLink>
      </p>
    </div>
  );
}
