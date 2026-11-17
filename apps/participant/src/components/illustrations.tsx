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

/**
 * How the hair is worn today (D-99): one picture per style, drawn from behind
 * so no face, skin or body is shown, only the head's outline and the hair.
 * The same language as the objects: monochrome line art in currentColor on a
 * 64×64 box, round caps, a 3-unit outline and thinner strokes for the hair's
 * detail. What tells two styles apart is drawn large enough to read at the
 * tile's 62 px: thick cornrows are three wide rows, thin cornrows six narrow
 * ones; braids hang below the head as plaits, twists as ropes, locs as solid
 * cords; a weave shows its sewn tracks, extensions their clips, and a wig sits
 * on a stand.
 */
export function HairstyleDrawing({ name }: { name: string }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const thin = { ...stroke, strokeWidth: 1.8 };
  const wrap = (children: React.ReactNode) => (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
  // The head from behind, and the neck and shoulders below it.
  const head = <ellipse cx="32" cy="25" rx="14" ry="16" {...stroke} />;
  const neck = <path d="M27 40 V48 M37 40 V48 M10 62 C11 54 19 50 27 48 M54 62 C53 54 45 50 37 48" {...stroke} />;
  const sideShoulders = <path d="M6 62 C7 57 11 54 16 53 M58 62 C57 57 53 54 48 53" {...stroke} />;
  /** How far the head reaches above and below its centre at a given x. */
  const halfHeight = (x: number) => 16 * Math.sqrt(Math.max(0, 1 - ((x - 32) / 14) ** 2));
  /** A plait: stacked chevrons down a line, as a braid is drawn. */
  const plait = (x: number, from: number, to: number, w: number, step: number) => {
    let d = "";
    for (let y = from; y + step * 0.7 <= to; y += step) d += `M${x - w} ${y} L${x} ${y + step * 0.7} L${x + w} ${y} `;
    return d;
  };
  /** Rows braided flat to the scalp, front to back. */
  const rows = (xs: number[], w: number, step: number, width: number) => (
    <>
      {head}
      {neck}
      {xs.map((x) => {
        const h = halfHeight(x);
        return <path key={x} d={plait(x, 25 - h + 3.5, 25 + h - 2.5, w, step)} {...thin} strokeWidth={width} />;
      })}
    </>
  );
  const hanging = [19, 25.5, 32, 38.5, 45];

  switch (name) {
    case "loose":
      return wrap(
        <>
          <path
            d="M18 24 C18 14 24 8 32 8 C40 8 46 14 46 24 C46 34 48 44 51 52 C45 54 38 54 32 54 C26 54 19 54 13 52 C16 44 18 34 18 24 Z"
            {...stroke}
          />
          <path d="M32 13 V49 M26 13 C24 26 22 38 20 49 M38 13 C40 26 42 38 44 49" {...thin} />
          <path d="M6 62 C7 58 10 55 14 53 M58 62 C57 58 54 55 50 53" {...stroke} />
        </>,
      );
    case "tied":
      return wrap(
        <>
          {head}
          {neck}
          <circle cx="32" cy="16" r="6" {...stroke} />
          <circle cx="32" cy="16" r="2.4" {...thin} />
          <path d="M21 33 C25 29 28 25 28.5 21.5 M43 33 C39 29 36 25 35.5 21.5 M32 39 V22.5" {...thin} />
        </>,
      );
    case "cornrows_thick":
      return wrap(rows([24, 32, 40], 2.6, 6, 2.4));
    case "cornrows_thin":
      return wrap(rows([21.5, 25.7, 29.9, 34.1, 38.3, 42.5], 1.3, 2.8, 1.3));
    case "braids":
      return wrap(
        <>
          {head}
          {sideShoulders}
          {hanging.map((x) => (
            <path key={x} d={plait(x, 17, 61, 1.7, 4)} {...thin} strokeWidth={1.6} />
          ))}
        </>,
      );
    case "twists":
      return wrap(
        <>
          {head}
          {sideShoulders}
          {hanging.map((x) => {
            let a = `M${x} 17`;
            let b = `M${x} 17`;
            for (let y = 17; y < 58; y += 5) {
              a += ` Q${x + 3} ${y + 2.5} ${x} ${y + 5}`;
              b += ` Q${x - 3} ${y + 2.5} ${x} ${y + 5}`;
            }
            return <path key={x} d={`${a} ${b}`} {...thin} strokeWidth={1.5} />;
          })}
        </>,
      );
    case "locs":
      return wrap(
        <>
          {head}
          {sideShoulders}
          {hanging.map((x, i) => (
            <path key={x} d={`M${x} 17 C${x + (i % 2 ? 1.5 : -1.5)} 32 ${x + (i % 2 ? -1.5 : 1.5)} 46 ${x} 60`} {...stroke} strokeWidth={4.2} />
          ))}
        </>,
      );
    case "weave": {
      // Three wefts sewn across the back of the head, each with its stitches.
      const tracks = [18, 26, 34];
      const stitches = tracks.flatMap((y0) =>
        [24, 28, 32, 36, 40].map((x) => {
          const t = (x - 20) / 24;
          const y = y0 + 10 * t * (1 - t);
          return `M${x} ${y - 1.8} V${y + 1.8}`;
        }),
      );
      return wrap(
        <>
          {head}
          {sideShoulders}
          <path d={tracks.map((y) => `M20 ${y} Q32 ${y + 10} 44 ${y}`).join(" ")} {...thin} strokeWidth={2.2} />
          <path d={stitches.join(" ")} {...thin} strokeWidth={1.4} />
          <path d="M21 36 C20 44 19 52 18 60 M27 40 C26.5 47 26 54 25.5 60 M37 40 C37.5 47 38 54 38.5 60 M43 36 C44 44 45 52 46 60" {...thin} />
        </>,
      );
    }
    case "extensions":
      // Clips across the back of the head, each holding a long weft of hair.
      return wrap(
        <>
          {head}
          {sideShoulders}
          {[23, 32, 41].map((x) => (
            <g key={x}>
              <rect x={x - 3.5} y={30.5} width={7} height={3.2} rx={1.2} {...thin} strokeWidth={2} />
              <path d={`M${x - 2.2} 34 C${x - 2.6} 44 ${x - 3} 52 ${x - 3.4} 61 M${x} 34 V61 M${x + 2.2} 34 C${x + 2.6} 44 ${x + 3} 52 ${x + 3.4} 61`} {...thin} strokeWidth={1.4} />
            </g>
          ))}
        </>,
      );
    case "wig":
      // A wig on a stand, from the front: the hair, the stand's face opening, and its pole.
      return wrap(
        <>
          <path d="M19 44 C14 35 15 23 20 16 C24 11 28 9 32 9 C36 9 40 11 44 16 C49 23 50 35 45 44" {...stroke} />
          <path d="M24 41 C22 33 23 25 28 21 C30 22.5 34 22.5 36 21 C41 25 42 33 40 41" {...thin} />
          <path d="M24 41 C27 45 37 45 40 41" {...thin} strokeDasharray="2 2.6" />
          <path d="M32 45 V57 M22 59 H42" {...stroke} />
        </>,
      );
    case "short": {
      // Close-cropped: the head's outline with a fine stubble across it.
      const dots: [number, number][] = [];
      for (let x = 22; x <= 42; x += 4)
        for (let y = 13; y <= 37; y += 4) if (Math.abs(y - 25) < halfHeight(x) * 0.8) dots.push([x, y]);
      return wrap(
        <>
          {head}
          {neck}
          {dots.map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r={0.9} fill="currentColor" />
          ))}
        </>,
      );
    }
    default:
      return null;
  }
}

export function Illustration({ token }: { token: string }) {
  if (token.startsWith("hair:")) return <HairPattern code={token.slice(5)} />;
  if (token.startsWith("object:")) return <ObjectDrawing name={token.slice(7)} />;
  if (token.startsWith("hairstyle:")) return <HairstyleDrawing name={token.slice(10)} />;
  return null;
}
