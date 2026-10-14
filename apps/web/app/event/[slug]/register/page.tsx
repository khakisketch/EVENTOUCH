import RegisterForm from "./RegisterForm";

export type PublishedField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

export type RegisterData = {
  name: string;
  consentText: string;
  consentVersion: number;
  registrationOpen: boolean;
  publishedVersion: number;
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
    event?: { name?: unknown } | null;
    workspace?: Record<string, unknown> | null;
  };
  if (!data.event) return null;
  const workspace = data.workspace ?? {};
  const rawFields = Array.isArray(workspace.publishedFields)
    ? workspace.publishedFields
    : [];
  return {
    name: typeof data.event.name === "string" ? data.event.name : "",
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
  try {
    data = await loadRegisterData(slug);
  } catch {
    throw new Error("행사 정보를 불러오지 못했습니다");
  }
  if (!data) {
    return (
      <main>
        <h1>신청할 수 없는 행사입니다</h1>
        <p>행사 주소를 확인하세요.</p>
      </main>
    );
  }
  if (!data.registrationOpen) {
    return (
      <main>
        <p>행사 안내</p>
        <h1>{data.name}</h1>
        <p>현재 신청을 받지 않습니다.</p>
      </main>
    );
  }
  return (
    <main>
      <p>참가 신청</p>
      <h1>{data.name}</h1>
      <RegisterForm
        slug={slug}
        fields={[...BUILT_IN_FIELDS, ...data.fields]}
        consentText={data.consentText}
        formVersion={data.publishedVersion}
      />
    </main>
  );
}
