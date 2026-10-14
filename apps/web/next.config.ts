import type { NextConfig } from "next";

// Same-origin API contract: the browser only ever talks to this app's
// origin under /api/*. In every environment the destination is the
// EVENTOUCH API (today the Node monolith on 8776); the frontend never
// talks to the API host directly, so cookies, CSP and CORS policy stay put.
const apiBase = process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";

const nextConfig: NextConfig = {
  rewrites: async () => [
    { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
  ],
};

export default nextConfig;
