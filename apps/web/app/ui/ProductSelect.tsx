"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";

export type ProductSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

const ProductSelect = forwardRef<HTMLSelectElement, ProductSelectProps>(function ProductSelect({ className, ...props }, ref) {
  return <select {...props} ref={ref} className={["product-native-field", className].filter(Boolean).join(" ")} />;
});

export default ProductSelect;
