import { ConsolePageSkeleton } from "./console-ui/ConsoleSkeleton";

// Route-level loading UI (2026-11-23). The console shell stays on screen; this
// fills the page area the moment a link is clicked, before the screen's own
// code and data arrive, so a click never shows an empty page.
export default function ConsoleLoading() {
  return <ConsolePageSkeleton shape="cards" />;
}
