import { ConsolePageSkeleton } from "../../console-ui/ConsoleSkeleton";

// See ../loading.tsx. Event screens are mostly lists and forms, so the generic
// list shape is the closest neutral guess until the screen's own skeleton
// (which knows its real shape) takes over.
export default function ConsoleEventLoading() {
  return <ConsolePageSkeleton shape="list" />;
}
