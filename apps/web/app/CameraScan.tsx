"use client";

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
export default function CameraScan({ onDetected, onClose, manualHint = "티켓 코드를 직접 입력하세요." }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [failure, setFailure] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    let hidden = false;
    let hintTimer = 0;
    let lastDecode = 0;
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
      } catch {
        setFailure(`카메라 권한이 없습니다. ${manualHint}`);
        return;
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
        stopStream();
        setFailure(`카메라를 시작하지 못했습니다. ${manualHint}`);
        return;
      }
      // Play resolves late: the tab may have hidden or the scanner closed
      // while waiting. Never schedule a loop or a hint timer on a dead
      // surface — release the tracks and leave quietly.
      if (stopped || hidden || doneRef.current) {
        stopStream();
        return;
      }
      const rendering = canvasNode.getContext("2d", { willReadFrequently: true });
      if (!rendering) {
        stopStream();
        setFailure(`카메라를 시작하지 못했습니다. ${manualHint}`);
        return;
      }
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
    // of burning battery on a preview nobody sees. Reopening the scanner
    // (not the tab) restarts it.
    function onVisibility() {
      if (document.hidden) {
        hidden = true;
        stopLoop();
        stopStream();
        setPaused(true);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      stopLoop();
      stopStream();
      window.clearTimeout(hintTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [manualHint]);

  return (
    <section className="camera-panel" aria-label="카메라 스캔">
      <h2>QR 스캔</h2>
      {failure ? (
        <p role="alert">{failure}</p>
      ) : paused ? null : (
        <video ref={videoRef} playsInline muted aria-label="카메라 미리보기" />
      )}
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      {hint && !paused ? <p className="auth-help" role="status">코드를 찾지 못했습니다. 아래에 코드를 직접 입력하세요.</p> : null}
      {paused ? <p className="auth-help" role="status">화면이 가려져 카메라를 멈췄습니다. 다시 스캔하려면 닫았다가 여세요.</p> : null}
      <button type="button" className="button button-secondary" onClick={onClose}>
        닫기
      </button>
    </section>
  );
}
