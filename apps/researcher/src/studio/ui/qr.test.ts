import { describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { QUIET_ZONE, qrCode, qrSvgFile } from "./qr.js";

/**
 * The participant link's QR code (D-56): drawn here from the link, with no
 * service asked. What matters is that it is the code for exactly that link,
 * and that it can be found and read — finder patterns in three corners, a
 * quiet zone round it.
 */

const LINK = "https://faisalmushtaq.github.io/MySelf/?study=future&survey=future_main";

describe("a participant link's QR code", () => {
  it("is the library's own code for exactly the link, with a quiet zone round it", () => {
    const qr = qrcode(0, "M");
    qr.addData(LINK, "Byte");
    qr.make();
    const { size, path } = qrCode(LINK);
    expect(size).toBe(qr.getModuleCount() + QUIET_ZONE * 2);
    const dark = (path.match(/M/g) ?? []).length;
    let expected = 0;
    for (let r = 0; r < qr.getModuleCount(); r += 1) for (let c = 0; c < qr.getModuleCount(); c += 1) if (qr.isDark(r, c)) expected += 1;
    expect(dark).toBe(expected);
  });

  it("has a finder pattern in three corners and none in the fourth", () => {
    const { size, path } = qrCode(LINK);
    const at = (col: number, row: number) => path.includes(`M${col} ${row}h1v1h-1z`);
    const q = QUIET_ZONE;
    const last = size - q - 1;
    expect(at(q, q)).toBe(true);
    expect(at(last, q)).toBe(true);
    expect(at(q, last)).toBe(true);
    // The quiet zone is empty.
    expect(at(0, 0)).toBe(false);
    expect(at(q - 1, q)).toBe(false);
  });

  it("is the same code every time, and a different one for another link", () => {
    expect(qrCode(LINK)).toEqual(qrCode(LINK));
    expect(qrCode(LINK).path).not.toBe(qrCode(LINK.replace("future_main", "future_two")).path);
  });

  it("downloads as a black-on-white SVG that names the link it opens", () => {
    const file = qrSvgFile(`${LINK}&x=<y>`);
    expect(file).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(file).toContain('fill="#ffffff"');
    expect(file).toContain('fill="#000000"');
    expect(file).toContain("&amp;x=&lt;y&gt;");
  });
});
