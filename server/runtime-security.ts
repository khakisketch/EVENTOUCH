import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

type Environment = Record<string, string | undefined>;
type AddressRequest = Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } };

export function developmentLoginEmail(env: Environment = process.env): string {
  const email = String(env.EVENTOUCH_DEV_QUICK_LOGIN || "").trim().toLowerCase();
  if (email && env.NODE_ENV !== "development") {
    throw new Error("개발용 빠른 로그인은 NODE_ENV=development에서만 허용됩니다. 운영에서는 EVENTOUCH_DEV_QUICK_LOGIN을 제거하세요.");
  }
  return email;
}

function normalizeAddress(value: string | undefined): string | null {
  const input = String(value || "").trim();
  const family = isIP(input);
  if (family === 4) return input;
  if (family !== 6 || input.includes("%")) return null;
  try {
    const canonical = new URL(`http://[${input}]/`).hostname.slice(1, -1).toLowerCase();
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return canonical;
  } catch {
    return null;
  }
}

/** Trust is an explicit network allow-list, never a client-controlled header. */
export function createClientAddressResolver(env: Environment = process.env) {
  const trusted = new BlockList();
  const entries = String(env.EVENTOUCH_TRUSTED_PROXIES || "").split(",").map(value => value.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split("/");
    const address = normalizeAddress(parts[0]);
    const family = address && isIP(address);
    const prefix = parts[1] === undefined ? null : Number(parts[1]);
    if (!address || !family || parts.length > 2 || (prefix !== null &&
        (!/^\d+$/.test(parts[1]) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)))) {
      throw new Error("EVENTOUCH_TRUSTED_PROXIES에는 신뢰하는 프록시의 IP 또는 CIDR만 입력하세요.");
    }
    if (prefix === null) trusted.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else trusted.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  const isTrusted = (address: string) => trusted.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  return (request: AddressRequest): string => {
    const peer = normalizeAddress(request.socket?.remoteAddress) || "unknown";
    if (!entries.length || peer === "unknown" || !isTrusted(peer)) return peer;
    const raw = request.headers?.["x-forwarded-for"];
    if (typeof raw !== "string" || raw.length > 4096) return peer;
    const chain = raw.split(",").map(value => normalizeAddress(value));
    if (!chain.length || chain.length > 32 || chain.some(value => !value)) return peer;
    let address = peer;
    for (let index = chain.length - 1; index >= 0 && isTrusted(address); index -= 1) {
      address = chain[index]!;
    }
    return address;
  };
}
