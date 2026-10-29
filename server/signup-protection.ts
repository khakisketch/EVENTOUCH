import { createHash } from "node:crypto";
import { createClientAddressResolver } from "./runtime-security.ts";
import type { IncomingMessage } from "node:http";

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
type Database = { transaction: <T>(operation: (client: { query: Query }) => Promise<T>) => Promise<T> };
type Environment = Record<string, string | undefined>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const setting = (env: Environment, key: string, fallback: number) => {
  const value = Number(env[key]);
  return Number.isInteger(value) && value >= 1 && value <= 100000 ? value : fallback;
};

/** Admission control only; the participant executor still owns all validation and receipts. */
export function createSignupProtection(database: Database, env: Environment = process.env) {
  const addressOf = createClientAddressResolver(env);
  const addressLimit = setting(env, "EVENTOUCH_SIGNUP_ADDRESS_LIMIT", 600);
  const eventLimit = setting(env, "EVENTOUCH_SIGNUP_EVENT_LIMIT", 3000);
  const windowSeconds = Math.min(setting(env, "EVENTOUCH_SIGNUP_WINDOW_SECONDS", 60), 3600);
  return async ({ slug, commandId, request }: { slug: string; commandId: unknown; request: IncomingMessage }) => {
    if (typeof commandId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(commandId)) return;
    await database.transaction(async client => {
      const events = await client.query("SELECT id FROM events WHERE slug = $1 LIMIT 1", [slug]);
      if (!events.rows[0]) return;
      const eventId = String(events.rows[0].id);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`signup-rate:${eventId}`]);
      // A response-loss retry is not another registration. This does not
      // authorize replay: the executor still verifies the receipt's request.
      const replay = await client.query(
        `SELECT 1 FROM command_receipts WHERE command_id = $1 AND event_id = $2
         UNION ALL SELECT 1 FROM signup_request_attempts WHERE event_id = $2 AND command_hash = $3 LIMIT 1`,
        [commandId, eventId, digest(commandId)],
      );
      if (replay.rows.length) return;
      const addressHash = digest(`${eventId}:${addressOf(request)}`);
      const counts = await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE address_hash = $2)::int AS address
         FROM signup_request_attempts WHERE event_id = $1 AND attempted_at > now() - ($3 * interval '1 second')`,
        [eventId, addressHash, windowSeconds],
      );
      if (Number(counts.rows[0]?.total) >= eventLimit || Number(counts.rows[0]?.address) >= addressLimit) {
        throw Object.assign(new Error("신청 요청이 많습니다. 잠시 후 같은 신청으로 다시 시도하세요."), { status: 429, retryAfterSeconds: windowSeconds });
      }
      await client.query(
        "INSERT INTO signup_request_attempts (event_id, command_hash, address_hash) VALUES ($1, $2, $3)",
        [eventId, digest(commandId), addressHash],
      );
      await client.query("DELETE FROM signup_request_attempts WHERE attempted_at < now() - interval '1 day'");
    });
  };
}
