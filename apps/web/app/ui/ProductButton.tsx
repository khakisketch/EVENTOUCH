"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { actionLabel, productActionClass, productActionVariant, type ProductActionVariant } from "./product-action";

export type ProductButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ProductActionVariant;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  label?: string;
  icon?: ReactNode;
  endContent?: ReactElement;
  tooltip?: string;
};

const ProductButton = forwardRef<HTMLButtonElement, ProductButtonProps>(function ProductButton({
  children, className, variant, size = "md", busy = false, disabled = false,
  label, icon, endContent, tooltip, type = "button", onClick, onKeyDown, ...props
}, ref) {
  const named = label ?? props["aria-label"] ?? (actionLabel(children) || props.title || "");
  const ariaDisabled = props["aria-disabled"] === true || props["aria-disabled"] === "true";
  const locked = disabled || busy || ariaDisabled;
  const shared = {
    ...props,
    name: props.name,
    ref,
    type,
    size,
    disabled,
    label: named,
    variant: productActionVariant(className, variant),
    className: productActionClass(className),
    // Native disabled keeps HTML form semantics; loading deliberately keeps focus.
    isLoading: busy,
    "aria-disabled": locked || undefined,
    "data-product-action": "true",
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (locked) { event.preventDefault(); event.stopPropagation(); return; }
      onClick?.(event);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (locked && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); return; }
      onKeyDown?.(event);
    },
  };
  if (!actionLabel(children) && (icon || children) && named) {
    return <IconButton {...shared} icon={icon ?? children} tooltip={tooltip ?? props.title ?? named} />;
  }
  return <Button {...shared} icon={icon} endContent={endContent} tooltip={tooltip}>{children}</Button>;
});

export default ProductButton;
