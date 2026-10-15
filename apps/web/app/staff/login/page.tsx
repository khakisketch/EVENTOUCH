import { redirect } from "next/navigation";
import { safeNextPath } from "../../auth-redirect";

// Compatibility entry: the shared login now lives at /login. Preserve an
// optional ?next= so old bookmarks and 401 redirects keep working.
export default async function StaffLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const resolved = await searchParams;
  const raw = Array.isArray(resolved.next) ? resolved.next[0] : resolved.next;
  const safe = safeNextPath(raw);
  redirect(safe ? `/login?next=${encodeURIComponent(safe)}` : "/login");
}
