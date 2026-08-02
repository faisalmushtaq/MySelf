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

export function Illustration({ token }: { token: string }) {
  if (token.startsWith("hair:")) return <HairPattern code={token.slice(5)} />;
  return null;
}
