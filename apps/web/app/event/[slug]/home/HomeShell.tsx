"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import TicketView from "../ticket/TicketView";
import styles from "./home.module.css";
import AttendeeHomeLanding, { HOME_MENUS, type HomeMenuKey } from "./AttendeeHomeLanding";
import CameraScan from "../../../CameraScan";
import { DEFAULT_HOME_STYLE, normalizeHomeStyle, type HomeStyle } from "../../../../lib/attendee-home";
import { isRecoveryBlocked, useVerificationMode } from "../../../../lib/use-verification-mode";

// Attendee home shell: five tabs (QR / notices / lucky number / roulette /
// vote) on one route. The ticket bearer lives in tab memory only
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
};

type LoadState =
  | { kind: "loading" }
  | { kind: "failed"; message: string; eventName: string }
  | {
      kind: "ready";
      eventId: string;
      eventName: string;
      keyvisual: string | null;
      homeStyle: HomeStyle;
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

function storeTicket(slug: string, ticket: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + slug, ticket);
  } catch {
    // Private mode: the in-memory bearer still works for this load.
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

// The five attendee destinations appear as an ungrouped two-column tile grid,
// matching the published participant-home reference. The circled numerals in
// the source PDF are annotation overlays, not UI labels.
export default function HomeShell({ slug }: { slug: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());
  const ticketRef = useRef<string>("");
  const commandIdsRef = useRef<Record<string, string>>({});
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const menuButtonRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    qr: null,
    notice: null,
    lucky: null,
    roulette: null,
    vote: null,
    stamp: null,
  });
  const previousTabRef = useRef<Tab | null>(null);

  function tabFromLocation(): Tab | null {
    const value = new URLSearchParams(window.location.search).get("view");
    return HOME_MENUS.some((menu) => menu.key === value) ? (value as Tab) : null;
  }

  useEffect(() => {
    const syncFromHistory = () => setActiveTab(tabFromLocation());
    syncFromHistory();
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => {
    if (activeTab) detailBackRef.current?.focus();
    else if (previousTabRef.current) menuButtonRefs.current[previousTabRef.current]?.focus();
    previousTabRef.current = activeTab;
  }, [activeTab]);

  function commandIdFor(key: string): string {
    if (!commandIdsRef.current[key]) commandIdsRef.current[key] = randomCommandId();
    return commandIdsRef.current[key];
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
      // Consume a linked bearer once, exactly like the ticket screen.
      if (fromLink) storeTicket(slug, fromLink);
      if (fromLink) {
        query.delete("ticket");
        const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", cleaned);
      }
      const ticket = fromLink || readStoredTicket(slug);
      ticketRef.current = ticket;
      try {
        const publicRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        const publicData = (await publicRes.json().catch(() => null)) as {
          event?: PublicEvent | null;
            workspace?: {
              notices?: unknown;
              pageExperience?: { published?: { keyvisual?: unknown; homeStyle?: unknown } } | null;
          } | null;
        } | null;
        const eventName = text(publicData?.event?.name);
        if (!publicRes.ok || !publicData?.event) {
          if (!cancelled) {
            setState({
              kind: "failed",
              message: publicRes.status === 404 ? "행사를 찾을 수 없습니다." : "행사 정보를 불러오지 못했습니다.",
              eventName,
            });
          }
          return;
        }
        const event = publicData.event;
        const publishedPage = publicData.workspace?.pageExperience?.published;
        const keyvisual = publicKeyvisualSource(slug, publishedPage?.keyvisual);
        const homeStyle = normalizeHomeStyle(publishedPage?.homeStyle);
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
        if (!ticket) {
          if (!cancelled) {
            setState({
              kind: "ready",
              eventId: text((event as { id?: unknown }).id),
              eventName: event.name,
              keyvisual,
              homeStyle,
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
            });
          }
          return;
        }
        const ticketRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, {
          headers: { authorization: `Bearer ${ticket}` },
          cache: "no-store",
        });
        const ticketData = (await ticketRes.json().catch(() => null)) as {
          error?: unknown;
          event?: { id?: unknown; name?: unknown } | null;
          participant?: Record<string, unknown> | null;
          workspace?: TicketWorkspace | null;
        } | null;
        if (!ticketRes.ok || !ticketData?.participant || !ticketData.workspace) {
          if (!cancelled) {
            setState({
              kind: "failed",
              message:
                typeof ticketData?.error === "string"
                  ? ticketData.error
                  : "티켓을 확인할 수 없습니다.",
              eventName,
            });
          }
          return;
        }
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
        if (!cancelled) {
          setState({
            kind: "ready",
            eventId: text(ticketData.event?.id),
            eventName: text(ticketData.event?.name, event.name),
            keyvisual,
            homeStyle,
            eventDate: event.date,
            eventTime: `${event.start} ~ ${event.end}`,
            ticketStatus: text(ticketData.participant.status) || "APPROVED",
            ticketName: text(ticketData.participant.name),
            hasTicket: true,
            ticketToken: ticket,
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
          });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요.", eventName: "" });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, reloadTick, activeTab]);

  // Voting and roulette can be opened or closed while an attendee waits on
  // the detail screen. Refresh only these live control states; selection
  // state remains local to VoteTab and is never reset by the poll.
  useEffect(() => {
    if (activeTab !== "vote" && activeTab !== "roulette") return;
    const timer = window.setInterval(() => {
      setReloadTick((tick) => tick + 1);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [activeTab]);

  async function postGuestCommand(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ticketRef.current}`,
      },
      body: JSON.stringify({ commandId: commandIdFor(formKey), command, payload }),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: unknown;
      field?: unknown;
    } & Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.";
      const field = typeof data?.field === "string" ? data.field : null;
      throw { message, field };
    }
    delete commandIdsRef.current[formKey];
    return data ?? {};
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

  if (state.kind === "loading") {
    return (
      <main id="main-content" tabIndex={-1} className={styles.homePage}>
        <p className={styles.loading} role="status">행사를 불러오는 중입니다.</p>
      </main>
    );
  }
  if (state.kind === "failed") {
    return (
      <main id="main-content" tabIndex={-1} className={styles.homePage}>
        <section className={styles.statePanel}>
          <h1 className={styles.stateTitle}>행사를 불러올 수 없습니다</h1>
          <p className={styles.stateMessage}>{state.message}</p>
          {recoveryBlocked ? (
            <p className={styles.stateMessage} role="note">
              이 행사에서는 문자로 티켓을 다시 연결할 수 없어 신청한 기기에서만 열 수 있습니다.
              티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.
            </p>
          ) : null}
          <p className={styles.stateAction}>
            {recoveryBlocked ? null : (
              <>
                <Link className={styles.stateButton} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
                  내 티켓 찾기
                </Link>{" "}
              </>
            )}
            <Link className={styles.stateButton} href={`/event/${encodeURIComponent(slug)}`}>
              행사 안내로
            </Link>
          </p>
        </section>
      </main>
    );
  }

  const activeMenu = activeTab ? HOME_MENUS.find((menu) => menu.key === activeTab) ?? null : null;

  return (
    <main id="main-content" tabIndex={-1} className={styles.homePage} style={homeSurfaceStyle(state.homeStyle)}>
      {activeTab === null ? (
        <AttendeeHomeLanding
          eventName={state.eventName}
          hasTicket={state.hasTicket && Boolean(state.ticketToken)}
          keyvisual={state.keyvisual}
          homeStyle={state.homeStyle}
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
        {activeTab === "qr" && <TicketView slug={slug} />}
        {activeTab === "notice" && <NoticeTab slug={slug} notices={state.notices} />}
        {activeTab === "lucky" && (
          <LuckyTab
            slug={slug}
            hasTicket={state.hasTicket}
            lucky={state.lucky}
            rewards={state.rewards}
            drawPrograms={state.drawPrograms}
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
        {activeTab === "roulette" && (
          <RouletteTab
            slug={slug}
            hasTicket={state.hasTicket}
            roulette={state.roulette}
            config={state.rouletteConfig}
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
        {activeTab === "stamp" && (
          <StampTab
            slug={slug}
            hasTicket={state.hasTicket}
            onVisit={async (code) => {
              const data = await postGuestCommand(state.eventId, "stamp", "booth.visit", { code });
              refresh();
              return { name: text(data.name), booth: text(data.booth) };
            }}
          />
        )}
        {activeTab === "vote" && (
          <VoteTab
            slug={slug}
            hasTicket={state.hasTicket}
            teams={state.teams}
            voteCounts={state.voteCounts}
            voteConfig={state.voteConfig}
            voteSubmitted={state.voteSubmitted}
            ownPicks={state.ownPicks}
            onSubmit={async (picks) => {
              await postGuestCommand(state.eventId, "vote", "vote.ranked", { picks });
              refresh();
            }}
          />
        )}
          </section>
        </>
      )}
    </main>
  );
}

function homeSurfaceStyle(homeStyle: HomeStyle): CSSProperties {
  const style = {
    "--home-background-color": homeStyle.backgroundColor,
  } as CSSProperties;
  if (homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor) return style;
  const dark = "#17252B";
  const light = "#FFFFFF";
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? [0, 0, 0];
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (foreground: string, background: string) => {
    const foregroundLuminance = foreground === light ? 1 : luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };
  const ink = contrast(dark, homeStyle.backgroundColor) >= contrast(light, homeStyle.backgroundColor) ? dark : light;
  return {
    ...style,
    "--home-background-ink": ink,
    "--home-background-copy": ink,
  } as CSSProperties;
}

function NoticeTab({ slug, notices }: { slug: string; notices: Notice[] }) {
  if (!notices.length) {
    return (
      <section className={styles.emptyState}>
        <p className={styles.emptyText}>등록된 공지사항이 없습니다.</p>
        <p className={styles.emptyText}>
          <Link className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}`}>행사 안내 보기</Link>
        </p>
      </section>
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
            {notice.body ? <p className={styles.noticeBody}>{notice.body}</p> : null}
          </article>
        ))}
      </div>
      <p className={styles.noticeVenueLink}>
        <Link className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}`}>행사 안내 보기</Link>
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
      <p className={styles.needTicketText}>티켓이 확인되지 않습니다. 신청 후 이용하세요.</p>
      {recoveryBlocked ? (
        <p className={styles.needTicketText} role="note">
          이 행사에서는 문자로 티켓을 다시 연결할 수 없어 신청한 기기에서만 열 수 있습니다.
          티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.
        </p>
      ) : null}
      <p className={styles.needTicketAction}>
        {recoveryBlocked ? null : (
          <>
            <Link className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
              내 티켓 찾기
            </Link>{" "}
          </>
        )}
        <Link className={styles.needTicketButton} href={`/event/${encodeURIComponent(slug)}/register`}>
          참가 신청하기
        </Link>
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
  onAssign,
}: {
  slug: string;
  hasTicket: boolean;
  lucky: { number: number; at: string } | null;
  rewards: RewardEntitlement[];
  drawPrograms: DrawProgram[];
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
              disabled={loading}
              onClick={assign}
            >
              {loading ? "발급 중입니다" : "럭키번호 발급"}
            </button>
            {error ? <p className={styles.luckyError} role="alert">{error}</p> : null}
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
  onSpin,
}: {
  slug: string;
  hasTicket: boolean;
  roulette: RouletteResult | null;
  config: RouletteConfig | null;
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
  const labelsFitOnWheel = prizes.length <= 6 && prizes.every((prize) =>
    prize.label.trim().length > 0 && Array.from(prize.label).length <= 8
  );

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
                showStart={!result && open}
                showLabels={labelsFitOnWheel}
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
            {rouletteWaitingMessage(config)}
          </p>
        )}
        {error && !result ? <p className={styles.rouletteError} role="alert">{error}</p> : null}
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

function rouletteLabelPosition(index: number, count: number): { x: number; y: number; rotation: number } {
  if (count === 1) return { x: 160, y: 76, rotation: 0 };
  const centerAngle = -90 + (index + 0.5) * (360 / count);
  const radians = centerAngle * Math.PI / 180;
  return {
    x: Number((160 + 103 * Math.cos(radians)).toFixed(2)),
    y: Number((160 + 103 * Math.sin(radians)).toFixed(2)),
    rotation: centerAngle + 90,
  };
}

function RouletteWheel({
  prizes,
  result,
  settlingResult,
  spinning,
  showStart,
  showLabels,
  onSpin,
  onSettled,
}: {
  prizes: RoulettePrize[];
  result: RouletteResult | null;
  settlingResult: RouletteResult | null;
  spinning: boolean;
  showStart: boolean;
  showLabels: boolean;
  onSpin: () => void;
  onSettled: () => void;
}) {
  const settlingIndex = settlingResult ? roulettePrizeIndex(prizes, settlingResult) : -1;
  const resultIndex = result ? roulettePrizeIndex(prizes, result) : -1;
  const rotating = settlingResult !== null && settlingIndex >= 0;
  const rotation = rotating
    ? ROULETTE_SPIN_TURNS * 360 + rouletteRestingRotation(settlingIndex, prizes.length)
    : resultIndex >= 0 ? rouletteRestingRotation(resultIndex, prizes.length) : 0;

  return (
    <div className={styles.wheelAssembly}>
      <svg
        className={styles.wheelSvg}
        viewBox="0 0 320 320"
        role="img"
        aria-label={result && resultIndex < 0
          ? `등록된 경품 ${prizes.length}개 룰렛입니다. 저장된 당첨 결과와 일치하는 섹터가 없습니다. 아래 경품 목록을 확인하세요.`
          : `등록된 경품 ${prizes.length}개를 동일 크기 섹터로 표시한 룰렛. 아래 경품 목록을 확인하세요.`}
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
            const label = showLabels && prize.label.trim()
              ? prize.label
              : String(roulettePrizeTier(prize, index));
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
                  transform={`rotate(${position.rotation} ${position.x} ${position.y})`}
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

function rouletteWaitingMessage(config: RouletteConfig | null): string {
  if (!config || config.status === "DRAFT") return "룰렛은 아직 준비 중입니다. 운영자가 경품과 시간을 설정하면 이 화면에서 확인할 수 있습니다.";
  if (config.status === "CLOSED") return "룰렛 운영이 종료되었습니다. 이미 참여했다면 당첨 결과는 계속 확인할 수 있습니다.";
  const now = Date.now();
  if (config.startsAt && Number.isFinite(Date.parse(config.startsAt)) && now < Date.parse(config.startsAt)) {
    return `룰렛 운영 예정 · ${formatKoreanDateTime(config.startsAt)}`;
  }
  if (config.endsAt && Number.isFinite(Date.parse(config.endsAt)) && now > Date.parse(config.endsAt)) {
    return "룰렛 운영 시간이 종료되었습니다.";
  }
  return "경품 재고를 모두 사용했거나 운영 상태가 바뀌었습니다. 잠시 후 다시 확인하세요.";
}

function formatKoreanDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function StampTab({
  slug,
  hasTicket,
  onVisit,
}: {
  slug: string;
  hasTicket: boolean;
  onVisit: (code: string) => Promise<{ name: string; booth: string }>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busyRef = useRef(false);

  if (!hasTicket) return <NeedTicket slug={slug} />;

  // A camera app hands over the code with the surrounding text; keep the
  // token from ET:BOOTH: on so copy/paste works without manual trimming.
  function normalize(value: string): string {
    const marker = "ET:BOOTH:";
    const at = value.indexOf(marker);
    return (at === -1 ? value : value.slice(at)).trim();
  }

  async function submit(value: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const visit = await onVisit(normalize(value));
      setDone(`${visit.name || "참가자"}님 · ${visit.booth || "부스"} 인증을 기록했습니다.`);
      setCode("");
    } catch (error) {
      const message = (error as { message?: unknown }).message;
      setFailure(typeof message === "string" ? message : "인증하지 못했습니다. 다시 시도하세요.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={styles.stampPanel}>
      <p className={styles.stampHint}>
        부스에 붙은 QR을 이 화면에서 바로 찍거나, 코드를 복사해 아래에 붙여넣으세요.
      </p>
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
        <button type="button" className={styles.submitButton} onClick={() => setCameraOpen(true)} disabled={busy}>
          카메라로 스캔
        </button>
      )}
      <form
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
          />
        </div>
        <button type="submit" className={styles.submitButton} disabled={busy || !code.trim()}>
          {busy ? "확인 중…" : "인증하기"}
        </button>
      </form>
      {failure ? <p className={styles.stampError} role="alert">{failure}</p> : null}
      {done ? <p className={styles.stampDone} role="status">{done}</p> : null}
      <p className={styles.stampHint}>
        행사장 입장(체크인) 후 인증할 수 있고, 부스마다 정해진 횟수까지 인증됩니다.
      </p>
    </section>
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
  onSubmit,
}: {
  slug: string;
  hasTicket: boolean;
  teams: Team[];
  voteCounts: Record<string, VoteCount>;
  voteConfig: VoteConfig | null;
  voteSubmitted: boolean;
  ownPicks: Array<{ teamId: string; rank: number | null }>;
  onSubmit: (picks: Array<{ teamId: string }>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exactCount = voteConfig?.pickCount ?? null;
  const maxCount = exactCount ?? 5;
  const requiredCount = exactCount ?? Math.min(teams.length, 5);
  const isClosed = voteConfig?.status === "CLOSED";
  const resultsPublished = voteConfig ? voteConfig.resultsPublished : true;
  const publishedRows = teams
    .map((team) => ({ team, count: voteCounts[team.id]?.count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.team.order - b.team.order);

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
    } catch (failure) {
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
        {resultsPublished ? <PublishedVoteResults rows={publishedRows} /> : null}
      </section>
    );
  }

  if (isClosed) {
    return (
      <section className={styles.voteWaiting}>
        <p className={styles.voteStateTitle}>투표가 마감되었습니다.</p>
        <p className={styles.voteStateNote}>결과가 공개되면 이 화면에 표시됩니다.</p>
        {resultsPublished ? <PublishedVoteResults rows={publishedRows} /> : null}
      </section>
    );
  }

  if (!teams.length) {
    return (
      <section className={styles.emptyState}>
        <p className={styles.emptyText}>투표 대상 팀이 아직 등록되지 않았습니다.</p>
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
      {error ? <p className={styles.voteError} role="alert">{error}</p> : null}
      <button
        type="button"
        className={styles.submitButton}
        disabled={loading || (exactCount !== null ? selected.length !== exactCount : !selected.length)}
        onClick={submit}
      >
        {loading ? "제출 중입니다" : "투표 제출"}
      </button>
      {resultsPublished ? <PublishedVoteResults rows={publishedRows} /> : null}
    </section>
  );
}

function PublishedVoteResults({ rows }: { rows: Array<{ team: Team; count: number }> }) {
  if (!rows.length) return null;
  return (
    <section className={styles.publishedVoteResults} aria-label="공개된 투표 현황">
      <h3>공개된 선택 현황</h3>
      <ul>
        {rows.map(({ team, count }) => (
          <li key={team.id}><span>{team.name}</span><strong>{count}표</strong></li>
        ))}
      </ul>
    </section>
  );
}
