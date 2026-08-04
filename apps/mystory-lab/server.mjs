import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Gateway, MockAdapter, OpenAiAdapter } from "@myself/llm";
import { NarrativeRunner, checkProtocol, protocols } from "@myself/narrative";

/**
 * The MyStory lab: run a narrative protocol on its own, without the survey.
 *
 * Two reasons this is a separate app rather than a page in the participant
 * app. It lets a researcher iterate on prompts and stages in seconds instead
 * of clicking through a hundred and fifty questions to reach the last screen.
 * And it holds the OpenAI key in a server process, which is where a provider
 * key belongs — the same arrangement the Cloud Function will have, so what is
 * proven here is what ships.
 *
 * No framework: one file, the Node http module, and the same packages the
 * platform uses. The point is to exercise @myself/narrative, not to be an
 * application.
 */

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// .env.local, read directly. A dependency to parse six lines is not worth the
// supply chain it brings.
//
// Quotes are stripped because people paste them, and a key wrapped in quotes
// fails as an authentication error, which reads like a bad key rather than a
// bad copy-and-paste.
const envFile = here("./.env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const key = (process.env.OPENAI_API_KEY ?? "").trim();
const live = key.length > 0;

/**
 * Say what is wrong and what to type, rather than only what happened.
 *
 * Running on the mock is a legitimate mode — it is how the whole journey gets
 * demonstrated without a key or a bill — so this is not an error. But somebody
 * who has just followed the setup steps and still sees "mock" needs to know
 * which of the two possible reasons they are looking at.
 */
if (!live) {
  console.log(
    [
      "",
      "Running on the DETERMINISTIC MOCK — no model calls will be made.",
      existsSync(envFile)
        ? `  ${envFile} exists but has no OPENAI_API_KEY line with a value in it.`
        : `  ${envFile} does not exist.`,
      "",
      "  To make live calls, either put the key in that file:",
      "",
      "      cd apps/mystory-lab",
      "      cp .env.example .env.local",
      '      echo "OPENAI_API_KEY=sk-..." >> .env.local',
      "      node server.mjs",
      "",
      "  or pass it for one run without a file at all:",
      "",
      "      OPENAI_API_KEY=sk-... node server.mjs",
      "",
      "  Never paste the key into a chat, an issue or a commit — anywhere it is",
      "  written down is somewhere it has to be rotated from.",
      "",
    ].join("\n"),
  );
}

/** Provenance rows, held in memory — this is a lab, not a study. */
const modelCalls = [];
const sessions = new Map();

const gateway = new Gateway({
  adapters: live ? [new OpenAiAdapter({ apiKey: key }), new MockAdapter()] : [new MockAdapter()],
  onCall: (call) => {
    // Replace the "started" row when the outcome arrives, so the lab shows one
    // row per call rather than two half-rows.
    const at = modelCalls.findIndex((c) => c.callId === call.callId);
    if (at >= 0) modelCalls[at] = call;
    else modelCalls.push(call);
  },
});

/** Swap every model stage onto the mock, for running without a key. */
const onMock = (protocol) => ({
  ...protocol,
  stages: protocol.stages.map((s) => (s.modelConfigKey ? { ...s, modelConfigKey: "mc.mock" } : s)),
});

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString());
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(here("./src/index.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/protocols") {
      json(res, 200, {
        live,
        protocols: protocols.map((p) => ({
          key: p.key,
          version: p.version,
          name: p.name,
          researchQuestion: p.researchQuestion,
          stages: p.stages.map((s) => ({ key: s.key, kind: s.kind })),
          offlineFallback: p.offlineFallback,
          permittedVariables: p.permittedVariables,
          permittedIdentifiers: p.permittedIdentifiers,
          problems: checkProtocol(p),
          models: p.models.map((m) => ({ key: m.key, provider: m.provider, model: m.model })),
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      const body = await readBody(req);
      const base = protocols.find((p) => p.key === body.protocol);
      if (!base) return json(res, 404, { error: "no such protocol" });

      const useMock = body.provider === "mock" || !live;
      const protocol = useMock ? onMock(base) : base;
      const sessionId = `lab_${Date.now().toString(36)}`;
      const runner = new NarrativeRunner(
        protocol,
        {
          sessionId,
          variables: { first_name: body.firstName ?? "", topic: body.topic ?? "how school has been this term" },
          online: body.online !== false,
        },
        gateway,
      );
      sessions.set(sessionId, runner);
      const screen = runner.start();
      json(res, 200, { sessionId, screen, records: runner.all, provider: useMock ? "mock" : "openai" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/turn") {
      const body = await readBody(req);
      const runner = sessions.get(body.sessionId);
      if (!runner) return json(res, 404, { error: "no such session" });

      const screen =
        body.action === "next"
          ? await runner.next()
          : body.action === "skip"
            ? await runner.skip()
            : await runner.submit(body.input ?? "");
      json(res, 200, {
        screen,
        records: runner.all,
        calls: modelCalls.filter((c) => c.sessionId === body.sessionId),
      });
      return;
    }

    res.writeHead(404).end("not found");
  } catch (error) {
    console.error(error);
    json(res, 500, { error: String(error) });
  }
});

const port = Number(process.env.PORT ?? 4300);
server.listen(port, () => {
  console.log(`MyStory lab on http://localhost:${port}`);
  // The last four characters only: enough to tell two keys apart when one has
  // been rotated, and not enough to be worth anything to anyone reading over a
  // shoulder or scrolling back through a terminal.
  if (live) console.log(`OpenAI key found (…${key.slice(-4)}) — live calls available, mock still selectable.`);
});
