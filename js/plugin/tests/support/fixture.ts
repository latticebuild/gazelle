// Fixture workspaces for the plugin's tests. Package manifests, BUILD files,
// pnpm-workspace.yaml and Vite, Vitest and Storybook configs carry an `.in`
// suffix in testdata so neither Bazel, pnpm nor editor tooling treats the
// fixtures as part of the repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "@bufbuild/protobuf";
import type { Operation } from "effection";
import { ensure } from "effection";

import { RuleSchema } from "../../src/generated/gazelle/v1/language_pb.js";
import type { Rule, Value } from "../../src/generated/gazelle/v1/language_pb.js";
import type { Inventory } from "../../src/sources.js";
import { scalar, strings } from "../../src/values.js";
import type { Package } from "../../src/workspace.js";
import { Workspace, createPackage } from "../../src/workspace.js";

const template = fileURLToPath(new URL("../../testdata/workspace", import.meta.url));

// SvelteKit writes these on sync; checkouts ignore `.svelte-kit`, so the
// fixture creates them. Bazel ignores them too, so the inventory never lists
// them, and a package reaches them through its js_svelte_kit rule (`kit`).
const kit: Record<string, string> = {
  "app/node_modules/$app/tsconfig.json": JSON.stringify({
    compilerOptions: {
      noEmit: true,
      rootDirs: ["../..", "../../.svelte-kit/types"],
      types: ["$app/types"],
    },
    include: ["types/**/*.d.ts", "../../src/**/*.ts"],
  }),
  "app/node_modules/$app/types/index.d.ts":
    'declare module "$app/env/public" {\n  export const PUBLIC_NAME: string;\n}\n',
};

export interface Fixture {
  root: string;
  // The checked-in pnpm workspace index.
  index: string;
  write(file: string, contents: string): void;
  remove(file: string): void;
  // A package as the host would describe it, with its existing rules.
  pkg(rel: string, rules?: Rule[], excluded?: string[]): Package;
}

// Copies the fixture workspace to a temporary directory, removed when the
// calling scope exits.
export function* useFixture(
  files: Record<string, string> = {},
  observe?: (phase: string) => void,
): Operation<Fixture> {
  observe?.("creating fixture directory");
  const parent = process.env["TEST_TMPDIR"] ?? os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "gazelle-js-")));
  yield* ensure(() => {
    observe?.("removing fixture directory");
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      observe?.("fixture cleanup settled");
    }
  });
  // Tools may leave generated directories in a local checkout.
  observe?.("copying fixture template");
  fs.cpSync(template, root, {
    recursive: true,
    filter: (source) => ![".svelte-kit", "node_modules"].includes(path.basename(source)),
  });
  observe?.("renaming fixture inputs");
  for (const file of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (file.endsWith(".in")) {
      fs.renameSync(path.join(root, file), path.join(root, file.slice(0, -3)));
    }
  }
  fs.writeFileSync(path.join(root, "loads.json"), JSON.stringify(loads));
  const fixture: Fixture = {
    root,
    index: path.join(root, "workspace.json"),
    write(file, contents) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    },
    remove(file) {
      fs.rmSync(path.join(root, file), { recursive: true });
    },
    pkg(rel, existing = [], excluded = []) {
      return createPackage(
        Workspace.load(root, path.join(root, "workspace.json")),
        rel,
        inventory(root, rel, excluded),
        existing,
      );
    },
  };
  observe?.("writing generated fixture files");
  for (const [file, contents] of Object.entries({ ...kit, ...files })) {
    fixture.write(file, contents);
  }
  observe?.("fixture ready");
  return fixture;
}

// The package's files as Gazelle's walk reports them: subdirectories with a
// BUILD file and installed packages belong elsewhere, paths Bazel ignores are
// absent, and excluded paths are listed separately.
export function inventory(root: string, rel: string, excluded: string[] = []): Inventory {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel, directory), { withFileTypes: true })) {
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (
        ["node_modules", ".svelte-kit"].includes(entry.name) ||
        excluded.some((item) => file === item || file.startsWith(item + "/"))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!fs.existsSync(path.join(root, rel, file, "BUILD.bazel"))) {
          walk(file);
        }
      } else if (entry.name !== "BUILD.bazel") {
        files.push(file);
      }
    }
  };
  walk("");
  return { files: files.toSorted(), excluded };
}

export function rule(
  kind: string,
  name: string,
  attributes: Record<string, Value | string | boolean | string[]>,
  kept: string[] = [],
): Rule {
  return create(RuleSchema, {
    kind,
    name,
    attributes: Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [
        key,
        {
          value: Array.isArray(value)
            ? strings(value)
            : typeof value === "object"
              ? value
              : scalar(value),
          kept: kept.includes(key),
        },
      ]),
    ),
    kept: kept.includes(""),
  });
}

export type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

// A value in a shape assertions can compare.
export function plain(value: Value | undefined): Plain {
  const item = value?.value;
  switch (item?.case) {
    case "stringValue":
    case "boolValue":
      return item.value;
    case "intValue":
      return Number(item.value);
    case "nullValue":
    case undefined:
      return null;
    case "list":
      return item.value.items.map(plain);
    case "dict":
      return Object.fromEntries(
        item.value.entries.map((entry) => {
          const key = plain(entry.key);
          if (key !== null && typeof key === "object") {
            throw new Error("Fixture dictionary keys must be scalar values");
          }
          return [String(key), plain(entry.value)];
        }),
      );
    case "glob":
      return {
        glob: item.value.include,
        exclude: item.value.exclude,
        allowEmpty: item.value.allowEmpty ?? false,
      };
    case "select":
      return {
        select: Object.fromEntries(
          item.value.cases.map((entry) => [entry.condition, plain(entry.value)]),
        ),
      };
    case "concatenation":
      return { concatenation: item.value.operands.map(plain) };
    case "reference":
      return { reference: item.value.spec?.import ?? "", fallback: item.value.fallback };
    case "opaque":
      return { opaque: item.value.source };
  }
}

// The attributes of generated rules by name, as plain values.
export function rules(
  generated: { kind: string; name: string; attributes: Record<string, Value> }[],
): Record<string, Record<string, Plain>> {
  return Object.fromEntries(
    generated.map((item) => [
      item.name,
      {
        kind: item.kind,
        ...Object.fromEntries(
          Object.entries(item.attributes).map(([key, value]) => [key, plain(value)]),
        ),
      },
    ]),
  );
}

const kinds = [
  "js_tsconfig",
  "js_svelte_kit",
  "js_tsc",
  "js_vite_config",
  "js_vite",
  "js_vitest",
  "js_storybook",
  "js_oxlint_test",
  "js_oxfmt_test",
  "js_prettier_test",
  "js_knip_test",
] as const;
export const loads = kinds.map((kind) => ({ kind, label: "//rules:defs.bzl" }));
