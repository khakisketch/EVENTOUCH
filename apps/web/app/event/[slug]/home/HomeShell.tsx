"use client";

import ValidatedForm from "../../../ui/ValidatedForm";


import { useCallback, useEffect, useRef, useState } from "react";
import ProductLink from "../../../ui/ProductLink";
import RichText from "../../../ui/RichText";
import dynamic from "next/dynamic";
import TicketView from "../ticket/TicketView";
import { fetchWithDeadline } from "../../../../lib/request-deadline";
import styles from "./home.module.css";
import AttendeeHomeLanding, { HOME_MENUS, type HomeMenuKey } from "./AttendeeHomeLanding";
import { normalizeHomeStyle, parseHomePhotos, type HomePhoto, type HomeStyle } from "../../../../lib/attendee-home";
import { homeSurfaceStyle } from "../../../../lib/home-surface";
import AttendeeSurface from "../ui/AttendeeSurface";
import AttendeeStateMessage from "../ui/AttendeeStateMessage";
import BottomAction from "../ui/BottomAction";
import AttendeeIcon from "../ui/AttendeeIcon";
import { attendeeLook } from "../attendee-look";
import { normalizeHomeMenus, type HomeMenus, type HomeProgram } from "../../../../lib/attendee-home-menus";
import { isRecoveryBlocked, useVerificationMode } from "../../../../lib/use-verification-mode";
import { useUnsavedNavigationGuard } from "../../../../lib/use-unsaved-navigation-guard";
import { readGuestReceipts, writeGuestReceipts, type GuestReceiptPointer } from "../../../../lib/receipt-recovery";
import { boothCanAttempt, boothOperatingStatus, formatBoothScheduleTime, isBoothContextChanged } from "../../../../lib/booth-availability";
import { captureServerClock, readServerClock, type ServerClock } from "../../../../lib/server-clock";
import { allowSessionForTab, clearSessionForTab, clearTicketRejected, getAllowedTicketForTab, isTicketRejected, markTicketRejected, REJECTED_TICKET_BEARER, ticketStorageAvailable } from "../../../../lib/attendee-ticket-identity";

// The scanner (and its decoder) loads only when the attendee opens it: the
// home shell never pays for jsQR until the first booth scan.
const CameraScan = dynamic(() => import("../../../CameraScan"), {
  ssr: false,
});

// Attendee home shell: ticket, application information, notices, lucky number,
// roulette, ranked vote and booth stamping share one route. The ticket bearer lives in tab memory only
// (sessionStorage, same key as the ticket screen) and travels in the
// Authorization header; it is never rendered or written to persistent
// storage. Guest writes go through the event command path with the resolved
// event id, exactly like the engagement screen.

type PublicEvent = {
  id: string;
  slug: string;
  name: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
  stage: string;
  features: string[];
};

const HOME_READ_TIMEOUT_MS = 8000;
const HOME_REFRESH_INTERVAL_MS = 4500;

type Notice = { id: string; title: string; body: string; pinned?: boolean };

type Team = { id: string; name: string; order: number };
type VoteCount = { count: number; ranks: { 1: number; 2: number; 3: number } };
type VoteConfig = { pickCount: number; status: "OPEN" | "CLOSED"; resultsPublished: boolean };
type RoulettePrize = { id: string; tier: number; label: string };
type RouletteResult = { tier: number; label: string; at: string };
type RouletteConfig = {
  status: "DRAFT" | "OPEN" | "CLOSED";
  open: boolean;
  startsAt: string | null;
  endsAt: string | null;
  scheduleNeedsReview: boolean;
  prizes: RoulettePrize[];
};
type RewardEntitlement = { id: string; name: string; status: string; at: string };
type DrawProgram = {
  id: string;
  name: string;
  quota: number;
  moduleId: string;
  status: string;
  published: boolean;
  drawnAt: string;
  winnerCount: number;
  winners: Array<{
    name: string;
    company: string;
    kind?: "PERSON" | "COMPANY";
    tier?: string;
    luckyNumber?: number;
  }>;
};

type TicketWorkspace = {
  teams?: unknown;
  voteCounts?: unknown;
  voteSubmitted?: unknown;
  ownVote?: unknown;
  lucky?: unknown;
  roulette?: unknown;
  rouletteConfig?: unknown;
  rouletteView?: unknown;
  rewards?: unknown;
  voteConfig?: unknown;
  drawPrograms?: unknown;
  booths?: unknown;
  visits?: unknown;
  stampMode?: unknown;
};

type HomeBooth = {
  id: string;
  name: string;
  limit: number;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number;
  used: number;
};
type StampMode = "SELF" | "STAFF";
type PendingGuestCommand = {
  key: string;
  formKey: string;
  eventId: string;
  slug: string;
  ticketToken: string;
  commandId: string;
  command: string;
  payload: Record<string, unknown>;
  teamNames: Record<string, string>;
  message: string;
};
type CompletedGuestCommand = {
  eventId: string;
  slug: string;
  ticketToken: string;
  message: string;
};

type LoadedTicketContext = { slug: string; eventId: string; ticketToken: string };

type LoadState =
  | { kind: "loading" }
  // Event lookup, ticket, and transport failures read differently and
  // recover differently: an unknown slug is not a lost ticket, and a lost
  // ticket link is not a dropped connection. The reason keeps the panel
  // honest and the retry scoped to the same tab and context.
  | {
      kind: "failed";
      reason: "event-missing" | "ticket-invalid" | "transient";
      message: string;
      eventName: string;
      hasTicket: boolean;
    }
  | {
      kind: "ready";
      eventId: string;
      eventName: string;
      keyvisual: string | null;
      defaultHomeBanner: "legacy" | "neutral";
      homeStyle: HomeStyle;
      accent: string | null;
      homeMenus: HomeMenus;
      programs: HomeProgram[];
      photos: HomePhoto[];
      eventDate: string;
      eventTime: string;
      ticketStatus: string;
      ticketName: string;
      hasTicket: boolean;
      ticketToken: string;
      notices: Notice[];
      teams: Team[];
      voteCounts: Record<string, VoteCount>;
      voteConfig: VoteConfig | null;
      voteSubmitted: boolean;
      ownPicks: Array<{ teamId: string; rank: number | null }>;
      lucky: { number: number; at: string } | null;
      roulette: RouletteResult | null;
      rouletteConfig: RouletteConfig | null;
      rewards: RewardEntitlement[];
      drawPrograms: DrawProgram[];
      stampMode: StampMode;
      serverClock: ServerClock | null;
      stampStatus?: "checking" | "stale";
      refreshFailed?: boolean;
      booths: HomeBooth[];
      ownVisits: Record<string, number>;
      hasPrograms: boolean;
      unavailable: HomeMenuKey[];
    };

type Tab = HomeMenuKey;

const STORAGE_PREFIX = "eventouch.ticket.";

function readStoredTicket(slug: string): string {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + slug) || "";
  } catch {
    return "";
  }
}

