import { expect, test } from "vitest";

import { format } from "./format.js";

test("format greets loudly", () => {
  expect(format("app")).toBe("HELLO, APP");
});
