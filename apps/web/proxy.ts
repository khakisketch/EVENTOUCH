import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Security boundary for the sole product UI: per-request CSP nonce.
//
// Each document request gets a fresh unpredictable nonce. The proxy puts it
// in the response Content-Security-Policy AND in the request headers it
// forwards upstream; Next.js reads the request CSP during SSR and stamps the
// same nonce on every framework/hydration script it emits, so the audit can
// compare response header against served inline scripts 1:1. Pages under the
// root layout therefore render dynamically (see app/layout.tsx).
//
// Deliberate allowances, all documented:
// - style-src keeps 'unsafe-inline' in every environment: the theme UI styles
//   through React style props (SSR'd style attributes + CSSOM), and blocking
//   those would break legitimate product rendering. style-src never weakens
//   script-src; scripts stay nonce-only.
// - script-src gains 'unsafe-eval' in development ONLY: React dev needs eval
//   for server-error reconstruction. Production has no unsafe-eval and no
//   unsafe-inline for scripts.
// - connect-src gains ws:/wss: in development ONLY for HMR; production is
//   same-origin.
// - frame-ancestors stays 'self' (with X-Frame-Options SAMEORIGIN): the
//   operator's same-origin phone preview must keep framing the product.
// - /api/* is excluded: those responses come from the API through rewrites
//   and already carry the API's own per-response policy (including its
//   nonce); stamping ours over them would clobber it.
function contentSecurityPolicy(nonce: string, isDev: boolean, secure: boolean): string {
  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");
  const connect = ["'self'", ...(isDev ? ["ws:", "wss:"] : [])].join(" ");
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(!isDev && secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function baselineHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(self), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
  };
  if (secure) {
    headers["strict-transport-security"] =
      "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const secure = process.env.COOKIE_SECURE === "1";
  const csp = contentSecurityPolicy(nonce, isDev, secure);

  const requestHeaders = new Headers(request.headers);
  // Next.js extracts the nonce from the REQUEST CSP during SSR and stamps
  // every script it emits; x-nonce additionally lets server components read it.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(baselineHeaders(secure))) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Document + RSC/data requests except the API rewrite target (the API owns
  // its own headers) and immutable build assets. Prefetch headers are
  // skipped per the Next.js CSP guide: prefetches are not documents.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