function storeTicket(slug: string, ticket: string): boolean {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + slug, ticket);
    return true;
  } catch {
    // Private mode: the in-memory bearer still works for this load.
    return false;
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function guestCommandName(command: string): string {
  if (command === "lucky.assign") return "럭키번호 발급";
  if (command === "roulette.spin") return "룰렛 추첨";
  if (command === "vote.ranked") return "순위 투표";
  if (command === "booth.visit") return "부스 인증";
  return "참가 요청";
}

function recoveredCommandMessage(pending: PendingGuestCommand, data: Record<string, unknown>): string {
  if (pending.command === "lucky.assign") {
    const lucky = asRecord(data.lucky);
    return typeof lucky?.number === "number" ? `럭키번호 ${lucky.number}번이 발급되었습니다.` : "럭키번호 발급을 확인했습니다.";
  }
  if (pending.command === "roulette.spin") {
    const roulette = asRecord(data.roulette);
    return roulette
      ? `룰렛 결과: ${text(roulette.label) || `제${String(roulette.tier)} 경품`}`
      : "룰렛 추첨 결과를 확인했습니다.";
  }
  if (pending.command === "vote.ranked") {
    const vote = asRecord(data.vote);
    const names = Array.isArray(vote?.picks)
      ? vote.picks.flatMap((item) => {
          const pick = asRecord(item);
          return typeof pick?.teamId === "string" && pending.teamNames[pick.teamId]
            ? [{ rank: Number(pick.rank) || 99, name: pending.teamNames[pick.teamId] }]
            : [];
        }).sort((a, b) => a.rank - b.rank).map((pick) => pick.name)
      : [];
    return names.length ? `투표가 접수되었습니다. 내 선택 · ${names.join(" · ")}` : "투표가 접수되었습니다.";
  }
  if (pending.command === "booth.visit") {
    const booth = text(data.booth, "부스");
    return `${booth} 인증을 기록했습니다.`;
  }
  return "요청 처리를 확인했습니다.";
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function publicKeyvisualSource(slug: string, value: unknown): string | null {
  const image = asRecord(value);
  const data = text(image?.data);
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return data;
  const fileId = text(image?.fileId);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) return null;
  return `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`;
}

function PendingGuestCommandRecovery({
  commands,
  receipts,
  storageAvailable,
  receiptMessage,
  recoveringCommandKey,
  isCurrentContext,
  onRetry,
  onCheck,
  onForget,
  onAbandon,
}: {
  commands: PendingGuestCommand[];
  receipts: GuestReceiptPointer[];
  storageAvailable: boolean;
  receiptMessage: string | null;
  recoveringCommandKey: string | null;
  isCurrentContext: (snapshot: PendingGuestCommand) => boolean;
  onRetry: (key: string) => void;
  onCheck: (pointer: GuestReceiptPointer) => void;
  onForget: (pointer: GuestReceiptPointer) => void;
  onAbandon: (key: string) => void;
}) {
  const savedOnly = receipts.filter((pointer) => !commands.some((command) => command.commandId === pointer.commandId));
  if (!commands.length && !savedOnly.length && !receiptMessage) return null;
  return (
    <section className={styles.commandRecovery} aria-labelledby="pending-command-recovery-title">
      <h2 id="pending-command-recovery-title" className={styles.commandRecoveryTitle}>처리 여부를 확인하지 못한 요청</h2>
      <p className={styles.commandRecoveryMemory}>
        원래 입력은 이 화면에서만 유지됩니다. {storageAvailable ? "새로고침 후에는 처리 여부만 확인할 수 있습니다." : "화면을 떠나기 전에 원래 요청을 확인하세요."}
      </p>
      {!storageAvailable ? <p role="alert">이 브라우저에서 결과 확인 정보를 저장할 수 없습니다.</p> : null}
      {receiptMessage ? <p role="status">{receiptMessage}</p> : null}
      {commands.map((command) => {
        const recoveryId = `${command.key}:${command.commandId}`;
        const recovering = recoveringCommandKey === recoveryId;
        const sameContext = isCurrentContext(command);
        const pointer = receipts.find((item) => item.commandId === command.commandId);
        return (
          <article className={styles.commandRecoveryItem} key={command.commandId}>
            <h3 className={styles.commandRecoveryItemTitle}>{guestCommandName(command.command)}</h3>
            <p className={styles.commandRecoveryMessage} role="alert">
              {command.message} 처음 보낸 행사·티켓·내용은 바뀌지 않습니다.
            </p>
            {!sameContext ? (
              <p className={styles.commandRecoveryNote} role="note">
                이전 티켓으로 보낸 요청입니다. 현재 티켓과 섞지 않고 원래 티켓으로만 다시 확인합니다.
              </p>
            ) : null}
            <p className={styles.commandRecoveryNote}>
              확인 중단은 서버 요청을 취소하거나 이미 기록된 결과를 되돌리지 않습니다. 진행 중인 확인의 늦은 응답은 이후 요청의 결과로 표시하지 않습니다.
            </p>
            {recovering ? <p className={styles.commandRecoveryProgress} role="status">같은 요청을 확인하고 있습니다.</p> : null}
            <div className={styles.commandRecoveryActions}>
              {pointer ? <button type="button" className={styles.recoveryRetryButton} disabled={recoveringCommandKey !== null} onClick={() => onCheck(pointer)}>서버 처리 확인</button> : null}
              <button
                type="button"
                className={pointer ? styles.recoveryAbandonButton : styles.recoveryRetryButton}
                disabled={recoveringCommandKey !== null}
                onClick={() => onRetry(command.key)}
              >
                {recovering ? "원래 요청 전송 중…" : "원래 요청 다시 보내기"}
              </button>
              <button
                type="button"
                className={styles.recoveryAbandonButton}
                onClick={() => onAbandon(command.key)}
              >
                확인 중단
              </button>
            </div>
          </article>
        );
      })}
      {savedOnly.map((pointer) => <article className={styles.commandRecoveryItem} key={pointer.commandId}>
        <h3 className={styles.commandRecoveryItemTitle}>{guestCommandName(pointer.command)}</h3>
        <p className={styles.commandRecoveryNote}>서버 처리 여부만 확인하며 요청을 다시 보내지 않습니다.</p>
        <div className={styles.commandRecoveryActions}>
          <button type="button" className={styles.recoveryRetryButton} disabled={recoveringCommandKey !== null} onClick={() => onCheck(pointer)}>서버 처리 확인</button>
          <button type="button" className={styles.recoveryAbandonButton} disabled={recoveringCommandKey !== null} onClick={() => onForget(pointer)}>목록에서 지우기</button>
        </div>
      </article>)}
    </section>
  );
}

function CompletedGuestCommandNotices({
  commands,
  isCurrentContext,
}: {
  commands: Array<[string, CompletedGuestCommand]>;
  isCurrentContext: (command: CompletedGuestCommand) => boolean;
}) {
  if (!commands.length) return null;
  return (
    <div className={styles.commandCompletedList}>
      {commands.map(([key, command]) => (
        <p className={styles.commandCompleted} role="status" key={key}>
          {isCurrentContext(command)
            ? command.message
            : "이전 티켓 요청은 확인되었지만 현재 티켓과 달라 결과를 표시하지 않습니다."}
        </p>
      ))}
    </div>
  );
}

// The landing retains the six established entries and adds paths to the
// attendee's application, published event information and participation.
export default function HomeShell({ slug }: { slug: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());
  const ticketRef = useRef<string>("");
  const ticketSlugRef = useRef(slug);
  const currentContextRef = useRef<LoadedTicketContext | null>(null);
  const commandIdsRef = useRef<Record<string, string>>({});
  const currentCommandIdsRef = useRef<Record<string, string>>({});
  const pendingCommandsRef = useRef<Record<string, PendingGuestCommand>>({});
  const [pendingCommands, setPendingCommands] = useState<Record<string, PendingGuestCommand>>({});
  const [completedCommands, setCompletedCommands] = useState<Record<string, CompletedGuestCommand>>({});
  const [recoveringCommandKey, setRecoveringCommandKey] = useState<string | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const [activeWrites, setActiveWrites] = useState(0);
  const [receipts, setReceipts] = useState<GuestReceiptPointer[]>([]);
  const receiptsRef = useRef<GuestReceiptPointer[]>([]);
  const [receiptStorageAvailable, setReceiptStorageAvailable] = useState(true);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const onDetailDirtyChange = useCallback((dirty: boolean) => setDetailDirty(dirty), []);
  const hasPendingWork = Object.keys(pendingCommands).length > 0 || activeWrites > 0;
  useUnsavedNavigationGuard(detailDirty || hasPendingWork,
    hasPendingWork
      ? "처리 결과를 확인 중입니다. 이동해도 서버 처리는 취소되지 않으며 원래 요청을 다시 보낼 수 없을 수 있습니다."
      : "선택하거나 입력한 내용이 있습니다. 이동하면 저장하지 않은 내용이 사라집니다.");
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const menuButtonRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    qr: null,
    application: null,
    notice: null,
    lucky: null,
    roulette: null,
    vote: null,
    stamp: null,
  });
  const previousTabRef = useRef<Tab | null>(null);

  useEffect(() => {
    const saved = readGuestReceipts(slug);
    receiptsRef.current = saved.items;
    setReceipts(saved.items);
    setReceiptStorageAvailable(saved.available);
  }, [slug]);

  function saveReceipts(items: GuestReceiptPointer[]) {
    receiptsRef.current = items;
    setReceipts(items);
    if (!writeGuestReceipts(slug, items)) setReceiptStorageAvailable(false);
  }
  function rememberReceipt(snapshot: PendingGuestCommand) {
    if (!receiptsRef.current.some((item) => item.commandId === snapshot.commandId)) {
      saveReceipts([...receiptsRef.current, { eventId: snapshot.eventId, commandId: snapshot.commandId, command: snapshot.command }]);
    }
  }
  function forgetReceipt(id: string) {
    saveReceipts(receiptsRef.current.filter((item) => item.commandId !== id));
  }

  function tabFromLocation(): Tab | null {
    const value = new URLSearchParams(window.location.search).get("view");
    return value === "application" || HOME_MENUS.some((menu) => menu.key === value) ? (value as Tab) : null;
  }

  useEffect(() => {
    const syncFromHistory = () => setActiveTab(tabFromLocation());
    syncFromHistory();
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => {
    if (activeTab && state.kind === "ready") detailBackRef.current?.focus();
    else if (!activeTab && previousTabRef.current) (menuButtonRefs.current[previousTabRef.current] ?? menuButtonRefs.current.qr)?.focus();
    previousTabRef.current = activeTab;
  }, [activeTab, state.kind]);

  function commandIdFor(key: string): string {
    if (!commandIdsRef.current[key]) commandIdsRef.current[key] = randomCommandId();
    return commandIdsRef.current[key];
  }

  function updatePendingCommand(key: string, pending: PendingGuestCommand | null) {
    const next = { ...pendingCommandsRef.current };
    if (pending) next[key] = pending;
    else delete next[key];
    pendingCommandsRef.current = next;
    setPendingCommands(next);
  }

  async function sendGuestCommand(snapshot: PendingGuestCommand): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchWithDeadline(`/api/events/${encodeURIComponent(snapshot.eventId)}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${snapshot.ticketToken}`,
        },
        body: JSON.stringify({
          commandId: snapshot.commandId,
          command: snapshot.command,
          payload: snapshot.payload,
        }),
      });
    } catch {
      throw { message: "서버 응답을 확인하지 못했습니다.", status: 0 };
    }
    const data = (await response.json()) as Record<string, unknown> | null;
    if (!response.ok) {
      throw {
        message: typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
        status: response.status,
        code: data?.code,
      };
    }
    const result = asRecord(data);
    const valid = snapshot.command === "lucky.assign"
      ? typeof asRecord(result?.lucky)?.number === "number"
      : snapshot.command === "roulette.spin"
        ? typeof asRecord(result?.roulette)?.tier === "number"
        : snapshot.command === "vote.ranked"
          ? Array.isArray(asRecord(result?.vote)?.picks)
          : snapshot.command === "booth.visit"
            ? typeof result?.name === "string" && typeof result?.booth === "string" &&
              result.visitId === snapshot.commandId && typeof result.participantId === "string" && Boolean(result.participantId) &&
              typeof snapshot.payload.code === "string" &&
              snapshot.payload.code.trim().slice(0, 512).startsWith(`ET:BOOTH:${snapshot.eventId}:`) &&
              result.boothId === snapshot.payload.code.trim().slice(0, 512).slice(`ET:BOOTH:${snapshot.eventId}:`.length) &&
              typeof result.boothId === "string" && Boolean(result.boothId)
            : false;
    if (!valid) throw { message: "성공 응답을 확인하지 못했습니다.", status: 0 };
    return result ?? {};
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    const readTimeout = window.setTimeout(() => controller.abort(), HOME_READ_TIMEOUT_MS);
    async function load() {
      if (ticketSlugRef.current !== slug) {
        ticketRef.current = "";
        ticketSlugRef.current = slug;
        currentContextRef.current = null;
      }
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
      const explicitSession = !fromLink && query.get("session") === "1";
      const rejected = !fromLink && !explicitSession && (query.get("ticket-error") === "1" || isTicketRejected(slug));
      // Consume a linked bearer once, exactly like the ticket screen.
      if (fromLink) { clearSessionForTab(slug); clearTicketRejected(slug); storeTicket(slug, fromLink); }
      if (fromLink) {
        query.delete("ticket");
        query.delete("ticket-error");
        query.delete("session");
        const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", cleaned);
      }
      const storageUsable = ticketStorageAvailable(slug);
      const ticket = rejected ? REJECTED_TICKET_BEARER : explicitSession ? "" : fromLink || getAllowedTicketForTab(slug) || ticketRef.current || (storageUsable ? readStoredTicket(slug) : "");
      const allowSession = !rejected && explicitSession;
      ticketRef.current = ticket;
      if (currentContextRef.current &&
        (currentContextRef.current.slug !== slug || currentContextRef.current.ticketToken !== ticket)) {
        currentContextRef.current = null;
      }
      function failLoad(reason: "event-missing" | "ticket-invalid" | "transient", message: string, eventName: string, hasTicket: boolean) {
        const context = currentContextRef.current;
        setState((current) => {
          const sameContext = reason === "transient" && current.kind === "ready" && current.hasTicket &&
            context?.slug === slug && context.eventId === current.eventId && current.ticketToken === ticket;
          if (sameContext && activeTab === "stamp") return { ...current, stampStatus: "stale" };
          if (sameContext && (activeTab === "vote" || activeTab === "roulette")) return { ...current, refreshFailed: true };
          return { kind: "failed", reason, message, eventName, hasTicket };
        });
      }
      try {
        const publicRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const publicData = (await publicRes.json().catch(() => null)) as {
          event?: PublicEvent | null;
            workspace?: {
              notices?: unknown;
              modules?: unknown;
              photos?: unknown;
              pageExperience?: { published?: { keyvisual?: unknown; accent?: unknown; defaultHomeBanner?: unknown; homeStyle?: unknown; homeMenus?: unknown; showAnnouncements?: unknown } } | null;
          } | null;
        } | null;
        const eventName = text(publicData?.event?.name);
        if (!publicRes.ok || !publicData?.event) {
          if (!cancelled) {
            if (publicRes.status === 404) currentContextRef.current = null;
            failLoad(
              publicRes.status === 404 ? "event-missing" : "transient",
              publicRes.status === 404 ? "요청한 행사 주소를 확인하세요." : "행사 정보를 불러오지 못했습니다.",
              eventName,
              Boolean(ticket),
            );
          }
          return;
        }
        const event = publicData.event;
        // The public projection already excludes drafts and disabled types.
        const programs: HomeProgram[] = Array.isArray(publicData.workspace?.modules) ? publicData.workspace.modules.flatMap((value) => {
          const item = asRecord(value);
          return typeof item?.id === "string" && typeof item.title === "string" ? [{ id: item.id, title: item.title }] : [];
        }) : [];
        const hasPrograms = programs.length > 0;
        const publishedPage = publicData.workspace?.pageExperience?.published;
        const enabled = new Set(Array.isArray(event.features) ? event.features : []);
        const unavailable: HomeMenuKey[] = [
          ...(publishedPage?.showAnnouncements === false ? ["notice" as const] : []),
          ...(!enabled.has("draw") ? ["lucky" as const, "roulette" as const] : []),
          ...(!enabled.has("poll") ? ["vote" as const] : []),
          ...(!enabled.has("stamp") ? ["stamp" as const] : []),
        ];
        const keyvisual = publicKeyvisualSource(slug, publishedPage?.keyvisual);
        const defaultHomeBanner = publishedPage?.defaultHomeBanner === "neutral" ? "neutral" : "legacy";
        const homeStyle = normalizeHomeStyle(publishedPage?.homeStyle);
        const accent = typeof publishedPage?.accent === "string" && /^#[0-9a-f]{6}$/i.test(publishedPage.accent) ? publishedPage.accent : null;
        const homeMenus = normalizeHomeMenus(publishedPage?.homeMenus);
        // The photo-first home lists approved participant photos only, and only
        // while the 사진 feature is on. The public projection also carries an
        // attendee's own pending photo; parseHomePhotos drops everything that
        // is not approved.
        const photos: HomePhoto[] = enabled.has("photo")
          ? parseHomePhotos(publicData.workspace?.photos, (fileId) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`)
          : [];
        const notices: Notice[] = Array.isArray(publicData.workspace?.notices)
          ? (publicData.workspace.notices as unknown[]).flatMap((item) => {
              const notice = asRecord(item);
              if (!notice || typeof notice.title !== "string") return [];
              return [{
                id: text(notice.id),
                title: notice.title,
                body: text(notice.body),
                pinned: notice.pinned === true,
              }];
            })
          : [];
        const ticketReadStarted = performance.now();
        const ticketRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, {
          ...(ticket ? { headers: { authorization: `Bearer ${ticket}` } } : {}),
          credentials: ticket || storageUsable || allowSession ? "same-origin" : "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        const ticketData = (await ticketRes.json().catch(() => null)) as {
          serverTimeMs?: unknown;
          error?: unknown;
          event?: { id?: unknown; name?: unknown } | null;
          participant?: Record<string, unknown> | null;
          workspace?: TicketWorkspace | null;
        } | null;
        const serverClock = captureServerClock(ticketData?.serverTimeMs, ticketReadStarted, performance.now(), Date.now());
        if (!ticket && ticketRes.status === 404) {
          if (!cancelled) {
            currentContextRef.current = { slug, eventId: text((event as { id?: unknown }).id), ticketToken: "" };
            setState({
              kind: "ready",
              eventId: text((event as { id?: unknown }).id),
              eventName: event.name,
              keyvisual,
              defaultHomeBanner,
              homeStyle,
              accent,
              homeMenus,
              programs,
              photos,
              eventDate: event.date,
              eventTime: `${event.start} ~ ${event.end}`,
              ticketStatus: "",
              ticketName: "",
              hasTicket: false,
              ticketToken: "",
              notices,
              teams: [],
              voteCounts: {},
              voteConfig: null,
              voteSubmitted: false,
              ownPicks: [],
              lucky: null,
              roulette: null,
              rouletteConfig: null,
              rewards: [],
              drawPrograms: [],
              stampMode: "STAFF",
              serverClock: null,
              booths: [],
              ownVisits: {},
              hasPrograms,
              unavailable,
            });
          }
          return;
        }
        if (!ticketRes.ok || !ticketData?.participant || !ticketData.workspace) {
          if (!cancelled) {
            const invalid = ticketRes.status === 404 || ticketRes.status === 401;
            if (invalid) currentContextRef.current = null;
            // The server says this link is not usable: stop replaying it on
            // the next load, exactly like the ticket screen. A dropped
            // connection keeps the stored bearer for the retry instead.
            if (ticketRes.status === 404) {
              markTicketRejected(slug);
              ticketRef.current = "";
              try {
                window.sessionStorage.removeItem(STORAGE_PREFIX + slug);
              } catch {
                // Private mode: nothing persisted to clear.
              }
            }
            failLoad(
              invalid ? "ticket-invalid" : "transient",
              typeof ticketData?.error === "string" ? ticketData.error : invalid
                ? "티켓을 확인할 수 없습니다."
                : "티켓 응답을 확인하지 못했습니다. 같은 화면에서 다시 시도하세요.",
              eventName,
              true,
            );
          }
          return;
        }
        const resolvedTicket = ticket || text(ticketData.participant.ticket);
        if (!cancelled && !ticket && allowSession) {
          const current = new URLSearchParams(window.location.search);
          current.delete("ticket-error"); current.delete("session");
          window.history.replaceState(null, "", `${window.location.pathname}${current.toString() ? `?${current.toString()}` : ""}${window.location.hash}`);
        }
        if (!cancelled && resolvedTicket) {
          clearTicketRejected(slug);
          ticketRef.current = resolvedTicket;
          currentContextRef.current = { slug, eventId: text(ticketData.event?.id), ticketToken: resolvedTicket };
          const stored = storeTicket(slug, resolvedTicket);
          if (stored && storageUsable) clearSessionForTab(slug);
          else allowSessionForTab(slug, resolvedTicket);
        }
        if (!cancelled && !resolvedTicket && !ticket) markTicketRejected(slug);
        const workspace = ticketData.workspace;
        const teams: Team[] = Array.isArray(workspace.teams)
          ? (workspace.teams as unknown[]).flatMap((item) => {
              const team = asRecord(item);
              if (!team || typeof team.id !== "string" || typeof team.name !== "string") return [];
              return [{ id: team.id, name: team.name, order: Number(team.order) || 0 }];
            }).sort((a, b) => a.order - b.order)
          : [];
        const voteCounts: Record<string, VoteCount> = {};
        const rawCounts = asRecord(workspace.voteCounts);
        if (rawCounts) {
          for (const [teamId, value] of Object.entries(rawCounts)) {
            const entry = asRecord(value);
            const ranks = asRecord(entry?.ranks);
            voteCounts[teamId] = {
              count: typeof entry?.count === "number" ? entry.count : 0,
              ranks: {
                1: typeof ranks?.["1"] === "number" ? (ranks["1"] as number) : 0,
                2: typeof ranks?.["2"] === "number" ? (ranks["2"] as number) : 0,
                3: typeof ranks?.["3"] === "number" ? (ranks["3"] as number) : 0,
              },
            };
          }
        }
        const ownVote = asRecord(workspace.ownVote);
        const ownPicks: Array<{ teamId: string; rank: number | null }> = Array.isArray(ownVote?.picks)
          ? (ownVote.picks as unknown[]).flatMap((item) => {
              const pick = asRecord(item);
              if (!pick || typeof pick.teamId !== "string") return [];
              const rank = Number(pick.rank);
              return [{ teamId: pick.teamId, rank: [1, 2, 3].includes(rank) ? rank : null }];
            })
          : [];
        const luckyRaw = asRecord(workspace.lucky);
        const lucky = luckyRaw && typeof luckyRaw.number === "number"
          ? { number: luckyRaw.number, at: text(luckyRaw.at) }
          : null;
        const rouletteRaw = asRecord(workspace.roulette);
        const roulette = rouletteRaw && typeof rouletteRaw.tier === "number"
          ? { tier: rouletteRaw.tier, label: text(rouletteRaw.label), at: text(rouletteRaw.at) }
          : null;
        const voteConfigRaw = asRecord(workspace.voteConfig);
        const voteConfig = voteConfigRaw && Number.isInteger(voteConfigRaw.pickCount)
          ? {
              pickCount: Math.max(1, Math.min(20, Number(voteConfigRaw.pickCount))),
              status: voteConfigRaw.status === "OPEN" ? "OPEN" as const : "CLOSED" as const,
              resultsPublished: voteConfigRaw.resultsPublished === true,
            }
          : null;
        // The safe public projection is named `rouletteView`; `rouletteConfig`
        // is accepted only for older in-flight server builds during deployment.
        const rouletteConfigRaw =
          asRecord(workspace.rouletteView) ?? asRecord(workspace.rouletteConfig);
        const rouletteConfig: RouletteConfig | null = rouletteConfigRaw
          ? {
              status: rouletteConfigRaw.status === "OPEN"
                ? "OPEN"
                : rouletteConfigRaw.status === "DRAFT" ? "DRAFT" : "CLOSED",
              open: rouletteConfigRaw.open === true,
              startsAt: typeof rouletteConfigRaw.startsAt === "string" ? rouletteConfigRaw.startsAt : null,
              endsAt: typeof rouletteConfigRaw.endsAt === "string" ? rouletteConfigRaw.endsAt : null,
              scheduleNeedsReview: rouletteConfigRaw.scheduleNeedsReview === true,
              prizes: Array.isArray(rouletteConfigRaw.prizes)
                ? rouletteConfigRaw.prizes.flatMap((item) => {
                    const prize = asRecord(item);
                    if (!prize || typeof prize.id !== "string" || typeof prize.label !== "string") return [];
                    return [{
                      id: prize.id,
                      tier: typeof prize.tier === "number" ? prize.tier : 0,
                      label: prize.label,
                    }];
                  })
                : [],
            }
          : null;
        const rewards: RewardEntitlement[] = Array.isArray(workspace.rewards)
          ? workspace.rewards.flatMap((item) => {
              const reward = asRecord(item);
              if (!reward || typeof reward.id !== "string" || typeof reward.name !== "string") return [];
              return [{
                id: reward.id,
                name: reward.name,
                status: text(reward.status),
                at: text(reward.at),
              }];
            })
          : [];
        const drawPrograms: DrawProgram[] = Array.isArray(workspace.drawPrograms)
          ? (workspace.drawPrograms as unknown[]).flatMap((item) => {
              const program = asRecord(item);
              if (!program || typeof program.id !== "string") return [];
              const winners = Array.isArray(program.winners)
                ? (program.winners as unknown[]).flatMap((winner) => {
                    const entry = asRecord(winner);
                    if (!entry || typeof entry.name !== "string") return [];
                    const kind: "PERSON" | "COMPANY" | undefined =
                      entry.kind === "PERSON" || entry.kind === "COMPANY" ? entry.kind : undefined;
                    return [{
                      name: entry.name,
                      company: text(entry.company),
                      ...(kind ? { kind } : {}),
                      ...(typeof entry.tier === "string" ? { tier: entry.tier } : {}),
                      ...(typeof entry.luckyNumber === "number" ? { luckyNumber: entry.luckyNumber } : {}),
                    }];
                  })
                : [];
              return [{
                id: program.id,
                name: text(program.name),
                quota: typeof program.quota === "number" ? program.quota : 0,
                moduleId: text(program.moduleId),
                status: text(program.status),
                published: program.published === true,
                drawnAt: text(program.drawnAt),
                winnerCount: typeof program.winnerCount === "number" ? program.winnerCount : winners.length,
                winners,
              }];
            })
          : [];
        const booths: HomeBooth[] = Array.isArray(workspace.booths)
          ? workspace.booths.flatMap((item) => {
              const booth = asRecord(item);
              if (!booth || typeof booth.id !== "string") return [];
              return [{
                id: booth.id,
                name: text(booth.name, "부스"),
                limit: Math.max(1, Number(booth.limit) || 1),
                status: text(booth.status, "UNKNOWN").toUpperCase(),
                startsAt: typeof booth.startsAt === "string" ? booth.startsAt || null : booth.startsAt == null ? null : "invalid",
                endsAt: typeof booth.endsAt === "string" ? booth.endsAt || null : booth.endsAt == null ? null : "invalid",
                capacity: Math.max(0, Number(booth.capacity) || 0),
                used: Math.max(0, Number(booth.used) || 0),
              }];
            })
          : [];
        const ownVisits: Record<string, number> = {};
        if (Array.isArray(workspace.visits)) {
          for (const item of workspace.visits) {
            const visit = asRecord(item);
            if (typeof visit?.boothId === "string") ownVisits[visit.boothId] = (ownVisits[visit.boothId] || 0) + 1;
          }
        }
        if (!cancelled) {
          setState({
            kind: "ready",
            eventId: text(ticketData.event?.id),
            eventName: text(ticketData.event?.name, event.name),
            keyvisual,
            defaultHomeBanner,
            homeStyle,
            accent,
            homeMenus,
            programs,
            photos,
            eventDate: event.date,
            eventTime: `${event.start} ~ ${event.end}`,
            ticketStatus: text(ticketData.participant.status) || "APPROVED",
            ticketName: text(ticketData.participant.name),
            hasTicket: true,
            ticketToken: resolvedTicket,
            notices,
            teams,
            voteCounts,
            voteConfig,
            voteSubmitted: workspace.voteSubmitted === true || ownPicks.length > 0,
            ownPicks,
            lucky,
            roulette,
            rouletteConfig,
            rewards,
            drawPrograms,
            stampMode: workspace.stampMode === "SELF" ? "SELF" : "STAFF",
            serverClock,
            booths,
            ownVisits,
            hasPrograms,
            unavailable,
          });
        }
      } catch {
        if (!cancelled) failLoad("transient", "연결하지 못했습니다. 다시 시도하세요.", "", Boolean(ticketRef.current));
      } finally {
        window.clearTimeout(readTimeout);
        // Schedule after the read settles: a fixed interval can continually
        // discard valid responses on a connection slower than the interval.
        if (!cancelled && (activeTab === "vote" || activeTab === "roulette" || activeTab === "stamp")) {
          refreshTimer = window.setTimeout(() => setReloadTick((tick) => tick + 1), HOME_REFRESH_INTERVAL_MS);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(readTimeout);
      window.clearTimeout(refreshTimer);
    };
  }, [slug, reloadTick, activeTab]);

  async function postGuestCommand(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const key = `${slug}:${formKey}`;
    const pending = pendingCommandsRef.current[key];
    if (pending) throw { kind: "uncertain", message: "먼저 이전 요청의 처리 여부를 확인하세요." };
    if (currentCommandIdsRef.current[key]) throw { kind: "in-flight", message: "요청을 처리하고 있습니다." };
    setCompletedCommands((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const snapshot: PendingGuestCommand = {
      key,
      formKey,
      eventId,
      slug,
      ticketToken: ticketRef.current,
      commandId: commandIdFor(key),
      command,
      payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
      teamNames: state.kind === "ready" ? Object.fromEntries(state.teams.map((team) => [team.id, team.name])) : {},
      message: "처리 여부를 확인하지 못했습니다. 원래 요청 그대로 다시 확인하거나 확인을 중단하세요.",
    };
    currentCommandIdsRef.current[key] = snapshot.commandId;
    rememberReceipt(snapshot);
    setActiveWrites((count) => count + 1);
    try {
      const data = await sendGuestCommand(snapshot);
      if (currentCommandIdsRef.current[key] !== snapshot.commandId) throw { kind: "context-changed" };
      forgetReceipt(snapshot.commandId);
      if (commandIdsRef.current[key] === snapshot.commandId) delete commandIdsRef.current[key];
      if (!isCurrentRequestContext(snapshot)) {
        setCompletedCommands((current) => ({
          ...current,
          [key]: {
            eventId: snapshot.eventId,
            slug: snapshot.slug,
            ticketToken: snapshot.ticketToken,
            message: "이전 티켓의 요청 처리는 확인했지만, 현재 티켓의 결과로 표시하지 않습니다.",
          },
        }));
        throw { kind: "context-changed" };
      }
      return data;
    } catch (failure) {
      if ((failure as { kind?: unknown }).kind === "context-changed") throw failure;
      if (currentCommandIdsRef.current[key] !== snapshot.commandId) throw { kind: "context-changed" };
      const details = failure as { message?: unknown; status?: unknown; code?: unknown };
      const message = typeof details.message === "string" ? details.message : "요청을 처리하지 못했습니다.";
      const status = typeof details.status === "number" ? details.status : 0;
      if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
        forgetReceipt(snapshot.commandId);
        if (commandIdsRef.current[key] === snapshot.commandId) delete commandIdsRef.current[key];
        if (command === "booth.visit" && (isBoothContextChanged(details.code) || details.code === "BOOTH_LIMIT_REACHED") && isCurrentRequestContext(snapshot)) {
          setState((current) => current.kind === "ready" ? { ...current, stampStatus: "checking" } : current);
          refresh();
        }
        throw { kind: "definite", message, code: details.code };
      }
      updatePendingCommand(key, { ...snapshot, message: "응답을 확인하지 못했습니다. 같은 요청을 다시 확인하거나 확인을 중단하세요." });
      throw { kind: "uncertain", message: "응답을 확인하지 못했습니다. 아래에서 같은 요청을 다시 확인하세요." };
    } finally {
      if (currentCommandIdsRef.current[key] === snapshot.commandId) delete currentCommandIdsRef.current[key];
      setActiveWrites((count) => Math.max(0, count - 1));
    }
  }

  async function retryPendingCommand(key: string) {
    const pending = pendingCommandsRef.current[key];
    if (!pending || currentCommandIdsRef.current[key]) return;
    const recoveryId = `${key}:${pending.commandId}`;
    currentCommandIdsRef.current[key] = pending.commandId;
    setActiveWrites((count) => count + 1);
    setRecoveringCommandKey(recoveryId);
    try {
      const data = await sendGuestCommand(pending);
      const isStillPending = pendingCommandsRef.current[key]?.commandId === pending.commandId &&
        currentCommandIdsRef.current[key] === pending.commandId;
      if (!isStillPending) return;
      const isCurrentTicket = isCurrentRequestContext(pending);
      const resultMessage = recoveredCommandMessage(pending, data);
      if (isCurrentTicket) {
        setState((current) => {
          if (current.kind !== "ready" || current.eventId !== pending.eventId || current.ticketToken !== pending.ticketToken) return current;
          if (pending.command === "lucky.assign") {
            const lucky = asRecord(data.lucky);
            return typeof lucky?.number === "number"
              ? { ...current, lucky: { number: lucky.number, at: text(lucky.at) } }
              : current;
          }
          if (pending.command === "roulette.spin") {
            const roulette = asRecord(data.roulette);
            return typeof roulette?.tier === "number"
              ? { ...current, roulette: { tier: roulette.tier, label: text(roulette.label), at: text(roulette.at) } }
              : current;
          }
          if (pending.command === "vote.ranked") {
            const vote = asRecord(data.vote);
            const ownPicks = Array.isArray(vote?.picks)
              ? vote.picks.flatMap((item) => {
                  const pick = asRecord(item);
                  if (typeof pick?.teamId !== "string") return [];
                  const rank = Number(pick.rank);
                  return [{ teamId: pick.teamId, rank: [1, 2, 3].includes(rank) ? rank : null }];
                })
              : [];
            return { ...current, voteSubmitted: true, ownPicks };
          }
          return current;
        });
        refresh();
      }
      setCompletedCommands((current) => ({
        ...current,
        [key]: {
          eventId: pending.eventId,
          slug: pending.slug,
          ticketToken: pending.ticketToken,
          message: isCurrentTicket ? resultMessage : "이전 티켓의 요청 처리는 확인했지만, 현재 티켓의 결과로 표시하지 않습니다.",
        },
      }));
      forgetReceipt(pending.commandId);
      updatePendingCommand(key, null);
      if (commandIdsRef.current[key] === pending.commandId) delete commandIdsRef.current[key];
    } catch {
      if (pendingCommandsRef.current[key]?.commandId === pending.commandId &&
        currentCommandIdsRef.current[key] === pending.commandId) {
        updatePendingCommand(key, {
          ...pending,
          message: "아직 처리 여부를 확인하지 못했습니다. 원래 요청 그대로 다시 확인하거나 확인을 중단하세요.",
        });
      }
    } finally {
      if (currentCommandIdsRef.current[key] === pending.commandId) delete currentCommandIdsRef.current[key];
      setRecoveringCommandKey((current) => current === recoveryId ? null : current);
      setActiveWrites((count) => Math.max(0, count - 1));
    }
  }

  function abandonPendingCommand(key: string) {
    const pending = pendingCommandsRef.current[key];
    if (pending) forgetReceipt(pending.commandId);
    updatePendingCommand(key, null);
    if (pending && commandIdsRef.current[key] === pending.commandId) delete commandIdsRef.current[key];
    if (pending && currentCommandIdsRef.current[key] === pending.commandId) delete currentCommandIdsRef.current[key];
  }

  async function checkReceipt(pointer: GuestReceiptPointer) {
    if (recoveringCommandKey !== null) return;
    const entry = Object.entries(pendingCommandsRef.current).find(([, pending]) => pending.commandId === pointer.commandId);
    const pending = entry?.[1];
    const token = pending?.ticketToken || ticketRef.current;
    if (!token) { setReceiptMessage("원래 참가자의 티켓을 연결한 뒤 확인하세요."); return; }
    setRecoveringCommandKey(`receipt:${pointer.commandId}`);
    setReceiptMessage(null);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(pointer.eventId)}/command-receipts/${encodeURIComponent(pointer.commandId)}`, {
        cache: "no-store", headers: { authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (!receiptsRef.current.some((item) => item.commandId === pointer.commandId) ||
          (pending && pendingCommandsRef.current[entry![0]]?.commandId !== pointer.commandId) ||
          (!pending && ticketRef.current !== token)) return;
      if (response.ok && body?.status === "APPLIED" && body.command === pointer.command) {
        // This lookup only confirms that a command exists, not its booth.
        // Keep an in-memory request until an exact replay validates its target.
        if (pending && pointer.command === "booth.visit") {
          setReceiptMessage("서버에 부스 인증 기록이 있습니다. 어느 부스인지 확인하려면 같은 요청을 다시 확인하세요.");
          return;
        }
        if (entry && pendingCommandsRef.current[entry[0]]?.commandId === pointer.commandId) {
          updatePendingCommand(entry[0], null);
          if (commandIdsRef.current[entry[0]] === pointer.commandId) delete commandIdsRef.current[entry[0]];
        }
        forgetReceipt(pointer.commandId);
        const currentTicket = pending ? isCurrentRequestContext(pending) : ticketRef.current === token;
        setReceiptMessage(currentTicket
          ? pointer.command === "booth.visit" ? "서버에 부스 인증 기록이 있습니다. 인증 내역에서 대상 부스를 확인하세요." : "서버에 반영된 것을 확인했습니다. 최신 내용을 다시 불러옵니다."
          : "이전 티켓의 처리는 확인했지만 현재 티켓의 결과로 표시하지 않습니다.");
        if (currentTicket) refresh();
      } else if (response.ok && body?.status === "UNCONFIRMED") {
        setReceiptMessage("아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요.");
      } else setReceiptMessage("현재 티켓과 연결 상태를 확인하지 못했습니다. 원래 참가자의 티켓을 확인하세요.");
    } catch { setReceiptMessage("연결하지 못했습니다. 요청은 다시 보내지 않았습니다."); }
    finally { setRecoveringCommandKey(null); }
  }

  function isCurrentRequestContext(snapshot: Pick<PendingGuestCommand, "slug" | "eventId" | "ticketToken">): boolean {
    const context = currentContextRef.current;
    return context?.slug === snapshot.slug && context.eventId === snapshot.eventId &&
      context.ticketToken === snapshot.ticketToken && slug === snapshot.slug &&
      ticketRef.current === snapshot.ticketToken;
  }

  function refresh() {
    setReloadTick((tick) => tick + 1);
  }

  function openTab(tab: Tab) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", tab);
    window.history.pushState({ eventouchAttendeeDetail: true }, "", `${url.pathname}${url.search}${url.hash}`);
    setActiveTab(tab);
  }

  function returnToMenu() {
    if ((detailDirty || activeWrites > 0) && !window.confirm(activeWrites > 0
      ? "요청을 처리 중입니다. 이동해도 서버 처리는 취소되지 않습니다. 참가 메뉴로 이동할까요?"
      : "선택하거나 입력한 내용이 사라집니다. 참가 메뉴로 이동할까요?")) return;
    const historyState = asRecord(window.history.state);
    if (historyState?.eventouchAttendeeDetail === true) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setActiveTab(null);
  }

  const pendingForSlug = Object.values(pendingCommands).filter((command) => command.slug === slug);
  const completedForSlug = Object.entries(completedCommands).filter(([, command]) => command.slug === slug);
  const recovery = <>
    <PendingGuestCommandRecovery
      commands={pendingForSlug}
      receipts={receipts}
      storageAvailable={receiptStorageAvailable}
      receiptMessage={receiptMessage}
      recoveringCommandKey={recoveringCommandKey}
      isCurrentContext={isCurrentRequestContext}
      onRetry={(key) => void retryPendingCommand(key)}
      onCheck={(pointer) => void checkReceipt(pointer)}
      onForget={(pointer) => {
        if (!window.confirm("목록에서 지워도 서버 처리는 취소되지 않습니다. 이미 반영됐을 수 있습니다. 지울까요?")) return;
        forgetReceipt(pointer.commandId);
        setReceiptMessage("목록에서 지웠습니다. 서버 처리는 취소되지 않았습니다.");
      }}
      onAbandon={abandonPendingCommand}
    />
    <CompletedGuestCommandNotices commands={completedForSlug} isCurrentContext={isCurrentRequestContext} />
  </>;

  if (state.kind === "loading") {
    return (
      <AttendeeSurface as="main" id="main-content" tabIndex={-1} className={styles.homePage}>
        <AttendeeStateMessage kind="info" icon="clock" title="행사를 불러오는 중입니다." className={styles.loading} />
        {recovery}
      </AttendeeSurface>
    );
  }
  if (state.kind === "failed") {
    // Same tab, same context: the retry only bumps the reload tick. The
    // open detail tab (URL ?view=) and the tab-kept ticket bearer stay
    // untouched, so recovery never restarts the whole flow. An unknown slug
    // is final enough that retrying it is not offered; a rejected ticket
    // points at recovery instead of a pointless replay.
    function retrySameTab() {
      setState({ kind: "loading" });
      setReloadTick((tick) => tick + 1);
    }
    const title =
      state.reason === "event-missing"
        ? "행사를 찾을 수 없습니다"
        : state.reason === "ticket-invalid"
          ? "티켓을 확인할 수 없습니다"
          : "행사를 불러올 수 없습니다";
    const guideHref = `/event/${encodeURIComponent(slug)}`;
    // One strong action at the bottom, the way back to the guide beside it.
    const primary = state.reason === "transient"
      ? { label: "다시 시도", onClick: retrySameTab }
      : state.reason === "ticket-invalid" && !recoveryBlocked
        ? { label: "내 티켓 찾기", href: `${guideHref}/ticket/recover` }
        : state.reason === "event-missing"
          ? { label: "처음으로", href: "/" }
          : { label: "행사 안내로", href: guideHref };
    const secondary = primary.label === "행사 안내로" ? undefined : { label: "행사 안내로", href: guideHref };
    return (
      <AttendeeSurface as="main" id="main-content" tabIndex={-1} className={styles.homePage}>
        <section className={styles.statePanel}>
          <h1 className={styles.stateTitle}>{title}</h1>
          <AttendeeStateMessage kind={state.reason === "transient" ? "error" : "info"} title={state.message}>
            {state.reason === "ticket-invalid" && recoveryBlocked
              ? "이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 신청을 완료한 브라우저 탭을 확인하고, 확인되지 않으면 행사 주최 측에 문의하세요."
              : null}
          </AttendeeStateMessage>
        </section>
        <BottomAction primary={primary} secondary={secondary} label="다음 행동" />
        {recovery}
      </AttendeeSurface>
    );
  }

  const activeMenu = activeTab === "application" ? { label: "내 신청 정보" } : activeTab ? HOME_MENUS.find((menu) => menu.key === activeTab) ?? null : null;

  // a1 white ground unless the agency picked a ground color (a2); the same look as the landing.
  const look = attendeeLook(state.homeStyle, state.accent);
  return (
    <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={styles.homePage} style={homeSurfaceStyle(state.homeStyle)}>
      {recovery}
      {activeTab === null ? (
        <AttendeeHomeLanding
          eventName={state.eventName}
          hasTicket={state.hasTicket && Boolean(state.ticketToken)}
          keyvisual={state.keyvisual}
          defaultHomeBanner={state.defaultHomeBanner}
          homeStyle={state.homeStyle}
          accent={state.accent}
          homeMenus={state.homeMenus}
          programs={state.programs}
          photos={state.photos}
          slug={slug}
          hasPrograms={state.hasPrograms}
          unavailable={state.unavailable}
          onOpen={openTab}
          menuButtonRef={(key, node) => { menuButtonRefs.current[key] = node; }}
        />
      ) : (
        <>
          <header className={styles.detailHeader}>
            <button
              ref={detailBackRef}
              type="button"
              className={styles.menuBack}
              onClick={returnToMenu}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none">
                <path d="M19 12H5m7 7-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>참가 메뉴</span>
            </button>
            <span className={styles.detailEventName}>{state.eventName}</span>
          </header>

          <section className={styles.tabPanel} id={`menu-${activeTab}`} aria-label={activeMenu?.label}>
        {state.refreshFailed && (activeTab === "vote" || activeTab === "roulette") && (
          <AttendeeStateMessage kind="info" icon="refresh" title="최신 상태를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요." action={{ label: "다시 시도", onClick: refresh }} className={styles.refreshNotice} />
        )}
        {activeTab === "qr" && <TicketView slug={slug} initialTicket={state.ticketToken} />}
        {activeTab === "application" && <TicketView slug={slug} initialTicket={state.ticketToken} mode="application" />}
        {state.unavailable.includes(activeTab) && <div className={styles.statePanel}><h1 className={styles.stateTitle}>{activeMenu?.label}</h1><AttendeeStateMessage kind="empty" title="현재 이 행사에서 제공하지 않습니다.">참가 메뉴에서 다른 안내를 확인하세요.</AttendeeStateMessage></div>}
        {activeTab === "notice" && !state.unavailable.includes(activeTab) && <NoticeTab slug={slug} notices={state.notices} />}
        {activeTab === "lucky" && !state.unavailable.includes(activeTab) && (
          <LuckyTab
            slug={slug}
            hasTicket={state.hasTicket}
            lucky={state.lucky}
            rewards={state.rewards}
            drawPrograms={state.drawPrograms}
            pending={Boolean(pendingCommands[`${slug}:lucky`])}
            onAssign={async () => {
              const data = await postGuestCommand(state.eventId, "lucky", "lucky.assign", {});
              const entry = asRecord(data.lucky);
              if (!entry || typeof entry.number !== "number") {
                throw { message: "번호 발급에 실패했습니다.", field: null };
              }
              refresh();
            }}
          />
        )}
        {activeTab === "roulette" && !state.unavailable.includes(activeTab) && (
          <RouletteTab
            slug={slug}
            hasTicket={state.hasTicket}
            roulette={state.roulette}
            config={state.rouletteConfig}
            serverClock={state.serverClock}
            pending={Boolean(pendingCommands[`${slug}:roulette`])}
            onSpin={async () => {
              const data = await postGuestCommand(state.eventId, "roulette", "roulette.spin", {});
              const entry = asRecord(data.roulette);
              if (!entry || typeof entry.tier !== "number") {
                throw { message: "룰렛 돌리기에 실패했습니다.", field: null };
              }
              refresh();
              return { tier: entry.tier, label: text(entry.label), at: text(entry.at) };
            }}
          />
        )}
        {activeTab === "stamp" && !state.unavailable.includes(activeTab) && (
          <StampTab
            slug={slug}
            hasTicket={state.hasTicket}
            mode={state.stampMode}
            serverClock={state.serverClock}
            booths={state.booths}
            ownVisits={state.ownVisits}
            stampStatus={state.stampStatus}
            pending={Boolean(pendingCommands[`${slug}:stamp`])}
            onDirtyChange={onDetailDirtyChange}
            onVisit={async (code) => {
              const data = await postGuestCommand(state.eventId, "stamp", "booth.visit", { code });
              refresh();
              return { name: text(data.name), booth: text(data.booth) };
            }}
          />
        )}
        {activeTab === "vote" && !state.unavailable.includes(activeTab) && (
          <VoteTab
            slug={slug}
            hasTicket={state.hasTicket}
            teams={state.teams}
            voteCounts={state.voteCounts}
            voteConfig={state.voteConfig}
            voteSubmitted={state.voteSubmitted}
            ownPicks={state.ownPicks}
            pending={Boolean(pendingCommands[`${slug}:vote`])}
            onDirtyChange={onDetailDirtyChange}
            onSubmit={async (picks) => {
              await postGuestCommand(state.eventId, "vote", "vote.ranked", { picks });
              refresh();
            }}
          />
        )}
          </section>
        </>
      )}
    </AttendeeSurface>
  );
}

function NoticeTab({ slug, notices }: { slug: string; notices: Notice[] }) {
  if (!notices.length) {
    return (
      <AttendeeStateMessage kind="empty" icon="board" title="등록된 공지사항이 없습니다." action={{ label: "행사 안내 보기", href: `/event/${encodeURIComponent(slug)}` }} />
    );
  }
  return (
    <section>
      <div className={styles.noticeList}>
        {notices.map((notice) => (
          <article key={notice.id} className={styles.noticeItem}>
            <h3 className={styles.noticeTitle}>
              {notice.pinned ? <span className={styles.noticePinned}>고정</span> : null}
              {notice.title}
            </h3>
            {notice.body ? <RichText className={styles.noticeBody} source={notice.body} imageSrc={(fileId) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`} /> : null}
          </article>
        ))}
      </div>
      <p className={styles.noticeVenueLink}>
        <ProductLink className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}`}>행사 안내 보기</ProductLink>
      </p>
    </section>
  );
}

function NeedTicket({ slug }: { slug: string }) {
  // Recovery availability resolves from the existing public health response;
  // until it does the link stays so a working path is never hidden by a
  // failed health read.
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());
  return (
    <section className={styles.needTicket}>
      <AttendeeStateMessage kind="info" icon="ticket" title="이 탭에서 티켓이 확인되지 않습니다.">
        {recoveryBlocked
          ? "이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 신청을 완료한 브라우저 탭을 확인하고, 탭을 찾을 수 없다면 행사 주최 측에 문의하세요."
          : "신청한 티켓을 확인하면 이 참여를 이어서 할 수 있어요."}
      </AttendeeStateMessage>
      <p className={styles.needTicketAction}>
        {recoveryBlocked ? null : (
          <>
            <ProductLink className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
              내 티켓 찾기
            </ProductLink>{" "}
          </>
        )}
        {recoveryBlocked ? <><ProductLink className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}`}>
          행사 안내 확인
        </ProductLink>{" "}</> : null}
        <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/register`}>
          처음 신청하기
        </ProductLink>
      </p>
    </section>
  );
}

function LuckyTab({
  slug,
  hasTicket,
  lucky,
  rewards,
  drawPrograms,
  pending,
  onAssign,
}: {
  slug: string;
  hasTicket: boolean;
  lucky: { number: number; at: string } | null;
  rewards: RewardEntitlement[];
  drawPrograms: DrawProgram[];
  pending: boolean;
  onAssign: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await onAssign();
    } catch (failure) {
      if ((failure as { kind?: unknown }).kind === "uncertain") return;
      const message = (failure as { message?: unknown }).message;
      setError(typeof message === "string" ? message : "번호 발급에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  if (!hasTicket) return <NeedTicket slug={slug} />;

  return (
    <section className={styles.luckyPanel}>
      <div className={styles.eticket}>
        <p className={styles.eticketHead}>E-Ticket</p>
        <p className={styles.eticketSub}>럭키드로우 번호</p>
        {lucky ? (
          <>
            <p className={styles.eticketNumber}>{lucky.number}<span>번</span></p>
            <p className={styles.eticketNote}>알림톡으로 안내된 번호와 같습니다. 추첨 발표 시 이 번호를 확인하세요.</p>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.assignButton}
              disabled={loading || pending}
              onClick={assign}
            >
              {loading ? "발급 중입니다" : "럭키번호 발급"}
            </button>
            {error ? <AttendeeStateMessage kind="error" title={error} className={styles.stateInline} /> : null}
          </>
        )}
      </div>
      {rewards.length ? (
        <section className={styles.personalRewards} aria-label="내 경품">
          <h3 className={styles.personalRewardsTitle}>내 경품</h3>
          <ul className={styles.personalRewardList}>
            {rewards.map((reward) => (
              <li key={reward.id} className={styles.personalRewardItem}>
                <strong>{reward.name}</strong>
                <span>{reward.status === "RECEIVED" ? "수령 완료" : reward.status === "READY" ? "수령 대기" : "운영자 확인 중"}</span>
              </li>
            ))}
          </ul>
          <p className={styles.personalRewardsNote}>경품은 행사장 안내에 따라 수령하세요.</p>
        </section>
      ) : null}
      {drawPrograms.filter((program) => program.published && program.winners.length).length ? (
        <section className={styles.luckyWinners} aria-label="발표된 추첨 결과">
          <h3 className={styles.luckyWinnersTitle}>발표된 추첨 결과</h3>
          {drawPrograms
            .filter((program) => program.published && program.winners.length)
            .map((program) => (
              <article key={program.id} className={styles.luckyWinnerItem}>
                <h4 className={styles.luckyWinnerName}>{program.name}</h4>
                <p className={styles.luckyWinnerList}>
                  {program.winners.map((winner) => winner.name).join(", ")}
                </p>
              </article>
            ))}
        </section>
      ) : null}
    </section>
  );
}

function RouletteTab({
  slug,
  hasTicket,
  roulette,
  config,
  serverClock,
  pending,
  onSpin,
}: {
  slug: string;
  hasTicket: boolean;
  roulette: RouletteResult | null;
  config: RouletteConfig | null;
  serverClock: ServerClock | null;
  pending: boolean;
  onSpin: () => Promise<RouletteResult>;
}) {
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RouletteResult | null>(null);
  const [settlingResult, setSettlingResult] = useState<RouletteResult | null>(null);
  const spinTimer = useRef<number | null>(null);
  const spinInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
    };
  }, []);

  function finishSpin(result: RouletteResult) {
    if (!mountedRef.current || !spinInFlightRef.current) return;
    if (spinTimer.current !== null) {
      window.clearTimeout(spinTimer.current);
      spinTimer.current = null;
    }
    setRevealed(result);
    setSettlingResult(null);
    setSpinning(false);
    spinInFlightRef.current = false;
  }

  async function spin() {
    if (spinning || spinInFlightRef.current) return;
    spinInFlightRef.current = true;
    setSpinning(true);
    setError(null);
    try {
      const result = await onSpin();
      if (!mountedRef.current) {
        spinInFlightRef.current = false;
        return;
      }
      let reduceMotion = false;
      try {
        reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        reduceMotion = false;
      }
      const prizeIndex = roulettePrizeIndex(config?.prizes ?? [], result);
      if (reduceMotion || prizeIndex < 0) {
        setRevealed(result);
        setSettlingResult(null);
        setSpinning(false);
        spinInFlightRef.current = false;
      } else {
        setSettlingResult(result);
        spinTimer.current = window.setTimeout(() => {
          finishSpin(result);
        }, ROULETTE_SPIN_FALLBACK_MS);
      }
    } catch (failure) {
      if (!mountedRef.current) {
        spinInFlightRef.current = false;
        return;
      }
      if ((failure as { kind?: unknown }).kind === "uncertain") {
        setSpinning(false);
        spinInFlightRef.current = false;
        return;
      }
      const message = (failure as { message?: unknown }).message;
      setError(typeof message === "string" ? message : "룰렛 돌리기에 실패했습니다.");
      setSettlingResult(null);
      setSpinning(false);
      spinInFlightRef.current = false;
    }
  }

  if (!hasTicket) return <NeedTicket slug={slug} />;

  const result = revealed ?? (spinning ? null : roulette);
  const open = config?.open === true;
  const prizes = config?.prizes ?? [];
  const matchedPrizeIndex = result ? roulettePrizeIndex(prizes, result) : -1;

  return (
    <section className={styles.roulettePanel}>
      <div className={styles.eticket}>
        <p className={styles.eticketHead}>E-Ticket</p>
        <h2 className={styles.eticketTitle}>룰렛 이벤트</h2>
        {config?.prizes.length ? (
          <>
            <div className={styles.wheelStage}>
              <RouletteWheel
                prizes={prizes}
                result={result}
                settlingResult={settlingResult}
                spinning={spinning}
                showStart={!result && open && !pending}
                onSpin={spin}
                onSettled={() => {
                  if (settlingResult) finishSpin(settlingResult);
                }}
              />
            </div>
            <ol className={styles.roulettePrizes} aria-label="룰렛 경품 목록">
              {prizes.map((prize, index) => (
                <li key={prize.id}>
                  <span className={styles.roulettePrizeTier}>{roulettePrizeTier(prize, index)}</span>
                  <span className={styles.roulettePrizeName}>{prize.label || "상품명 정보 없음"}</span>
                </li>
              ))}
            </ol>
            <p className={styles.rouletteOddsNote}>
              각 섹터는 경품 목록을 보여주는 표시용입니다. 섹터 크기는 당첨 확률을 나타내지 않습니다.
              섹터 안 번호는 경품 목록 번호와 같습니다.
            </p>
          </>
        ) : (
          <p className={styles.rouletteWaiting} role="status">룰렛 경품이 아직 준비되지 않았습니다.</p>
        )}
        {spinning ? (
          <p className={styles.rouletteSpinStatus} role="status">
            {settlingResult ? "룰렛이 멈추고 있습니다." : "서버가 경품을 추첨하고 있습니다."}
          </p>
        ) : null}
        {result ? (
          <div className={styles.rouletteResult} role="status" aria-live="polite">
            <span className={styles.rouletteResultLabel}>내 당첨 경품</span>
            <strong className={styles.rouletteResultName}>{result.label || "상품 정보 없음"}</strong>
            {matchedPrizeIndex < 0 ? (
              <p className={styles.rouletteUnmatched}>
                저장된 당첨 결과가 현재 경품 목록과 일치하지 않아 룰렛 섹터는 표시하지 않았습니다.
              </p>
            ) : null}
            <p className={styles.eticketNote}>당첨 결과는 저장되어 다시 방문해도 확인할 수 있습니다. 현장 수령 안내를 확인하세요.</p>
          </div>
        ) : open ? (
          <p className={styles.eticketNote}>START를 누르면 서버가 경품을 추첨합니다. 기회는 한 번입니다.</p>
        ) : (
          <p className={styles.rouletteWaiting} role="status">
            {rouletteWaitingMessage(config, serverClock)}
          </p>
        )}
        {error && !result ? <AttendeeStateMessage kind="error" title={error} className={styles.stateInline} /> : null}
      </div>
    </section>
  );
}

const ROULETTE_SPIN_MS = 3400;
const ROULETTE_SPIN_FALLBACK_MS = ROULETTE_SPIN_MS + 500;
const ROULETTE_SPIN_TURNS = 4;

function roulettePrizeIndex(prizes: RoulettePrize[], result: RouletteResult): number {
  if (!Number.isInteger(result.tier) || result.tier < 1) return -1;
  const hasTierMetadata = prizes.some((prize) => Number.isInteger(prize.tier) && prize.tier > 0);
  const index = hasTierMetadata
    ? prizes.findIndex((prize) => prize.tier === result.tier)
    : result.tier - 1;
  const configuredLabel = prizes[index]?.label;
  return configuredLabel?.trim() && configuredLabel === result.label ? index : -1;
}

function roulettePrizeTier(prize: RoulettePrize, index: number): number {
  return Number.isInteger(prize.tier) && prize.tier > 0 ? prize.tier : index + 1;
}

function rouletteRestingRotation(index: number, count: number): number {
  if (count <= 1) return 0;
  const degreesFromPointer = -((index + 0.5) * (360 / count));
  return ((degreesFromPointer % 360) + 360) % 360;
}

function rouletteSlicePath(index: number, count: number): string {
  const step = 360 / count;
  const start = (-90 + index * step) * Math.PI / 180;
  const end = start + step * Math.PI / 180;
  const radius = 148;
  const x1 = (160 + radius * Math.cos(start)).toFixed(2);
  const y1 = (160 + radius * Math.sin(start)).toFixed(2);
  const x2 = (160 + radius * Math.cos(end)).toFixed(2);
  const y2 = (160 + radius * Math.sin(end)).toFixed(2);
  return `M 160 160 L ${x1} ${y1} A ${radius} ${radius} 0 ${step > 180 ? 1 : 0} 1 ${x2} ${y2} Z`;
}

function rouletteLabelPosition(index: number, count: number): { x: number; y: number } {
  if (count === 1) return { x: 160, y: 76 };
  const centerAngle = -90 + (index + 0.5) * (360 / count);
  const radians = centerAngle * Math.PI / 180;
  // Sector-center anchor only. Glyph orientation is handled in RouletteWheel
  // by counter-rotating each label against the rotor angle, so a bare
  // rotation here would compose with the rotor and tilt the text.
  return {
    x: Number((160 + 103 * Math.cos(radians)).toFixed(2)),
    y: Number((160 + 103 * Math.sin(radians)).toFixed(2)),
  };
}

function RouletteWheel({
  prizes,
  result,
  settlingResult,
  spinning,
  showStart,
  onSpin,
  onSettled,
}: {
  prizes: RoulettePrize[];
  result: RouletteResult | null;
  settlingResult: RouletteResult | null;
  spinning: boolean;
  showStart: boolean;
  onSpin: () => void;
  onSettled: () => void;
}) {
  const settlingIndex = settlingResult ? roulettePrizeIndex(prizes, settlingResult) : -1;
  const resultIndex = result ? roulettePrizeIndex(prizes, result) : -1;
  const rotating = settlingResult !== null && settlingIndex >= 0;
  const rotation = rotating
    ? ROULETTE_SPIN_TURNS * 360 + rouletteRestingRotation(settlingIndex, prizes.length)
    : resultIndex >= 0 ? rouletteRestingRotation(resultIndex, prizes.length) : 0;
  // Counter-rotate glyphs against the rotor so sector numbers read upright
  // on screen at rest (net orientation rotation + labelRotation = 0, hence no
  // 6/9 ambiguity once stopped). While the settle animation runs the numbers
  // necessarily travel with the wheel; nothing is read mid-spin (the status
  // line announces the spin and the saved-result panel + legend carry the
  // authoritative result after it stops). Positions still rotate with their
  // sectors, so sector-legend-server-winner mapping is untouched.

  return (
    <div className={styles.wheelAssembly}>
      <svg
        className={styles.wheelSvg}
        viewBox="0 0 320 320"
        role="img"
        aria-label={result && resultIndex < 0
          ? `등록된 경품 ${prizes.length}개 룰렛입니다. 저장된 당첨 결과와 일치하는 섹터가 없습니다. 경품 목록을 확인하세요.`
          : `등록된 경품 ${prizes.length}개를 동일 크기 섹터로 표시한 룰렛. 섹터 번호는 경품 목록 번호와 같습니다.`}
      >
        <g
          className={`${styles.wheelRotor} ${rotating ? styles.wheelRotorAnimating : ""}`}
          style={{ transform: `rotate(${rotation}deg)` }}
          onTransitionEnd={(event) => {
            if (
              rotating &&
              event.target === event.currentTarget &&
              event.propertyName === "transform"
            ) onSettled();
          }}
        >
          {prizes.map((prize, index) => {
            const position = rouletteLabelPosition(index, prizes.length);
            // The wheel carries only the legend number: full prize names stay
            // verbatim in the numbered legend and the saved-result panel.
            // Numbers are counter-rotated below so they read upright at rest
            // for any prize count; mapping still comes from the sector index.
            const label = String(roulettePrizeTier(prize, index));
            const labelRotation = -rotation;
            return (
              <g key={prize.id}>
                {prizes.length === 1 ? (
                  <circle
                    className={`${styles.wheelSlice} ${resultIndex === index ? styles.wheelSliceSelected : ""}`}
                    cx="160"
                    cy="160"
                    r="148"
                    style={{ fill: "var(--ref-wheel-blue)" }}
                  />
                ) : (
                  <path
                    className={`${styles.wheelSlice} ${resultIndex === index ? styles.wheelSliceSelected : ""}`}
                    d={rouletteSlicePath(index, prizes.length)}
                    style={{ fill: index % 2 === 0 ? "var(--ref-wheel-deep)" : "var(--ref-wheel-blue)" }}
                  />
                )}
                <text
                  className={styles.wheelSectorLabel}
                  x={position.x}
                  y={position.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${labelRotation} ${position.x} ${position.y})`}
                >
                  {label}
                </text>
              </g>
            );
          })}
          <circle className={styles.wheelHubDisc} cx="160" cy="160" r="45" />
        </g>
        {!result || resultIndex >= 0 ? (
          <path className={styles.wheelPointer} d="M160 38 144 9h32z" />
        ) : null}
      </svg>
      {showStart ? (
        <button
          type="button"
          className={styles.wheelStart}
          disabled={spinning}
          onClick={onSpin}
          aria-label={spinning ? "서버 추첨 결과를 기다리는 중" : "START · 서버 추첨 시작"}
        >
          {spinning ? "···" : "START"}
        </button>
      ) : (
        <span className={styles.wheelHub} aria-hidden="true">LUCKY</span>
      )}
    </div>
  );
}

function rouletteWaitingMessage(config: RouletteConfig | null, serverClock: ServerClock | null): string {
  if (!config || config.status === "DRAFT") return "룰렛은 아직 준비 중입니다. 운영자가 경품과 시간을 설정하면 이 화면에서 확인할 수 있습니다.";
  if (config.status === "CLOSED") return "룰렛 운영이 종료되었습니다. 이미 참여했다면 당첨 결과는 계속 확인할 수 있습니다.";
  if (config.scheduleNeedsReview) return "룰렛 운영 시간을 확인하고 있습니다. 현장 운영자에게 문의하세요.";
  const reading = readServerClock(serverClock);
  if (!reading) return "룰렛 운영 상태를 확인하고 있습니다. 잠시 후 다시 확인하세요.";
  if (reading && config.startsAt && Number.isFinite(Date.parse(config.startsAt)) && reading.now + reading.uncertaintyMs < Date.parse(config.startsAt)) {
    return `룰렛 운영 예정 · ${formatKoreanDateTime(config.startsAt)}`;
  }
  if (reading && config.endsAt && Number.isFinite(Date.parse(config.endsAt)) && reading.now - reading.uncertaintyMs > Date.parse(config.endsAt)) {
    return "룰렛 운영 시간이 종료되었습니다.";
  }
  return "경품 재고를 모두 사용했거나 운영 상태가 바뀌었습니다. 잠시 후 다시 확인하세요.";
}

function formatKoreanDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date) + " (한국 시간)";
}

function StampTab({
  slug,
  hasTicket,
  mode,
  serverClock,
  booths,
  ownVisits,
  stampStatus,
  pending,
  onDirtyChange,
  onVisit,
}: {
  slug: string;
  hasTicket: boolean;
  mode: StampMode;
  serverClock: ServerClock | null;
  booths: HomeBooth[];
  ownVisits: Record<string, number>;
  stampStatus?: "checking" | "stale";
  pending: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onVisit: (code: string) => Promise<{ name: string; booth: string }>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [failure, setFailure] = useState<{ message: string; limitReached: boolean } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busyRef = useRef(false);
  const clock = readServerClock(serverClock);
  const availableBooths = stampStatus ? [] : booths.filter((booth) => boothCanAttempt(boothOperatingStatus(booth, clock?.now ?? null, clock?.uncertaintyMs)) && (ownVisits[booth.id] ?? 0) < booth.limit);
  const nextBooth = availableBooths[0];
  const canVisit = Boolean(nextBooth);

  useEffect(() => {
    if (!canVisit || mode !== "SELF") setCameraOpen(false);
  }, [canVisit, mode]);

  useEffect(() => {
    onDirtyChange(canVisit && mode === "SELF" && code.trim() !== "");
    return () => onDirtyChange(false);
  }, [canVisit, code, mode, onDirtyChange]);

  if (!hasTicket) return <NeedTicket slug={slug} />;

  // A camera app hands over the code with the surrounding text; keep the
  // token from ET:BOOTH: on so copy/paste works without manual trimming.
  function normalize(value: string): string {
    const marker = "ET:BOOTH:";
    const at = value.indexOf(marker);
    return (at === -1 ? value : value.slice(at)).trim();
  }

  async function submit(value: string) {
    if (busyRef.current || !canVisit) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const visit = await onVisit(normalize(value));
      setDone(`${visit.name || "참가자"}님 · ${visit.booth || "부스"} 인증을 기록했습니다.`);
      setCode("");
    } catch (error) {
      const details = error as { kind?: unknown; message?: unknown; code?: unknown };
      if (details.kind === "uncertain") return;
      const limitReached = details.code === "BOOTH_LIMIT_REACHED";
      if (limitReached) setCode((current) => normalize(current) === normalize(value) ? "" : current);
      setFailure({
        limitReached,
        message: limitReached ? "이 부스의 인증 횟수를 모두 사용했습니다." :
          typeof details.message === "string" ? details.message : "인증하지 못했습니다. 다시 시도하세요.",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.stampPanel} ${styles.stampWorkspace}`}>
      <section className={styles.stampProgress} aria-labelledby="stamp-progress-title">
        <div className={styles.stampProgressHeading}>
          <h1 id="stamp-progress-title" className={styles.stampProgressTitle}>내 부스 인증</h1>
          <span className={styles.stampModeBadge}>{mode === "SELF" ? "직접 인증" : "직원 인증"}</span>
        </div>
        {booths.length ? (
          <ul className={styles.stampBoothList}>
            {booths.map((booth) => {
              const count = ownVisits[booth.id] ?? 0;
              const operatingStatus = stampStatus ? "상태 확인 필요" : boothOperatingStatus(booth, clock?.now ?? null, clock?.uncertaintyMs);
              const limitReached = boothCanAttempt(operatingStatus) && count >= booth.limit;
              const next = failure?.limitReached && booth === nextBooth;
              return (
                <li className={styles.stampBooth} key={booth.id} id={next ? "stamp-next-booth" : undefined} tabIndex={next ? -1 : undefined}>
                  <div className={styles.stampBoothMain}>
                    <div className={styles.stampBoothTitleRow}>
                      <span className={styles.stampBoothName}>{booth.name}</span>
                      <span className={`${styles.stampBoothStatus} ${
                        operatingStatus === "운영 중" && !limitReached
                          ? styles.stampStatusOpen
                          : limitReached || operatingStatus === "운영 종료" || operatingStatus === "수량 소진"
                            ? styles.stampStatusClosed
                            : operatingStatus === "상태 확인 필요" || operatingStatus === "운영 시간 확인 필요"
                              ? styles.stampStatusUnknown
                              : styles.stampStatusWaiting
                      }`}>{limitReached ? "한도 도달" : operatingStatus}</span>
                    </div>
                    <p className={styles.stampBoothSchedule}>
                      {[booth.startsAt ? `시작 ${formatBoothScheduleTime(booth.startsAt)}` : null,
                        booth.endsAt ? `종료 ${formatBoothScheduleTime(booth.endsAt)}` : null]
                        .filter(Boolean).join(" · ") || "운영 시간 미설정"}
                    </p>
                    {operatingStatus === "운영 시간 확인 필요" ? <p className={styles.stampBoothSchedule}>운영 시간은 현장 스태프에게 문의하세요.</p> : null}
                    {operatingStatus === "인증 시 시간 확인" ? <p className={styles.stampBoothSchedule}>운영 시각을 확인할 수 없어 인증할 때 서버에서 확인합니다.</p> : null}
                    <p className={styles.stampBoothInventory}>
                      {booth.capacity > 0
                        ? `재고 잔여 ${Math.max(0, booth.capacity - booth.used)} / ${booth.capacity}`
                        : "재고 제한 없음"}
                    </p>
                  </div>
                  <div className={styles.stampBoothProgress}>
                    <span className={styles.stampBoothCount}>
                      내 인증 {count} / {booth.limit}
                    </span>
                    <progress
                      className={styles.stampBoothMeter}
                      value={Math.min(count, booth.limit)}
                      max={booth.limit}
                      aria-label={`${booth.name}: 내 인증 ${count}회, 부스당 한도 ${booth.limit}회`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.stampHint}>아직 등록된 부스가 없습니다.</p>}
      </section>
      {failure ? <AttendeeStateMessage kind="error" title={failure.message} className={styles.stateInline} /> : null}
      {failure?.limitReached && nextBooth ? (
        <a href="#stamp-next-booth" className={styles.stampNextLink}>인증 가능한 부스 {availableBooths.length}곳 보기</a>
      ) : null}
      {done ? <p className={styles.stampDone} role="status">{done}</p> : null}
      {stampStatus ? <p className={styles.stampHint} role="status">{stampStatus === "checking"
        ? "최신 부스 상태를 확인하고 있습니다."
        : "최신 부스 상태를 확인하지 못했습니다. 위 목록은 마지막으로 확인한 정보입니다. 연결되면 다시 확인합니다."}</p> : null}
      {!canVisit && !pending && !busy ? (
        stampStatus ? null : <p className={styles.stampHint} role="status">지금 인증할 수 있는 부스가 없습니다. 위 목록에서 부스 상태를 확인하세요.</p>
      ) : mode === "SELF" ? (
        <>
          <p className={styles.stampHint}>부스 QR을 이 화면에서 찍거나 코드를 복사해 입력하세요.</p>
          {cameraOpen ? (
            <CameraScan
              manualHint="부스 코드를 직접 입력하세요."
              onDetected={(scanned) => {
                setCameraOpen(false);
                void submit(scanned);
              }}
              onClose={() => setCameraOpen(false)}
            />
          ) : (
            <button type="button" className="button button-secondary" onClick={() => setCameraOpen(true)} disabled={busy || pending}>
              카메라로 스캔
            </button>
          )}
          <ValidatedForm
            className={styles.stampPanel}
            onSubmit={(event) => {
              event.preventDefault();
              void submit(code);
            }}
          >
            <div className={styles.stampField}>
              <label htmlFor="booth-code">부스 코드</label>
              <input
                id="booth-code"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ET:BOOTH:..."
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy || pending}
              />
            </div>
            <button type="submit" className={styles.submitButton} disabled={busy || pending || !code.trim()}>
              {busy ? "확인 중…" : "인증하기"}
            </button>
          </ValidatedForm>
        </>
      ) : (
        <p className={styles.stampHint} role="note">직원이 티켓을 확인하는 방식입니다. 부스 직원에게 티켓을 제시하세요.</p>
      )}
      <p className={styles.stampHint}>
        행사장 입장(체크인) 후 인증할 수 있고, 부스마다 정해진 횟수까지 인증됩니다.
      </p>
    </div>
  );
}

function VoteTab({
  slug,
  hasTicket,
  teams,
  voteCounts,
  voteConfig,
  voteSubmitted,
  ownPicks,
  pending,
  onDirtyChange,
  onSubmit,
}: {
  slug: string;
  hasTicket: boolean;
  teams: Team[];
  voteCounts: Record<string, VoteCount>;
  voteConfig: VoteConfig | null;
  voteSubmitted: boolean;
  ownPicks: Array<{ teamId: string; rank: number | null }>;
  pending: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSubmit: (picks: Array<{ teamId: string }>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    onDirtyChange(selected.length > 0 && !voteSubmitted);
    return () => onDirtyChange(false);
  }, [selected.length, voteSubmitted, onDirtyChange]);
  const exactCount = voteConfig?.pickCount ?? null;
  const maxCount = exactCount ?? 5;
  const requiredCount = exactCount ?? Math.min(teams.length, 5);
  const isClosed = voteConfig?.status === "CLOSED";
  const resultsPublished = voteConfig ? voteConfig.resultsPublished : true;
  const publishedRows = teams
    .map((team) => ({ team, count: voteCounts[team.id]?.count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.team.order - b.team.order);
  const ownTeamIds = new Set(
    ownPicks.map((pick) => pick.teamId).filter((teamId) => teams.some((team) => team.id === teamId)),
  );

  function toggle(teamId: string) {
    setError(null);
    setSelected((prev) => {
      if (prev.includes(teamId)) return prev.filter((id) => id !== teamId);
      if (prev.length >= maxCount) {
        setError(exactCount ? `정확히 ${exactCount}개 팀까지 선택할 수 있습니다.` : "최대 5개 팀까지 선택할 수 있습니다.");
        return prev;
      }
      return [...prev, teamId];
    });
  }

  async function submit() {
    if (loading) return;
    if (exactCount !== null && selected.length !== exactCount) {
      setError(`투표를 제출하려면 정확히 ${exactCount}개 팀을 선택하세요.`);
      return;
    }
    if (!selected.length) {
      setError("최소 한 팀 이상 선택하세요.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit(selected.map((teamId) => ({ teamId })));
      setSelected([]);
    } catch (failure) {
      if ((failure as { kind?: unknown }).kind === "uncertain") return;
      const message = (failure as { message?: unknown }).message;
      setError(typeof message === "string" ? message : "투표 제출에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  if (!hasTicket) return <NeedTicket slug={slug} />;

  if (voteSubmitted) {
    const names = ownPicks
      .map((pick) => teams.find((entry) => entry.id === pick.teamId)?.name ?? null)
      .filter(Boolean);
    return (
      <section className={styles.voteSubmitted}>
        <p className={styles.voteSubmittedText}>투표가 접수되었습니다.</p>
        {names.length ? (
          <p className={styles.voteSubmittedNote}>내 선택 · {names.join(" · ")}</p>
        ) : (
          <p className={styles.voteSubmittedNote}>내 투표 기록은 저장되어 있습니다.</p>
        )}
        {isClosed ? <p className={styles.voteStateNote}>투표가 마감되었습니다.</p> : null}
        {resultsPublished ? <PublishedVoteResults rows={publishedRows} ownTeamIds={ownTeamIds} /> : null}
      </section>
    );
  }

  if (isClosed) {
    return (
      <section className={styles.voteWaiting}>
        <p className={styles.voteStateTitle}>투표가 마감되었습니다.</p>
        <p className={styles.voteStateNote}>결과가 공개되면 이 화면에 표시됩니다.</p>
        {resultsPublished ? <PublishedVoteResults rows={publishedRows} ownTeamIds={ownTeamIds} /> : null}
      </section>
    );
  }

  if (!teams.length) {
    return (
      <section className={styles.emptyState}>
        <AttendeeStateMessage kind="empty" icon="vote" title="투표 대상 팀이 아직 등록되지 않았습니다." />
      </section>
    );
  }

  if (exactCount !== null && teams.length < exactCount) {
    return (
      <section className={styles.voteWaiting}>
        <p className={styles.voteStateTitle}>투표 대상 팀을 준비 중입니다.</p>
        <p className={styles.voteStateNote}>운영자가 {exactCount}개 팀을 등록하면 투표할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section className={styles.votePanel}>
      <h2 className={styles.voteTitle}>
        {exactCount === null ? `최대 ${requiredCount}개 팀을 선택해주세요` : `정확히 ${exactCount}개 팀을 선택해주세요`}
      </h2>
      <div className={styles.teamGrid} role="group" aria-label="투표 대상 팀">
        {teams.map((team) => {
          const active = selected.includes(team.id);
          return (
            <article
              key={team.id}
              className={`${styles.teamCard} ${active ? styles.teamSelected : ""}`}
            >
              <button
                type="button"
                className={styles.teamPick}
                aria-pressed={active}
                aria-label={`${team.name} 선택`}
                onClick={() => toggle(team.id)}
                disabled={loading || pending}
              >
                <span className={styles.candidateAvatar} aria-hidden="true">
                  {team.name.charAt(0)}
                </span>
                <span className={styles.teamName}>{team.name}</span>
                <span className={`${styles.candidateCheck} ${active ? styles.candidateChecked : ""}`} aria-hidden="true" />
              </button>
            </article>
          );
        })}
      </div>
      <p className={styles.voteCount}>
        선택된 팀: {selected.length} / {exactCount === null ? `최대 ${maxCount}` : requiredCount}
      </p>
      {error ? <AttendeeStateMessage kind="error" title={error} className={styles.stateInline} /> : null}
      <button
        type="button"
        className={styles.submitButton}
        disabled={loading || pending || (exactCount !== null ? selected.length !== exactCount : !selected.length)}
        onClick={submit}
      >
        {loading ? "제출 중입니다" : "투표 제출"}
      </button>
      {resultsPublished ? <PublishedVoteResults rows={publishedRows} ownTeamIds={ownTeamIds} /> : null}
    </section>
  );
}

function PublishedVoteResults({ rows, ownTeamIds }: { rows: Array<{ team: Team; count: number }>; ownTeamIds?: ReadonlySet<string> }) {
  if (!rows.length) return null;
  return (
    <section className={styles.publishedVoteResults} aria-label="공개된 투표 현황">
      <h3>공개된 선택 현황</h3>
      <ul>
        {rows.map(({ team, count }) => {
          const isOwn = ownTeamIds?.has(team.id) === true;
          return (
            <li key={team.id} className={isOwn ? styles.publishedVoteOwnRow : undefined}>
              <span className={isOwn ? styles.publishedVoteOwnName : undefined}>
                {team.name}
                {isOwn ? <span className={styles.publishedVoteOwn}>내 선택</span> : null}
              </span>
              <strong>{count}표</strong>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
