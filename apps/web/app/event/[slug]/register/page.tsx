import RegisterForm from "./RegisterForm";
import Link from "next/link";
import VerificationUnavailable from "../VerificationUnavailable";
import { loadVerificationMode } from "../../../../lib/verification-mode";
import type { VerificationMode } from "../../../../lib/verification-mode";
import { BUILT_IN_FIELDS, parseRegisterData } from "./register-data";
import type { RegisterData } from "./register-data";
export type { PublishedField } from "./register-data";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

async function loadRegisterData(slug: string): Promise<RegisterData | null> {
  const res = await fetch(`${apiBase()}/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`행사 정보를 불러오지 못했습니다 (${res.status})`);
  const result = parseRegisterData(await res.json());
  if (!result) throw new Error("행사 정보를 확인하지 못했습니다");
  return result;
}

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
          <p role="note">이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 신청을 완료한 브라우저 탭을 확인하세요. {data.recoveryContact ? `문의: ${data.recoveryContact}` : "탭을 찾을 수 없다면 행사 초대 안내를 확인하거나 행사 주최 측에 문의하세요."}</p>
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
        <VerificationUnavailable slug={slug} mode={verificationMode} contact={data.recoveryContact} />
      </main>
    );
  }
  return (
    <main id="main-content" tabIndex={-1} className="site-page registration-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className="eyebrow">참가 신청</p>
      </header>
      <p><Link href={`/event/${encodeURIComponent(slug)}`}>← 행사 안내로</Link></p>
      <h1 className="registration-title">{data.name}</h1>
      <RegisterForm
        slug={slug}
        fields={[...BUILT_IN_FIELDS, ...data.fields]}
        consentText={data.consentText}
        consentVersion={data.consentVersion}
        formVersion={data.publishedVersion}
        verificationRequired={data.verificationRequired}
        approvalRequired={data.approvalRequired}
        paymentPending={data.paymentPending}
        recoveryBlocked={verificationMode === "none" || verificationMode === "mock"}
        recoveryContact={data.recoveryContact}
      />
    </main>
  );
}
