import assert from "node:assert/strict";
import { test } from "node:test";
import { value } from "./lib/dist/index.js";
test("generated compiler output executes", () => assert.equal(value, 42));
