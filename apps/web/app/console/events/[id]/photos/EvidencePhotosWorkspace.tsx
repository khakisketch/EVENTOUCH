"use client";

import ProductButton from "../../../../ui/ProductButton";
import ValidatedForm from "../../../../ui/ValidatedForm";

import { useEffect, useRef, useState } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import EvidenceGallery, { type GalleryItem } from "./EvidenceGallery";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import StatusPill from "../../../console-ui/StatusPill";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import styles from "./evidence-photos.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { acknowledgeOperatorReceipt, confirmsEvidenceCommand } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";

const EVIDENCE_SECTIONS = [
  { key: "SPACE", label: "공간구성" },
  { key: "STAGE", label: "무대연출" },
  { key: "PARTICIPANT_BOOTH", label: "참가자부스" },
  { key: "ONSITE_DIRECTION", label: "현장연출" },
  { key: "PRE_SETUP", label: "사전세팅" },
  { key: "ARRIVAL_REGISTRATION", label: "도착/등록" },
  { key: "PROGRAM", label: "프로그램" },
  { key: "AWARDS", label: "시상식" },
] as const;

type EvidenceSection = (typeof EVIDENCE_SECTIONS)[number]["key"];
type ImageFileRef = {
  fileId: string;
  name: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
};
type EvidencePhoto = {
  id: string;
  section: EvidenceSection;
  image: ImageFileRef;
  uploadedAt: string;
  uploadedBy: string;
};
type UploadStatus =
  | "selected"
  | "queued"
  | "uploading"
  | "bytes-uploaded"
  | "recording"
  | "recorded"
  | "failed-upload"
  | "failed-record"
  | "invalid";
type UploadJob = {
  id: string;
  file: File;
  previewUrl: string | null;
  contentType: string;
  section: EvidenceSection;
  uploadCommandId: string;
  recordCommandId: string;
  uploadedFile: ImageFileRef | null;
  status: UploadStatus;
  error: string | null;
};

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      eventMeta?: string;
      archived: boolean;
      role: string;
      userId: string;
      memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
      photos: EvidencePhoto[];
    };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// Long-list paging for the current-section archive: reveal the first page
// only, then grow incrementally. ZIP/selection/upload semantics use the full
// section list; only the rendered grid is windowed. Plain slicing only.
const PHOTO_PAGE_SIZE = 12;
let fallbackCommandSequence = 0;

function randomCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackCommandSequence += 1;
  return `web-${Date.now()}-${fallbackCommandSequence}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isEvidenceSection(value: unknown): value is EvidenceSection {
  return EVIDENCE_SECTIONS.some((section) => section.key === value);
}

function sectionLabel(section: EvidenceSection): string {
  return EVIDENCE_SECTIONS.find((item) => item.key === section)?.label ?? "현장 사진";
}

function directionParticle(value: string): "로" | "으로" {
  const lastSyllable = value.charCodeAt(value.length - 1) - 0xac00;
  const finalConsonant = lastSyllable >= 0 && lastSyllable <= 11171 ? lastSyllable % 28 : 0;
  return finalConsonant === 0 || finalConsonant === 8 ? "로" : "으로";
}

function parseImageFileRef(value: unknown, fallback: File, fallbackType = fallback.type): ImageFileRef | null {
  const item = asRecord(value);
  if (!item || typeof item.fileId !== "string" || !item.fileId) return null;
  return {
    fileId: item.fileId,
    name: text(item.name, fallback.name),
    type: text(item.type, fallbackType),
    size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : fallback.size,
    ...(typeof item.width === "number" && Number.isFinite(item.width) ? { width: item.width } : {}),
    ...(typeof item.height === "number" && Number.isFinite(item.height) ? { height: item.height } : {}),
  };
}

function getContentType(file: File): string {
  if (ACCEPTED_IMAGE_TYPES.has(file.type)) return file.type;
  if (file.type) return "";
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "";
}

function validateFile(file: File, contentType: string): string | null {
  if (!contentType || !ACCEPTED_IMAGE_TYPES.has(contentType)) {
    return "PNG, JPEG, WebP 이미지만 올릴 수 있습니다.";
  }
  if (file.size > MAX_IMAGE_BYTES) return "파일당 8MB 이하 이미지를 선택하세요.";
  return null;
}

function formatUploadedAt(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function commandErrorMessage(value: unknown, fallback: string): string {
  const item = asRecord(value);
  return typeof item?.error === "string" ? item.error : fallback;
}

function ImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM9 11a1.5 1.5 0 1 0 0-.01M20 15l-4.5-4.5L8 18" /></svg>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
  );
}

function evidenceZipHref(eventId: string, section: EvidenceSection): string {
  const params = new URLSearchParams({ section });
  return `/api/events/${encodeURIComponent(eventId)}/evidence-photos.zip?${params.toString()}`;
}

function uploadStatusLabel(status: UploadStatus): string {
  switch (status) {
    case "selected": return "업로드 전 미리보기";
    case "queued": return "대기 중";
    case "uploading": return "파일 업로드 중";
    case "bytes-uploaded": return "파일 업로드 완료 · 보관 기록 대기";
    case "recording": return "파일 업로드 완료 · 보관 기록 등록 중";
    case "recorded": return "보관함에 등록됨";
    case "failed-upload": return "파일 업로드 확인 필요";
    case "failed-record": return "파일 업로드 완료 · 보관 기록 확인 필요";
    case "invalid": return "선택할 수 없는 파일";
  }
}

export default function EvidencePhotosWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedSection, setSelectedSection] = useState<EvidenceSection>("SPACE");
  const [photoLimit, setPhotoLimit] = useState(PHOTO_PAGE_SIZE);
  // 더 보기 inserts rows before the focused button: park the first newly
  // revealed index at click time, then focus its row after render. The row
  // itself is focusable (tabIndex -1), so no extra announcement is added.
  const photoRevealRef = useRef<number | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  // How many photos the running upload started with, for the "n / total" progress line.
  const [runTotal, setRunTotal] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState<{ photo: EvidencePhoto; nextSection: EvidenceSection } | null>(null);
  const [removePending, setRemovePending] = useState<EvidencePhoto | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<string, EvidenceSection>>({});
  // The photo open in the viewer drawer; its neighbours are the section order.
  const [viewerId, setViewerId] = useState<string | null>(null);
  const viewerIndexRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobsRef = useRef<UploadJob[]>([]);
  const queueRunningRef = useRef(false);
  const activeEventRef = useRef(eventId);
  const jobEventRef = useRef(eventId);
  activeEventRef.current = eventId;
  const loadSequenceRef = useRef(0);
  const actionCommandIdsRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (jobEventRef.current === eventId) return;
    for (const job of jobsRef.current) if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
    jobsRef.current = [];
    setJobs([]);
    queueRunningRef.current = false;
    setQueueBusy(false);
    actionCommandIdsRef.current.clear();
    setMovePending(null); setRemovePending(null); setMoveTargets({}); setViewerId(null);
    setBusyPhotoId(null);
    setSelectedSection("SPACE");
    jobEventRef.current = eventId;
  }, [eventId]);
  const otherEvidenceIds = useEventReceipts(eventId).filter((item) => item.command.startsWith("evidence.photo.") && !jobs.some((job) => job.recordCommandId === item.commandId)).map((item) => item.commandId).sort();
  const otherEvidenceReceipt = otherEvidenceIds.length > 0;
  const evidenceIdsKey = JSON.stringify(otherEvidenceIds);
  const priorEvidenceIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>(JSON.parse(evidenceIdsKey) as string[]);
    for (const [key, id] of actionCommandIdsRef.current) {
      if (priorEvidenceIds.current.has(id) && !next.has(id)) actionCommandIdsRef.current.delete(key);
    }
    priorEvidenceIds.current = next;
  }, [eventId, evidenceIdsKey]);
  useEffect(() => {
    const releases = jobs.filter((job) => job.status === "failed-record").map((job) => manageOperatorReceipt(job.recordCommandId));
    return () => { releases.forEach((release) => release()); };
  }, [jobs]);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 보기·내보내기만 둡니다. 증빙 사진 쓰기(evidence.photo.*)는 결과
  // 쓰기 권한이 필요하며, 서버가 매번 다시 확인합니다. 읽기는 행사 구성원
  // 자격이면 열립니다.
  const photosCapability = state.kind === "ready"
    ? { role: state.role, userId: state.userId, memberships: state.memberships, eventId }
    : null;
  const canWritePhotos = photosCapability
    ? canWriteEvent(photosCapability, "evidence.photo.add")
    : false;
  const writeLocked = state.kind === "ready" && (state.archived || !canWritePhotos || otherEvidenceReceipt);
  const hadOtherEvidenceReceipt = useRef(false);
  useEffect(() => {
    if (hadOtherEvidenceReceipt.current && !otherEvidenceReceipt) setReloadTick((tick) => tick + 1);
    hadOtherEvidenceReceipt.current = otherEvidenceReceipt && !queueRunningRef.current && busyPhotoId === null;
  }, [otherEvidenceReceipt, busyPhotoId, eventId]);

  // Cross-route guard predicate: any upload job that is not settled in the
  // archive (staged drafts, queued/in-flight work, failed retries). Settled
  // history and the section picker stay unguarded.
  useConsoleDraftGuard(
    jobs.some((job) => job.status !== "recorded"),
    "처리되지 않은 사진 업로드가 있습니다."
  );

  function selectSection(section: EvidenceSection) {
    setSelectedSection(section);
    setPhotoLimit(PHOTO_PAGE_SIZE);
    photoRevealRef.current = null;
  }

  // After a move or remove the open photo leaves this section: show its
  // neighbour in the same position, or close the viewer when none is left.
  useEffect(() => {
    if (!viewerId || state.kind !== "ready") return;
    const list = state.photos.filter((photo) => photo.section === selectedSection);
    if (list.some((photo) => photo.id === viewerId)) return;
    const next = list[Math.min(viewerIndexRef.current, list.length - 1)];
    setViewerId(next ? next.id : null);
  }, [state, viewerId, selectedSection]);

  function revealMorePhotos() {
    photoRevealRef.current = photoLimit;
    setPhotoLimit((limit) => limit + PHOTO_PAGE_SIZE);
  }

  // Focus the first newly revealed row after a 더 보기 expansion, whether the
  // button stays (intermediate reveal) or unmounts (final reveal).
  useEffect(() => {
    if (photoRevealRef.current === null || state.kind !== "ready") return;
    const index = photoRevealRef.current;
    photoRevealRef.current = null;
    const sectionPhotos = state.photos.filter((photo) => photo.section === selectedSection);
    const target = sectionPhotos[index] ?? null;
    if (!target) return;
    const row = document.getElementById(`evidence-photo-${target.id}`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }, [photoLimit, state, selectedSection]);

  function commitJobs(next: UploadJob[]) {
    jobsRef.current = next;
    setJobs(next);
  }

  function updateJob(jobId: string, changes: Partial<UploadJob>) {
    const next = jobsRef.current.map((job) => job.id === jobId ? { ...job, ...changes } : job);
    commitJobs(next);
  }

  function commandIdFor(key: string): string {
    const existing = actionCommandIdsRef.current.get(key);
    if (existing) return existing;
    const created = randomCommandId();
    actionCommandIdsRef.current.set(key, created);
    return created;
  }

  async function load(silent = false) {
    const requestId = ++loadSequenceRef.current;
    if (!silent) setState({ kind: "loading" });
    try {
      const [meResponse, bootstrapResponse] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (requestId !== loadSequenceRef.current) return;
      if (meResponse.status === 401 || bootstrapResponse.status === 401) {
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      const [meData, bootstrapData] = await Promise.all([
        meResponse.json().catch(() => null) as Promise<unknown>,
        bootstrapResponse.json().catch(() => null) as Promise<unknown>,
      ]);
      const user = asRecord(asRecord(meData)?.user);
      const bootstrap = asRecord(asRecord(bootstrapData)?.state);
      if (!meResponse.ok || !bootstrapResponse.ok || !user || !bootstrap) {
        if (requestId === loadSequenceRef.current) {
          setState({ kind: "failed", message: "현장 사진 정보를 불러오지 못했습니다." });
        }
        return;
      }

      const role = text(user.role);
      const userId = text(user.id);
      const memberships = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships
            .map(asRecord)
            .filter((item): item is Record<string, unknown> => item !== null)
            .flatMap((item) => (
              typeof item.accountId === "string" && typeof item.eventId === "string"
                ? [{ accountId: item.accountId, eventId: item.eventId, write: item.write }]
                : []
            ))
        : [];
      const isMember = memberships.some((membership) =>
        membership.accountId === userId && membership.eventId === eventId
      );
      const events = Array.isArray(bootstrap.events)
        ? bootstrap.events.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
        : [];
      const event = events.find((item) => item.id === eventId);
      const workspaces = asRecord(bootstrap.workspaces);
      const workspace = asRecord(workspaces?.[eventId]);
      if (!event || !workspace) {
        if (requestId === loadSequenceRef.current) {
          setState({ kind: "failed", message: "행사 정보를 찾을 수 없습니다." });
        }
        return;
      }

      const clients = Array.isArray(bootstrap.clients)
        ? bootstrap.clients.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
        : [];
      const clientName = clients.find((client) => client.id === event.clientId)?.name;
      const venue = asRecord(workspace.venue);
      const photos: EvidencePhoto[] = (role === "AGENCY" || isMember) && Array.isArray(workspace.evidencePhotos)
        ? workspace.evidencePhotos.flatMap((value) => {
            const item = asRecord(value);
            const image = asRecord(item?.image);
            if (
              !item || typeof item.id !== "string" || !item.id ||
              !isEvidenceSection(item.section) ||
              !image || typeof image.fileId !== "string" || !image.fileId
            ) return [];
            const fileRef: ImageFileRef = {
              fileId: image.fileId,
              name: text(image.name, "현장 사진"),
              type: text(image.type),
              size: typeof image.size === "number" && Number.isFinite(image.size) ? image.size : 0,
              ...(typeof image.width === "number" && Number.isFinite(image.width) ? { width: image.width } : {}),
              ...(typeof image.height === "number" && Number.isFinite(image.height) ? { height: image.height } : {}),
            };
            return [{
              id: item.id,
              section: item.section,
              image: fileRef,
              uploadedAt: text(item.uploadedAt),
              uploadedBy: text(item.uploadedBy),
            }];
          })
        : [];
      if (requestId !== loadSequenceRef.current) return;
      setState({
        kind: "ready",
        eventName: text(event.name, eventId),
        eventMeta: formatConsoleEventMeta({
          clientName: text(clientName),
          date: text(event.date),
          start: text(event.start),
          end: text(event.end),
          venue: text(venue?.name),
        }),
        archived: text(event.stage).toUpperCase() === "ARCHIVED",
        role,
        userId,
        memberships,
        photos,
      });
    } catch {
      if (requestId === loadSequenceRef.current) {
        setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      }
    }
  }

  useEffect(() => {
    void load();
    return () => {
      loadSequenceRef.current += 1;
    };
    // load is intentionally local so the request can share the event-specific redirect target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, reloadTick]);

  useEffect(() => () => {
    for (const job of jobsRef.current) {
      if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
    }
  }, []);

  async function uploadAndRecordJob(jobId: string) {
    const requestEventId = eventId;
    let job = jobsRef.current.find((item) => item.id === jobId);
    if (!job || job.status === "invalid" || job.status === "recorded") return;
    const hadUnconfirmedRecord = job.status === "failed-record";

    try {
      if (!job.uploadedFile) {
        updateJob(job.id, { status: "uploading", error: null });
        const uploadUrl = new URLSearchParams({ name: job.file.name, commandId: job.uploadCommandId });
        const uploadResponse = await consoleFetch(
          `/api/events/${encodeURIComponent(eventId)}/files?${uploadUrl.toString()}`,
          { method: "POST", headers: { "content-type": job.contentType }, body: job.file }
        );
        const uploadData = await uploadResponse.json().catch(() => null) as unknown;
        if (activeEventRef.current !== requestEventId) return;
        const fileRef = parseImageFileRef(asRecord(uploadData)?.file, job.file, job.contentType);
        if (!uploadResponse.ok || !fileRef) {
          throw new Error(commandErrorMessage(uploadData, "파일 업로드 응답을 확인하지 못했습니다."));
        }
        job = { ...job, uploadedFile: fileRef };
        updateJob(job.id, {
          uploadedFile: fileRef,
          status: "bytes-uploaded",
          error: null,
        });
      }

      updateJob(job.id, { status: "recording", error: null });
      const recordResponse = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: job.recordCommandId,
          command: "evidence.photo.add",
          payload: { section: job.section, image: job.uploadedFile },
        }),
      });
      const recordData = await recordResponse.json().catch(() => null) as unknown;
      if (activeEventRef.current !== requestEventId) return;
      if (!recordResponse.ok && !hadUnconfirmedRecord && recordResponse.status >= 400 && recordResponse.status < 500 && ![408, 425, 429].includes(recordResponse.status)) {
        throw new Error(commandErrorMessage(recordData, "보관 기록에 등록하지 못했습니다."));
      }
      if (!recordResponse.ok || !confirmsEvidenceCommand("evidence.photo.add", job.recordCommandId, { section: job.section, image: job.uploadedFile }, recordData)) {
        throw new Error("보관 기록 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.");
      }
      acknowledgeOperatorReceipt(job.recordCommandId);
      forgetOperatorReceipt(job.recordCommandId);
      if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
      updateJob(job.id, { previewUrl: null, status: "recorded", error: null });
      setNotice(`${sectionLabel(job.section)}에 사진을 등록했습니다.`);
      setFailure(null);
      await load(true);
    } catch (error) {
      if (activeEventRef.current !== requestEventId) return;
      const latestJob = jobsRef.current.find((item) => item.id === jobId);
      const bytesUploaded = Boolean(latestJob?.uploadedFile);
      updateJob(jobId, {
        status: bytesUploaded ? "failed-record" : "failed-upload",
        error: error instanceof Error ? error.message : "처리하지 못했습니다.",
      });
      setNotice(null);
    }
  }

  async function processJobs(jobIds: string[]) {
    if (queueRunningRef.current || writeLocked) return;
    const requestEventId = eventId;
    queueRunningRef.current = true;
    setQueueBusy(true);
    setFailure(null);
    try {
      for (const jobId of jobIds) {
        if (activeEventRef.current !== requestEventId) break;
        await uploadAndRecordJob(jobId);
      }
    } finally {
      if (activeEventRef.current === requestEventId) {
        queueRunningRef.current = false;
        setQueueBusy(false);
      }
    }
  }

  function selectFiles(files: FileList | null) {
    if (!files?.length || queueRunningRef.current || writeLocked) return;
    setNotice(null);
    setFailure(null);
    const selected = Array.from(files);
    const nextJobs: UploadJob[] = selected.map((file) => {
      const contentType = getContentType(file);
      const error = validateFile(file, contentType);
      return {
        id: randomCommandId(),
        file,
        previewUrl: (file.type.startsWith("image/") || contentType.startsWith("image/")) && file.size <= MAX_PREVIEW_BYTES
          ? URL.createObjectURL(file)
          : null,
        contentType,
        section: selectedSection,
        uploadCommandId: randomCommandId(),
        recordCommandId: randomCommandId(),
        uploadedFile: null,
        status: error ? "invalid" : "selected",
        error,
      };
    });
    commitJobs([...jobsRef.current, ...nextJobs]);
  }

  function removeDraftJob(jobId: string) {
    if (queueRunningRef.current) return;
    const removed = jobsRef.current.find((job) => job.id === jobId);
    if (!removed || (removed.status !== "selected" && removed.status !== "invalid")) return;
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    commitJobs(jobsRef.current.filter((job) => job.id !== jobId));
  }

  function clearDraftJobs() {
    if (queueRunningRef.current) return;
    const remaining = jobsRef.current.filter((job) => {
      const isDraft = job.status === "selected" || job.status === "invalid";
      if (isDraft && job.previewUrl) URL.revokeObjectURL(job.previewUrl);
      return !isDraft;
    });
    commitJobs(remaining);
  }

  function uploadSelectedJobs() {
    if (queueRunningRef.current || writeLocked) return;
    const selectedIds = new Set(jobsRef.current.filter((job) => job.status === "selected").map((job) => job.id));
    if (!selectedIds.size) return;
    setRunTotal(selectedIds.size);
    commitJobs(jobsRef.current.map((job) => selectedIds.has(job.id)
      ? { ...job, status: "queued", error: null }
      : job));
    void processJobs([...selectedIds]);
  }

  function clearFinishedJobs() {
    const remaining = jobsRef.current.filter((job) => job.status !== "recorded");
    commitJobs(remaining);
  }

  async function postEvidenceCommand(
    command: "evidence.photo.move" | "evidence.photo.remove",
    payload: Record<string, unknown>,
    commandId: string,
    fallback: string
  ) {
    const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, command, payload }),
    });
    const data = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new Error(commandErrorMessage(data, fallback));
    if (!confirmsEvidenceCommand(command, commandId, payload, data)) throw new Error("사진 처리 결과를 확인하지 못했습니다. 서버 처리 여부를 확인하세요.");
    acknowledgeOperatorReceipt(commandId);
    forgetOperatorReceipt(commandId);
  }

  function requestMovePhoto(photo: EvidencePhoto, nextSection: EvidenceSection) {
    if (nextSection === photo.section || busyPhotoId || writeLocked) return;
    setMovePending({ photo, nextSection });
  }

  async function confirmMovePhoto() {
    const pending = movePending;
    if (!pending || state.kind !== "ready") {
      setMovePending(null);
      return;
    }
    const current = state.photos.find((item) => item.id === pending.photo.id);
    if (!current || pending.nextSection === current.section || busyPhotoId || writeLocked) {
      setMovePending(null);
      return;
    }
    const destination = sectionLabel(pending.nextSection);
    const requestEventId = eventId;
    const commandKey = `move:${current.id}:${pending.nextSection}`;
    setBusyPhotoId(current.id);
    setFailure(null);
    setNotice(null);
    try {
      await postEvidenceCommand("evidence.photo.move", { id: current.id, section: pending.nextSection }, commandIdFor(commandKey), "사진 구간을 변경하지 못했습니다.");
      if (activeEventRef.current !== requestEventId) return;
      actionCommandIdsRef.current.delete(commandKey);
      setNotice(`사진을 ${destination}${directionParticle(destination)} 옮겼습니다.`);
      await load(true);
    } catch (error) {
      if (activeEventRef.current !== requestEventId) return;
      setViewerId(null);
      setFailure(error instanceof Error ? error.message : "사진 구간을 변경하지 못했습니다.");
    } finally {
      if (activeEventRef.current === requestEventId) { setBusyPhotoId(null); setMovePending(null); }
    }
  }

  function requestRemovePhoto(photo: EvidencePhoto) {
    if (busyPhotoId || writeLocked) return;
    setRemovePending(photo);
  }

  async function confirmRemovePhoto() {
    const pending = removePending;
    if (!pending || state.kind !== "ready") {
      setRemovePending(null);
      return;
    }
    const current = state.photos.find((item) => item.id === pending.id);
    if (!current || busyPhotoId || writeLocked) {
      setRemovePending(null);
      return;
    }
    const commandKey = `remove:${current.id}`;
    const requestEventId = eventId;
    setBusyPhotoId(current.id);
    setFailure(null);
    setNotice(null);
    try {
      await postEvidenceCommand("evidence.photo.remove", { id: current.id }, commandIdFor(commandKey), "보관함에서 제외하지 못했습니다.");
      if (activeEventRef.current !== requestEventId) return;
      actionCommandIdsRef.current.delete(commandKey);
      setNotice("사진을 보관함에서 제외했습니다. 원본 파일과 기존 행사 파일 권한은 유지됩니다.");
      await load(true);
    } catch (error) {
      if (activeEventRef.current !== requestEventId) return;
      setViewerId(null);
      setFailure(error instanceof Error ? error.message : "보관함에서 제외하지 못했습니다.");
    } finally {
      if (activeEventRef.current === requestEventId) { setBusyPhotoId(null); setRemovePending(null); }
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="photos" eventId={eventId}>
        <ConsoleStatePanel kind="loading" shape="cards" message="현장 사진 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }

  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="photos" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => setReloadTick((tick) => tick + 1)}
          actions={<ProductLink variant="secondary" href="/console">행사 목록으로</ProductLink>}
        />
      </ConsolePage>
    );
  }

  // Reads stay open to every event member; only the upload/move/delete
  // affordances above need the results grant (writeLocked covers both the
  // archived stage and the missing grant).
  if (!(state.role === "AGENCY" || state.memberships.some((membership) => membership.accountId === state.userId && membership.eventId === eventId))) {
    return (
      <ConsolePage pageId="photos" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message="현장 사진은 조직 소유자 또는 이 행사의 운영사 구성원만 관리할 수 있습니다."
          onRetry={() => setReloadTick((tick) => tick + 1)}
          actions={<ProductLink variant="secondary" href={`/console/events/${encodeURIComponent(eventId)}`}>운영 현황으로</ProductLink>}
        />
      </ConsolePage>
    );
  }

  const sectionCounts = EVIDENCE_SECTIONS.map((section) => ({
    ...section,
    count: state.photos.filter((photo) => photo.section === section.key).length,
  }));
  const selectedPhotos = state.photos.filter((photo) => photo.section === selectedSection);
  const stagedJobs = jobs.filter((job) => job.status === "selected" || job.status === "invalid");
  const selectedJobs = jobs.filter((job) => job.status === "selected");
  const historyJobs = jobs.filter((job) => job.status !== "selected" && job.status !== "invalid");
  const stagedGroups = EVIDENCE_SECTIONS.map((section) => ({
    ...section,
    jobs: stagedJobs.filter((job) => job.section === section.key),
  })).filter((group) => group.jobs.length > 0);
  const selectedLabel = sectionLabel(selectedSection);
  const fileHref = (photo: EvidencePhoto) => `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(photo.image.fileId)}`;
  const filledSections = sectionCounts.filter((section) => section.count > 0).length;
  const emptySections = sectionCounts.filter((section) => section.count === 0);
  const galleryItems: GalleryItem[] = selectedPhotos.map((photo, index) => ({
    id: photo.id,
    src: fileHref(photo),
    label: `${sectionLabel(photo.section)} ${index + 1}번 사진 ${photo.image.name}`,
    time: formatUploadedAt(photo.uploadedAt),
    width: photo.image.width,
    height: photo.image.height,
  }));
  const viewerIndex = viewerId ? selectedPhotos.findIndex((photo) => photo.id === viewerId) : -1;
  const viewerPhoto = viewerIndex >= 0 ? selectedPhotos[viewerIndex] : null;
  if (viewerIndex >= 0) viewerIndexRef.current = viewerIndex;
  function openViewer(id: string) { setViewerId(id); }
  function stepViewer(delta: number) {
    const next = selectedPhotos[Math.min(Math.max(viewerIndex + delta, 0), selectedPhotos.length - 1)];
    if (next) setViewerId(next.id);
  }
  const hasUnresolvedJobs = historyJobs.some((job) => job.status !== "recorded");
  const activeJobs = jobs.filter((job) => ["queued", "uploading", "bytes-uploaded", "recording"].includes(job.status)).length;
  // The list is named after what it holds ("현장 사진 3장"), not after the process that made it.
  const historySections = [...new Set(historyJobs.map((job) => job.section))];
  const historySummary = `${historySections.length === 1 ? `${sectionLabel(historySections[0])} 사진` : "올린 사진"} ${historyJobs.length}장${hasUnresolvedJobs ? " · 확인 필요" : ""}`;

  return (
    <ConsolePage
      pageId="photos"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={writeLocked ? undefined : (
        // 선택(고르기)과 올리기(저장)를 다른 말로 쓴다. 고른 사진이 있으면 주 버튼은 아래의 "올리기"이고 여기는 보조다.
        <ProductButton type="button" variant={stagedJobs.length ? "secondary" : "primary"} disabled={queueBusy} aria-describedby="evidence-photo-file-guidance" onClick={() => fileInputRef.current?.click()}>사진 선택</ProductButton>
      )}
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {otherEvidenceReceipt ? <ConsoleFeedback kind="warning">이전 사진 처리 결과를 위에서 확인한 뒤 사진을 변경할 수 있습니다.</ConsoleFeedback> : null}
          {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 사진을 보고 내려받을 수 있지만 올리거나 옮길 수 없습니다.</ConsoleFeedback>
          ) : null}
          {!state.archived && !canWritePhotos ? (
            <ConsoleFeedback kind="warning">증빙 사진 올리기·옮기기·삭제는 결과 쓰기 권한이 필요합니다. 보기·내보내기는 그대로 할 수 있습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <p className={styles.intro}>
        참가자 사진과 별도로 보관합니다.
      </p>

      <section className={styles.coverage} aria-label="증빙 구간 현황">
        <div className={styles.coverageNumber}><b>{state.photos.length}</b><span>장 · {EVIDENCE_SECTIONS.length}구간 중 {filledSections}구간</span></div>
        <div className={styles.coverageBar} role="img" aria-label={`${EVIDENCE_SECTIONS.length}구간 중 ${filledSections}구간에 사진이 있습니다`}>
          {sectionCounts.map((section) => <i key={section.key} data-filled={section.count > 0 || undefined} />)}
        </div>
        {emptySections.length ? <p className={styles.coverageNote}><b>{emptySections.map((section) => section.label).join(" · ")}</b> 구간이 비어 있습니다</p> : <p className={styles.coverageNote}>모든 구간에 사진이 있습니다</p>}
      </section>

      <h2 className="sr-only" id="evidence-photo-sections">촬영 구간</h2>
      <div className={styles.sectionTiles} role="group" aria-labelledby="evidence-photo-sections">
        {sectionCounts.map((section) => {
          const cover = state.photos.find((photo) => photo.section === section.key);
          return (
            <button
              key={section.key}
              type="button"
              className={styles.sectionTile}
              aria-pressed={section.key === selectedSection}
              onClick={() => selectSection(section.key)}
            >
              <span className={styles.tileCover} data-empty={cover ? undefined : "true"}>
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileHref(cover)} alt="" loading="lazy" decoding="async" />
                ) : <ImageGlyph />}
              </span>
              <span className={styles.tileName}>{section.label}</span>
              <span className={styles.tileCount} data-empty={section.count === 0 || undefined}>{section.count === 0 ? <StatusPill tone="wait" size="sm">비어 있음</StatusPill> : `${section.count}장`}</span>
            </button>
          );
        })}
      </div>

      <div
        className={styles.galleryArea}
        role="group"
        aria-label={`${selectedLabel} 사진 추가`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          selectFiles(event.dataTransfer.files);
        }}
      >
        <div className={styles.galleryHead}>
          <h2 id="evidence-photo-archive">{selectedLabel}<small>{selectedPhotos.length}장</small></h2>
          {selectedPhotos.length ? (
            <a
              className="product-action product-link" data-action-variant="ghost" data-native-control="download"
              href={evidenceZipHref(eventId, selectedSection)}
            >
              <span className={styles.zipLong}>이 구간 ZIP 다운로드 ({selectedPhotos.length}장)</span>
              <span className={styles.zipShort}>ZIP · {selectedPhotos.length}장</span>
            </a>
          ) : null}
        </div>
        <p id="evidence-photo-file-guidance" className={styles.guidance}>
          현재 구간 <strong>{selectedLabel}</strong>에 저장 · PNG, JPG, WebP · 장당 8MB 이하 · 사진을 끌어 놓아도 됩니다 · ZIP 한도: 최대 1,000장 · 512MB
        </p>
        <input
          id="evidence-photo-files"
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={queueBusy || writeLocked}
          tabIndex={-1}
          aria-hidden="true"
          // The visible 사진 선택 / 사진 추가 buttons are the keyboard entry
          // points; this input stays programmatic-only by design. The label
          // keeps it named for assistive tech instead of labelless.
          aria-label="증빙 사진 파일 선택 (PNG, JPG, WebP)"
          onChange={(event) => {
            selectFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />

        {stagedJobs.length ? (
          <section className={styles.previewArea} aria-labelledby="evidence-photo-preview-title">
            <div className={styles.previewHeading}>
              <div>
                <h3 id="evidence-photo-preview-title">업로드 전 미리보기 <span>{stagedJobs.length}장</span></h3>
                <p className={styles.guidance}>
                  {selectedJobs.length
                    ? `${selectedJobs.length}장을 올릴 수 있습니다. 사진별 저장 구간을 확인하세요.`
                    : "올릴 수 있는 파일이 없습니다. 형식과 용량을 확인하세요."}
                </p>
              </div>
              <button type="button" className={styles.textButton} onClick={clearDraftJobs} disabled={queueBusy}>
                전체 선택 취소
              </button>
            </div>

            {stagedGroups.map((group) => (
              <div key={group.key} className={styles.previewGroup}>
                <h4>{group.label} <span>{group.jobs.length}장</span></h4>
                <ul className={styles.previewGrid}>
                  {group.jobs.map((job) => (
                    <li key={job.id} className={styles.previewItem}>
                      <div className={styles.previewMedia}>
                        {job.previewUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img className={styles.previewImage} src={job.previewUrl} alt="" loading="lazy" />
                        ) : (
                          <div className={styles.previewPlaceholder}>미리보기 없음</div>
                        )}
                        <button
                          type="button"
                          className={styles.removePreview}
                          aria-label={`${job.file.name} 선택 해제`}
                          title="선택 해제"
                          disabled={queueBusy}
                          onClick={() => removeDraftJob(job.id)}
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="m6 6 8 8M14 6l-8 8" />
                          </svg>
                        </button>
                      </div>
                      <p className={styles.previewFile} title={job.file.name}>{job.file.name}</p>
                      <p className={styles.previewMeta}>{(job.file.size / 1024 / 1024).toFixed(2)}MB</p>
                      {job.error ? <p className={styles.jobError}>{job.error}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <div className={styles.previewActions} role="group" aria-label="사진 올리기">
              <p className={styles.guidance} role={queueBusy ? "status" : undefined}>
                {queueBusy
                  ? `${selectedLabel} 구간에 올리는 중 · ${Math.max(0, runTotal - activeJobs)} / ${runTotal}장`
                  : `${selectedJobs.length}장을 고르셨습니다. 올리기를 누르기 전까지 행사에 저장되지 않습니다.`}
              </p>
              <ProductButton
                type="button"
                variant="primary"
                disabled={queueBusy || selectedJobs.length === 0}
                onClick={uploadSelectedJobs}
              >
                {queueBusy ? "올리는 중…" : `${selectedJobs.length}장 올리기`}
              </ProductButton>
            </div>
          </section>
        ) : null}

        {historyJobs.length ? (
          <details className={styles.jobDisclosure} open={hasUnresolvedJobs}>
            <summary>{historySummary}</summary>
            <div className={styles.jobArea} aria-labelledby="evidence-upload-history-title">
              <div className={styles.jobHeading}>
                <h3 id="evidence-upload-history-title">파일별 처리 상태</h3>
                {historyJobs.some((job) => job.status === "recorded") ? (
                  <button type="button" className={styles.textButton} onClick={clearFinishedJobs} disabled={queueBusy}>
                    완료 내역 지우기
                  </button>
                ) : null}
              </div>
              <ul className={styles.jobList}>
                {historyJobs.map((job) => {
                  const orphanRisk = job.status === "failed-record" && Boolean(job.uploadedFile);
                  return (
                    <li key={job.id} className={styles.jobItem}>
                      <div className={styles.jobCopy}>
                        <p className={styles.jobFile} title={job.file.name}>{job.file.name}</p>
                        <p className={styles.jobMeta}>{sectionLabel(job.section)} · {(job.file.size / 1024 / 1024).toFixed(2)}MB</p>
                        <p className={job.status === "recorded" ? styles.jobDone : styles.jobStatus} role="status" aria-live="polite">
                          {uploadStatusLabel(job.status)}
                        </p>
                        {job.error ? <p className={styles.jobError} role="alert">{job.error}</p> : null}
                        {orphanRisk ? (
                          <p className={styles.orphanWarning}>
                            파일은 업로드됐지만 보관 기록이 반영됐는지 확인하지 못했습니다. 이미 등록됐거나 파일만 남아 있을 수 있습니다. 다시 시도하면 파일을 재업로드하지 않고 같은 보관 기록 요청만 확인합니다.
                          </p>
                        ) : null}
                        {job.status === "failed-upload" ? (
                          <p className={styles.guidance}>응답을 받지 못했습니다. 이미 올라갔을 수 있어도 다시 시도하면 같은 사진이 두 번 저장되지 않습니다.</p>
                        ) : null}
                      </div>
                      {job.status === "failed-upload" || job.status === "failed-record" ? (
                        <ProductButton
                          type="button"
                          variant="secondary"
                          disabled={queueBusy || writeLocked}
                          onClick={() => void processJobs([job.id])}
                        >
                          {queueBusy ? "처리 중…" : job.status === "failed-record" ? "기록 등록 재시도" : "업로드 재시도"}
                        </ProductButton>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          </details>
        ) : null}

        {selectedPhotos.length ? (
          <>
            <EvidenceGallery
              items={galleryItems.slice(0, photoLimit)}
              onOpen={openViewer}
              addSlot={writeLocked ? undefined : (
                <button type="button" className={styles.addTile} disabled={queueBusy} aria-describedby="evidence-photo-file-guidance" onClick={() => fileInputRef.current?.click()}>
                  <PlusGlyph />{stagedJobs.length ? "사진 더 선택" : "사진 추가"}
                </button>
              )}
            />
            {selectedPhotos.length > photoLimit ? (
              <p className={styles.moreRow}>
                <ProductButton type="button" variant="ghost" onClick={revealMorePhotos}>
                  더 보기 ({selectedPhotos.length - photoLimit})
                </ProductButton>
              </p>
            ) : null}
          </>
        ) : (
          <ConsoleEmptyState
            title="이 구간에는 아직 등록된 사진이 없습니다."
            description={writeLocked ? undefined : "‘사진 선택’으로 사진을 고른 뒤 올리세요."}
          />
        )}
      </div>

      {viewerPhoto ? (
        <ConsoleDialog title={`${sectionLabel(viewerPhoto.section)} · ${viewerIndex + 1} / ${selectedPhotos.length}`} titleId="evidence-photo-viewer-title" presentation="drawer" stickyChrome busy={busyPhotoId !== null} onClose={() => setViewerId(null)}>
          <div className={styles.viewer} onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("select, input, textarea")) return;
            if (event.key === "ArrowLeft") { event.preventDefault(); stepViewer(-1); }
            if (event.key === "ArrowRight") { event.preventDefault(); stepViewer(1); }
          }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.viewerImage} src={fileHref(viewerPhoto)} alt={`${sectionLabel(viewerPhoto.section)} 현장 사진 파일: ${viewerPhoto.image.name}`} />
            <div className={styles.viewerNav}>
              <ProductButton type="button" variant="ghost" disabled={viewerIndex <= 0} onClick={() => stepViewer(-1)}>이전 사진</ProductButton>
              <ProductButton type="button" variant="ghost" disabled={viewerIndex >= selectedPhotos.length - 1} onClick={() => stepViewer(1)}>다음 사진</ProductButton>
            </div>
            <div className={styles.viewerInfo}>
              <b title={viewerPhoto.image.name}>{viewerPhoto.image.name}</b>
              <small>{formatUploadedAt(viewerPhoto.uploadedAt) ?? "등록 시각 미상"}</small>
            </div>
            <a className={styles.originalLink} href={fileHref(viewerPhoto)} download={viewerPhoto.image.name || "현장사진"}>원본 다운로드</a>
            <ValidatedForm
              className={styles.photoControls}
              onSubmit={(event) => {
                event.preventDefault();
                requestMovePhoto(viewerPhoto, moveTargets[viewerPhoto.id] ?? viewerPhoto.section);
              }}
            >
              <label htmlFor={`move-photo-${viewerPhoto.id}`}>보관 구간 변경</label>
              <div className={styles.moveRow}>
                <select
                  id={`move-photo-${viewerPhoto.id}`}
                  value={moveTargets[viewerPhoto.id] ?? viewerPhoto.section}
                  disabled={busyPhotoId !== null || writeLocked}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (isEvidenceSection(value)) setMoveTargets((current) => ({ ...current, [viewerPhoto.id]: value }));
                  }}
                >
                  {EVIDENCE_SECTIONS.map((section) => (
                    <option key={section.key} value={section.key}>{section.label}</option>
                  ))}
                </select>
                <ProductButton
                  type="submit"
                  variant="secondary"
                  disabled={busyPhotoId !== null || writeLocked || (moveTargets[viewerPhoto.id] ?? viewerPhoto.section) === viewerPhoto.section}
                >
                  {busyPhotoId === viewerPhoto.id ? "처리 중…" : "구간 변경"}
                </ProductButton>
              </div>
            </ValidatedForm>
            <ProductButton type="button" variant="destructive" disabled={busyPhotoId !== null || writeLocked} onClick={() => requestRemovePhoto(viewerPhoto)}>보관함에서 제외</ProductButton>
            {movePending && movePending.photo.id === viewerPhoto.id ? (
              <ConsoleConfirm
                summary={`이 사진의 보관함 분류를 ${sectionLabel(movePending.photo.section)}에서 ${sectionLabel(movePending.nextSection)}${directionParticle(sectionLabel(movePending.nextSection))} 변경할까요?`}
                confirmLabel="구간 변경하기"
                busy={busyPhotoId === viewerPhoto.id}
                onConfirm={() => void confirmMovePhoto()}
                onCancel={() => setMovePending(null)}
              />
            ) : null}
            {removePending && removePending.id === viewerPhoto.id ? (
              <ConsoleConfirm
                summary="이 사진을 보관함에서 제외할까요? 보관함 참조만 제거합니다. 원본 파일은 삭제되지 않고 기존 행사 파일 읽기 권한은 그대로 적용됩니다."
                confirmLabel="보관함에서 제외하기"
                busy={busyPhotoId === viewerPhoto.id}
                onConfirm={() => void confirmRemovePhoto()}
                onCancel={() => setRemovePending(null)}
              />
            ) : null}
          </div>
        </ConsoleDialog>
      ) : null}
    </ConsolePage>
  );
}
