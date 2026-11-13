"use client";

import NextLink from "next/link";
import { forwardRef, type ComponentProps } from "react";
import { Link } from "@astryxdesign/core/Link";
import { productActionClass, productActionVariant, type ProductActionVariant } from "./product-action";

type ProductLinkProps = ComponentProps<typeof NextLink> & {
  variant?: ProductActionVariant;
  size?: "sm" | "md" | "lg";
};

const ProductLink = forwardRef<HTMLAnchorElement, ProductLinkProps>(function ProductLink({
  children, className, variant, size = "md", type, href, as, color, ...props
}, ref) {
  const asAction = variant !== undefined || /(?:^|\s)button(?:\s|-|$)/.test(className ?? "");
  const classes = productActionClass(className, asAction ? "product-action product-link" : "product-link");
  const presentation = {
    className: classes,
    "data-product-link": "true",
    "data-action-variant": asAction ? productActionVariant(className, variant) : undefined,
    "data-action-size": asAction ? size : undefined,
  };
  // Structured destinations, route aliases and MIME types belong to Next's anchor API.
  if (typeof href !== "string" || type || as || color) {
    return <NextLink {...props} {...presentation} href={href} as={as} ref={ref} type={type} color={color}>{children}</NextLink>;
  }
  // Use the anchor API even for action-styled navigation, preserving event and ref types.
  return <Link {...props} {...presentation} href={href} as={NextLink} ref={ref} type="inherit">{children}</Link>;
});

export default ProductLink;
