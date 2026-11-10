"use client";

import { useEffect, useState } from "react";
import { useOperatorContextSnapshot } from "./use-operator-context";
import { operatorReceipts, subscribeOperatorReceipts, type OperatorReceiptPointer } from "./operator-receipts";

// Only minimal, scoped pointers survive a reload; the original inputs do not.
// The shared recovery panel lets the operator check or deliberately dismiss
// them before starting a potentially duplicate organization-level write.
export function useOrganizationReceipts(): OperatorReceiptPointer[] {
  const context = useOperatorContextSnapshot().context;
  const [items, setItems] = useState<OperatorReceiptPointer[]>([]);
  useEffect(() => {
    // Include in-flight pointers too: a confirmed navigation can unmount the
    // original form before its request settles.
    const update = () => setItems(operatorReceipts());
    update();
    return subscribeOperatorReceipts(update);
  }, []);
  return context ? items.filter((item) => item.eventId === null && item.userId === context.userId && item.organizationId === context.organizationId) : [];
}
