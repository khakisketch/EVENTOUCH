"use client";
import RuntimeRecovery from "./RuntimeRecovery";

// Root route boundary for the staff/attendee/console screens: a runtime or
// chunk-load failure inside a segment lands here instead of on the framework
// default. Recovery is always explicit — this boundary never reloads on its
// own, because an unconditional reload would discard input the operator or
// attendee already typed.
export default function RootError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return <RuntimeRecovery error={error} retry={retry} />;
}
