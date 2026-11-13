import { Children, isValidElement, type ReactNode } from "react";

export type ProductActionVariant = "primary" | "secondary" | "ghost" | "destructive";
const legacyClasses = new Set(["button", "button-primary", "button-secondary", "button-quiet", "button-ghost", "button-danger", "button-small", "button-compact"]);

export function productActionClass(className = "", base = "product-action") {
  return [base, ...className.split(/\s+/).filter(name => name && !legacyClasses.has(name))].join(" ");
}

export function productActionVariant(className = "", variant?: ProductActionVariant): ProductActionVariant {
  if (variant) return variant;
  const classes = new Set(className.split(/\s+/));
  if (classes.has("button-danger")) return "destructive";
  if (classes.has("button-primary")) return "primary";
  if (classes.has("button-quiet") || classes.has("button-ghost")) return "ghost";
  return "secondary";
}

export function actionLabel(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{ children?: ReactNode; "aria-hidden"?: boolean | "true" | "false" }>(child) || child.props["aria-hidden"] === true || child.props["aria-hidden"] === "true") return "";
    return actionLabel(child.props.children);
  }).join("").replace(/\s+/g, " ").trim();
}
