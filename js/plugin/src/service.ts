// The JavaScript language for the Gazelle host: TypeScript projects, Vite,
// Vitest and Storybook configurations and check tests of pnpm workspace
// members.
import path from "node:path";
import { z } from "zod";

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";

import { checkTests, createsCheck } from "./checks.js";
import {
  ValueSchema,
  GeneratedRuleSchema,
  GenerateResponseSchema,
  IndexResponseSchema,
  InitializeResponseSchema,
} from "./generated/gazelle/v1/language_pb.js";
import type {
  GenerateRequest,
  LanguageService,
  Rule,
  Value,
} from "./generated/gazelle/v1/language_pb.js";
import { kitConfig, kitConfigs, kitImports, kitInputs } from "./kit.js";
import { expand, sources, supported } from "./sources.js";
import type { Emission, Scope } from "./trace.js";
import { trace } from "./trace.js";
import type { Project } from "./tsconfig.js";
import {
  compilerOptions,
  discoverProjects,
  programInput,
  projectOutputs,
  projectPatterns,
  projectRole,
} from "./tsconfig.js";
import {
  Dependencies,
  boolean,
  concatenation,
  dict,
  fileImport,
  glob,
  list,
  localAttribute,
  localName,
  reference,
  relativeLabel,
  scalar,
  string,
  strings,
  text,
} from "./values.js";
import type { Provider, Storybook } from "./vite.js";
import {
  consumers,
  discoverProviders,
  discoverStorybooks,
  isViteConfig,
  providerName,
  storybookGone,
  typecheckConfigs,
  vitestConfigs,
} from "./vite.js";
import type { Package } from "./workspace.js";
import { Workspace, createPackage, owner, packagePath } from "./workspace.js";

export interface ServiceOptions {
  // Absolute path of the pnpm workspace index.
  index: string;
  // Validated owner facades for the selected generated kinds.
  loads: readonly { kind: string; label: string }[];
}

const kinds = [
  {
    name: "js_tsconfig",
    mergeable: ["compiler_options", "config", "srcs"],
    resolve: ["aliases", "data", "deps", "extends"],
  },
  {
    name: "js_svelte_kit",
    mergeable: ["compiler_options", "config", "deps", "srcs", "tool_deps"],
    resolve: [],
  },
  { name: "js_tsc", mergeable: ["config", "typescript"], resolve: [] },
  { name: "js_vite_config", mergeable: ["config"], resolve: ["aliases", "deps"] },
  { name: "js_vite", mergeable: ["config"], resolve: [] },
  { name: "js_vitest", mergeable: ["config"], resolve: ["aliases", "deps"] },
  { name: "js_storybook", mergeable: ["config_dir", "srcs"], resolve: ["aliases", "deps"] },
  // Check tests name only local rules and bindings; `paths` is authored.
  { name: "js_oxlint_test", mergeable: ["data", "deps", "srcs"], resolve: [] },
  { name: "js_oxfmt_test", mergeable: ["data", "deps", "srcs"], resolve: [] },
  { name: "js_prettier_test", mergeable: ["data", "deps", "srcs"], resolve: [] },
  {
    name: "js_knip_test",
    mergeable: ["data", "deps", "production", "srcs", "workspace"],
    resolve: [],
  },
];
const providerKinds = new Set(["js_svelte_kit", "js_tsconfig", "js_vite_config"]);

