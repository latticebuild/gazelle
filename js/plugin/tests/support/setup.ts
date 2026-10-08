import { call, run } from "effection";
import { afterAll, afterEach, beforeEach } from "vitest";

const originalFetch = globalThis.fetch;
const unexpectedFetch: typeof globalThis.fetch = () => {
  throw new Error("Unexpected fetch in unit test");
};

globalThis.fetch = unexpectedFetch;

beforeEach(() =>
  run(() =>
    call(() => {
      globalThis.fetch = unexpectedFetch;
    }),
  ),
);

afterEach(() =>
  run(() =>
    call(() => {
      globalThis.fetch = unexpectedFetch;
    }),
  ),
);

afterAll(() =>
  run(() =>
    call(() => {
      globalThis.fetch = originalFetch;
    }),
  ),
);
