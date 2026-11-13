"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";

export type ProductTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

const ProductTextarea = forwardRef<HTMLTextAreaElement, ProductTextareaProps>(function ProductTextarea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={["product-native-field", className].filter(Boolean).join(" ")} />;
});

export default ProductTextarea;