export function createService(options: ServiceOptions): ServiceImpl<typeof LanguageService> {
  const records = z
    .array(
      z
        .object({
          kind: z.string().min(1),
          label: z
            .string()
            .regex(/^(?:@{1,2}[A-Za-z0-9_.+~-]+)?\/\/[A-Za-z0-9_./+~-]*:[A-Za-z0-9_.+-]+\.bzl$/u),
        })
        .strict(),
    )
    .parse(options.loads);
  const mappings = new Map<string, string>();
  const known = new Set(kinds.map((kind) => kind.name));
  for (const record of records) {
    if (!known.has(record.kind) || mappings.has(record.kind)) {
      throw new ConnectError(
        `unknown or duplicate load-map kind ${record.kind}`,
        Code.InvalidArgument,
      );
    }
    mappings.set(record.kind, record.label);
  }
  const groups = new Map<string, string[]>();
  for (const [kind, label] of mappings) {
    const symbols = groups.get(label) ?? [];
    symbols.push(kind);
    groups.set(label, symbols);
  }
  let workspace: Workspace | undefined;
  const initialized = () => {
    if (!workspace) {
      // The host calls Initialize first; anything else is a host defect.
      throw new ConnectError("Initialize must be called first", Code.Internal);
    }
    return workspace;
  };
  return {
    initialize: (request) =>
      guard(() => {
        if (!path.isAbsolute(request.repositoryRoot)) {
          // The host always sends Gazelle's absolute root; anything else is a host defect.
          throw new ConnectError(
            `repository root ${JSON.stringify(request.repositoryRoot)} must be absolute`,
            Code.Internal,
          );
        }
        workspace = Workspace.load(request.repositoryRoot, options.index);
        return create(InitializeResponseSchema, {
          kinds: kinds.map((kind) => ({
            name: kind.name,
            mergeableAttributes: kind.mergeable,
            resolveAttributes: kind.resolve,
            nonEmptyAttributes: [...kind.mergeable, ...kind.resolve].toSorted(),
          })),
          loads: [...groups]
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([label, symbols]) => ({ label, symbols: symbols.toSorted() })),
          directives: [
            { name: "js_check", inherited: true },
            { name: "js_package", inherited: false },
            { name: "js_typescript", inherited: true },
          ],
          packages: [...new Set(["", ...workspace.packages.keys()])].toSorted(),
        });
      }),
    generate: (request) =>
      guard(async () => {
        const result = await generate(initialized(), request);
        for (const rule of result.rules) {
          if (!mappings.has(rule.kind)) {
            throw new ConnectError(
              `no load-map entry for generated kind ${rule.kind}`,
              Code.InvalidArgument,
            );
          }
        }
        return result;
      }),
    index: (request) =>
      guard(() =>
        create(IndexResponseSchema, {
          rules: request.rules.flatMap((rule) => {
            if (!providerKinds.has(rule.kind)) {
              return [];
            }
            const file = configFile(rule, request.package);
            return file === undefined
              ? []
              : [{ name: rule.name, imports: [{ import: fileImport(file) }] }];
          }),
        }),
      ),
  };
}

// User-fixable failures are already invalid-argument errors; anything else is
// a defect of the plugin.
async function guard<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ConnectError) {
      throw error;
    }
    throw new ConnectError(
      error instanceof Error ? error.message : String(error),
      Code.Internal,
      undefined,
      undefined,
      error,
    );
  }
}

// The repository-relative file a configuration rule provides: its config, or
// for js_svelte_kit the configuration sync generates.
function configFile(rule: Rule, pkg: string): string | undefined {
  if (rule.kind === "js_svelte_kit") {
    return path.posix.join(pkg, kitConfig);
  }
  const label = text(rule.attributes["config"]?.value);
  if (label === undefined || (label.startsWith("@") && !label.startsWith("@//"))) {
    return undefined;
  }
  const absolute = label.startsWith("@//") ? label.slice(1) : label;
  if (absolute.startsWith("//")) {
    const [directory, name] = absolute.slice(2).split(":");
    return name ? path.posix.join(directory!, name) : undefined;
  }
  return path.posix.join(pkg, absolute.replace(/^:/v, ""));
}

interface Generated {
  kind: string;
  name: string;
  attributes: Map<string, Value>;
}

