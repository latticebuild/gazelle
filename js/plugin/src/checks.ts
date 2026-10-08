// Check tests: Oxlint, Oxfmt, Prettier and Knip over a pnpm workspace member,
// enabled per directory tree by the inherited `gazelle:js_check` directive,
// which also names the repository policy files each test stages as `data`.
import fs from "node:fs";
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";

import type { DirectiveValue, Rule, Value } from "./generated/gazelle/v1/language_pb.js";
import { beneath, expand, matches, supported } from "./sources.js";
import { Dependencies, concatenation, glob, scalar, string, strings, text } from "./values.js";
import type { Package } from "./workspace.js";

// A check test to generate. Operands of its `paths` that `srcs` cannot follow
// are problems, which fail generation unless `srcs` is kept.
export interface Check {
  kind: string;
  name: string;
  attributes: Map<string, Value>;
  existing: Rule | undefined;
  problems: string[];
}

// The names generated tests of each kind take; only rules under these names
// are ever stale.
const names = new Map([
  ["js_oxlint_test", ["oxlint_test"]],
  ["js_oxfmt_test", ["oxfmt_test"]],
  ["js_prettier_test", ["prettier_test"]],
  ["js_knip_test", ["knip_test", "knip_production_test"]],
]);

// The check tests of a workspace member. The configuration rules generated for
// the package become their inputs.
export function checkTests(
  pkg: Package,
  directives: readonly Pick<DirectiveValue, "name" | "value">[],
  generated: readonly { kind: string; name: string }[],
): Check[] {
  // The repository root's manifest lists the tools themselves; directories
  // outside the workspace hold fixtures and hand-written packages.
  if (!pkg.entry || pkg.rel === "") {
    return [];
  }
  const enabled = enabledKinds(directives);
  // The package's own configuration rules of the given kinds.
  const configurations = (kinds: readonly string[]) => {
    const deps = new Dependencies();
    for (const rule of generated) {
      if (kinds.includes(rule.kind)) {
        deps.add(`//${pkg.rel}:${rule.name}`);
      }
    }
    return deps;
  };
  const checks: Check[] = [];
  const oxlintData = enabled.get(oxlint.kind);
  if (oxlintData) {
    // Its tsconfigs carry the extended bases, the manifest and the packages
    // imports resolve to.
    const deps = configurations(["js_tsconfig"]);
    checks.push(checkTest(pkg, oxlint, "oxlint_test", oxlintData, deps));
  }
  const oxfmtData = enabled.get(oxfmt.kind);
  if (oxfmtData) {
    checks.push(checkTest(pkg, oxfmt, "oxfmt_test", oxfmtData, new Dependencies()));
  }
  const prettierData = enabled.get(prettier.kind);
  const svelte = prettierData ? sveltePaths(pkg) : [];
  if (prettierData && svelte.length > 0) {
    checks.push(
      checkTest(pkg, prettier, "prettier_test", prettierData, new Dependencies(), svelte),
    );
  }
  const knipData = enabled.get(knip.kind);
  if (knipData && pkg.files.has("knip.json")) {
    // Knip executes configs, resolves project imports and reads the installed
    // manifest of every package the member declares, for peer hosts, binaries
    // and bundled types. Bindings also hold the root's devDependencies, which
    // the member does not declare; optional packages pnpm skipped have none.
    const deps = configurations(["js_tsconfig", "js_vite_config"]);
    const manifest = pkg.manifest();
    for (const declared of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      for (const name of declared?.keys() ?? []) {
        const binding = pkg.entry.bindings.get(name);
        if (binding) {
          deps.add(binding.label, pkg.workspace.conditions(binding));
        }
      }
    }
    for (const production of [false, true]) {
      const check = checkTest(
        pkg,
        knip,
        production ? "knip_production_test" : "knip_test",
        knipData,
        deps,
        undefined,
        importTargets(pkg),
      );
      check.attributes.set("workspace", string(manifest.name ?? "."));
      if (production) {
        check.attributes.set("production", scalar(true));
      }
      checks.push(check);
    }
  }
  return checks;
}

