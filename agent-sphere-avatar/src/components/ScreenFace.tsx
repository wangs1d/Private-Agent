import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import type { AgentMood } from "../types/agent";

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
}

const CANVAS = 256;

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

  if (mood === "speaking" || mouthOpen > 0.1) {
    const open = Math.min(1, mouthOpen);
    const w = 14 + open * 20;
    const h = 6 + open * 36;
    const lip = accent;

    ctx.strokeStyle = lip;
    ctx.fillStyle = lip;
    ctx.lineWidth = 3 + open * 2;

    ctx.beginPath();
    ctx.ellipse(cx, mouthY - h * 0.08, w + 2, h * 0.35 + 3, 0, Math.PI, 0);
    ctx.stroke();

    ctx.fillStyle = "#120608";
    ctx.beginPath();
    ctx.ellipse(cx, mouthY + h * 0.12, w * 0.88, h * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();

    if (open > 0.35) {
      ctx.fillStyle = "rgba(255, 220, 210, 0.55)";
      ctx.fillRect(cx - w * 0.55, mouthY - h * 0.05, w * 1.1, h * 0.28);
    }

    ctx.strokeStyle = lip;
    ctx.lineWidth = 2.5 + open;
    ctx.beginPath();
    ctx.ellipse(cx, mouthY + h * 0.22, w * 0.95, h * 0.28 + 2, 0, 0, Math.PI);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = mood === "happy" ? "#86efac" : accent;
  ctx.fillStyle = mood === "happy" ? "#86efac" : accent;
  ctx.lineWidth = 3.5;

  if (mood === "happy") {
    ctx.beginPath();
    ctx.arc(cx, mouthY - 10, 20, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.stroke();
  } else if (mood === "alert" || surprise > 0.3) {
    ctx.beginPath();
    ctx.ellipse(cx, mouthY, 12 + surprise * 8, 14 + surprise * 10, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mood === "thinking") {
    ctx.beginPath();
    ctx.moveTo(cx - 16, mouthY + Math.sin(mouthY) * 2);
    ctx.quadraticCurveTo(cx, mouthY - 4, cx + 16, mouthY);
    ctx.stroke();
  } else if (mood === "listening") {
    ctx.beginPath();
    ctx.ellipse(cx, mouthY, 9, 11, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, mouthY - 5, 13, 0.18 * Math.PI, 0.82 * Math.PI);
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
  speakPulse: number,
) {
  ctx.clearRect(0, 0, CANVAS, CANVAS);

  const cx = CANVAS / 2;
  const cy = CANVAS / 2;
  const glow = 0.4 + energy * 0.6 + speakPulse * 0.15;
  const breathe = Math.sin(t * 1.5) * 0.04;

  const bg = ctx.createRadialGradient(cx, cy - 10, 8, cx, cy, CANVAS * 0.48);
  bg.addColorStop(0, `rgba(18, 28, 42, ${0.55 + glow * 0.15})`);
  bg.addColorStop(1, "#030508");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, CANVAS * 0.46, 0, Math.PI * 2);
  ctx.fill();

  const eyeColor =
    mood === "alert" ? "#ffb4b4" : mood === "happy" ? "#a5f3fc" : "#88bbff";
  const accent = eyeColor;
  const eyeY = cy - 20 + lookY * 8 - surprise * 10 + breathe * 8;
  const eyeSpacing = 40 + surprise * 8;
  const baseEyeH = mood === "alert" || surprise > 0.2 ? 24 : mood === "listening" ? 20 : 17;
  const eyeH = (baseEyeH + surprise * 12) * (1 + breathe);
  const eyeW = (mood === "listening" ? 22 : 15) + surprise * 5;
  const blinkPhase = (t * 0.55) % 4.2;
  const blink = blinkPhase > 3.85 ? 0.06 : blinkPhase > 3.75 ? 0.35 : 1;

  const drawEye = (x: number, squash = 1) => {
    ctx.fillStyle = `rgba(136, 187, 255, ${0.12 * glow})`;
    ctx.beginPath();
    ctx.ellipse(x, eyeY, eyeW + 8, eyeH + 10, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = eyeColor;
    ctx.beginPath();
    ctx.ellipse(x, eyeY, eyeW * squash, eyeH * blink, 0, 0, Math.PI * 2);
    ctx.fill();

    const pupilX = x + lookX * 7;
    const pupilY = eyeY + lookY * 5;
    ctx.fillStyle = "#061018";
    ctx.beginPath();
    ctx.ellipse(pupilX, pupilY, eyeW * 0.42, eyeH * 0.48 * blink, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#e8f4ff";
    ctx.beginPath();
    ctx.arc(pupilX - 3 + lookX, pupilY - 4 + lookY * 2, 4, 0, Math.PI * 2);
    ctx.fill();
  };

  drawEye(cx - eyeSpacing);
  drawEye(cx + eyeSpacing, mood === "happy" ? 0.88 : 1);

  if (mood === "happy" || mood === "speaking" || speakPulse > 0.3) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    const browY = eyeY - eyeH - 8;
    const arch = mood === "happy" ? -6 : -3;
    ctx.beginPath();
    ctx.moveTo(cx - eyeSpacing - 14, browY);
    ctx.quadraticCurveTo(cx - eyeSpacing, browY + arch, cx - eyeSpacing + 14, browY + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + eyeSpacing - 14, browY + 2);
    ctx.quadraticCurveTo(cx + eyeSpacing, browY + arch, cx + eyeSpacing + 14, browY);
    ctx.stroke();
  }

  if (mood === "happy" || (mood === "speaking" && energy > 0.45)) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    const arcY = eyeY - 16 - surprise * 4;
    ctx.beginPath();
    ctx.arc(cx - eyeSpacing, arcY, 9, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + eyeSpacing, arcY, 9, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();
  }

  drawMouth(ctx, mood, cx, cy + 38 + surprise * 5, mouthOpen, surprise, accent);

  if (mood === "happy" || speakPulse > 0.5) {
    ctx.fillStyle = `rgba(136, 187, 255, ${0.06 + speakPulse * 0.08})`;
    ctx.beginPath();
    ctx.ellipse(cx - 52, cy + 18, 10, 6, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 52, cy + 18, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 黑色曲屏上的眼睛与嘴巴 — 持续微动，像活物 */
export function ScreenFace({ mood, energy, focused, signalsRef }: ScreenFaceProps) {
  const [gx, gy, gz] = MODEL.glassScreenPosition;
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

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const signals = signalsRef.current;
    const bump = signals?.boundaryBump ?? 0;
    const excitement = signals?.excitement ?? 0;
    const speed = signals?.speed ?? 0;
    const speakPulse = signals?.speakPulse ?? 0;
    const userTouch = signals?.userTouch ?? 0;
    const userSpin = signals?.userSpin ?? 0;

    if (signals) {
      signals.boundaryBump = Math.max(0, bump - 0.035);
      signals.userTouch = Math.max(0, userTouch - 0.04);
      signals.userSpin = Math.max(0, userSpin - 0.03);
    }

    if (t > nextSaccadeAt.current) {
      lookTargetRef.current = {
        x: (Math.random() - 0.5) * (mood === "thinking" ? 0.9 : 0.55),
        y: (Math.random() - 0.5) * 0.45,
      };
      nextSaccadeAt.current = t + (mood === "idle" ? 2.2 : 1.1) + Math.random() * 2;
    }

    const touchLookX = userTouch > 0.15 ? Math.sin(t * 4.2) * userTouch * 0.35 : 0;
    const touchLookY = userTouch > 0.15 ? -userTouch * 0.25 : 0;

    lookRef.current.x = THREE.MathUtils.lerp(
      lookRef.current.x,
      lookTargetRef.current.x + speed * 0.12 + touchLookX,
      0.06 + userTouch * 0.08,
    );
    lookRef.current.y = THREE.MathUtils.lerp(
      lookRef.current.y,
      lookTargetRef.current.y + (mood === "listening" ? 0.12 : 0) + touchLookY,
      0.06 + userTouch * 0.08,
    );

    if (mood === "speaking") {
      const fast = (Math.sin(t * 19) + 1) * 0.5;
      const mid = (Math.sin(t * 8.5 + 1.2) + 1) * 0.5;
      const slow = (Math.sin(t * 3.6) + 1) * 0.5;
      const punch = Math.sin(t * 27) > 0.92 ? 0.45 : 0;
      mouthPhase.current = Math.min(
        1,
        (fast * 0.45 + mid * 0.35 + slow * 0.2 + punch) * (0.6 + energy * 0.55),
      );
      if (signals) signals.speakPulse = mouthPhase.current;
    } else if (mood === "happy" || excitement > 0.25) {
      mouthPhase.current = (Math.sin(t * 11) + 1) * 0.35 * Math.max(excitement, 0.35);
      if (signals) signals.speakPulse = mouthPhase.current * 0.6;
    } else if (mood === "listening") {
      mouthPhase.current = (Math.sin(t * 2.2) + 1) * 0.08;
      if (signals) signals.speakPulse = 0.1;
    } else {
      mouthPhase.current = THREE.MathUtils.lerp(mouthPhase.current, Math.sin(t * 1.8) * 0.04 + 0.04, 0.05);
      if (signals) signals.speakPulse *= 0.92;
    }

    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    drawFace(
      ctx,
      mood,
      t,
      energy,
      mouthPhase.current,
      bump + excitement * 0.35 + userSpin * 0.45 + userTouch * 0.2,
      lookRef.current.x,
      lookRef.current.y,
      speakPulse || mouthPhase.current,
    );
    texture.needsUpdate = true;
  });

  return (
    <mesh position={[gx, gy, gz + 0.008]} renderOrder={2}>
      <circleGeometry args={[0.34, 64]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={focused ? 1 : 0.97}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
