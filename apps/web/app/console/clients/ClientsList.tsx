"use client";
import ProductButton from "../../ui/ProductButton";

import ValidatedForm from "../../ui/ValidatedForm";

import { consoleFetch as fetch } from "../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsClientSave, isOrganizationContextBlock } from "../../../lib/operator-context";
import { forgetOperatorReceipt } from "../../../lib/operator-receipts";
import { useOrganizationReceipts } from "../../../lib/use-organization-receipts";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../auth-redirect";
import ConsoleConfirm from "../console-ui/ConsoleConfirm";
import ConsolePage from "../console-ui/ConsolePage";
import ConsoleToolbar from "../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../console-ui/ConsoleFeedback";
import ConsoleDialog from "../console-ui/ConsoleDialog";
import ConsoleFormActions from "../console-ui/ConsoleFormActions";
import ConsoleSection from "../console-ui/ConsoleSection";
import ConsoleStatePanel from "../console-ui/ConsoleStatePanel";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard } from "../console-draft-guard";
import consoleUiStyles from "../console-ui/console-ui.module.css";
import styles from "./clients.module.css";

type Client = {
  id: string;
  name: string;
  contact: string;
  email: string;
  logoFileId: string;
  docFileId: string;
};

type ClientsState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; clients: Client[]; canManage: boolean };

type Draft = { id: string; name: string; contact: string; email: string };
type AttachmentAttempt = {
  client: Client; kind: "logo" | "doc"; file: File;
  uploadCommandId: string; linkCommandId: string; fileId: string; uncertain: boolean;
};

const EMPTY_DRAFT: Draft = { id: "", name: "", contact: "", email: "" };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDefinitiveClientError(status: number): boolean {
  // 4xx (except 408/425/429) proves the server saw and rejected this exact request;
  // 5xx, 408/425/429 and network loss stay ambiguous, so the retry replays the SAME
  // command id and the receipt replays the original record.
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

// Removal summary, moved verbatim from the previous native confirm: the
// client is named because the list shows several similar rows.
function removeSummary(client: Client, kind: "logo" | "doc"): string {
  return kind === "logo"
    ? `${client.name}의 로고를 제거할까요?`
    : `${client.name}의 사업자등록증을 제거할까요?`;
}

function confirmLines(message: string): ReactNode {
  const parts = message.split("\n");
  return parts.flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]));
}

const DIRTY_CLOSE_MESSAGE = "작성 중인 고객사 내용이 사라집니다. 닫을까요?";

