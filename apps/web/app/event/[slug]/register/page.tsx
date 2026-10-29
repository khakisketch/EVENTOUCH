import RegisterForm from "./RegisterForm";
import Link from "next/link";
import VerificationUnavailable from "../VerificationUnavailable";
import { loadVerificationMode } from "../../../../lib/verification-mode";
import type { VerificationMode } from "../../../../lib/verification-mode";

export type PublishedField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

export type RegisterData = {
  name: string;
  stage: string;
  consentText: string;
  consentVersion: number;
  registrationOpen: boolean;
  publishedVersion: number;
  verificationRequired: boolean;
  approvalRequired: boolean;
  paymentPending: boolean;
  fields: PublishedField[];
};

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

function asField(value: unknown): PublishedField | null {
  if (typeof value !== "object" || value === null) return null;
  const field = value as Record<string, unknown>;
  if (typeof field.id !== "string" || !field.id) return null;
  if (field.id === "name" || field.id === "phone" || field.id === "company") {
    return null;
  }
  return {
    id: field.id,
    label: typeof field.label === "string" ? field.label : field.id,
    type: typeof field.type === "string" ? field.type : "text",
    required: field.required === true,
    options: Array.isArray(field.options)
      ? field.options.filter((option): option is string => typeof option === "string")
      : [],
  };
}

async function loadRegisterData(slug: string): Promise<RegisterData | null> {
  const res = await fetch(
    `${apiBase()}/api/public/events/${encodeURIComponent(slug)}`,
    { cache: "no-store" }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`행사 정보를 불러오지 못했습니다 (${res.status})`);
  const data = (await res.json()) as {
    event?: { name?: unknown; stage?: unknown; features?: unknown } | null;
    workspace?: Record<string, unknown> | null;
  };
  if (!data.event) return null;
  const workspace = data.workspace ?? {};
  // Stage already ships in this payload: an ENDED event with the intake
  // flag still on must render the closed state, because the public signup
  // writer rejects ENDED (participants writer rule). No API change.
  const eventStage = typeof data.event.stage === "string" ? data.event.stage.toUpperCase() : "";
  const rawFields = Array.isArray(workspace.publishedFields)
    ? workspace.publishedFields
    : [];
  return {
    name: typeof data.event.name === "string" ? data.event.name : "",
    stage: eventStage,
    consentText:
      typeof workspace.consentText === "string" ? workspace.consentText : "",
    consentVersion:
      typeof workspace.consentVersion === "number"
        ? workspace.consentVersion
        : 1,
    registrationOpen: workspace.registrationOpen === true,
    publishedVersion:
      typeof workspace.publishedVersion === "number"
        ? workspace.publishedVersion
        : 0,
    verificationRequired: workspace.verificationRequired === true,
    approvalRequired: workspace.approvalRequired === true,
    // Paid-flow mirror of the participants writer rule (payment feature
    // plus a positive price): signup has a PENDING payment, regardless of
    // approval status, so the form must not promise an immediately usable ticket.
    // Read-only copy input; no payment behavior is added (v1-excluded).
    paymentPending: (Array.isArray(data.event.features) && data.event.features.includes('payment'))
      && Number(workspace.price) > 0,
    fields: rawFields
      .map(asField)
      .filter((field): field is PublishedField => field !== null),
  };
}

const BUILT_IN_FIELDS: PublishedField[] = [
  { id: "name", label: "이름", type: "text", required: true, options: [] },
  { id: "phone", label: "연락처", type: "text", required: true, options: [] },
  { id: "company", label: "소속", type: "text", required: false, options: [] },
];

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let data: RegisterData | null = null;
  let verificationMode: VerificationMode = "unknown";
  try {
    [data, verificationMode] = await Promise.all([
      loadRegisterData(slug),
      loadVerificationMode(),
    ]);
  } catch {
    throw new Error("행사 정보를 불러오지 못했습니다");
  }
  if (!data) {
    return (
      <main id="main-content" tabIndex={-1} className="site-page registration-page registration-state">
        <h1>신청할 수 없는 행사입니다</h1>
        <p>행사 주소를 확인하세요.</p>
      </main>
    );
  }
  if (!data.registrationOpen || data.stage === "ENDED") {
    const recoveryUnavailable = verificationMode === "mock" || verificationMode === "none";
    return (
      <main id="main-content" tabIndex={-1} className="site-page registration-page registration-state">
        <header className="public-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">참가 신청</p>
        </header>
        <h1>{data.name}</h1>
        <p>현재 신청을 받지 않습니다.</p>
        {recoveryUnavailable ? (
          <p role="note">이 행사에서는 문자로 티켓을 다시 연결할 수 없어, 티켓은 신청한 기기에서만 열 수 있습니다. 티켓을 잃었다면 행사 안내의 문의처로 운영자에게 연락하세요.</p>
        ) : (
          <p>
            <Link className="button button-primary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
              이미 신청했다면 내 티켓 찾기
            </Link>
          </p>
        )}
        <p>
          <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>
            행사 안내로
          </Link>
        </p>
      </main>
    );
  }
  if (data.verificationRequired && (verificationMode === "mock" || verificationMode === "none")) {
    return (
      <main id="main-content" tabIndex={-1} className="site-page registration-page registration-state">
        <header className="public-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">참가 신청</p>
        </header>
        <h1 className="registration-title">{data.name}</h1>
        <VerificationUnavailable slug={slug} mode={verificationMode} />
      </main>
    );
  }
  return (
    <main id="main-content" tabIndex={-1} className="site-page registration-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className="eyebrow">참가 신청</p>
      </header>
      <h1 className="registration-title">{data.name}</h1>
      <RegisterForm
        slug={slug}
        fields={[...BUILT_IN_FIELDS, ...data.fields]}
        consentText={data.consentText}
        formVersion={data.publishedVersion}
        verificationRequired={data.verificationRequired}
        approvalRequired={data.approvalRequired}
        paymentPending={data.paymentPending}
        recoveryBlocked={verificationMode === "none" || verificationMode === "mock"}
      />
    </main>
  );
}
