import qrcode from "qrcode-generator";

/**
 * A QR code for a participant link, drawn here (D-56, docs/16 §11.2).
 *
 * In the browser, from the link itself, by a small and long-established
 * library with no dependencies (`qrcode-generator`, MIT). No service is asked:
 * a QR image from a third party would be a third party told every survey link
 * the study prints, and would not draw at all offline.
 *
 * Medium error correction (about 15 % of the code can be damaged and still
 * read), which is what a link printed on a sheet in a school hall wants, and a
 * four-module quiet zone, which is what the standard asks for and what phone
 * cameras need to find the code on a busy page.
 */

export interface QrCode {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** One SVG path: a unit square per dark module, offset by the quiet zone. */
  path: string;
}

export const QUIET_ZONE = 4;

export function qrCode(text: string): QrCode {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { size: count + QUIET_ZONE * 2, path };
}

/**
 * The same code as a standalone SVG file, black on white whatever the page's
 * theme — a printed code has to scan on paper — with the link written beneath
 * it in the title, so a file found later says what it opens.
 */
export function qrSvgFile(text: string, scale = 8): string {
  const { size, path } = qrCode(text);
  const px = size * scale;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<title>${escaped}</title>`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    "</svg>",
    "",
  ].join("\n");
}
