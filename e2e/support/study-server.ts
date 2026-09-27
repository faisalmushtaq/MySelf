import { createServer, type Server } from "node:http";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * A stand-in for the deployed `saveSitting`, over real HTTP, onto a real Firestore.
 *
 * WHAT THIS IS FOR. Every other test stops at a seam. The contract tests prove the
 * shapes agree. The integration tests prove the write path keeps two devices apart.
 * The browser tests prove the app collects and hands over as a file. None of them puts
 * the real client request on a real socket in front of the real handler — and that is
 * the seam a study actually depends on: an iPad in a hall sending a sitting and the
 * database ending up with it.
 *
 * IT IS NOT A MOCK OF THE HANDLER. It calls the same `registerDevice` and
 * `storeSitting` the deployed function calls, in the same order, with the same
 * credential parsing and the same response shape. What it replaces is only the Cloud
 * Functions wrapper — the bit that turns an HTTP request into arguments — because that
 * wrapper cannot be run outside Google's runtime.
 *
 * So a drift between what the app sends and what the study accepts fails here. That is
 * the whole point, and it is why this deliberately does no parsing of its own: the
 * request goes through the shared `sittingUpload` schema, exactly as the function does.
 */

export interface StudyServer {
  url: string;
  db: Firestore;
  /**
   * Every request seen, so a test can assert what the device actually did.
   *
   * `receivedAt` is this machine's clock when the request arrived, which is what makes
   * the device's own `sentAt` checkable: the two are readings of the same moment, so
   * they should agree to within a request's latency. Comparing `sentAt` to the clock at
   * the END of a test proves nothing — a walk through the survey takes minutes and the
   * first checkpoint is legitimately that old.
   */
  requests: { authorization: string | undefined; body: unknown; receivedAt: number }[];
  /** Make the next `n` requests fail, to test a device's retry behaviour. */
  failNext(n: number, status?: number): void;
  /**
   * Refuse everything until told otherwise.
   *
   * Needed because `failNext(n)` is unusable against a device that checkpoints: a walk
   * of several minutes produces dozens of uploads, so any fixed count is spent long
   * before the sitting is finished and the test ends up asserting against a study that
   * quietly came back.
   */
  failEverything(on: boolean, status?: number): void;
  close(): Promise<void>;
}

export async function startStudyServer(study = "ybm"): Promise<StudyServer> {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("the study server needs the Firestore emulator; run this under test:e2e:sync");
  }

  // Imported here rather than at module scope: these pull in the functions' own
  // modules, which set global options and must not run for the file-handover tests.
  const [{ registerDevice }, { deviceIdFor, sittingRefusal, storeSitting }, { sittingUpload }] = await Promise.all([
    import("../../apps/functions/src/relay.js"),
    import("../../apps/functions/src/sittings.js"),
    import("@myself/store"),
  ]);

  const app: App = initializeApp({ projectId: "demo-myself" }, `study-server-${Date.now()}`);
  const db = getFirestore(app);
  const requests: StudyServer["requests"] = [];
  let failures = 0;
  let failureStatus = 503;
  let refuseAll = false;

  const server: Server = createServer((req, res) => {
    /**
     * The same origin rule the deployed function applies.
     *
     * `allowedOrigins` admits `http://localhost:<port>` for a researcher running the
     * page locally, which is what the test's preview server is — so the CORS rule is
     * exercised here rather than bypassed, and a page served from the wrong host would
     * fail the same way it would in the field.
     */
    const origin = req.headers.origin;
    if (origin && /^http:\/\/localhost:\d+$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "post" } }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        requests.push({ authorization: req.headers.authorization, body, receivedAt: Date.now() });

        if (refuseAll || failures > 0) {
          if (!refuseAll) failures -= 1;
          res
            .writeHead(failureStatus, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { kind: "unknown", message: "the test server is pretending to be down" } }));
          return;
        }

        try {
          const caller = await registerDevice(db, study, (req.headers.authorization ?? "").replace(/^Device /, ""));
          const refusal = sittingRefusal(caller);
          if (refusal) throw new Error(refusal);

          const parsed = sittingUpload.safeParse(body);
          if (!parsed.success) {
            res
              .writeHead(400, { "content-type": "application/json" })
              .end(JSON.stringify({ error: { kind: "unknown", message: parsed.error.issues[0]?.message } }));
            return;
          }

          const deviceId = deviceIdFor(caller, parsed.data.deviceId);
          const now = new Date();
          const outcomes = [];
          for (const one of parsed.data.sittings) {
            outcomes.push(
              await storeSitting(db, study, one as never, deviceId, now, caller.device ? "device" : "imported"),
            );
          }
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ stored: outcomes.filter((o) => o.stored).length, outcomes }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown";
          const status = (error as { status?: number } | null)?.status ?? 500;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // EADDRINUSE here is almost always a previous run that was interrupted, and the
      // bare message sends you looking for a bug in the test instead of a stray process.
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              "port 4319 is already in use — a previous sync run is probably still going. Kill it and try again.",
            )
          : error,
      );
    });
    server.listen(4319, "127.0.0.1", () => resolve());
  });

  return {
    url: "http://127.0.0.1:4319/saveSitting",
    db,
    requests,
    failNext(n: number, status = 503) {
      failures = n;
      failureStatus = status;
    },
    failEverything(on: boolean, status = 503) {
      refuseAll = on;
      failureStatus = status;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(app);
    },
  };
}