// The kinds the `js_check` directives in effect enable, with the labels their
// tests stage as data. The last directive for a kind wins; `<kind> off`
// disables it. A directive holds only its value, so labels are absolute.
function enabledKinds(
  directives: readonly Pick<DirectiveValue, "name" | "value">[],
): Map<string, string[]> {
  const enabled = new Map<string, string[]>();
  for (const directive of directives) {
    if (directive.name !== "js_check") {
      continue;
    }
    const [kind = "", ...labels] = directive.value.trim().split(/\s+/v);
    if (!names.has(kind)) {
      throw new ConnectError(
        `gazelle:js_check ${directive.value}: ${JSON.stringify(kind)} is not a check test kind; use one of ${[...names.keys()].join(", ")}`,
        Code.InvalidArgument,
      );
    }
    if (labels.length === 1 && labels[0] === "off") {
      enabled.delete(kind);
      continue;
    }
    const relative = labels.find((label) => !label.startsWith("//") && !label.startsWith("@"));
    if (relative !== undefined) {
      throw new ConnectError(
        `gazelle:js_check ${directive.value}: ${relative} is not an absolute label; name data as //package:target or @repository//package:target, or write "${kind} off" alone`,
        Code.InvalidArgument,
      );
    }
    enabled.set(kind, labels);
  }
  return enabled;
}

// The files a tool checks when an operand names a directory: by extension, and
// for Oxlint also the package-root tsconfigs.
interface Tool {
  kind: string;
  extensions: ReadonlySet<string>;
  tsconfigs: boolean;
}

const scripts = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];
const oxlint: Tool = {
  kind: "js_oxlint_test",
  extensions: new Set([...scripts, ".svelte", ".vue", ".astro"]),
  tsconfigs: true,
};
// Probed with `oxfmt --list-different`.
const oxfmt: Tool = {
  kind: "js_oxfmt_test",
  extensions: new Set([
    ...scripts,
    ".json",
    ".jsonc",
    ".json5",
    ".md",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".vue",
    ".yaml",
    ".yml",
    ".toml",
    ".graphql",
  ]),
  tsconfigs: false,
};
// prettier-plugin-svelte's language and Prettier 3's own, as
// `prettier --support-info` lists them. Languages Prettier selects by file name
// alone, such as `.babelrc` or `README`, are not staged.
const prettier: Tool = {
  kind: "js_prettier_test",
  extensions: new Set(
    [
      ".svelte",
      // JavaScript, Flow, JSX, TypeScript and TSX.
      ".js ._js .bones .cjs .es .es6 .gs .jake .javascript .jsb .jscad .jsfl .jslib .jsm .jspre",
      ".jss .mjs .njs .pac .sjs .ssjs .xsjs .xsjslib .start.frag .end.frag .wxs .js.flow .jsx",
      ".ts .cts .mts .tsx",
      // JSON, JSON with comments and JSON5.
      ".json .importmap .4DForm .4DProject .avsc .geojson .gltf .har .ice .JSON-tmLanguage",
      ".json.example .mcmeta .sarif .slnlaunch .tact .tfstate .tfstate.backup .topojson .webapp",
      ".webmanifest .yy .yyp .jsonc .code-snippets .code-workspace .sublime-build",
      ".sublime-color-scheme .sublime-commands .sublime-completions .sublime-keymap",
      ".sublime-macro .sublime-menu .sublime-mousemap .sublime-project .sublime-settings",
      ".sublime-theme .sublime-workspace .sublime_metrics .sublime_session .json5",
      // Markup.
      ".handlebars .hbs .graphql .gql .graphqls .component.html .html .hta .htm .html.hl .inc",
      ".xht .xhtml .mjml .vue .md .livemd .markdown .mdown .mdwn .mkd .mkdn .mkdown .ronn .scd",
      ".workbook .mdx",
      // Stylesheets.
      ".css .wxss .pcss .postcss .less .scss",
      // YAML.
      ".yml .mir .reek .rviz .sublime-syntax .syntax .yaml .yaml-tmlanguage .yaml.sed .yml.mysql",
    ].flatMap((group) => group.split(" ")),
  ),
  tsconfigs: false,
};
// Knip reads what the other tools check; `.json` covers package.json,
// knip.json and the tsconfigs, and `.css` stylesheets.
const knip: Tool = {
  kind: "js_knip_test",
  extensions: new Set([...oxlint.extensions, ...oxfmt.extensions, ...prettier.extensions]),
  tsconfigs: false,
};

