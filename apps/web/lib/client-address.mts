import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

type AddressRequest = Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } };

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

/** Walk from the socket peer and stop at the first address outside the allowlist. */
export function createForwardedClientAddressResolver(value: string | undefined, setting: string) {
  const trusted = new BlockList();
  const entries = String(value || "").split(",").map(entry => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split("/");
    const address = normalizeAddress(parts[0]);
    const family = address && isIP(address);
    const prefix = parts[1] === undefined ? null : Number(parts[1]);
    if (!address || !family || parts.length > 2 || (prefix !== null &&
        (!/^\d+$/.test(parts[1]) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)))) {
      throw new Error(`${setting}에는 신뢰하는 프록시의 IP 또는 CIDR만 입력하세요.`);
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
    const chain = raw.split(",").map(entry => normalizeAddress(entry));
    if (!chain.length || chain.length > 32 || chain.some(address => !address)) return peer;
    let address = peer;
    for (let index = chain.length - 1; index >= 0 && isTrusted(address); index -= 1) {
      address = chain[index]!;
    }
    return address;
  };
}
