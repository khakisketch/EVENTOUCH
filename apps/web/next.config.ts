import type { NextConfig } from "next";

// Same-origin API contract: the browser only ever talks to this app's
// origin under /api/*. In every environment the destination is the
// EVENTOUCH API (today the Node monolith on 8776); the frontend never
// talks to the API host directly, so cookies, CSP and CORS policy stay put.
const apiBase = (process.env.EVENTOUCH_API_URL || `http://127.0.0.1:${process.env.API_PORT || "8776"}`).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // The framework's default X-Powered-By header advertises the stack on
  // every document; the product needs no client to read it.
  poweredByHeader: false,
  // The dev server starts on localhost, while the in-app preview can open it
  // through 127.0.0.1. Allow that exact hostname so Next can serve HMR assets.
  allowedDevOrigins: ["127.0.0.1"],
  rewrites: async () => [
    { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
  ],
};

export default nextConfig;
