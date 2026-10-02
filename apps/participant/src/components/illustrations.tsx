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
 * Everyday objects, drawn simply: the pictures above the four Edinburgh
 * Handedness questions (write with a pen, throw a ball, hold a toothbrush,
 * hold a spoon), where showing the object is quicker than naming it.
 *
 * One set, one language, so keep any new or redrawn object inside it:
 * - Monochrome line art in currentColor on a 64×64 box. A 3-unit stroke with
 *   round caps and joins; a 2-unit `thin` stroke only for small interior
 *   details; no fills beyond the pencil's small solid lead; no text.
 * - The object alone — never a hand or a person.
 * - Neutral about handedness. Every object stands upright on the centre line
 *   (x = 32), so it sits over "Both equally" just as its container is centred
 *   over the axis (D-32). Nothing leans: a pen drawn diagonally with its tip at
 *   the lower left is how a right-handed writer holds it, which is a nudge on
 *   the very question being asked.
 * - The same optical size: the tall objects share the band y ≈ 5.5–58.5 and
 *   are about 20 units wide, and the ball is about 39 across, so no one
 *   picture looks heavier than the others.
 * - Readable at 32 px as well as at the size the screen shows them.
 */
export function ObjectDrawing({ name }: { name: string }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const thin = { ...stroke, strokeWidth: 2 };
  const wrap = (children: React.ReactNode) => (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );

  switch (name) {
    case "pen":
      // Drawn as a pencil on purpose: eraser, ferrule and a sharpened lead say
      // "writing" at a glance even at 32 px, and it is mirror-symmetric. A
      // ballpoint needs a clip, which pushes it to one side and reads as a
      // marker or syringe when small.
      return wrap(
        <>
          <path d="M24 11 a4 4 0 0 1 4 -4 h8 a4 4 0 0 1 4 4 V42 L32 57 L24 42 Z" {...stroke} />
          <path d="M24 14 H40 M24 20 H40 M24 42 H40" {...stroke} />
          <path
            d="M28.8 50 L32 57 L35.2 50 Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </>,
      );
    case "ball":
      // Tennis-ball seams read as a ball; equator + meridians read as a globe.
      // Each seam is an arc of the ball's own radius that starts and ends on
      // the rim, mirrored left and right.
      return wrap(
        <>
          <circle cx="32" cy="32" r="18" {...stroke} />
          <path d="M20 18.58 A18 18 0 0 1 20 45.42 M44 18.58 A18 18 0 0 0 44 45.42" {...stroke} />
        </>,
      );
    case "toothbrush":
      // Side view: a block of bristles on a slim head, with the rounded tip of
      // the head just above them and a handle that widens into a grip. The
      // bristles are the one detail that sits to a side; which side says
      // nothing about the hand that holds it.
      return wrap(
        <>
          <path
            d="M32 10.75 a3.75 3.75 0 0 1 7.5 0 V32 C39.5 34.5 40.75 35.5 40.75 38 V52 a5 5 0 0 1 -10 0 V38 C30.75 35.5 32 34.5 32 32 Z"
            {...stroke}
          />
          <path d="M32 10.75 H24.5 A1.5 1.5 0 0 0 23 12.25 V25.25 A1.5 1.5 0 0 0 24.5 26.75 H32" {...stroke} />
          <path d="M23 16.1 H32 M23 21.4 H32" {...thin} />
        </>,
      );
    case "spoon":
      // One outline from an egg-shaped bowl through a narrow neck to a handle
      // that flares at the end. An oval on a stick reads as a magnifying glass
      // or a lollipop.
      return wrap(
        <>
          <path
            d="M32 7 C37.3 7, 40.5 11, 40.5 17 C40.5 24, 34.5 26, 34.5 32 C34.5 40, 35.5 46, 35.5 53.5 A3.5 3.5 0 0 1 28.5 53.5 C28.5 46, 29.5 40, 29.5 32 C29.5 26, 23.5 24, 23.5 17 C23.5 11, 26.7 7, 32 7 Z"
            {...stroke}
          />
          <path d="M27.8 17.5 C27.8 14.5, 29.1 12.5, 31 11.7" {...thin} />
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
