"use client";
import { useSyncExternalStore } from "react";
import { getOperatorContextSnapshot, subscribeOperatorContext, type OperatorContextSnapshot } from "./operator-context";

const SERVER_SNAPSHOT: OperatorContextSnapshot = {
  context: null, observed: null, changed: false, loading: true, error: null,
  inFlightWrites: 0, uncertainWrites: 0,
};
export function useOperatorContextSnapshot() {
  return useSyncExternalStore(subscribeOperatorContext, getOperatorContextSnapshot, () => SERVER_SNAPSHOT);
}
