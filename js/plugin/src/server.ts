// One HTTP/2 connection with prior knowledge over a pair of byte streams, such
// as the process's standard input and output, served with the Connect
// protocol.
import { Http2ServerRequest, Http2ServerResponse, performServerHandshake } from "node:http2";
import { Duplex } from "node:stream";
import type { Readable, Writable } from "node:stream";

import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

/** @internal Exported for tests. */
export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
}

// Resolves when the peer closes the connection with no request in flight, and
// rejects when the connection breaks during a request.
export function serve(
  input: Readable,
  output: Writable,
  routes: (router: ConnectRouter) => void,
): Promise<void> {
  const socket = duplex(input, output);
  const session = performServerHandshake(socket, { settings: { enablePush: false } });
  const handler = connectNodeAdapter({ routes, grpc: false, grpcWeb: false });
  let active = 0;
  session.on("stream", (stream, headers, _flags, rawHeaders) => {
    active++;
    stream.once("close", () => {
      active--;
    });
    handler(
      new Http2ServerRequest(stream, headers, {}, rawHeaders),
      new Http2ServerResponse(stream),
    );
  });
  return new Promise((resolve, reject) => {
    let failure: unknown;
    const fail = (error: unknown) => {
      failure ??= error;
      session.destroy();
    };
    session.once("error", fail);
    socket.once("error", fail);
    // The host ends the connection by closing its side of the pipe. The
    // socket ends only after HTTP/2 has read every frame before the end, so
    // requests in flight are counted.
    socket.once("end", () => {
      if (active > 0) {
        fail(new ConnectionError(`connection closed with ${active} request(s) in flight`));
      }
      session.close();
    });
    session.once("close", () => {
      if (failure === undefined && active === 0) {
        resolve();
      } else {
        reject(new ConnectionError("connection broke during a request", { cause: failure }));
      }
    });
  });
}

/**
 * Joins a readable and a writable stream into one socket.
 *
 * @internal Exported for tests.
 */
export function duplex(input: Readable, output: Writable): Duplex {
  const socket = new Duplex({
    read() {
      input.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      output.write(chunk, callback);
    },
  });
  input.on("data", (chunk: Buffer) => {
    if (!socket.push(chunk)) {
      input.pause();
    }
  });
  input.once("end", () => socket.push(null));
  input.once("error", (error) => socket.destroy(error));
  output.once("error", (error) => socket.destroy(error));
  return socket;
}
