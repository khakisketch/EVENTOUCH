"use client";

import ProductButton from "./ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import {
  DECODE_INTERVAL_MS,
  MAX_DECODE_HEIGHT,
  MAX_DECODE_WIDTH,
  decodeFrameSize,
  isCameraApiAvailable,
  shouldAttemptDecode,
} from "./scan-frame";

type Props = {
  onDetected: (code: string) => void;
  onClose: () => void;
  focusOrigin?: HTMLButtonElement | null;
  onUseManual?: () => void;
  // Fallback copy differs per desk: staff scan tickets, participants scan
  // booth codes. Both keep the same decode-only rule.
  manualHint?: string;
};

// Camera QR scanning for staff check-in and participant booth stamping. The
// decoded string is handed to the caller, which submits it through the same
// server-checked path as a typed code: the camera never decides anything.
// Requires a secure context (localhost or HTTPS); without a camera or
// permission the caller keeps the manual entry form, so a broken lens never
// blocks the work.
//
// Cost discipline: the jsQR decoder is imported only when a scan actually
// starts (never in the route bundle), the camera is capped at 640x480, and
// decoding runs at most ~5 times a second on a downscaled frame
// (see scan-frame.ts, executed by the contract test).
export default function CameraScan({ onDetected, onClose, focusOrigin, onUseManual, manualHint = "티켓 코드를 직접 입력하세요." }: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [failure, setFailure] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [starting, setStarting] = useState(true);
  const [startupSlow, setStartupSlow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!focusOrigin || document.hidden || document.activeElement !== focusOrigin) return;
    panelRef.current?.focus({ preventScroll: true });
    panelRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [focusOrigin]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    let hidden = false;
    let hintTimer = 0;
    let lastDecode = 0;
    const startupTimer = window.setTimeout(() => {
      if (!stopped && !hidden && !doneRef.current) setStartupSlow(true);
    }, 6000);
    const stopStartupTimer = () => window.clearTimeout(startupTimer);
    const stopStream = () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
    };
    const stopLoop = () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    async function start() {
      const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!isCameraApiAvailable(media)) {
        stopStartupTimer();
        setStarting(false);
        setFailure(`이 기기에서 카메라를 사용할 수 없습니다. ${manualHint}`);
        return;
      }
      let decode: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
      try {
        // Decoder loads with the scan, not with the route: opening the
        // camera is the first moment its bytes are needed.
        const decoder: unknown = await import("jsqr");
        if (stopped || doneRef.current) return;
        const candidate: unknown =
          (decoder as { default?: unknown } | null)?.default ?? decoder;
        if (typeof candidate === "function") {
          decode = candidate as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
        } else if (
          candidate !== null &&
          typeof candidate === "object" &&
          typeof (candidate as { jsQR?: unknown }).jsQR === "function"
        ) {
          decode = (candidate as {
            jsQR: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
          }).jsQR;
        } else {
          throw new Error("decoder unavailable");
        }
      } catch {
        stopStartupTimer();
        if (stopped || hidden) return;
        setStarting(false);
        setFailure(`스캐너를 불러오지 못했습니다. ${manualHint}`);
        return;
      }
      try {
        stream = await media.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: MAX_DECODE_WIDTH },
            height: { ideal: MAX_DECODE_HEIGHT },
          },
          audio: false,
        });
      } catch (error) {
        stopStartupTimer();
        if (stopped || hidden) return;
        setStarting(false);
        const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        const reason = name === "NotAllowedError" || name === "SecurityError"
          ? "카메라 권한이 없습니다. 브라우저 설정에서 카메라를 허용하세요."
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "사용할 수 있는 카메라를 찾지 못했습니다."
            : name === "NotReadableError" || name === "TrackStartError"
              ? "카메라를 열 수 없습니다. 다른 앱이 사용 중인지 확인하세요."
              : "카메라를 시작하지 못했습니다.";
        setFailure(`${reason} ${manualHint}`);
        return;
      }
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (stopped || hidden || doneRef.current) return;
          stopLoop();
          stopStream();
          setFailure(`카메라 연결이 중단됐습니다. 다시 시도하거나 ${manualHint}`);
        }, { once: true });
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || stopped || hidden) {
        stopStream();
        return;
      }
      const videoNode: HTMLVideoElement = video;
      const canvasNode: HTMLCanvasElement = canvas;
      videoNode.srcObject = stream;
      try {
        await videoNode.play();
      } catch {
        stopStartupTimer();
        stopStream();
        if (stopped || hidden) return;
        setStarting(false);
        setFailure(`카메라를 시작하지 못했습니다. ${manualHint}`);
        return;
      }
      // Play resolves late: the tab may have hidden or the scanner closed
      // while waiting. Never schedule a loop or a hint timer on a dead
      // surface — release the tracks and leave quietly.
      if (stopped || hidden || doneRef.current) {
        stopStream();
        stopStartupTimer();
        return;
      }
      const rendering = canvasNode.getContext("2d", { willReadFrequently: true });
      if (!rendering) {
        stopStartupTimer();
        stopStream();
        setStarting(false);
        setFailure(`카메라를 시작하지 못했습니다. ${manualHint}`);
        return;
      }
      stopStartupTimer();
      setStarting(false);
      const context: CanvasRenderingContext2D = rendering;
      // A camera that sees nothing for a while is a real situation (dirty
      // lens, wrong code): point at the manual path instead of waiting.
      hintTimer = window.setTimeout(() => {
        if (!doneRef.current) setHint(true);
      }, 8000);
      function tick() {
        if (stopped || doneRef.current || hidden) return;
        frame = requestAnimationFrame(tick);
        if (!videoNode.videoWidth || !videoNode.videoHeight) return;
        const now = Date.now();
        // Throttled decode: the preview runs at display rate but the
        // decoder only sees a downscaled frame ~5 times a second.
        if (!shouldAttemptDecode(now, lastDecode, DECODE_INTERVAL_MS)) return;
        lastDecode = now;
        const { width, height } = decodeFrameSize(videoNode.videoWidth, videoNode.videoHeight);
        if (canvasNode.width !== width) canvasNode.width = width;
        if (canvasNode.height !== height) canvasNode.height = height;
        context.drawImage(videoNode, 0, 0, width, height);
        let image: ImageData;
        try {
          image = context.getImageData(0, 0, width, height);
        } catch {
          return;
        }
        const decoded = decode(image.data, image.width, image.height);
        if (decoded && decoded.data) {
          doneRef.current = true;
          window.clearTimeout(hintTimer);
          // Release the camera here, not on unmount: the caller submits the
          // code through the server path and may stay mounted on a slow
          // network. The preview must not keep running behind that.
          stopLoop();
          stopStream();
          onDetectedRef.current(decoded.data);
        }
      }
      frame = requestAnimationFrame(tick);
    }
    // A hidden tab keeps no camera: stop tracks and the decode loop instead
    // of burning battery on a preview nobody sees. An explicit retry starts
    // a new stream after the user returns.
    function onVisibility() {
      if (document.hidden) {
        hidden = true;
        stopStartupTimer();
        stopLoop();
        stopStream();
        setPaused(true);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) onVisibility();
    else void start();
    return () => {
      stopLoop();
      stopStream();
      stopStartupTimer();
      window.clearTimeout(hintTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [manualHint, attempt]);

  return (
    <section ref={panelRef} className="camera-panel" aria-label="카메라 스캔" tabIndex={-1}>
      <h2>QR 스캔</h2>
      {failure ? (
        <p role="alert">{failure}</p>
      ) : paused ? null : (
        <video ref={videoRef} playsInline muted aria-label="카메라 미리보기" />
      )}
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      {!failure && !paused && starting ? <p className="auth-help" role="status">{startupSlow ? `카메라 시작이 늦어지고 있습니다. 브라우저 권한 요청을 확인하거나 ${manualHint}` : "카메라를 준비하고 있습니다. 브라우저에 권한 요청이 표시되면 허용해 주세요."}</p> : null}
      {hint && !paused && !failure ? <p className="auth-help" role="status">QR 코드를 찾지 못했습니다. {manualHint}</p> : null}
      {paused ? <p className="auth-help" role="status">화면이 가려져 카메라를 멈췄습니다. 다시 시도해 스캔을 계속하세요.</p> : null}
      {failure || paused ? <ProductButton type="button" className="button button-primary" onClick={() => {
        doneRef.current = false;
        setFailure(null);
        setPaused(false);
        setHint(false);
        setStarting(true);
        setStartupSlow(false);
        setAttempt((value) => value + 1);
        panelRef.current?.focus({ preventScroll: true });
      }}>다시 시도</ProductButton> : null}
      {onUseManual ? <ProductButton type="button" className="button button-secondary" onClick={onUseManual}>명단에서 참가자 찾기</ProductButton> : null}
      <ProductButton type="button" className="button button-secondary" onClick={() => {
        onClose();
        window.requestAnimationFrame(() => {
          if (focusOrigin?.isConnected && !focusOrigin.disabled && document.activeElement === document.body) focusOrigin.focus();
        });
      }}>
        닫기
      </ProductButton>
    </section>
  );
}
