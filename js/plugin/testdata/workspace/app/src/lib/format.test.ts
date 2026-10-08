import { expect, test } from "vitest";

import { format } from "./format.js";

test("format", () => {
  expect(format("a/b")).toBe("api:b");
});
