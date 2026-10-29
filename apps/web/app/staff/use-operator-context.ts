"use client";

import { useSyncExternalStore } from "react";
import {
  getOperatorContextSnapshot,
  subscribeOperatorContext,
  type OperatorContextSnapshot,
} from "../../lib/operator-context";

// Staff view of the shared operator context. The snapshot type, field names,
// and semantics come from the shared adapter contract exactly; this hook
// only binds it to React with a stable server snapshot for hydration.
const SERVER_SNAPSHOT: OperatorContextSnapshot = {
  context: null,
  observed: null,
  changed: false,
  loading: true,
  error: null,
  inFlightWrites: 0,
  uncertainWrites: 0,
};

function getServerSnapshot(): OperatorContextSnapshot {
  return SERVER_SNAPSHOT;
}

export function useOperatorContextSnapshot(): OperatorContextSnapshot {
  return useSyncExternalStore(
    subscribeOperatorContext,
    getOperatorContextSnapshot,
    getServerSnapshot
  );
}