async function generate(workspace: Workspace, request: GenerateRequest) {
  const typescript = request.directives.findLast(
    (directive) => directive.name === "js_typescript",
  )?.value;
  const pkg = createPackage(
    workspace,
    request.package,
    { files: [...request.files].toSorted(), excluded: request.excludedPaths },
    request.buildFile?.rules ?? [],
    typescript || undefined,
  );
  const providers = discoverProviders(pkg);
  const projects = discoverProjects(pkg, typecheckConfigs(pkg, vitestConfigs(pkg, providers)));
  const emissions = new Map<string, Emission>();
  for (const project of projects) {
    for (const [output, emission] of projectOutputs(project, pkg)) {
      emissions.set(output, emission);
    }
  }
  const editor = projects.find((project) => project.local === "tsconfig.json");
  const scope: Scope = {
    pkg,
    emissions,
    aliases: editor?.parsed.options,
    providers: new Map([
      ...projects.map((project) => [project.file, project.name] as const),
      ...providers.map((provider) => [provider.file, provider.name] as const),
    ]),
  };
  orphanedTests(pkg, providers);
  const rules = (
    await ordered([
      ...projects.map((project) =>
        project.kind === "js_svelte_kit"
          ? svelteKitRules(scope, project)
          : projectRules(scope, project),
      ),
      ...providers.map((provider) => providerRules(scope, provider)),
      ...discoverStorybooks(pkg).map(async (storybook) => [await storybookRule(scope, storybook)]),
    ])
  ).flat();
  // Check tests stage the configuration rules above.
  for (const check of checkTests(pkg, request.directives, rules)) {
    permit(check.existing, ["srcs"], `//${pkg.rel}:${check.name}`, check.problems);
    // Nothing consumes a test.
    rules.push(creation(pkg, check.existing, check, { visibility: false }));
  }
  for (const rule of rules) {
    inferTools(pkg, rule);
  }
  return create(GenerateResponseSchema, {
    rules: readingOrder(pkg, rules).map((rule) =>
      create(GeneratedRuleSchema, {
        kind: rule.kind,
        name: rule.name,
        attributes: Object.fromEntries(rule.attributes),
      }),
    ),
    staleRules: staleRules(pkg, rules, projects),
  });
}

const tools: Readonly<Record<string, readonly (readonly [string, string, string?])[]>> = {
  js_tsc: [
    ["tsc", "@typescript/native", "tsc"],
    ["typescript", "typescript"],
  ],
  js_svelte_kit: [
    ["kit", "@sveltejs/kit", "svelte-kit"],
    ["typescript", "typescript"],
  ],
  js_vite: [["vite", "vite", "vite"]],
  js_vitest: [
    ["vitest", "vitest", "vitest"],
    ["coverage_provider", "@vitest/coverage-v8"],
  ],
  js_storybook: [["storybook", "storybook", "storybook"]],
  js_oxlint_test: [["oxlint", "oxlint", "oxlint"]],
  js_oxfmt_test: [["oxfmt", "oxfmt", "oxfmt"]],
  js_prettier_test: [["prettier", "prettier", "prettier"]],
  js_knip_test: [["knip", "knip", "knip"]],
};

function inferTools(pkg: Package, rule: Generated) {
  const existing = pkg.rules.find((item) => item.kind === rule.kind && item.name === rule.name);
  if (existing?.kept) {
    return;
  }
  for (const [attribute, name, command] of tools[rule.kind] ?? []) {
    if (
      rule.attributes.has(attribute) ||
      (existing?.attributes[attribute] && attribute !== "typescript")
    ) {
      continue;
    }
    if (existing?.attributes[attribute]?.kept) {
      continue;
    }
    const binding = pkg.entry?.bindings.get(name);
    const label = command ? binding?.binaries.get(command) : binding?.label;
    if (!label) {
      throw new ConnectError(
        `//${pkg.rel}:${rule.name}: missing installed tool ${name}${command ? ` command ${command}` : ""}; rebuild the version-3 workspace index or author ${attribute}`,
        Code.InvalidArgument,
      );
    }
    const conditions = pkg.workspace.conditions(binding!);
    const value = string(relativeLabel(label, pkg.rel));
    rule.attributes.set(
      attribute,
      conditions
        ? create(ValueSchema, {
            value: {
              case: "select",
              value: {
                cases: [
                  ...conditions.map((condition) => ({ condition, value })),
                  { condition: "//conditions:default", value: scalar(null) },
                ],
              },
            },
          })
        : value,
    );
  }
}

