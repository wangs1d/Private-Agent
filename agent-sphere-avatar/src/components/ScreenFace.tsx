import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { OledFaceTextureContext } from "../context/oled-face-context";
import type { AgentMood } from "../types/agent";
import { OledScreenMesh } from "./OledScreenMesh";

export interface FaceSignals {
  boundaryBump: number;
  excitement: number;
  speed: number;
  speakPulse: number;
  /** 用户正在触摸/拖拽身体 */
  userTouch: number;
  /** 用户旋转强度 */
  userSpin: number;
}

interface ScreenFaceProps {
  mood: AgentMood;
  energy: number;
  focused: boolean;
  signalsRef: React.RefObject<FaceSignals>;
  children?: ReactNode;
}

const CANVAS = 256;
const FACE_SAFE_SCALE = 0.84;
const EDGE_EYE_COMPENSATION = 0.13;

function isCalmMood(mood: AgentMood): boolean {
  return mood === "idle" || mood === "thinking";
}

function drawMouth(
  ctx: CanvasRenderingContext2D,
  mood: AgentMood,
  cx: number,
  mouthY: number,
  mouthOpen: number,
  surprise: number,
  accent: string,
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (mood === "happy" || mouthOpen > 0.1) {
    const open = Math.min(1, mouthOpen);
    const w = 12 + open * 15;
    const h = 5 + open * 24;
    const lip = accent;

    ctx.strokeStyle = lip;
    ctx.fillStyle = lip;
    ctx.lineWidth = 2.5 + open * 1.5;

    ctx.beginPath();
    ctx.ellipse(cx, mouthY - h * 0.06, w + 1, h * 0.28 + 2, 0, Math.PI, 0);
    ctx.stroke();

    ctx.fillStyle = "#120608";
    ctx.beginPath();
    ctx.ellipse(cx, mouthY + h * 0.1, w * 0.82, h * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    if (open > 0.42) {
      ctx.fillStyle = "rgba(255, 220, 210, 0.55)";
      ctx.fillRect(cx - w * 0.45, mouthY - h * 0.02, w * 0.9, h * 0.2);
    }

    ctx.strokeStyle = lip;
    ctx.lineWidth = 2 + open * 0.9;
    ctx.beginPath();
    ctx.ellipse(cx, mouthY + h * 0.18, w * 0.88, h * 0.2 + 1.5, 0, 0, Math.PI);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 3;

  if (mood === "alert" || surprise > 0.3) {
    ctx.beginPath();
    ctx.ellipse(cx, mouthY, 9 + surprise * 5, 11 + surprise * 7, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mood === "thinking") {
    ctx.beginPath();
    ctx.moveTo(cx - 13, mouthY + Math.sin(mouthY) * 1.5);
    ctx.quadraticCurveTo(cx, mouthY - 3, cx + 13, mouthY);
    ctx.stroke();
  } else if (mood === "listening") {
    ctx.beginPath();
    ctx.ellipse(cx, mouthY, 7, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, mouthY - 4, 10, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  mood: AgentMood,
  t: number,
  energy: number,
  mouthOpen: number,
  surprise: number,
  lookX: number,
  lookY: number,
) {
  ctx.clearRect(0, 0, CANVAS, CANVAS);
  // 不透明 OLED 底 — 避免 transparent 材质 + clearRect 导致整屏不可见
  ctx.fillStyle = "#030508";
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  const cx = CANVAS / 2;
  const cy = CANVAS / 2;
  const safe = FACE_SAFE_SCALE;
  const calm = isCalmMood(mood);
  const glow = 0.4 + energy * 0.6;
  const breathe = calm ? 0 : Math.sin(t * 1.5) * 0.012;

  const bg = ctx.createRadialGradient(cx, cy - 10, 8, cx, cy, CANVAS * 0.48);
  bg.addColorStop(0, `rgba(18, 28, 42, ${0.55 + glow * 0.15})`);
  bg.addColorStop(1, "#030508");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, CANVAS * 0.46, 0, Math.PI * 2);
  ctx.fill();

  // 曲屏边缘暗角 — 与玻璃 bezel 融合
  const bezel = ctx.createRadialGradient(cx, cy, CANVAS * 0.28, cx, cy, CANVAS * 0.5);
  bezel.addColorStop(0, "rgba(0, 0, 0, 0)");
  bezel.addColorStop(0.64, "rgba(0, 0, 0, 0.42)");
  bezel.addColorStop(1, "rgba(0, 0, 0, 0.92)");
  ctx.fillStyle = bezel;
  ctx.beginPath();
  ctx.arc(cx, cy, CANVAS * 0.5, 0, Math.PI * 2);
  ctx.fill();

  const eyeColor =
    mood === "alert" ? "#ffb4b4" : mood === "happy" ? "#a5f3fc" : "#88bbff";
  const accent = eyeColor;
  const eyeY = cy - 16 * safe + lookY * 7 - surprise * 8 + breathe * 7;
  const eyeSpacing = (32 + surprise * 4) * safe;
  const curveComp = eyeSpacing * EDGE_EYE_COMPENSATION;
  const baseEyeH = mood === "alert" || surprise > 0.2 ? 19 : mood === "listening" ? 17 : 14;
  const eyeH = (baseEyeH + surprise * 7) * (1 + breathe * 0.8) * safe;
  const eyeW = ((mood === "listening" ? 18 : 12) + surprise * 3) * safe;
  const blinkCycle = calm ? 7.5 : 4.2;
  const blinkPhase = (t * (calm ? 0.32 : 0.55)) % blinkCycle;
  const blinkClose = blinkCycle - (calm ? 0.28 : 0.35);
  const blinkStart = blinkClose - 0.1;
  const blink = blinkPhase > blinkClose ? 0.06 : blinkPhase > blinkStart ? 0.35 : 1;

  const drawEye = (x: number, edgeSign: -1 | 1, squash = 1) => {
    const eyeCx = x - edgeSign * curveComp;
    const outerSqueeze = 1 - Math.abs(edgeSign) * 0.08;
    ctx.fillStyle = `rgba(136, 187, 255, ${0.12 * glow})`;
    ctx.beginPath();
    ctx.ellipse(eyeCx, eyeY, eyeW + 6, eyeH + 7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = eyeColor;
    ctx.beginPath();
    ctx.ellipse(eyeCx, eyeY, eyeW * squash * outerSqueeze, eyeH * blink, 0, 0, Math.PI * 2);
    ctx.fill();

    const pupilX = eyeCx + lookX * 5 - edgeSign * curveComp * 0.18;
    const pupilY = eyeY + lookY * 4;
    ctx.fillStyle = "#061018";
    ctx.beginPath();
    ctx.ellipse(pupilX, pupilY, eyeW * 0.34, eyeH * 0.42 * blink, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#e8f4ff";
    ctx.beginPath();
    ctx.arc(pupilX - 2 + lookX, pupilY - 3 + lookY * 1.5, 3, 0, Math.PI * 2);
    ctx.fill();
  };

  drawEye(cx - eyeSpacing, -1);
  drawEye(cx + eyeSpacing, 1, mood === "happy" ? 0.9 : 1);

  drawMouth(ctx, mood, cx, cy + 30 * safe + surprise * 3, mouthOpen * 0.82, surprise, accent);
}

/**
 * 黑色曲屏 OLED：Canvas 画眼/嘴，纹理贴到 DG2 玻璃网格（真实曲面，非前置圆盘）。
 */
export function ScreenFace({ mood, energy, signalsRef, children }: ScreenFaceProps) {
  const canvasRef = useRef(document.createElement("canvas"));
  const lookRef = useRef({ x: 0, y: 0 });
  const lookTargetRef = useRef({ x: 0, y: 0 });
  const mouthPhase = useRef(0);
  const nextSaccadeAt = useRef(0);

  const texture = useMemo(() => {
    const c = canvasRef.current;
    c.width = CANVAS;
    c.height = CANVAS;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(() => () => texture.dispose(), [texture]);

  const redrawFace = (t: number) => {
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    const signals = signalsRef.current;
    const bump = signals?.boundaryBump ?? 0;
    const excitement = signals?.excitement ?? 0;
    const userSpin = signals?.userSpin ?? 0;
    const userTouch = signals?.userTouch ?? 0;
    const calm = isCalmMood(mood);
    drawFace(
      ctx,
      mood,
      t,
      energy,
      mouthPhase.current,
      bump * (calm ? 0.4 : 1) + excitement * (calm ? 0.08 : 0.2) + userSpin * 0.45 + userTouch * 0.2,
      lookRef.current.x,
      lookRef.current.y,
    );
    texture.needsUpdate = true;
  };

  useLayoutEffect(() => {
    redrawFace(0);
  }, [mood, energy, texture]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const signals = signalsRef.current;
    const bump = signals?.boundaryBump ?? 0;
    const speed = signals?.speed ?? 0;
    const userTouch = signals?.userTouch ?? 0;
    const userSpin = signals?.userSpin ?? 0;

    if (signals) {
      signals.boundaryBump = Math.max(0, bump - 0.035);
      signals.userTouch = Math.max(0, userTouch - 0.04);
      signals.userSpin = Math.max(0, userSpin - 0.03);
    }

    const calm = isCalmMood(mood);

    if (t > nextSaccadeAt.current) {
      const roam = calm ? 0.18 : mood === "thinking" ? 0.55 : 0.4;
      lookTargetRef.current = {
        x: (Math.random() - 0.5) * roam,
        y: (Math.random() - 0.5) * (calm ? 0.12 : 0.35),
      };
      nextSaccadeAt.current =
        t + (calm ? 9 : mood === "idle" ? 4 : 2.2) + Math.random() * (calm ? 8 : 3);
    }

    const touchLookX = userTouch > 0.15 ? Math.sin(t * 4.2) * userTouch * 0.35 : 0;
    const touchLookY = userTouch > 0.15 ? -userTouch * 0.25 : 0;
    const lookLerp = calm ? 0.025 : 0.06;

    lookRef.current.x = THREE.MathUtils.lerp(
      lookRef.current.x,
      lookTargetRef.current.x + (calm ? 0 : speed * 0.12) + touchLookX,
      lookLerp + userTouch * 0.08,
    );
    lookRef.current.y = THREE.MathUtils.lerp(
      lookRef.current.y,
      lookTargetRef.current.y + (mood === "listening" ? 0.1 : 0) + touchLookY,
      lookLerp + userTouch * 0.08,
    );

    if (mood === "happy") {
      const fast = (Math.sin(t * 19) + 1) * 0.5;
      const mid = (Math.sin(t * 8.5 + 1.2) + 1) * 0.5;
      const slow = (Math.sin(t * 3.6) + 1) * 0.5;
      const punch = Math.sin(t * 27) > 0.92 ? 0.45 : 0;
      mouthPhase.current = Math.min(
        1,
        (fast * 0.45 + mid * 0.35 + slow * 0.2 + punch) * (0.6 + energy * 0.55),
      );
      if (signals) signals.speakPulse = mouthPhase.current;
    } else {
      mouthPhase.current = THREE.MathUtils.lerp(mouthPhase.current, 0, calm ? 0.18 : 0.12);
      if (signals) signals.speakPulse = 0;
    }

    redrawFace(t);
  });

  return (
    <>
      <OledScreenMesh map={texture} />
      <OledFaceTextureContext.Provider value={texture}>{children}</OledFaceTextureContext.Provider>
    </>
  );
}
