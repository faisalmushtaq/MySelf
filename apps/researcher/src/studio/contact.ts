/**
 * Who a person who cannot get in should contact: the study's own address, as
 * the live survey shows it to participants (composition.contact.email), read
 * from the release bundled with this build rather than written out again here.
 */

const bundled = import.meta.glob("../../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export function studyContact(): string | null {
  for (const manifest of Object.values(bundled)) {
    const email = (manifest as { composition?: { contact?: { email?: unknown } } } | null)?.composition?.contact?.email;
    if (typeof email === "string" && email.includes("@")) return email;
  }
  return null;
}
