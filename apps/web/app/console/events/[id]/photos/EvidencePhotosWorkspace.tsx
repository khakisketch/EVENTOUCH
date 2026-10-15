"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePageHeader, { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import styles from "./evidence-photos.module.css";

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
  contentType: string;
  section: EvidenceSection;
  uploadCommandId: string;
  recordCommandId: string;
  uploadedFile: ImageFileRef | null;
  status: UploadStatus;
  error: string | null;
};
type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      eventMeta?: string;
      canManage: boolean;
      photos: EvidencePhoto[];
    };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
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

function evidenceZipHref(eventId: string, section: EvidenceSection): string {
  const params = new URLSearchParams({ section });
  return `/api/events/${encodeURIComponent(eventId)}/evidence-photos.zip?${params.toString()}`;
}

function uploadStatusLabel(status: UploadStatus): string {
  switch (status) {
    case "queued": return "대기 중";
    case "uploading": return "파일 업로드 중";
    case "bytes-uploaded": return "파일 업로드 완료 · 보관 기록 대기";
    case "recording": return "파일 업로드 완료 · 보관 기록 등록 중";
    case "recorded": return "보관함에 등록됨";
    case "failed-upload": return "파일 업로드 확인 필요";
    case "failed-record": return "파일 업로드 완료 · 보관 기록 등록 실패";
    case "invalid": return "선택할 수 없는 파일";
  }
}

