// Fastify route boundary, first increment.
//
// The HTTP layer migrates route by route: this module owns GET /api/health
// behind an injectable boundary, and server.js delegates exactly that path
// to it. Everything else stays on the hand-rolled server until its own
// slice moves it. The response shape is byte-identical to the previous
// handler (tests/server-skeleton, server-auth, and server-message-outbox
// pin the fields), so the migration is invisible outside this file.
//
// Like commands/shared.ts this runs without a build step (Node 24 type
// stripping) and is verified by `npm run server:typecheck`.

import fastify, { type FastifyInstance } from "fastify";

export type HealthStatus = {
  connected: boolean;
  provider: string | null;
};

export type HealthDeps = {
  getMessaging: () => HealthStatus;
  getVerificationMode: () => string;
  countOutbox: (() => Promise<number | null>) | null;
  includeDevLogin: boolean;
};

export function buildHealthApp(deps: HealthDeps): FastifyInstance {
  const app = fastify({ logger: false });
  app.get("/api/health", async () => {
    const messaging = deps.getMessaging();
    const base: Record<string, unknown> = {
      ok: true,
      version: 1,
      ...(deps.includeDevLogin ? { devQuickLogin: true } : {}),
      messaging: messaging.connected,
      messagingProvider: messaging.provider,
      verification: deps.getVerificationMode(),
    };
    // Queue depth is best-effort, as before: a failing count omits the
    // field instead of turning a live server unhealthy.
    if (!deps.countOutbox) return base;
    try {
      const pending = await deps.countOutbox();
      return pending === null ? base : { ...base, outboxPending: pending };
    } catch {
      return base;
    }
  });
  return app;
}