async function projectRules(scope: Scope, project: Project): Promise<Generated[]> {
  const { pkg } = scope;
  const { workspace } = pkg;
  const attributes = new Map<string, Value>([
    ["config", string(project.local)],
    [
      "compiler_options",
      dict([...compilerOptions(project, pkg)].map(([key, value]) => [key, scalar(value)])),
    ],
  ]);
  // Installed configurations are packages. Others are inherited from the
  // rules providing them, which pass on their own bases in turn.
  const inherited: string[] = [];
  for (const file of project.extended) {
    const installation = workspace.installation(file);
    if (installation) {
      inherited.push(installation);
    }
  }
  // In the configuration's own order, since later bases override earlier ones.
  const bases: Value[] = [];
  for (const file of project.bases) {
    if (workspace.installation(file)) {
      continue;
    }
    const rel = workspace.relative(file);
    const provider = scope.providers.get(rel);
    if (packagePath(pkg.rel, rel) !== undefined && provider !== undefined) {
      bases.push(string(`:${provider}`));
      continue;
    }
    const other = workspace.inside(file) ? owner(workspace.root, rel) : pkg.rel;
    if (other === pkg.rel) {
      throw new ConnectError(
        `${project.file}: extends ${rel}, which is neither in //${pkg.rel} nor in another package; stop excluding it or extend another config`,
        Code.InvalidArgument,
      );
    }
    // The rule providing it, or else the file itself.
    bases.push(reference(rel, `//${other}:${path.posix.relative(other, rel)}`));
  }
  attributes.set("extends", list(bases));
  let deps = new Dependencies();
  // A created project checking tests or stories depends on test-only targets.
  let tests = false;
  if (project.entry) {
    const roots: string[] = [];
    for (const input of project.parsed.fileNames) {
      const rel = workspace.relative(input);
      const local = packagePath(pkg.rel, rel);
      if (local === undefined || !pkg.files.has(local)) {
        throw new ConnectError(
          `${project.file}: source ${rel} is not a file of //${pkg.rel}; include only files of the package`,
          Code.InvalidArgument,
        );
      }
      if (!scope.emissions.has(rel)) {
        roots.push(rel);
      }
    }
    const result = await trace(scope, roots, {
      name: project.name,
      file: project.file,
      options: project.parsed.options,
      compilations: project.compilations,
      kit: project.extended.some(
        (file) => packagePath(pkg.rel, workspace.relative(file)) === kitConfig,
      ),
    });
    permit(project.existing, ["deps"], project.file, result.problems);
    // js_tsconfig reads the package manifest through its package attribute.
    const manifest = path.posix.join(pkg.rel, "package.json");
    const set = new Set(roots);
    for (const file of result.files) {
      if (programInput(project, file) && !scope.emissions.has(file) && file !== manifest) {
        set.add(file);
      }
    }
    tests = [...set].some((file) => testInput.test(packagePath(pkg.rel, file)!));
    attributes.set(
      "srcs",
      sources(
        [...set].map((file) => packagePath(pkg.rel, file)!),
        pkg.inventory,
        projectPatterns(project, pkg),
      ),
    );
    deps = result.deps;
    attributes.set("aliases", aliases(result.aliases, pkg.rel));
  }
  for (const label of inherited) {
    deps.add(label);
  }
  attributes.set("deps", deps.value(pkg.rel));
  const rules: Generated[] = [
    creation(
      pkg,
      project.existing,
      { kind: "js_tsconfig", name: project.name, attributes },
      { testonly: tests },
    ),
  ];
  // A compilation follows its configuration, authored or created.
  const testonly = project.existing
    ? boolean(project.existing.attributes["testonly"]?.value) === true
    : tests;
  const existing = new Map(
    pkg.rules.filter((rule) => rule.kind === "js_tsc").map((rule) => [rule.name, rule]),
  );
  for (const name of project.compilations) {
    const compilation = new Map([["config", string(`:${project.name}`)]]);
    if (pkg.typescript) {
      compilation.set("typescript", string(pkg.typescript));
    }
    rules.push(
      creation(
        pkg,
        existing.get(name),
        { kind: "js_tsc", name, attributes: compilation },
        { testonly },
      ),
    );
  }
  return rules;
}