function checkTest(
  pkg: Package,
  tool: Tool,
  name: string,
  labels: readonly string[],
  deps: Dependencies,
  created?: readonly string[],
  resolved: readonly string[] = [],
): Check {
  const existing = pkg.rules.find((rule) => rule.kind === tool.kind && rule.name === name);
  const shown = `//${pkg.rel}:${name}`;
  const problems: string[] = [];
  const data = new Dependencies();
  for (const label of labels) {
    data.add(label);
  }
  // `srcs` follow the operands the tool runs on: the rule's authored `paths`,
  // its default `.` when it has none, or the paths it is created with, so a
  // second run reproduces the first.
  let operands = created ?? ["."];
  if (existing) {
    const authored = existing.attributes["paths"]?.value;
    const items = authored?.value.case === "list" ? authored.value.value.items.map(text) : [];
    operands = authored === undefined ? ["."] : items.filter((item) => item !== undefined);
    if (
      authored !== undefined &&
      (authored.value.case !== "list" || operands.length < items.length)
    ) {
      problems.push(`${shown}: paths must be a list of strings`);
    }
  }
  const attributes = new Map<string, Value>([
    ["srcs", checkSources(pkg, tool, operands, shown, problems, resolved)],
    ["data", data.value(pkg.rel)],
    ["deps", deps.value(pkg.rel)],
  ]);
  // Like visibility, `paths` is written only when the rule is created.
  if (!existing && created) {
    attributes.set("paths", strings(created));
  }
  return { kind: tool.kind, name, attributes, existing, problems };
}

// Directory operands stay as globs rather than enumerated file lists:
// the host's inventory includes git-ignored files, so a list would depend on
// which local files exist. `.` and directory operands become
// `<directory>/**/*<extension>` for each top-level or named directory and
// extension in use and `*<extension>` for package-root files; a glob or file
// operand stays as written. Explicit files are listed beside the globs.
// `resolved` paths join whatever their files' types.
function checkSources(
  pkg: Package,
  tool: Tool,
  operands: readonly string[],
  shown: string,
  problems: string[],
  resolved: readonly string[] = [],
): Value {
  const scopes = new Map<string, Set<string>>();
  const include = new Set<string>(resolved);
  for (const written of operands) {
    const operand = path.posix.normalize(written).replace(/\/+$/v, "");
    const inside = pkg.inventory.files.filter(
      (file) => operand === "." || file.startsWith(`${operand}/`),
    );
    if (operand === "." || (!operand.includes("*") && inside.length > 0)) {
      for (const file of inside) {
        const pattern = selector(tool, file);
        if (pattern === undefined) {
          continue;
        }
        let scope = operand;
        if (operand === ".") {
          const slash = file.indexOf("/");
          scope = slash < 0 ? "" : file.slice(0, slash);
        }
        scopes.set(scope, (scopes.get(scope) ?? new Set()).add(pattern));
      }
    } else if (supported(operand) && (operand.includes("*") || pkg.files.has(operand))) {
      include.add(operand);
    } else {
      problems.push(
        `${shown}: paths names ${written}, which is neither ".", a directory or file of the package nor a glob of literal segments, * and **`,
      );
    }
  }
  for (const [scope, patterns] of scopes) {
    if (scope && !supported(scope)) {
      problems.push(`${shown}: no glob of literal segments, * and ** can name ${scope}`);
      continue;
    }
    for (const pattern of patterns) {
      include.add(scope ? `${scope}/**/${pattern}` : pattern);
    }
  }
  const selectors = [...include].toSorted();
  if (selectors.length === 0) {
    return strings([]);
  }
  // Bazel globs still match what Gazelle excluded.
  const exclude = new Set<string>();
  for (const entry of pkg.inventory.excluded) {
    const directory = fs
      .statSync(pkg.workspace.absolute(path.posix.join(pkg.rel, entry)), { throwIfNoEntry: false })
      ?.isDirectory();
    if (directory && selectors.some((pattern) => beneath(pattern, entry))) {
      exclude.add(`${entry}/**`);
    } else if (!directory && selectors.some((pattern) => matches(pattern, entry))) {
      exclude.add(entry);
    }
  }
  const excludes = [...exclude].toSorted();
  const globs = selectors.filter((pattern) => pattern.includes("*"));
  const files = selectors.filter(
    (file) =>
      !file.includes("*") &&
      !excludes.some((pattern) => matches(pattern, file)) &&
      !globs.some((pattern) => matches(pattern, file)),
  );
  return concatenation([
    strings(files),
    ...(globs.length === 0
      ? []
      : [
          glob(
            globs,
            excludes,
            globs.some((pattern) => expand(pkg.inventory.files, [pattern], excludes).length === 0),
          ),
        ]),
  ]);
}

