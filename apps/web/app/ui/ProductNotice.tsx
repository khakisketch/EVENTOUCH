import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";

type ProductNoticeProps = {
  kind: "success" | "error" | "warning" | "info";
  children: ReactNode;
  id?: string;
  className?: string;
};

export default function ProductNotice({ kind, children, id, className }: ProductNoticeProps) {
  return <Banner status={kind} title={children} id={id} className={className}
    role={kind === "error" ? "alert" : "status"} collapsible={false} container="section" />;
}