export default function EvidencePhotosWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedSection, setSelectedSection] = useState<EvidenceSection>("SPACE");
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<string, EvidenceSection>>({});
  const jobsRef = useRef<UploadJob[]>([]);
  const queueRunningRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const actionCommandIdsRef = useRef(new Map<string, string>());

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
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
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
        ? bootstrap.memberships.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
        : [];
      const isMember = memberships.some((membership) =>
        membership.accountId === userId && membership.eventId === eventId
      );
      const canManage = role === "AGENCY" || (role === "MANAGER" && isMember);
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
      const photos: EvidencePhoto[] = canManage && Array.isArray(workspace.evidencePhotos)
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
        canManage,
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

  async function uploadAndRecordJob(jobId: string) {
    let job = jobsRef.current.find((item) => item.id === jobId);
    if (!job || job.status === "invalid" || job.status === "recorded") return;

    try {
      if (!job.uploadedFile) {
        updateJob(job.id, { status: "uploading", error: null });
        const uploadUrl = new URLSearchParams({ name: job.file.name, commandId: job.uploadCommandId });
        const uploadResponse = await fetch(
          `/api/events/${encodeURIComponent(eventId)}/files?${uploadUrl.toString()}`,
          { method: "POST", headers: { "content-type": job.contentType }, body: job.file }
        );
        const uploadData = await uploadResponse.json().catch(() => null) as unknown;
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
      const recordResponse = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: job.recordCommandId,
          command: "evidence.photo.add",
          payload: { section: job.section, image: job.uploadedFile },
        }),
      });
      const recordData = await recordResponse.json().catch(() => null) as unknown;
      if (!recordResponse.ok) {
        throw new Error(commandErrorMessage(recordData, "보관 기록에 등록하지 못했습니다."));
      }
      updateJob(job.id, { status: "recorded", error: null });
      setNotice(`${sectionLabel(job.section)}에 사진을 등록했습니다.`);
      setFailure(null);
      await load(true);
    } catch (error) {
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
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;
    setQueueBusy(true);
    setFailure(null);
    try {
      for (const jobId of jobIds) {
        await uploadAndRecordJob(jobId);
      }
    } finally {
      queueRunningRef.current = false;
      setQueueBusy(false);
    }
  }

  function selectFiles(files: FileList | null) {
    if (!files?.length || queueRunningRef.current) return;
    setNotice(null);
    setFailure(null);
    const selected = Array.from(files);
    const nextJobs: UploadJob[] = selected.map((file) => {
      const contentType = getContentType(file);
      const error = validateFile(file, contentType);
      return {
        id: randomCommandId(),
        file,
        contentType,
        section: selectedSection,
        uploadCommandId: randomCommandId(),
        recordCommandId: randomCommandId(),
        uploadedFile: null,
        status: error ? "invalid" : "queued",
        error,
      };
    });
    commitJobs([...jobsRef.current, ...nextJobs]);
    void processJobs(nextJobs.filter((job) => job.status === "queued").map((job) => job.id));
  }

  function clearFinishedJobs() {
    const remaining = jobsRef.current.filter((job) => job.status !== "recorded" && job.status !== "invalid");
    commitJobs(remaining);
  }

  async function postEvidenceCommand(
    command: "evidence.photo.move" | "evidence.photo.remove",
    payload: Record<string, unknown>,
    commandId: string,
    fallback: string
  ) {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, command, payload }),
    });
    const data = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new Error(commandErrorMessage(data, fallback));
  }

  async function movePhoto(photo: EvidencePhoto, nextSection: EvidenceSection) {
    if (nextSection === photo.section || busyPhotoId) return;
    const destination = sectionLabel(nextSection);
    if (!window.confirm(`이 사진의 보관함 분류를 ${sectionLabel(photo.section)}에서 ${destination}${directionParticle(destination)} 변경할까요?`)) return;
    const commandKey = `move:${photo.id}:${nextSection}`;
    setBusyPhotoId(photo.id);
    setFailure(null);
    setNotice(null);
    try {
      await postEvidenceCommand("evidence.photo.move", { id: photo.id, section: nextSection }, commandIdFor(commandKey), "사진 구간을 변경하지 못했습니다.");
      actionCommandIdsRef.current.delete(commandKey);
      setNotice(`사진을 ${destination}${directionParticle(destination)} 옮겼습니다.`);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "사진 구간을 변경하지 못했습니다.");
    } finally {
      setBusyPhotoId(null);
    }
  }

  async function removePhoto(photo: EvidencePhoto) {
    if (busyPhotoId) return;
    const confirmed = window.confirm(
      "이 사진을 보관함에서 제외할까요? 보관함 참조만 제거합니다. 원본 파일은 삭제되지 않고 기존 행사 파일 읽기 권한은 그대로 적용됩니다."
    );
    if (!confirmed) return;
    const commandKey = `remove:${photo.id}`;
    setBusyPhotoId(photo.id);
    setFailure(null);
    setNotice(null);
    try {
      await postEvidenceCommand("evidence.photo.remove", { id: photo.id }, commandIdFor(commandKey), "보관함에서 제외하지 못했습니다.");
      actionCommandIdsRef.current.delete(commandKey);
      setNotice("사진을 보관함에서 제외했습니다. 원본 파일과 기존 행사 파일 권한은 유지됩니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "보관함에서 제외하지 못했습니다.");
    } finally {
      setBusyPhotoId(null);
    }
  }

  const pageHeader = (
    <ConsolePageHeader
      title={state.kind === "ready" ? state.eventName : "행사"}
      back={{ href: `/console/events/${encodeURIComponent(eventId)}`, label: "← 운영 현황" }}
      meta={state.kind === "ready" ? state.eventMeta : undefined}
    />
  );

  if (state.kind === "loading") {
    return (
      <div className={styles.page}>
        {pageHeader}
        <ConsoleStatePanel kind="loading" message="현장 사진 정보를 불러오고 있습니다." onRetry={() => {}} />
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className={styles.page}>
        {pageHeader}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => setReloadTick((tick) => tick + 1)}
          actions={<Link className="button button-secondary" href="/console">행사 목록으로</Link>}
        />
      </div>
    );
  }

  if (!state.canManage) {
    return (
      <div className={styles.page}>
        {pageHeader}
        <ConsoleStatePanel
          kind="failed"
          message="현장 사진은 조직 소유자 또는 이 행사의 운영사 구성원만 관리할 수 있습니다."
          onRetry={() => setReloadTick((tick) => tick + 1)}
          actions={<Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}`}>운영 현황으로</Link>}
        />
      </div>
    );
  }

  const sectionCounts = EVIDENCE_SECTIONS.map((section) => ({
    ...section,
    count: state.photos.filter((photo) => photo.section === section.key).length,
  }));
  const selectedPhotos = state.photos.filter((photo) => photo.section === selectedSection);
  const selectedLabel = sectionLabel(selectedSection);

  return (
    <div className={styles.page}>
      {pageHeader}
      <p className={styles.intro}>
        현장 증빙 사진을 제안서의 8개 고정 구간으로 보관합니다. 참가자가 공유한 사진은 참여 프로그램의 사진 목록에서 별도로 관리합니다.
      </p>

      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {failure ? <p className={styles.failure} role="alert">{failure}</p> : null}

      <ConsoleSection
        headingId="evidence-photo-sections"
        title="촬영 구간"
        description="보관할 구간을 선택하세요. 사진 목록과 ZIP은 선택한 구간만 표시합니다."
      >
        <div className={styles.categoryGrid} role="group" aria-label="현장 사진 구간 선택">
          {sectionCounts.map((section) => {
            const selected = section.key === selectedSection;
            return (
              <button
                key={section.key}
                type="button"
                className={styles.categoryButton}
                aria-pressed={selected}
                onClick={() => setSelectedSection(section.key)}
              >
                <span className={styles.categoryLabel}>{section.label}</span>
                <span className={styles.categoryMeta}>
                  <span>{section.count}장</span>
                  {selected ? <span className={styles.selectedText}>선택됨</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </ConsoleSection>

      <ConsoleSection
        headingId="evidence-photo-upload"
        title={`${selectedLabel}에 사진 추가`}
        description="여러 장을 한 번에 선택할 수 있습니다. 각 파일은 업로드 후 보관 기록에 연결되며, 파일당 8MB 이하 PNG·JPEG·WebP만 지원합니다."
      >
        <div className={styles.uploadArea}>
          <label className={styles.fileLabel} htmlFor="evidence-photo-files">현장 사진 파일</label>
          <input
            id="evidence-photo-files"
            className={styles.fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={queueBusy}
            onChange={(event) => {
              selectFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            aria-describedby="evidence-photo-file-guidance"
          />
          <p id="evidence-photo-file-guidance" className={styles.guidance}>
            선택한 파일은 현재 구간인 <strong>{selectedLabel}</strong>에 등록됩니다. 파일 선택 후 순서대로 처리하며, 업로드와 보관 기록 등록 상태를 각각 표시합니다.
          </p>
        </div>

        {jobs.length ? (
          <div className={styles.jobArea} aria-labelledby="evidence-upload-history-title">
            <div className={styles.jobHeading}>
              <h3 id="evidence-upload-history-title">업로드 내역</h3>
              {jobs.some((job) => job.status === "recorded" || job.status === "invalid") ? (
                <button type="button" className={styles.textButton} onClick={clearFinishedJobs} disabled={queueBusy}>
                  완료·선택 불가 항목 지우기
                </button>
              ) : null}
            </div>
            <ul className={styles.jobList}>
              {jobs.map((job) => {
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
                          파일은 업로드됐지만 보관 기록에 연결되지 않았습니다. 비공개 보관소에 연결되지 않은 파일이 남아 있을 수 있습니다. 다시 시도하면 파일을 재업로드하지 않고 같은 보관 기록 요청만 재시도합니다.
                        </p>
                      ) : null}
                      {job.status === "failed-upload" ? (
                        <p className={styles.guidance}>응답이 유실됐을 수 있습니다. 다시 시도해도 같은 파일과 업로드 요청 ID를 사용합니다.</p>
                      ) : null}
                    </div>
                    {job.status === "failed-upload" || job.status === "failed-record" ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={queueBusy}
                        onClick={() => void processJobs([job.id])}
                      >
                        {queueBusy ? "처리 중…" : job.status === "failed-record" ? "기록 등록 재시도" : "업로드 재시도"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </ConsoleSection>

      <ConsoleSection
        headingId="evidence-photo-archive"
        title={`${selectedLabel} 사진`}
        description={`${selectedLabel} 구간에 등록된 현장 증빙 사진입니다. 보관함 제외는 원본 삭제나 행사 파일 권한 회수가 아니며, 목록과 ZIP에서만 빠집니다. ZIP은 최대 1,000장·512MB까지이며, 한도를 넘으면 원본을 개별 다운로드하세요.`}
        action={selectedPhotos.length ? (
          <a
            className="button button-secondary"
            href={evidenceZipHref(eventId, selectedSection)}
          >
            이 구간 ZIP 다운로드 ({selectedPhotos.length}장)
          </a>
        ) : undefined}
      >
        {selectedPhotos.length ? (
          <ul className={styles.photoGrid}>
            {selectedPhotos.map((photo) => {
              const photoBusy = busyPhotoId === photo.id;
              const selectedTarget = moveTargets[photo.id] ?? photo.section;
              const uploadedAt = formatUploadedAt(photo.uploadedAt);
              const originalHref = `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(photo.image.fileId)}`;
              return (
                <li key={photo.id} className={styles.photoItem}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className={styles.thumbnail}
                    src={originalHref}
                    alt={`${sectionLabel(photo.section)} 현장 사진 파일: ${photo.image.name}`}
                    loading="lazy"
                  />
                  <div className={styles.photoInfo}>
                    <p className={styles.fileName} title={photo.image.name}>{photo.image.name}</p>
                    <p className={styles.photoMeta}>
                      {uploadedAt ? <time dateTime={photo.uploadedAt}>{uploadedAt}</time> : <span>등록 시각 미상</span>}
                    </p>
                    <a className={styles.originalLink} href={originalHref} download={photo.image.name || "현장사진"}>
                      원본 다운로드
                    </a>
                  </div>
                  <form
                    className={styles.photoControls}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void movePhoto(photo, selectedTarget);
                    }}
                  >
                    <label htmlFor={`move-photo-${photo.id}`}>보관 구간 변경</label>
                    <div className={styles.moveRow}>
                      <select
                        id={`move-photo-${photo.id}`}
                        value={selectedTarget}
                        disabled={busyPhotoId !== null}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (isEvidenceSection(value)) {
                            setMoveTargets((current) => ({ ...current, [photo.id]: value }));
                          }
                        }}
                      >
                        {EVIDENCE_SECTIONS.map((section) => (
                          <option key={section.key} value={section.key}>{section.label}</option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="button button-secondary"
                        disabled={photoBusy || busyPhotoId !== null || selectedTarget === photo.section}
                      >
                        {photoBusy ? "처리 중…" : "구간 변경"}
                      </button>
                    </div>
                  </form>
                  <button
                    type="button"
                    className={styles.removeButton}
                    disabled={photoBusy || busyPhotoId !== null}
                    onClick={() => void removePhoto(photo)}
                  >
                    보관함에서 제외
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>이 구간에는 아직 등록된 사진이 없습니다. 위의 파일 선택에서 첫 사진을 추가하세요.</p>
        )}
      </ConsoleSection>

    </div>
  );
}
