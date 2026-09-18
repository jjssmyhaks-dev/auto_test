"use client";

import { useEffect, useRef } from "react";

function noise(x: number, y: number) {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export function PixelField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const styles = getComputedStyle(document.documentElement);
    const palette = ["--pixel-ink", "--pixel-blue", "--pixel-yellow", "--pixel-red", "--pixel-lime"].map((token) =>
      styles.getPropertyValue(token).trim(),
    );

    let frame = 0;
    let animation = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const paint = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);

      const size = Math.max(6, Math.floor(bounds.width / 170));
      const gap = 1;
      const cols = Math.ceil(bounds.width / size);
      const rows = Math.ceil(bounds.height / size);
      const t = frame * 0.006;

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const nx = x / cols;
          const ny = y / rows;
          const sweep = Math.sin(nx * 7.2 - ny * 4.8 + t) * 0.5 + 0.5;
          const grain = noise(x + Math.floor(frame / 24), y);
          const cutout = Math.pow((nx - 0.76) / 0.29, 2) + Math.pow((ny - 0.72) / 0.42, 2);
          const fringe = noise(x * 0.37, y * 0.57);

          if ((ny > 0.68 && cutout < 1 + fringe * 0.35) || (ny > 0.5 && grain > 0.92)) continue;
          if (ny > 0.82 && grain > 0.4) continue;

          let colorIndex = 0;
          if (sweep + grain * 0.52 > 1.05) colorIndex = 1;
          if (sweep + nx * 0.75 + grain * 0.3 > 1.28) colorIndex = 2;
          if (sweep + nx * 0.9 + grain * 0.46 > 1.68) colorIndex = 3;
          if (grain > 0.962) colorIndex = 4;
          context.fillStyle = palette[colorIndex] ?? palette[0] ?? "oklch(0.2 0.07 263)";
          context.fillRect(x * size, y * size, size - gap, size - gap);
        }
      }
    };

    const tick = () => {
      frame += 1;
      paint();
      animation = window.requestAnimationFrame(tick);
    };

    paint();
    if (!reduceMotion) animation = window.requestAnimationFrame(tick);
    window.addEventListener("resize", paint);
    return () => {
      window.removeEventListener("resize", paint);
      window.cancelAnimationFrame(animation);
    };
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
