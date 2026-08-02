import type React from "react";

/**
 * MySelf-authored illustrations.
 *
 * Drawn as inline SVG so they scale crisply, work offline with no asset
 * fetch, and carry no third-party image dependency or licence question.
 * Purely presentational: every illustration is paired with its authoritative
 * text label and marked aria-hidden.
 */

/** Curl pattern for a hair-type code (1a straight … 4c tightly coiled). */
export function HairPattern({ code }: { code: string }) {
  const family = Number(code[0] ?? 1); // 1 straight, 2 wavy, 3 curly, 4 coily
  const sub = code[1] ?? "a"; // a < b < c: increasing definition/tightness
  const subIndex = sub === "a" ? 0 : sub === "b" ? 1 : 2;

  const height = 64;
  const strands = [16, 32, 48];

  const path = (x: number): string => {
    if (family === 1) {
      // Straight: a faint drift only, so the three sub-types stay distinct.
      const drift = subIndex * 1.6;
      return `M ${x} 5 C ${x + drift} 22, ${x - drift} 44, ${x} 59`;
    }
    if (family === 2) {
      // Waves: long, open S-curves. Amplitude grows a → c.
      const amp = 3.5 + subIndex * 1.8;
      const wl = 22 - subIndex * 3; // wavelength shortens slightly
      let d = `M ${x} 5`;
      let dir = 1;
      for (let y = 5; y < 59; y += wl) {
        d += ` Q ${x + amp * dir} ${y + wl / 2}, ${x} ${Math.min(59, y + wl)}`;
        dir *= -1;
      }
      return d;
    }
    if (family === 3) {
      // Curls: closed loops down the strand — visibly rounder than waves.
      const r = 5.5 - subIndex * 0.9; // loop radius tightens a → c
      const step = r * 2;
      let d = `M ${x} 5`;
      for (let y = 5; y < 59 - step; y += step) {
        // full loop: out, around, back to the strand
        d += ` C ${x + r * 2.4} ${y}, ${x + r * 2.4} ${y + step}, ${x} ${y + step}`;
        d += ` C ${x - r * 2.4} ${y + step}, ${x - r * 2.4} ${y + step * 2}, ${x} ${y + step * 2}`;
        y += step;
      }
      return d;
    }
    // Coils: very tight. 4b is an angular zig-zag, 4a/4c are tiny loops.
    const amp = 4.6 - subIndex * 0.9;
    const step = 5.2 - subIndex * 1.2;
    let d = `M ${x} 5`;
    let dir = 1;
    for (let y = 5; y < 59; y += step) {
      const yy = Math.min(59, y + step);
      d += sub === "b" ? ` L ${x + amp * dir} ${yy}` : ` Q ${x + amp * dir * 1.5} ${y + step / 2}, ${x} ${yy}`;
      dir *= -1;
    }
    return d;
  };

  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
      {strands.map((x) => (
        <path
          key={x}
          d={path(x)}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/**
 * Everyday objects, drawn simply. Used where naming the object in words is
 * less immediate than showing it (handedness: "Writing" + a pen).
 */
export function ObjectDrawing({ name }: { name: string }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const wrap = (children: React.ReactNode) => (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );

  switch (name) {
    case "pen":
      return wrap(
        <>
          <path d="M14 50 L18 40 L44 14 L50 20 L24 46 Z" {...stroke} />
          <path d="M40 18 L46 24" {...stroke} />
          <path d="M14 50 L20 48" {...stroke} />
        </>,
      );
    case "ball":
      // Tennis-ball seams read as a ball; equator + meridians read as a globe.
      return wrap(
        <>
          <circle cx="32" cy="32" r="18" {...stroke} />
          <path d="M17 22 C 26 30, 26 40, 19 46" {...stroke} />
          <path d="M47 22 C 38 30, 38 40, 45 46" {...stroke} />
        </>,
      );
    case "toothbrush":
      return wrap(
        <>
          <path d="M20 50 L38 22" {...stroke} />
          <path d="M36 20 q 6 -8 12 -4 q 4 4 -2 10 Z" {...stroke} />
          <path d="M38 12 v -5 M44 15 v -5 M49 20 v -5" {...stroke} />
        </>,
      );
    case "spoon":
      return wrap(
        <>
          <path d="M26 52 L36 32" {...stroke} />
          <ellipse cx="40" cy="22" rx="9" ry="12" transform="rotate(24 40 22)" {...stroke} />
        </>,
      );
    default:
      return null;
  }
}

export function Illustration({ token }: { token: string }) {
  if (token.startsWith("hair:")) return <HairPattern code={token.slice(5)} />;
  if (token.startsWith("object:")) return <ObjectDrawing name={token.slice(7)} />;
  return null;
}