// Maintains the js_svelte_kit that generates and provides SvelteKit's
// configuration: sync reads SvelteKit's default input directories and the
// local files the configuration imports, and loads the configuration with the
// packages it imports. Configurations extending the generated one inherit the
// packages its declarations import. The input glob is the same whatever the
// checkout holds, and leaves out dotfiles, since sync lists every file under
// `static/` as an asset.
async function svelteKitRules(scope: Scope, project: Project): Promise<Generated[]> {
  const { pkg } = scope;
  const config = kitConfigs.find((file) => pkg.files.has(file));
  if (config === undefined) {
    throw new ConnectError(
      `${project.file}: SvelteKit generates this configuration from a Vite configuration, and //${pkg.rel} has none`,
      Code.InvalidArgument,
    );
  }
  const file = path.posix.join(pkg.rel, config);
  const declarations = [...pkg.files].filter((local) =>
    /^src\/(?:env|params)\.[cm]?[jt]s$/v.test(local),
  );
  const result = await trace(scope, [
    file,
    ...declarations.map((local) => path.posix.join(pkg.rel, local)),
  ]);
  permit(project.existing, ["tool_deps"], file, result.problems);
  const manifest = path.posix.join(pkg.rel, "package.json");
  const imported = [...result.files]
    .filter((item) => item !== file && item !== manifest)
    .map((item) => packagePath(pkg.rel, item)!);
  const deps = new Dependencies();
  const missing: string[] = [];
  for (const name of kitImports) {
    const binding = pkg.entry?.bindings.get(name);
    if (binding) {
      deps.add(binding.label, pkg.workspace.conditions(binding));
    } else {
      missing.push(name);
    }
  }
  const existing = project.existing;
  if (missing.length > 0 && !existing?.kept && !existing?.attributes["deps"]?.kept) {
    const them = missing.length === 1 ? "it" : "them";
    throw new ConnectError(
      `${project.file}: SvelteKit's generated declarations import ${missing.join(" and ")}; add ${them} to //${pkg.rel}'s package.json, or declare ${them} in deps and mark the attribute # keep`,
      Code.InvalidArgument,
    );
  }
  const attributes = new Map<string, Value>([
    [
      "srcs",
      concatenation([
        strings(imported.toSorted()),
        glob(kitInputs, ["**/.*", ...imported].toSorted(), true),
      ]),
    ],
    ["tool_deps", result.deps.value(pkg.rel)],
    ["deps", deps.value(pkg.rel)],
    [
      "compiler_options",
      dict([...compilerOptions(project, pkg)].map(([key, value]) => [key, scalar(value)])),
    ],
  ]);
  if (config !== kitConfigs[0]) {
    attributes.set("config", string(config));
  }
  return [
    creation(pkg, project.existing, { kind: "js_svelte_kit", name: project.name, attributes }),
  ];
}

async function providerRules(scope: Scope, provider: Provider): Promise<Generated[]> {
  const { pkg } = scope;
  const result = await trace(scope, [provider.file]);
  permit(provider.existing, ["deps"], provider.file, result.problems);
  // Local files the config imports are configuration code, like its packages.
  const manifest = path.posix.join(pkg.rel, "package.json");
  for (const file of result.files) {
    if (file !== provider.file && file !== manifest) {
      result.deps.add(packagePath(pkg.rel, file)!);
    }
  }
  const rules: Generated[] = [
    creation(
      pkg,
      provider.existing,
      {
        kind: "js_vite_config",
        name: provider.name,
        attributes: new Map([
          ["config", string(provider.local)],
          ["deps", result.deps.value(pkg.rel)],
          ["aliases", aliases(result.aliases, pkg.rel)],
        ]),
      },
      // Vitest and Storybook configs serve only tests.
      { testonly: testInput.test(provider.local) },
    ),
  ];
  const builds = consumers(pkg, "js_vite", provider);
  for (const rule of builds.length > 0 ? builds : isViteConfig(provider) ? [undefined] : []) {
    rules.push(
      creation(pkg, rule, {
        kind: "js_vite",
        name: rule?.name ?? "vite_build",
        attributes: new Map([["config", string(`:${provider.name}`)]]),
      }),
    );
  }
  rules.push(
    ...(await ordered(
      consumers(pkg, "js_vitest", provider).map((rule) => vitestRule(scope, provider, rule)),
    )),
  );
  return rules;
}

