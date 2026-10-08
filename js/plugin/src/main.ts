// Serves the JavaScript language to the Gazelle host over standard input and
// output. Standard error carries diagnostics.
import fs from "node:fs";
import { Console } from "node:console";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { LanguageService } from "./generated/gazelle/v1/language_pb.js";
import { serve } from "./server.js";
import { createService } from "./service.js";

// Returns the process exit status: zero once the host closes the connection.
export async function main(args: string[], input: Readable, output: Writable): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args,
      options: {
        index: { type: "string" },
        loads: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!options.index || !options.loads) {
    console.error("usage: gazelle-js --index <pnpm workspace index> --loads <JSON load map>");
    return 2;
  }
  try {
    const service = createService({
      index: options.index,
      loads: JSON.parse(fs.readFileSync(options.loads, "utf8")),
    });
    await serve(input, output, (router) => router.service(LanguageService, service));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  // Standard output carries only the connection; any logging goes to standard
  // error.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  // Exit at once: a broken connection must not wait for work in flight.
  process.exit(await main(process.argv.slice(2), process.stdin, process.stdout));
}