// The last glob segment selecting a file the tool checks: `*` and the file's
// longest extension the tool reads, or undefined for other files.
function selector(tool: Tool, file: string): string | undefined {
  const name = path.posix.basename(file);
  let extension = "";
  for (const candidate of tool.extensions) {
    if (name.endsWith(candidate) && candidate.length > extension.length) {
      extension = candidate;
    }
  }
  if (extension) {
    return `*${extension}`;
  }
  return tool.tsconfigs && /^tsconfig[^\/]*\.json$/v.test(file) ? "tsconfig*.json" : undefined;
}

// The files the member's own `imports` map resolves to, whatever their type:
// Knip resolves `#…` specifiers, such as a test's
// `import.meta.resolve("#fixtures/…")`, and reports targets it cannot find.
// Node's `*` matches across directories, so a pattern stages the directory
// before its first `*`.
function importTargets(pkg: Package): string[] {
  const targets = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (!value.startsWith("./")) {
        return;
      }
      const target = path.posix.normalize(value.slice(2));
      const star = target.indexOf("*");
      if (star >= 0) {
        const directory = target.slice(0, star).replace(/\/[^\/]*$/v, "");
        targets.add(directory && directory !== target.slice(0, star) ? `${directory}/**` : "**");
      } else if (pkg.files.has(target)) {
        targets.add(target);
      } else if (pkg.inventory.files.some((file) => file.startsWith(`${target}/`))) {
        targets.add(`${target}/**`);
      }
    } else if (value !== null && typeof value === "object") {
      // Conditions and nested targets.
      for (const nested of Object.values(value)) {
        visit(nested);
      }
    }
  };
  visit(pkg.manifest().imports);
  return [...targets].filter((target) => supported(target)).toSorted();
}

// Prettier's created paths: each top-level directory holding `.svelte` files
// outside hidden directories, or the package root.
function sveltePaths(pkg: Package): string[] {
  const operands = new Set<string>();
  for (const file of pkg.inventory.files) {
    const directories = file.split("/").slice(0, -1);
    if (file.endsWith(".svelte") && !directories.some((part) => part.startsWith("."))) {
      operands.add(directories.length > 0 ? `${directories[0]}/**/*.svelte` : "*.svelte");
    }
  }
  return [...operands].toSorted();
}

// Whether generation creates check tests of the rule's kind under its name in
// the rule's package, so that the rule is stale when a run does not.
export function createsCheck(pkg: Package, rule: Rule): boolean {
  return (
    pkg.entry !== undefined && pkg.rel !== "" && Boolean(names.get(rule.kind)?.includes(rule.name))
  );
}