// Waits for concurrent traces and reports the first failure in declaration
// order, so a package with several problems always reports the same one.
async function ordered<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

// Maintains an authored Vitest target: its sources are the trace roots, and
// the imports they reach become its dependencies.
async function vitestRule(scope: Scope, provider: Provider, rule: Rule): Promise<Generated> {
  const { pkg } = scope;
  const problems: string[] = [];
  const shown = `//${pkg.rel}:${rule.name}`;
  const expanded = (value: Value | undefined): string[] => {
    const item = value?.value;
    switch (item?.case) {
      case undefined:
        return [];
      case "list":
        return item.value.items.flatMap((entry) => {
          const label = text(entry);
          if (label === undefined) {
            problems.push(`${shown}: srcs holds a value other than a string`);
            return [];
          }
          const name = localName(label, pkg.rel);
          if (name !== undefined && pkg.files.has(name)) {
            return [name];
          }
          if (
            /^[:@]|^\/\//v.test(label) ||
            pkg.rules.some((candidate) => candidate.name === name)
          ) {
            return [];
          }
          problems.push(`${shown}: srcs names ${label}, which is not a file of the package`);
          return [];
        });
      case "glob":
        if (
          ![...item.value.include, ...item.value.exclude].every((pattern) => supported(pattern))
        ) {
          problems.push(`${shown}: srcs uses glob syntax other than literal segments, * and **`);
          return [];
        }
        return expand(pkg.inventory.files, item.value.include, item.value.exclude);
      case "concatenation":
        return item.value.operands.flatMap((operand) => expanded(operand));
      default:
        problems.push(`${shown}: srcs must be a list, a glob() or their concatenation`);
        return [];
    }
  };
  const entries = [...new Set(expanded(rule.attributes["srcs"]?.value))].map((file) =>
    path.posix.join(pkg.rel, file),
  );
  const result = await trace(scope, entries);
  permit(rule, ["deps"], shown, [...problems, ...result.problems]);
  const manifest = path.posix.join(pkg.rel, "package.json");
  for (const file of result.files) {
    if (!entries.includes(file) && file !== manifest) {
      result.deps.add(packagePath(pkg.rel, file)!);
    }
  }
  return {
    kind: "js_vitest",
    name: rule.name,
    attributes: new Map([
      ["config", string(`:${provider.name}`)],
      ["deps", result.deps.value(pkg.rel)],
      ["aliases", aliases(result.aliases, pkg.rel)],
    ]),
  };
}

async function storybookRule(scope: Scope, storybook: Storybook): Promise<Generated> {
  const { pkg } = scope;
  const main = path.posix.join(pkg.rel, storybook.main);
  const result = await trace(scope, [main]);
  permit(storybook.existing, ["deps", "srcs"], main, result.problems);
  const manifest = path.posix.join(pkg.rel, "package.json");
  const rule: Generated = {
    kind: "js_storybook",
    name: storybook.name,
    attributes: new Map([
      ["config_dir", string(storybook.directory)],
      [
        "srcs",
        sources(
          [...result.files]
            .filter((file) => file !== manifest)
            .map((file) => packagePath(pkg.rel, file)!),
          pkg.inventory,
        ),
      ],
      ["deps", result.deps.value(pkg.rel)],
      ["aliases", aliases(result.aliases, pkg.rel)],
    ]),
  };
  // A Storybook server only serves stories, and stays private to its package.
  return creation(pkg, storybook.existing, rule, { testonly: true, visibility: false });
}

