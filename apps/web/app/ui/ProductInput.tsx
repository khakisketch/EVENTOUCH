"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";

export type ProductInputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Explicit labels replace, rather than nest inside, a caller-owned label. */
  labelMode?: "native" | "astryx";
  label?: string;
};

const astryxTypes = new Set(["text", "password", "email", "search", "tel", "url"]);
const capitalizationModes = ["off", "none", "on", "sentences", "words", "characters"] as const;

const ProductInput = forwardRef<HTMLInputElement, ProductInputProps>(function ProductInput({
  labelMode = "native", label, type = "text", className, name, required, disabled,
  value, defaultValue, onChange, autoComplete, inputMode, size, autoCapitalize, ...props
}, ref) {
  const capitalization = capitalizationModes.find(mode => mode === autoCapitalize);
  const native = labelMode !== "astryx" || !label || !astryxTypes.has(type) || size !== undefined ||
    defaultValue !== undefined || value == null || (autoCapitalize !== undefined && capitalization === undefined);
  if (native) {
    const input = <input {...props} ref={ref} type={type} name={name} required={required} disabled={disabled}
      className={["product-native-field", className].filter(Boolean).join(" ")} value={value} defaultValue={defaultValue}
      autoComplete={autoComplete} inputMode={inputMode} size={size} autoCapitalize={autoCapitalize} onChange={onChange} />;
    return labelMode === "astryx" && label
      ? <VStack as="label" gap={1}><Text>{label}</Text>{input}</VStack>
      : input;
  }

  // The library forwards these native attributes; its ARIA flags alone are not validation or disabling.
  const nativeProps = { ...props, required, disabled };
  return <TextInput {...nativeProps} ref={ref} label={label} type={type as "text" | "password" | "email" | "search" | "tel" | "url"}
    htmlName={name} isReadOnly={props.readOnly} value={String(value)} autoComplete={autoComplete} inputMode={inputMode}
    autoCapitalize={capitalization} onChange={onChange ? (_value, event) => onChange(event) : undefined}
    isRequired={required} controlClassName={["product-native-field", className].filter(Boolean).join(" ")} />;
});

export default ProductInput;
