#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import { parseProtocolFile, protocolToToml, TomlError } from "./config.js";
import { checkProtocol } from "./protocol.js";
import { protocols } from "./protocols.js";
import { resolveText } from "./runner.js";

/**
 * The command a researcher runs after editing a study file.
 *
 * The point of configuration-over-code is lost if the only way to find out
 * whether a file is right is to field it. This says so in a few seconds, at a
 * terminal, before anyone has a study running on it:
 *
 *   check   the file parses, the protocol is valid, the publish gate passes,
 *           and — the part that matters — what a participant would read on
 *           every screen, so a mistyped placeholder is visible as a mistyped
 *           placeholder rather than as a blank screen in front of a child.
 *
 *   write   a shipped protocol out as a file to start from.
 */

const usage = `MyStory protocol files

  check <file.toml|file.json>   validate a study configuration and show what it says
  write <np.protocol_key> [out] write a shipped protocol out as a starting point

Shipped protocols: ${protocols.map((p) => p.key).join(", ")}

`;

function check(path: string): number {
  let protocol;
  try {
    protocol = parseProtocolFile(readFileSync(path, "utf8"), basename(path));
  } catch (error) {
    if (error instanceof TomlError) {
      console.error(`${path}: ${error.message}`);
    } else if (error instanceof ZodError) {
      console.error(`${path} is not a valid study configuration:\n`);
      for (const issue of error.issues) {
        console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
    } else {
      console.error(`${path}: ${(error as Error).message}`);
    }
    return 1;
  }

  const problems = checkProtocol(protocol);
  if (problems.length > 0) {
    console.error(`${protocol.key} would not publish:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }

  const model = protocol.models.find((m) => m.provider !== "mock");
  console.log(`${protocol.key}@${protocol.version} — ${protocol.name}`);
  console.log(`  ${protocol.interview?.questions.length ?? 0} questions, ` +
    `${Object.keys(protocol.extraction?.keys ?? {}).length} extraction keys, ` +
    `${protocol.scenario?.personas.length ?? 0} personas`);
  console.log(`  model: ${model?.provider}/${model?.model} at temperature ${model?.temperature}`);
  console.log(
    `  identifiers permitted into prompts: ${protocol.permittedIdentifiers.join(", ") || "none"}`,
  );
  console.log(`  quality control: ${protocol.qualityControl.enabled ? "on" : "off"}`);
  console.log(`  offline: ${protocol.offlineFallback}`);

  // Rendered with placeholder values, because the failure this catches is a
  // stage that says "{topic}" to a child, or nothing at all.
  const permitted = new Set(protocol.permittedVariables);
  const context = Object.fromEntries(protocol.permittedVariables.map((v) => [v, `<${v}>`]));
  console.log("\n  what the participant reads:");
  for (const stage of protocol.stages) {
    const text = resolveText(stage.text, context, permitted).text;
    const lede = resolveText(stage.lede ?? "", context, permitted).text;
    if (!text && !lede) continue;
    console.log(`\n    [${stage.kind}] ${text}`);
    if (lede) console.log(`             ${lede}`);
  }

  console.log(`\n${path}: valid.`);
  return 0;
}

function write(key: string, out: string | undefined): number {
  const protocol = protocols.find((p) => p.key === key);
  if (!protocol) {
    console.error(`no shipped protocol '${key}'. Available: ${protocols.map((p) => p.key).join(", ")}`);
    return 1;
  }
  let toml: string;
  try {
    toml = protocolToToml(protocol);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (out) {
    writeFileSync(out, toml);
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(toml);
  }
  return 0;
}

/**
 * Resolve a path the way the person typing it expects.
 *
 * The documented command is run from the repository root:
 *
 *   pnpm --filter @myself/narrative check protocols/my_study.toml
 *
 * but pnpm runs the script with the working directory set to the package, so
 * `protocols/…` would be looked for inside `packages/narrative/`. pnpm sets
 * INIT_CWD to where the command was actually invoked, which is the directory
 * the relative path was written against.
 */
const fromCallerCwd = (path: string): string => {
  const base = process.env["INIT_CWD"];
  return !base || isAbsolute(path) ? path : resolve(base, path);
};

const [command, ...rest] = process.argv.slice(2);
if (command === "check" && rest[0]) process.exit(check(fromCallerCwd(rest[0])));
else if (command === "write" && rest[0]) process.exit(write(rest[0], rest[1] ? fromCallerCwd(rest[1]) : undefined));
else {
  console.error(usage);
  process.exit(2);
}
