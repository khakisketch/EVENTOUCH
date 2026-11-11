---
name: EVENTOUCH
description: 밝은 작업면에서 행사를 끝까지 운영하는 행사 운영 SaaS
colors:
  brand: "#EA552E"
  brand-hover: "#C7441C"
  brand-text: "#8E351F"
  on-brand: "#19191C"
  on-brand-hover: "#FFFFFF"
  brand-soft: "#FFF1E8"
  brand-tint: "#FDEEE4"
  ink: "#1E2026"
  muted: "#61656C"
  line: "#E5E5E7"
  line-strong: "#8A939F"
  paper: "#FFFFFF"
  ground: "#FFFFFF"
  workspace-ground: "#FFFFFF"
  surface-muted: "#FAFAFB"
  nav: "#FAFBFC"
  nav-hover: "#EFF1F4"
  nav-active: "#FFF0E6"
  nav-text: "#252A34"
  nav-muted: "#626B78"
  danger: "#B21E35"
  danger-soft: "#F7E4E7"
  danger-line: "#E0B4BA"
  success: "#2F6B4F"
  success-soft: "#E4EFE7"
  success-line: "#A8C3B3"
  warning: "#81520E"
  warning-soft: "#FFF4E1"
  warning-line: "#D9BB84"
  info: "#315B82"
  info-soft: "#EAF0F7"
  info-line: "#BDCEDF"
  message-kakao-header: "#FEE500"
  focus: "#2453A6"
typography:
  display:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "clamp(48px, 3.4vw, 56px)"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "-0.05em"
  headline:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.35
  console-headline:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  console-headline-mobile:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  console-section-title:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.4
  console-context:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  body:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.006em"
  label:
    fontFamily: "'Pretendard Variable', Pretendard, 'Noto Sans KR', 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  card: "18px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
  s8: "64px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-brand-hover}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  pill:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  pill-active:
    backgroundColor: "{colors.brand-tint}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.nav-muted}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  ledger-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "12px 0"
  feedback-error:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  feedback-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  status-chip:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# EVENTOUCH design direction

The YAML frontmatter is the design-tool input; `apps/web/app/tokens.css` is the runtime token source. Keep those inputs aligned when token values change.

Use a light, calm operations-service vocabulary with restrained orange accents as a reference. A screen's task, role, current user request, and feedback determine its structure and density; this reference does not prescribe a shared layout for every screen.

Preserve EVENTOUCH's Korean-language identity and customer-approved banners and published attendee styles. Do not flatten event-specific content into shared defaults. Keep keyboard access, focus, readable status, and recovery visible. Check real device behavior with [the device checklist](scripts/device-checklist.md).

Stable interaction and data-safety behavior belongs in [UX-CONTRACT.md](UX-CONTRACT.md); proposal-specific acceptance belongs in [docs/CONTRACT-SCOPE.md](docs/CONTRACT-SCOPE.md).
