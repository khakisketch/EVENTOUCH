"use client";

import { useEffect, useState } from "react";
import { useOperatorContextSnapshot } from "./use-operator-context";
import { operatorReceipts, subscribeOperatorReceipts, type OperatorReceiptPointer } from "./operator-receipts";

// A reload keeps only scoped command identifiers. Components can prevent a
// potentially duplicate task while the shared status panel checks them.
export function useEventReceipts(eventId: string): OperatorReceiptPointer[] {
  const context = useOperatorContextSnapshot().context;
  const [items, setItems] = useState<OperatorReceiptPointer[]>([]);
  useEffect(() => {
    const update = () => setItems(operatorReceipts());
    update();
    return subscribeOperatorReceipts(update);
  }, []);
  return context ? items.filter((item) => item.eventId === eventId && item.userId === context.userId && item.organizationId === context.organizationId) : [];
}
