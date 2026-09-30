import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

/**
 * The published site, as GitHub Pages lays it out, on this machine.
 *
 * pages.yml ships ONE artefact: the participant app at /MySelf/ and the
 * researcher view (with the Studio) at /MySelf/researcher/. The Studio's end-to-end
 * test has to drive both in one browser — publish in one tab, take the survey
 * in another — and both must be the same origin they are in production, since
 * they share it there. So this serves the two built `dist` folders at those
 * two paths and nothing else.
 *
 * On `localhost`, not 127.0.0.1: the functions' origin allowlist admits
 * http://localhost:<port> (relay-policy.ts), so the participant's upload
 * crosses the same CORS check it does in the field.
 */

const PORT = Number(process.env.STUDIO_SITE_PORT ?? 4175);
const root = resolve(new URL("../..", import.meta.url).pathname);
const participant = join(root, "apps/participant/dist");
const researcher = join(root, "apps/researcher/dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function fileFor(pathname) {
  const decoded = decodeURIComponent(pathname);
  let base;
  let rest;
  if (decoded.startsWith("/MySelf/researcher/") || decoded === "/MySelf/researcher") {
    base = researcher;
    rest = decoded.slice("/MySelf/researcher".length) || "/";
  } else if (decoded.startsWith("/MySelf/") || decoded === "/MySelf") {
    base = participant;
    rest = decoded.slice("/MySelf".length) || "/";
  } else {
    return null;
  }
  const target = normalize(join(base, rest));
  if (!target.startsWith(base)) return null; // no escaping the folder
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, "index.html");
  return target;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/MySelf/" }).end();
    return;
  }
  const file = fileFor(url.pathname);
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    // The service worker is re-fetched on every check, as GitHub Pages effectively does.
    "cache-control": file.endsWith("sw.js") ? "no-cache" : "public, max-age=0",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, "localhost", () => {
  console.log(`site on http://localhost:${PORT}/MySelf/`);
});
