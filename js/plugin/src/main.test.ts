import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import http2 from "node:http2";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { call, ensure, run, withResolvers } from "effection";
import type { Operation } from "effection";
import { describe, expect, test } from "vitest";

import { useFixture } from "../tests/support/fixture.js";
import { duplex } from "./server.js";

// The compiled command, as the host runs it.
const command = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface Command {
  child: ChildProcessByStdio<Writable, Readable, null>;
  // The exit status.
  exited: Promise<number | null>;
}

// Starts the command, which is killed and awaited when the scope exits.
function* useCommand(args: string[]): Operation<Command> {
  const child = spawn(process.execPath, [command, ...args], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  yield* ensure(function* () {
    child.kill();
    yield* call(() => exited);
  });
  return { child, exited };
}

describe("main", () => {
  test("exits zero when standard input reaches end of file", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const { child, exited } = yield* useCommand([
        "--index",
        fixture.index,
        "--loads",
        `${fixture.root}/loads.json`,
      ]);
      child.stdin.end();
      const code = yield* call(() => exited);
      expect(code).toBe(0);
    }));

  test("exits nonzero when the connection breaks during a request", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const { child, exited } = yield* useCommand([
        "--index",
        fixture.index,
        "--loads",
        `${fixture.root}/loads.json`,
      ]);
      const session = http2.connect("http://gazelle", {
        createConnection: () => duplex(child.stdout, child.stdin),
      });
      const errors: unknown[] = [];
      session.on("error", (error) => errors.push(error));
      yield* ensure(() => {
        session.destroy();
      });
      // A request whose body never ends stays in flight.
      const stream = session.request(
        {
          ":method": "POST",
          ":path": "/gazelle.v1.LanguageService/Initialize",
          "content-type": "application/proto",
          "connect-protocol-version": "1",
        },
        { endStream: false },
      );
      stream.on("error", (error) => errors.push(error));
      // The acknowledgement follows the request's headers on the connection.
      const acknowledged = withResolvers<void>();
      session.ping((error) => (error ? acknowledged.reject(error) : acknowledged.resolve()));
      yield* acknowledged.operation;
      child.stdin.end();
      const code = yield* call(() => exited);
      expect(code).toBe(1);
    }));

  test("rejects a missing index argument", () =>
    run(function* () {
      const { child, exited } = yield* useCommand([]);
      child.stdin.end();
      const code = yield* call(() => exited);
      expect(code).toBe(2);
    }));
});