export default function ClientsList() {
  const router = useRouter();
  const [state, setState] = useState<ClientsState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Local-only directory search (no API): name/contact/email match with a
  // visible count and clear. File and write paths below are untouched.
  const [clientQuery, setClientQuery] = useState("");
  // Opening snapshot for true-diff dirt: a pristine open form is not dirty,
  // only an actual change versus these values (or unsettled/pending work).
  const draftBaselineRef = useRef<Draft | null>(null);
  const [formError, setFormError] = useState<{ field: string | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [clientUncertain, setClientUncertain] = useState(false);
  const [checkingClient, setCheckingClient] = useState(false);
  const organizationReceipts = useOrganizationReceipts();
  const [uploading, setUploading] = useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<AttachmentAttempt | null>(null);
  const pendingAttachmentRef = useRef<AttachmentAttempt | null>(null);
  const [abandonAttachment, setAbandonAttachment] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // One in-place removal confirm at a time: the trigger button stays, and
  // the confirm renders inside the same row. Confirming runs the existing
  // removal and clears the slot; cancelling only clears it.
  const [removePending, setRemovePending] = useState<{ id: string; kind: "logo" | "doc" } | null>(null);
  // Synchronous same-turn gate: state flags flip only on re-render, so a
  // double activation in one turn would slip past them. Covers save, file
  // upload/link and removal. The fingerprint receipt id is untouched by this.
  const clientWriteRef = useRef(false);
  const pendingClientRef = useRef<{ fingerprint: string; commandId: string; uncertain: boolean } | null>(null);
  const otherClientReceipt = organizationReceipts.some((item) => item.command === "client.save" &&
    item.commandId !== pendingClientRef.current?.commandId && item.commandId !== pendingAttachmentRef.current?.linkCommandId);
  const hadOtherClientReceipt = useRef(false);
  useEffect(() => {
    if (hadOtherClientReceipt.current && !otherClientReceipt) setReloadTick((tick) => tick + 1);
    hadOtherClientReceipt.current = otherClientReceipt;
  }, [otherClientReceipt]);

  // An open create/edit form holds unsaved input only when it actually
  // differs from its opening snapshot; unsettled or pending writes count
  // too. The list itself is never dirty.
  const draftBaseline = draftBaselineRef.current;
  const draftDiffers =
    draft !== null &&
    draftBaseline !== null &&
    (draft.name !== draftBaseline.name ||
      draft.contact !== draftBaseline.contact ||
      draft.email !== draftBaseline.email);
  useConsoleDraftGuard(
    draftDiffers || pendingClientRef.current !== null || clientWriteRef.current || Boolean(pendingAttachment),
    pendingAttachment ? "파일이 이미 서버에 저장되었을 수 있습니다. 화면을 떠나면 파일을 다시 선택해야 합니다."
      : pendingClientRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : "작성 중인 고객사 내용이 사라질 수 있습니다."
  );

  function openDraft(next: Draft) {
    if (otherClientReceipt || pendingAttachment) return;
    draftBaselineRef.current = { ...next };
    setDraft(next);
    setFormError(null);
  }

  // Single dismissal predicate: the shared dialog calls canClose ONCE on
  // Escape/backdrop and then the pure closeDraft below — never two
  // confirms. Cancel consults the same predicate once. The busy ref (not
  // state) blocks pre-render writes too. Success closes bypass confirmation
  // via direct setDraft(null).
  function canCloseClientDialog(): boolean {
    if (clientWriteRef.current || saving || checkingClient) return false;
    const baseline = draftBaselineRef.current;
    const dirty =
      draft !== null &&
      baseline !== null &&
      (draft.name !== baseline.name ||
        draft.contact !== baseline.contact ||
        draft.email !== baseline.email);
    return (!dirty && !pendingClientRef.current) || window.confirm(pendingClientRef.current ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : DIRTY_CLOSE_MESSAGE);
  }

  function closeDraft(): void {
    setDraft(null);
    draftBaselineRef.current = null;
    // The explicit close warning leaves the scoped, status-only pointer in
    // the shared recovery panel; do not keep an invisible draft in memory.
    pendingClientRef.current = null;
    setClientUncertain(false);
  }

  async function load(preserveOnError = false) {
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/console/directory", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return false;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        directory?: { clients?: unknown } | null;
      } | null;
      if (!meRes.ok || !bootRes.ok || !me?.user || !boot?.directory) {
        if (!preserveOnError) setState({ kind: "failed", message: "고객사 목록을 불러오지 못했습니다." });
        return false;
      }
      const clients: Client[] = Array.isArray(boot.directory.clients)
        ? boot.directory.clients.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const client = item as Record<string, unknown>;
            if (typeof client.id !== "string" || typeof client.name !== "string") return [];
            return [{
              id: client.id,
              name: client.name,
              contact: text(client.contact),
              email: text(client.email),
              logoFileId: text(client.logoFileId),
              docFileId: text(client.docFileId),
            }];
          })
        : [];
      setState({
        kind: "ready",
        clients,
        canManage: me.user.role === "AGENCY",
      });
      return true;
    } catch {
      if (!preserveOnError) setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  async function saveClient(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving || checkingClient || clientWriteRef.current || otherClientReceipt || pendingAttachmentRef.current) return;
    clientWriteRef.current = true;
    setSaving(true);
    setFormError(null);
    setNotice(null);
    // A possibly committed write must be resolved with its original inputs
    // and id before another version of the record can be submitted.
    const payload = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      contact: draft.contact,
      email: draft.email,
    };
    const fingerprint = JSON.stringify(payload);
    const attempt = pendingClientRef.current?.fingerprint === fingerprint
      ? pendingClientRef.current
      : { fingerprint, commandId: randomCommandId(), uncertain: false };
    if (pendingClientRef.current?.uncertain && pendingClientRef.current.fingerprint !== fingerprint) {
      clientWriteRef.current = false;
      setSaving(false);
      setFormError({ field: null, message: "이전 등록 결과를 확인한 뒤 내용을 바꾸세요." });
      return;
    }
    pendingClientRef.current = attempt;
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, ...payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        client?: unknown;
      } | null;
      if (!res.ok) {
        const serverMessage = typeof data?.error === "string" ? data.error : "저장하지 못했습니다.";
        if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
          pendingClientRef.current = null;
          setClientUncertain(false);
          setFormError({
            field: typeof data?.field === "string" ? data.field : null,
            message: serverMessage,
          });
        } else {
          attempt.uncertain = true;
          setClientUncertain(true);
          setFormError({
            field: null,
            message: "저장 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.",
          });
        }
        return;
      }
      if (!confirmsClientSave(payload, data)) {
        attempt.uncertain = true;
        setClientUncertain(true);
        setFormError({ field: null, message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      pendingClientRef.current = null;
      setClientUncertain(false);
      setNotice(draft.id ? "고객사 정보를 수정했습니다." : "고객사를 등록했습니다.");
      setDraft(null);
      draftBaselineRef.current = null;
      await load();
    } catch (error) {
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        pendingClientRef.current = null;
        setFormError({ field: null, message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        attempt.uncertain = true;
        setClientUncertain(true);
        setFormError({ field: null, message: "연결하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요." });
      }
    } finally {
      clientWriteRef.current = false;
      setSaving(false);
    }
  }

  async function checkClientResult() {
    const attempt = pendingClientRef.current;
    if (!attempt || !attempt.uncertain || saving || checkingClient) return;
    setCheckingClient(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (res.ok && data?.status === "APPLIED" && data.command === "client.save") {
        if (await load(true)) {
          acknowledgeOperatorReceipt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingClientRef.current = null;
          setClientUncertain(false);
          setNotice("고객사 저장이 반영된 것을 확인하고 목록을 불러왔습니다.");
          setDraft(null);
          draftBaselineRef.current = null;
        } else setFormError({ field: null, message: "저장은 확인했지만 목록을 불러오지 못했습니다. 다시 확인하세요." });
      } else if (res.ok && data?.status === "UNCONFIRMED") {
        setFormError({ field: null, message: "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하거나 같은 요청을 다시 시도하세요." });
      } else if (res.status >= 500 || [425, 429].includes(res.status)) setFormError({ field: null, message: "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요." });
      else setFormError({ field: null, message: "처리 결과를 확인하지 못했습니다. 현재 계정과 조직 권한을 확인하세요." });
    } catch {
      setFormError({ field: null, message: "서버에 연결하지 못했습니다. 저장 요청은 다시 보내지 않았습니다." });
    } finally { setCheckingClient(false); }
  }

  // Logo and registration documents live on the customer record, outside any
  // event. The file id is what the record keeps; bytes travel the file route.
  async function uploadAttachment(client: Client, kind: "logo" | "doc", file: File) {
    if (clientWriteRef.current || pendingAttachmentRef.current || otherClientReceipt) return;
    setNotice(null);
    if (kind === "logo" && file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
      setFormError({ field: null, message: "로고는 JPG·PNG·WebP 이미지를 사용하세요." });
      return;
    }
    if (kind === "doc" && file.type !== "application/pdf") {
      setFormError({ field: null, message: "사업자등록증은 PDF로 올려주세요." });
      return;
    }
    if (file.size > 600000) {
      setFormError({ field: null, message: "600KB 이하 파일을 올려주세요." });
      return;
    }
    const attempt: AttachmentAttempt = { client, kind, file, uploadCommandId: randomCommandId(), linkCommandId: randomCommandId(), fileId: "", uncertain: false };
    pendingAttachmentRef.current = attempt;
    setPendingAttachment({ ...attempt });
    await runAttachment(attempt);
  }

  async function runAttachment(attempt: AttachmentAttempt) {
    if (clientWriteRef.current || pendingAttachmentRef.current !== attempt) return;
    clientWriteRef.current = true;
    setUploading(`${attempt.client.id}:${attempt.kind}`);
    setFormError(null);
    const uncertain = (message: string) => {
      attempt.uncertain = true;
      setPendingAttachment({ ...attempt });
      setFormError({ field: null, message });
    };
    try {
      if (!attempt.fileId) {
        const res = await fetch(
          `/api/clients/${encodeURIComponent(attempt.client.id)}/files?name=${encodeURIComponent(attempt.file.name)}&commandId=${encodeURIComponent(attempt.uploadCommandId)}`,
          { method: "POST", headers: { "content-type": attempt.file.type }, body: attempt.file }
        );
        const data = await res.json().catch(() => null) as { file?: { fileId?: unknown; name?: unknown; type?: unknown; size?: unknown }; error?: unknown } | null;
        if (!res.ok) {
          if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
            pendingAttachmentRef.current = null;
            setPendingAttachment(null);
            setFormError({ field: null, message: typeof data?.error === "string" ? data.error : "파일을 올리지 못했습니다." });
          } else uncertain("파일 업로드 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.");
          return;
        }
        const file = data?.file;
        if (!file || typeof file.fileId !== "string" || !file.fileId || file.name !== attempt.file.name || file.type !== attempt.file.type || file.size !== attempt.file.size) {
          uncertain("파일 업로드 응답을 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.");
          return;
        }
        attempt.fileId = file.fileId;
        attempt.uncertain = false;
        setPendingAttachment({ ...attempt });
      }
      const payload = {
        id: attempt.client.id, name: attempt.client.name, contact: attempt.client.contact, email: attempt.client.email,
        ...(attempt.kind === "logo" ? { logoFileId: attempt.fileId } : { docFileId: attempt.fileId }),
      };
      const save = await fetch("/api/clients", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.linkCommandId, ...payload }),
      });
      const data = await save.json().catch(() => null) as { error?: unknown } | null;
      if (!save.ok || !confirmsClientSave(payload, data)) {
        uncertain("파일을 올렸지만 고객사 연결 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.");
        return;
      }
      pendingAttachmentRef.current = null;
      setPendingAttachment(null);
      setNotice(attempt.kind === "logo" ? "로고를 등록했습니다." : "사업자등록증을 등록했습니다.");
      await load();
    } catch (error) {
      if (!attempt.uncertain && !attempt.fileId && isOrganizationContextBlock(error)) {
        pendingAttachmentRef.current = null;
        setPendingAttachment(null);
        setFormError({ field: null, message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else uncertain("연결이 끊겨 파일 처리 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.");
    } finally {
      clientWriteRef.current = false;
      setUploading(null);
    }
  }

  function requestRemoveAttachment(client: Client, kind: "logo" | "doc") {
    if (pendingAttachmentRef.current || otherClientReceipt) return;
    // Name the client in the confirm: logo/doc removes are per-record and
    // the list shows several similar rows.
    setRemovePending({ id: client.id, kind });
  }

  async function executeRemoveAttachment(client: Client, kind: "logo" | "doc") {
    if (clientWriteRef.current || pendingAttachmentRef.current || otherClientReceipt) return;
    clientWriteRef.current = true;
    setNotice(null);
    try {
      const payload = {
        id: client.id, name: client.name, contact: client.contact, email: client.email,
        ...(kind === "logo" ? { logoFileId: "" } : { docFileId: "" }),
      };
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          ...payload,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !confirmsClientSave(payload, data)) {
        setFormError({ field: null, message: res.ok || !isDefinitiveClientError(res.status) ? "제거 결과를 확인하지 못했습니다. 처리 결과 확인에서 확인하세요." : "제거하지 못했습니다." });
        return;
      }
      setNotice(kind === "logo" ? "로고를 제거했습니다." : "사업자등록증을 제거했습니다.");
      await load();
    } catch {
      setFormError({ field: null, message: "제거 결과를 확인하지 못했습니다. 처리 결과 확인에서 확인하세요." });
    } finally {
      clientWriteRef.current = false;
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="clients">
        <ConsoleStatePanel kind="loading" message="고객사 목록을 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="clients">
        {/* ConsoleStatePanel supplies "다시 불러오기" and wakes the shell with eventouch:shell-reload. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  // Local filter only: no API, no new detail area. Counts stay in the
  // section so a filtered list never reads as the whole directory.
  const clientSearch = clientQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleClients = state.kind === "ready" && clientSearch
    ? state.clients.filter((client) =>
        `${client.name} ${client.contact} ${client.email}`.toLocaleLowerCase("ko-KR").includes(clientSearch)
      )
    : state.kind === "ready" ? state.clients : [];

  return (
    <ConsolePage
      pageId="clients"
      toolbar={
        <ConsoleToolbar
          filters={
            <label>
              <span className="sr-only" id="client-search-label">고객사 검색</span>
              <input
                aria-labelledby="client-search-label"
                type="search"
                placeholder="고객사명·담당자·이메일 검색"
                value={clientQuery}
                onChange={(event) => setClientQuery(event.target.value)}
              />
            </label>
          }
          actions={
            state.canManage ? (
              <ProductButton type="button" className="button button-primary" disabled={otherClientReceipt || Boolean(pendingAttachment)} onClick={() => openDraft({ ...EMPTY_DRAFT })}>
                고객사 등록
              </ProductButton>
            ) : undefined
          }
        />
      }
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {formError && !draft ? <ConsoleFeedback kind="error">{formError.message}</ConsoleFeedback> : null}
          {otherClientReceipt ? <ConsoleFeedback kind="warning">이전 고객사 저장의 처리 여부를 위의 처리 결과 확인에서 확인한 뒤 새로 저장할 수 있습니다.</ConsoleFeedback> : null}
          {pendingAttachment ? <section aria-label="파일 처리 확인">
            <ConsoleFeedback kind="warning">{pendingAttachment.client.name}의 {pendingAttachment.kind === "logo" ? "로고" : "사업자등록증"} {uploading ? "파일을 처리하고 있습니다." : "처리가 끝나지 않았습니다. 이 화면을 떠나면 파일은 다시 선택해야 합니다."}</ConsoleFeedback>
            <p>
              <ProductButton type="button" className="button button-secondary" disabled={uploading !== null} onClick={() => { if (pendingAttachmentRef.current) void runAttachment(pendingAttachmentRef.current); }}>같은 파일 요청 다시 확인</ProductButton>{" "}
              <ProductButton type="button" className="button button-secondary" disabled={uploading !== null} onClick={() => setAbandonAttachment(true)}>파일 확인 그만두기</ProductButton>
            </p>
            {abandonAttachment ? <ConsoleConfirm
              summary="파일이 이미 서버에 저장되었거나 고객사에 연결되었을 수 있습니다. 확인을 그만둘까요?"
              confirmLabel="확인 그만두기"
              onCancel={() => setAbandonAttachment(false)}
              onConfirm={() => {
                const attempt = pendingAttachmentRef.current;
                if (attempt) { abandonOperatorAttempt(attempt.uploadCommandId); abandonOperatorAttempt(attempt.linkCommandId); }
                pendingAttachmentRef.current = null;
                setPendingAttachment(null);
                setAbandonAttachment(false);
                setFormError(null);
                setNotice("파일 확인을 그만두었습니다. 서버에 이미 저장된 파일은 취소되지 않습니다.");
                setReloadTick((tick) => tick + 1);
              }}
            /> : null}
          </section> : null}
          {!state.canManage ? (
            <ConsoleFeedback kind="warning">고객사 등록·수정 권한이 없습니다. 변경이 필요하면 조직 소유자에게 요청하세요.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <ConsoleSection headingId="client-list-heading" title="고객사 목록" surface="plain" width="full">
        <p className="participant-count" role="status">
          {clientSearch
            ? `검색 결과 ${visibleClients.length}개 / 전체 ${state.clients.length}개`
            : `전체 ${state.clients.length}개`}
          {clientSearch ? (
            <>
              {" "}
              <ProductButton type="button" className="button button-secondary" onClick={() => setClientQuery("")}>
                검색 지우기
              </ProductButton>
            </>
          ) : null}
        </p>
        {!state.clients.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>등록된 고객사가 없습니다.</h3>
            <p>새 행사의 고객사는 행사 만들기에서 함께 지정할 수 있습니다.</p>
          </div>
        ) : !visibleClients.length ? (
          <div className={consoleUiStyles.empty}>
            <h3>조건에 맞는 고객사가 없습니다.</h3>
            <p>검색어를 바꾸거나 다른 이름·담당자·이메일로 찾아보세요.</p>
            <p>
              <ProductButton type="button" className="button button-secondary" onClick={() => setClientQuery("")}>
                검색 지우기
              </ProductButton>
            </p>
          </div>
        ) : (
          <ul className={consoleUiStyles.collection} aria-label="고객사 목록">
            {visibleClients.map((client) => (
              <li className={`${consoleUiStyles.recordRow} ${styles.clientRow}`} key={client.id}>
                <div className={`${consoleUiStyles.recordMain} ${styles.clientMain}`}>
                  <h3>{client.name}</h3>
                  {client.logoFileId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="client-logo"
                      src={`/api/clients/${encodeURIComponent(client.id)}/files/${encodeURIComponent(client.logoFileId)}`}
                      alt={`${client.name} 로고`}
                    />
                  ) : null}
                  {/* Document presence is independent of contact display: a
                      client with only a business-license file still gets the
                      문서 보기 link. File permission stays server-side. */}
                  {client.contact || client.email || client.docFileId ? (
                    <dl className="client-meta">
                      {client.contact ? (
                        <div>
                          <dt>담당자</dt>
                          <dd>{client.contact}</dd>
                        </div>
                      ) : null}
                      {client.email ? (
                        <div>
                          <dt>이메일</dt>
                          <dd>{client.email}</dd>
                        </div>
                      ) : null}
                      {client.docFileId ? (
                        <div>
                          <dt>사업자등록증</dt>
                          <dd>
                            <a href={`/api/clients/${encodeURIComponent(client.id)}/files/${encodeURIComponent(client.docFileId)}`}>
                              문서 보기
                            </a>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </div>
                {state.canManage ? (
                  <div className={`${consoleUiStyles.recordActions} ${styles.clientActions}`}>
                    <div className={styles.clientInfoGroup} role="group" aria-label={`${client.name} 정보 관리`}>
                    <ProductButton
                      type="button"
                      className="button button-secondary"
                      disabled={otherClientReceipt || Boolean(pendingAttachment)}
                      onClick={() => {
                        openDraft({ id: client.id, name: client.name, contact: client.contact, email: client.email });
                      }}
                    >
                      정보 수정
                    </ProductButton>
                    </div>
                    <details className={styles.attachmentTools}>
                      <summary>파일 관리</summary>
                      <div className={styles.attachmentPanel}>
                    <div className={styles.clientFileGroup} role="group" aria-label={`${client.name} 로고 관리`}>
                    <label className="button button-secondary">
                      {uploading === `${client.id}:logo` ? "올리는 중…" : client.logoFileId ? "로고 교체" : "로고 등록"}
                      <input
                        type="file"
                        className="sr-only"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={uploading !== null || Boolean(pendingAttachment) || otherClientReceipt}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAttachment(client, "logo", file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {client.logoFileId ? (
                      <ProductButton type="button" className="button button-secondary" disabled={Boolean(pendingAttachment) || otherClientReceipt} onClick={() => requestRemoveAttachment(client, "logo")}>
                        로고 제거
                      </ProductButton>
                    ) : null}
                    </div>
                    <div className={styles.clientFileGroup} role="group" aria-label={`${client.name} 사업자등록증 관리`}>
                    <label className="button button-secondary">
                      {uploading === `${client.id}:doc` ? "올리는 중…" : client.docFileId ? "서류 교체" : "사업자등록증 등록"}
                      <input
                        type="file"
                        className="sr-only"
                        accept="application/pdf"
                        disabled={uploading !== null || Boolean(pendingAttachment) || otherClientReceipt}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAttachment(client, "doc", file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {client.docFileId ? (
                      <ProductButton type="button" className="button button-secondary" disabled={Boolean(pendingAttachment) || otherClientReceipt} onClick={() => requestRemoveAttachment(client, "doc")}>
                        서류 제거
                      </ProductButton>
                    ) : null}
                    </div>
                      </div>
                    </details>
                    {removePending?.id === client.id ? (
                      <ConsoleConfirm
                        summary={confirmLines(removeSummary(client, removePending.kind))}
                        confirmLabel="제거한다"
                        onConfirm={() => {
                          const pending = removePending;
                          setRemovePending(null);
                          void executeRemoveAttachment(client, pending.kind);
                        }}
                        onCancel={() => setRemovePending(null)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>
      {draft && state.canManage ? (
        <ConsoleDialog
          title={draft.id ? "고객사 정보 수정" : "고객사 등록"}
          onClose={closeDraft}
          busy={saving || checkingClient}
          canClose={canCloseClientDialog}
          footer={
            <ConsoleFormActions>
              <ProductButton type="button" className="button button-secondary" onClick={() => { if (canCloseClientDialog()) closeDraft(); }} disabled={saving || checkingClient}>
                취소
              </ProductButton>
              {clientUncertain ? <ProductButton type="button" className="button button-secondary" disabled={saving || checkingClient} onClick={() => void checkClientResult()}>{checkingClient ? "확인 중…" : "서버 처리 확인"}</ProductButton> : null}
              <ProductButton type="submit" form="client-form" className="button button-primary" disabled={saving || checkingClient || otherClientReceipt}>
                {saving ? "저장 중…" : clientUncertain ? "같은 요청 다시 시도" : "저장"}
              </ProductButton>
            </ConsoleFormActions>
          }
        >
          <ValidatedForm
            id="client-form"
            className={consoleUiStyles.formStack}
            onSubmit={(event) => void saveClient(event)}
          >
            {clientUncertain ? <p role="status">결과를 확인할 때까지 원래 입력 내용을 유지합니다.</p> : null}
            <div className={consoleUiStyles.field}>
              <label htmlFor="client-name">고객사명 (필수)</label>
              <input
                id="client-name"
                type="text"
                maxLength={80}
                required
                value={draft.name}
                readOnly={saving || checkingClient || clientUncertain}
                aria-invalid={formError?.field === "name"}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              {formError?.field === "name" ? <ConsoleFeedback kind="error">{formError.message}</ConsoleFeedback> : null}
            </div>
            <div className={consoleUiStyles.field}>
              <label htmlFor="client-contact">담당자 (선택)</label>
              <input
                id="client-contact"
                type="text"
                maxLength={60}
                value={draft.contact}
                readOnly={saving || checkingClient || clientUncertain}
                onChange={(event) => setDraft({ ...draft, contact: event.target.value })}
              />
            </div>
            <div className={consoleUiStyles.field}>
              <label htmlFor="client-email">담당자 이메일 (선택)</label>
              <input
                id="client-email"
                type="email"
                maxLength={120}
                value={draft.email}
                readOnly={saving || checkingClient || clientUncertain}
                aria-invalid={formError?.field === "email"}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
              {formError?.field === "email" ? <ConsoleFeedback kind="error">{formError.message}</ConsoleFeedback> : null}
            </div>
            {formError && !formError.field ? <ConsoleFeedback kind="error">{formError.message}</ConsoleFeedback> : null}
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}
    </ConsolePage>
  );
}
