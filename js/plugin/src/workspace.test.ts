import fs from "node:fs";
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import { call, run } from "effection";
import { describe, expect, test } from "vitest";

import { useFixture } from "../tests/support/fixture.js";
import { Workspace, owner, packagePath } from "./workspace.js";

describe("Workspace", () => {
  test("reads members, bindings and installations from the pnpm index", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const workspace = Workspace.load(fixture.root, fixture.index);
      expect([...workspace.packages.keys()]).toEqual(["", "app", "lib"]);
      const binding = workspace.packages.get("app")!.bindings.get("fsevents")!;
      expect(workspace.conditions(binding)).toEqual(["@//gazelle/platforms:darwin_arm64"]);
      expect(
        workspace.conditions(workspace.packages.get("app")!.bindings.get("vitest")!),
      ).toBeUndefined();
      expect(
        workspace.installation(path.join(fixture.root, "node_modules/vitest/dist/index.js")),
      ).toBe("@pnpm//node_modules/vitest");
      expect(
        workspace.installation(path.join(fixture.root, "app/src/lib/format.ts")),
      ).toBeUndefined();
    }));

  test("keeps prototype-shaped keys as data", () =>
    run(function* () {
      const fixture = yield* useFixture();
      const index = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
      index.packages.app.bindings = JSON.parse(
        '{"__proto__": {"label": "@pnpm//node_modules/proto", "name": "__proto__", "path": "node_modules/proto", "platforms": [], "workspace": false, "binaries": {}}}',
      );
      fs.writeFileSync(fixture.index, JSON.stringify(index));
      const bindings = Workspace.load(fixture.root, fixture.index).packages.get("app")!.bindings;
      expect([...bindings.keys()]).toEqual(["__proto__"]);
    }));

  test("rejects an index without the fields generation reads", () =>
    run(function* () {
      const fixture = yield* useFixture();
      fs.writeFileSync(fixture.index, '{"repository": "pnpm", "packages": {}}');
      let failure: unknown;
      try {
        Workspace.load(fixture.root, fixture.index);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConnectError);
      expect(failure).toMatchObject({
        code: Code.InvalidArgument,
        rawMessage: `${fixture.index}: invalid pnpm workspace index; rebuild @pnpm//:workspace.json`,
      });
    }));
});

describe("packages", () => {
  test("the nearest BUILD file owns a path", () =>
    run(function* () {
      const fixture = yield* useFixture();
      expect(owner(fixture.root, "app/generated/api.ts")).toBe("app/generated");
      expect(owner(fixture.root, "app/src/lib/format.ts")).toBe("app");
      expect(owner(fixture.root, "tsconfig.base.json")).toBe("");
    }));

  test("paths are relative to their package", () =>
    run(function* () {
      yield* call(() => {
        expect(packagePath("app", "app/src/a.ts")).toBe("src/a.ts");
        expect(packagePath("app", "application/a.ts")).toBeUndefined();
        expect(packagePath("", "a.ts")).toBe("a.ts");
      });
    }));
});
