import { createForwardedClientAddressResolver } from "../apps/web/lib/client-address.mts";

type Environment = Record<string, string | undefined>;

export function developmentLoginEmail(env: Environment = process.env): string {
  const email = String(env.EVENTOUCH_DEV_QUICK_LOGIN || "").trim().toLowerCase();
  if (email && env.NODE_ENV !== "development") {
    throw new Error("개발용 빠른 로그인은 NODE_ENV=development에서만 허용됩니다. 운영에서는 EVENTOUCH_DEV_QUICK_LOGIN을 제거하세요.");
  }
  return email;
}

export function createClientAddressResolver(env: Environment = process.env) {
  return createForwardedClientAddressResolver(env.EVENTOUCH_TRUSTED_PROXIES, "EVENTOUCH_TRUSTED_PROXIES");
}
