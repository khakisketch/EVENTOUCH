import type { ReactNode } from "react";
import ProductNotice from "../../ui/ProductNotice";

type ConsoleFeedbackProps = {
  kind: "success" | "error" | "warning" | "info";
  children: ReactNode;
  id?: string;
};

export default function ConsoleFeedback({ kind, children, id }: ConsoleFeedbackProps) {
  return <ProductNotice kind={kind} id={id}>{children}</ProductNotice>;
}
