import { loads } from "../tests/support/fixture.js";
import { PassThrough } from "node:stream";

import { createClient } from "@connectrpc/connect";
import type { ConnectRouter } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { call, ensure, run, withResolvers } from "effection";
import type { Operation } from "effection";
import { describe, expect, test } from "vitest";

import { useFixture } from "../tests/support/fixture.js";
import { LanguageService } from "./generated/gazelle/v1/language_pb.js";
import type { InitializeResponse } from "./generated/gazelle/v1/language_pb.js";
import { ConnectionError, duplex, serve } from "./server.js";
import { createService } from "./service.js";

// Serves routes on a pair of pipes, as the host's process pipes would carry
// them, and connects an HTTP/2 Connect client with prior knowledge.
function* useConnection(routes: (router: ConnectRouter) => void): Operation<{
  client: ReturnType<typeof createClient<typeof LanguageService>>;
  served: Promise<void>;
  close(): void;
}> {
  const input = new PassThrough();
  const output = new PassThrough();
  yield* ensure(() => {
    input.destroy();
    output.destroy();
  });
  const served = serve(input, output, routes);
  // Settled by each test; observed here so an early failure is not unhandled.
  served.catch(() => null);
  const socket = duplex(output, input);
  const transport = createConnectTransport({
    baseUrl: "http://gazelle",
    httpVersion: "2",
    nodeOptions: { createConnection: () => socket },
  });
  return {
    client: createClient(LanguageService, transport),
    served,
    // The host closes its side of the pipe.
    close: () => input.end(),
  };
}

describe("serve", () => {
  test("answers requests and finishes when the host closes the connection", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const connection = yield* useConnection((router) =>
        router.service(
          LanguageService,
          createService({
            index: fixture.index,
            loads: loads.map((record) => ({ ...record, label: "//gazelle:defs.bzl" })),
          }),
        ),
      );
      const response = yield* call(() =>
        connection.client.initialize({ repositoryRoot: fixture.root }),
      );
      expect(response.packages).toEqual(["", "app", "lib"]);
      connection.close();
      yield* call(() => connection.served);
    }));

  test("finishes when the host closes the connection before any request", () =>
    run(function* () {
      const connection = yield* useConnection((router) => router.service(LanguageService, {}));
      connection.close();
      yield* call(() => connection.served);
    }));

  test("fails when the connection breaks during a request", () =>
    run(function* () {
      const entered = withResolvers<void>();
      // A request the service never answers.
      const unanswered = Promise.withResolvers<InitializeResponse>();
      const connection = yield* useConnection((router) =>
        router.service(LanguageService, {
          initialize: () => {
            entered.resolve();
            return unanswered.promise;
          },
        }),
      );
      const pending = connection.client
        .initialize({ repositoryRoot: "/" })
        .catch((error: unknown) => error);
      yield* entered.operation;
      connection.close();
      let failure: unknown;
      try {
        yield* call(() => connection.served);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConnectionError);
      yield* call(() => pending);
    }));
});
