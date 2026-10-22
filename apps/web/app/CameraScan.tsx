"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

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
export default function CameraScan({ onDetected, onClose, manualHint = "티켓 코드를 직접 입력하세요." }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [failure, setFailure] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const stopStream = () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
    };
    async function start() {
      const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!media || typeof media.getUserMedia !== "function") {
        setFailure(`이 기기에서 카메라를 사용할 수 없습니다. ${manualHint}`);
        return;
      }
      try {
        stream = await media.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch {
        setFailure(`카메라 권한이 없습니다. ${manualHint}`);
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || stopped) {
        stream.getTracks().forEach((track) => track.stop());
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
      const rendering = canvasNode.getContext("2d", { willReadFrequently: true });
      if (!rendering) {
        stopStream();
        setFailure(`카메라를 시작하지 못했습니다. ${manualHint}`);
        return;
      }
      const context: CanvasRenderingContext2D = rendering;
      // A camera that sees nothing for a while is a real situation (dirty
      // lens, wrong code): point at the manual path instead of waiting.
      const hintTimer = window.setTimeout(() => {
        if (!doneRef.current) setHint(true);
      }, 8000);
      function tick() {
        if (stopped || doneRef.current) return;
        frame = requestAnimationFrame(tick);
        if (!videoNode.videoWidth || !videoNode.videoHeight) return;
        if (canvasNode.width !== videoNode.videoWidth) canvasNode.width = videoNode.videoWidth;
        if (canvasNode.height !== videoNode.videoHeight) canvasNode.height = videoNode.videoHeight;
        context.drawImage(videoNode, 0, 0, canvasNode.width, canvasNode.height);
        const image = context.getImageData(0, 0, canvasNode.width, canvasNode.height);
        const decoded = jsQR(image.data, image.width, image.height);
        if (decoded && decoded.data) {
          doneRef.current = true;
          window.clearTimeout(hintTimer);
          onDetectedRef.current(decoded.data);
        }
      }
      frame = requestAnimationFrame(tick);
    }
    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stopStream();
    };
  }, [manualHint]);

  return (
    <section className="camera-panel" aria-label="카메라 스캔">
      <h2>QR 스캔</h2>
      {failure ? (
        <p role="alert">{failure}</p>
      ) : (
        <video ref={videoRef} playsInline muted aria-label="카메라 미리보기" />
      )}
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      {hint ? <p className="auth-help" role="status">코드를 찾지 못했습니다. 아래에 코드를 직접 입력하세요.</p> : null}
      <button type="button" className="button button-secondary" onClick={onClose}>
        닫기
      </button>
    </section>
  );
}