// Unresolved imports fail generation unless the rule or the attribute they
// would change is kept, which declares its inputs authored.
function permit(
  rule: Rule | undefined,
  attributes: string[],
  file: string,
  problems: readonly string[],
) {
  if (
    problems.length === 0 ||
    rule?.kept ||
    attributes.some((name) => rule?.attributes[name]?.kept)
  ) {
    return;
  }
  throw new ConnectError(
    `${file}: cannot trace dependencies:\n${problems.join("\n")}\nDeclare these inputs in ${attributes.join(" or ")} and mark the attribute # keep.`,
    Code.InvalidArgument,
  );
}

function aliases(entries: Map<string, string>, pkg: string): Value {
  return dict(
    [...entries]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, label]) => [name, string(relativeLabel(label, pkg))]),
  );
}

// Visibility and testonly are written only when the host creates the rule;
// afterwards they are authored.
function creation(
  pkg: Package,
  existing: Rule | undefined,
  rule: Generated,
  { testonly = false, visibility = true }: { testonly?: boolean; visibility?: boolean } = {},
): Generated {
  if (existing) {
    return rule;
  }
  if (visibility) {
    rule.attributes.set(
      "visibility",
      strings(["//:__subpackages__", `@${pkg.workspace.repository}//:__subpackages__`]),
    );
  }
  const inherited = pkg.rules.some(
    (candidate) =>
      candidate.kind === "package" &&
      boolean(candidate.attributes["default_testonly"]?.value) === true,
  );
  if (testonly && !inherited) {
    rule.attributes.set("testonly", scalar(true));
  }
  return rule;
}

// Test, story and test-configuration inputs, by package-relative path.
const testInput =
  /(?:^|\/)(?:tests|\.storybook)\/|\.(?:test|spec|stories)\.[^\/]+$|(?:^|\/)vitest[^\/]*\.config\.[^\/]+$/v;

// Existing rules of generated kinds whose configuration no longer exists, and
// check tests no longer enabled. Only rules under the name the plugin would
// create for them are stale;
// authored names and js_vitest rules are the user's.
function staleRules(pkg: Package, rules: readonly Generated[], projects: readonly Project[]) {
  const generated = new Set(rules.map((rule) => `${rule.kind}:${rule.name}`));
  const providers = new Set(
    projects.filter((project) => project.entry).map((project) => project.name),
  );
  return pkg.rules
    .filter((rule) => {
      if (generated.has(`${rule.kind}:${rule.name}`)) {
        return false;
      }
      const config = localAttribute(rule, "config", pkg.rel);
      switch (rule.kind) {
        case "js_tsconfig": {
          const role = config === undefined ? "" : projectRole(config);
          return configGone(pkg, rule) && rule.name === (role ? `${role}_tsconfig` : "tsconfig");
        }
        case "js_vite_config":
          return configGone(pkg, rule) && rule.name === providerName(config!);
        case "js_tsc": {
          // `lib_tsconfig` compiles as `lib_tsc`, `tsconfig` as `tsc`.
          const canonical =
            config !== undefined && /(?:^|_)tsconfig$/v.test(config)
              ? `${config.slice(0, -"tsconfig".length)}tsc`
              : undefined;
          return (
            rule.name === canonical &&
            (providerGone(pkg, "js_tsconfig", config) ||
              (generated.has(`js_tsconfig:${config}`) && !providers.has(config!)))
          );
        }
        case "js_vite":
          return rule.name === "vite_build" && providerGone(pkg, "js_vite_config", config);
        case "js_svelte_kit":
          // No configuration extends the generated one any more.
          return rule.name === "kit";
        case "js_storybook":
          return rule.name === "storybook" && storybookGone(pkg, rule);
        default:
          // A check test whose directive is off or whose trigger file is gone.
          return createsCheck(pkg, rule);
      }
    })
    .map((rule) => ({ kind: rule.kind, name: rule.name }));
}

// Whether a configuration rule names a package file that no longer exists.
function configGone(pkg: Package, rule: Rule) {
  const config = localAttribute(rule, "config", pkg.rel);
  return config !== undefined && !pkg.files.has(config);
}

