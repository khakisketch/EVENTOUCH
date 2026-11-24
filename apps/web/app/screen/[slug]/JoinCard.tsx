"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import QRCode from "react-qr-code";
import stageStyles from "./board-stage.module.css";

// The attendee page address the screen asks the room to scan. The configured
// public base (EVENTOUCH_PUBLIC_URL, passed from the server page) wins; without
// it the address this screen is open on is used, the same fallback the console's
// attendee guide QR takes.
export function attendeePageUrl(origin: string, slug: string): string {
  if (!origin) return "";
  try {
    return new URL(`${origin.replace(/\/+$/, "")}/event/${encodeURIComponent(slug)}`).href;
  } catch {
    return "";
  }
}

// A QR that cannot be drawn must never take the scene down with it: the
// boundary renders nothing, so the board shows exactly what it showed before.
class JoinCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function JoinCard({ slug, publicBase = null }: { slug: string; publicBase?: string | null }) {
  const [origin, setOrigin] = useState(publicBase ?? "");
  useEffect(() => {
    setOrigin(publicBase ?? window.location.origin);
  }, [publicBase]);
  const url = attendeePageUrl(origin, slug);
  // Until the address is known there is no card, not an empty one.
  if (!url) return null;
  const shown = url.replace(/^https?:\/\//u, "");
  return (
    <JoinCardBoundary>
      <div className={stageStyles.joinCard} role="group" aria-label="참여 안내">
        <QRCode className={stageStyles.joinQr} value={url} size={256} level="M" title="참가자 페이지 QR" />
        <strong>휴대폰 카메라로<br />스캔해 참여하세요</strong>
        <small>{shown}</small>
      </div>
    </JoinCardBoundary>
  );
}
