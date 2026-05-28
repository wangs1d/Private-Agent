import { useMemo } from "react";
import * as THREE from "three";
import type { AgentMood } from "../types/agent";

const CANVAS_SIZE = 512;

function drawEye(
  ctx: CanvasRenderingContext2D,
  mood: AgentMood,
  t: number,
  focused: boolean,
) {
  const w = CANVAS_SIZE;
  const h = CANVAS_SIZE;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const glow = focused ? 0.35 : 0.12;

  const gradient = ctx.createRadialGradient(cx, cy, 20, cx, cy, w * 0.48);
  gradient.addColorStop(0, `rgba(${40 + glow * 80},${180 + glow * 40},255,${0.08 + glow})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(120,200,255,0.8)";
  ctx.shadowBlur = focused ? 28 : 12;

  switch (mood) {
    case "listening": {
      const pulse = 0.85 + Math.sin(t * 4) * 0.08;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, 90 * pulse, 0.35 * Math.PI, 0.65 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - 18, 14 + Math.sin(t * 6) * 4, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "thinking": {
      ctx.lineWidth = 5;
      for (let i = 0; i < 3; i++) {
        const phase = (t * 2 + i * 0.6) % 3;
        const alpha = phase < 1 ? phase : 2 - phase;
        ctx.globalAlpha = 0.25 + alpha * 0.75;
        ctx.beginPath();
        ctx.arc(cx - 48 + i * 48, cy + 8, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "speaking": {
      ctx.lineWidth = 5;
      const bars = 7;
      for (let i = 0; i < bars; i++) {
        const amp = 18 + Math.abs(Math.sin(t * 8 + i)) * 42;
        ctx.beginPath();
        ctx.moveTo(cx - 72 + i * 24, cy + amp / 2);
        ctx.lineTo(cx - 72 + i * 24, cy - amp / 2);
        ctx.stroke();
      }
      break;
    }
    case "happy": {
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(cx, cy + 10, 95, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - 42, cy - 28, 8, 0, Math.PI * 2);
      ctx.arc(cx + 42, cy - 28, 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      break;
    }
    case "alert": {
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy + 20, 70, 1.15 * Math.PI, 1.85 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 50, cy - 40);
      ctx.lineTo(cx, cy - 70);
      ctx.lineTo(cx + 50, cy - 40);
      ctx.stroke();
      break;
    }
    default: {
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy + 6, 88, 0.22 * Math.PI, 0.78 * Math.PI);
      ctx.stroke();
      break;
    }
  }
}

export function useEyeTexture(mood: AgentMood, focused: boolean) {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = CANVAS_SIZE;
    c.height = CANVAS_SIZE;
    return c;
  }, []);

  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, [canvas]);

  const update = (t: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawEye(ctx, mood, t, focused);
    texture.needsUpdate = true;
  };

  return { texture, update };
}