// Whether a consumer's local provider is missing or has lost its config file.
function providerGone(pkg: Package, kind: string, name: string | undefined) {
  if (name === undefined) {
    return false;
  }
  const target = pkg.rules.find((candidate) => candidate.name === name);
  return !target || (target.kind === kind && configGone(pkg, target));
}

// The plugin never creates or removes js_vitest rules, whose sources are
// authored; one whose configuration is gone needs its author.
function orphanedTests(pkg: Package, providers: readonly Provider[]) {
  for (const rule of pkg.rules) {
    const config = rule.kind === "js_vitest" ? localAttribute(rule, "config", pkg.rel) : undefined;
    if (
      !rule.kept &&
      !providers.some((provider) => provider.name === config) &&
      providerGone(pkg, "js_vite_config", config)
    ) {
      const provider = pkg.rules.find((candidate) => candidate.name === config);
      const file = provider && localAttribute(provider, "config", pkg.rel);
      throw new ConnectError(
        `//${pkg.rel}:${rule.name}: its config :${config} ${file ? `names ${path.posix.join(pkg.rel, file)}, which no longer exists` : "names no rule of the package"}; point the js_vitest rule at an existing Vitest config or remove it`,
        Code.InvalidArgument,
      );
    }
  }
}

// The order a reader meets the package's generated rules: those authored rules
// use first, then entry points, each followed depth-first by its local inputs.
function readingOrder(pkg: Package, rules: readonly Generated[]): Generated[] {
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  // An inherited configuration file stands for the rule providing it.
  const byConfig = new Map(
    rules
      .filter((rule) => providerKinds.has(rule.kind))
      .map((rule) => [text(rule.attributes.get("config")), rule.name]),
  );
  const inputs = (attributes: Iterable<readonly [string, Value | undefined]>) => {
    const found: string[] = [];
    for (const [key, value] of attributes) {
      const visit = (item: Value | undefined) => {
        const current = item?.value;
        if (current?.case === "stringValue") {
          const local = localName(current.value, pkg.rel);
          const name =
            local !== undefined && byName.has(local)
              ? local
              : key === "data"
                ? byConfig.get(current.value)
                : undefined;
          if (name !== undefined && !found.includes(name)) {
            found.push(name);
          }
        } else if (current?.case === "list") {
          current.value.items.forEach((entry) => visit(entry));
        } else if (current?.case === "concatenation") {
          current.value.operands.forEach((operand) => visit(operand));
        } else if (current?.case === "select") {
          current.value.cases.forEach((entry) => visit(entry.value));
        } else if (current?.case === "dict") {
          current.value.entries.forEach((entry) => visit(entry.value));
        }
      };
      visit(value);
    }
    return found;
  };
  const edges = new Map(rules.map((rule) => [rule.name, inputs(rule.attributes)]));
  const referenced = new Set([...edges.values()].flat());
  const authored = inputs(
    pkg.rules
      .filter((rule) => !byName.has(rule.name))
      .flatMap((rule) =>
        Object.entries(rule.attributes).map(([key, attribute]) => [key, attribute.value] as const),
      ),
  );
  const rank = [
    "js_vite",
    "js_vitest",
    "js_storybook",
    "js_oxlint_test",
    "js_oxfmt_test",
    "js_prettier_test",
    "js_knip_test",
    "js_tsc",
    "js_vite_config",
    "js_tsconfig",
    "js_svelte_kit",
  ];
  const entries = rules
    .filter((rule) => !referenced.has(rule.name))
    .toSorted((left, right) => rank.indexOf(left.kind) - rank.indexOf(right.kind));
  const result: Generated[] = [];
  const visited = new Set<string>();
  const append = (name: string) => {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);
    result.push(byName.get(name)!);
    for (const input of edges.get(name)!) {
      append(input);
    }
  };
  for (const name of [
    ...authored,
    ...entries.map((rule) => rule.name),
    ...rules.map((rule) => rule.name),
  ]) {
    append(name);
  }
  return result;
}
