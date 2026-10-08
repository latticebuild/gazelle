// TypeScript projects: configuration discovery, effective compiler options,
// inherited configurations, source sets and outputs.
import fs from "node:fs";
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import ts from "typescript";

import type { Rule } from "./generated/gazelle/v1/language_pb.js";
import { inKit, kitConfig, unsynced } from "./kit.js";
import type { Patterns } from "./sources.js";
import type { Emission } from "./trace.js";
import type { Scalar } from "./values.js";
import { localAttribute } from "./values.js";
import type { Package } from "./workspace.js";
import { packagePath } from "./workspace.js";

// Compiler internals the plugin reads through its own TypeScript dependency.
const internal = ts as typeof ts & {
  matchFiles(
    path: string,
    extensions: readonly string[] | undefined,
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    caseSensitive: boolean,
    currentDirectory: string,
    depth: number | undefined,
    entries: (directory: string) => { files: string[]; directories: string[] },
    realpath: (file: string) => string,
  ): string[];
  optionDeclarations: { name: string; type: string | Map<string, number> }[];
  getResolveJsonModule(options: ts.CompilerOptions): boolean;
  getSupportedExtensions(
    options: ts.CompilerOptions,
    extra: readonly ts.FileExtensionInfo[],
  ): readonly (readonly string[])[];
  nodeNextJsonConfigResolver(
    moduleName: string,
    containingFile: string,
    host: ts.ModuleResolutionHost,
  ): ts.ResolvedModuleWithFailedLookupLocations;
};

const extraExtensions: ts.FileExtensionInfo[] = [
  { extension: ".svelte", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
  // Svelte checking reads stylesheets that configs include.
  { extension: ".css", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
];
// The output-affecting options js_tsc reads from the effective set its
// providers merge along `extends`; each rule declares what its configuration
// contributes. Paths are relative to the configuration that sets them.
const pathOptions = new Set(["rootDir", "outDir", "tsBuildInfoFile", "declarationDir", "outFile"]);
const outputOptions = [
  ...pathOptions,
  "allowJs",
  "checkJs",
  "composite",
  "declaration",
  "declarationMap",
  "emitBOM",
  "emitDeclarationOnly",
  "incremental",
  "inlineSourceMap",
  "jsx",
  "noCheck",
  "noEmit",
  "resolveJsonModule",
  "sourceMap",
].toSorted();
const emitted = /\.(?:[cm]?[jt]sx?|json)$/v;
const declarationFile = /\.d\.[cm]?ts$/v;

export interface Project {
  // js_tsconfig, or js_svelte_kit for SvelteKit's generated configuration.
  kind: "js_tsconfig" | "js_svelte_kit";
  // Package-relative and repository-relative config paths.
  local: string;
  file: string;
  parsed: ts.ParsedCommandLine;
  // Every configuration `extends` reaches, as TypeScript spells file names:
  // absolute, with forward slashes.
  extended: readonly string[];
  // The configurations the config's own `extends` names, spelled the same way.
  bases: readonly string[];
  // The rule name.
  name: string;
  // Whether the project has sources and compilations, or only provides
  // configuration to others.
  entry: boolean;
  existing: Rule | undefined;
  // js_tsc rule names: existing compilations of this configuration, or the
  // canonical one.
  compilations: string[];
}

// The package's TypeScript projects: root `tsconfig*.json` files, configs named
// by existing js_tsconfig rules and the given typecheck configs are entries;
// configs they extend inside the package provide configuration only. SvelteKit's
// generated configuration, once one of them extends it, is a js_svelte_kit.
export function discoverProjects(pkg: Package, required: Iterable<string>): Project[] {
  const existing = new Map<string, Rule[]>();
  for (const rule of pkg.rules) {
    const config =
      rule.kind === "js_svelte_kit"
        ? kitConfig
        : rule.kind === "js_tsconfig"
          ? localAttribute(rule, "config", pkg.rel)
          : undefined;
    if (config !== undefined && (pkg.files.has(config) || rule.kind === "js_svelte_kit")) {
      existing.set(config, [...(existing.get(config) ?? []), rule]);
    }
  }
  const entries = new Set([
    ...[...pkg.files].filter((file) => /^tsconfig[^\/]*\.json$/v.test(file)),
    ...[...required].filter((file) => pkg.files.has(file)),
  ]);
  // The generated configuration is a project only while a config extends it.
  const pending = [...entries, ...existing.keys()]
    .filter((local) => local !== kitConfig)
    .toSorted();
  const configs = new Map<
    string,
    { parsed: ts.ParsedCommandLine; extended: string[]; bases: string[] }
  >();
  // Configs another config of the package extends.
  const bases = new Set<string>();
  while (pending.length > 0) {
    const local = pending.shift()!;
    if (configs.has(local)) {
      continue;
    }
    const config = parseConfig(pkg, local);
    configs.set(local, config);
    for (const file of config.extended) {
      const target = packagePath(pkg.rel, pkg.workspace.relative(file));
      if (target !== undefined && (pkg.files.has(target) || target === kitConfig)) {
        bases.add(target);
        pending.push(target);
      }
    }
  }
  const names = new Map<string, string>();
  const projects: Project[] = [];
  for (const [local, config] of [...configs].toSorted(([a], [b]) => a.localeCompare(b))) {
    const rules = existing.get(local) ?? [];
    if (rules.length > 1) {
      throw new ConnectError(
        `${path.posix.join(pkg.rel, local)}: ${rules[0]!.kind} rules ${rules.map((rule) => rule.name).join(", ")} declare the same config; remove all but one`,
        Code.InvalidArgument,
      );
    }
    const kind = local === kitConfig ? "js_svelte_kit" : "js_tsconfig";
    const role = projectRole(local);
    const name =
      rules[0]?.name ?? (kind === "js_svelte_kit" ? role : role ? `${role}_tsconfig` : "tsconfig");
    const clash = names.get(name);
    if (clash !== undefined) {
      throw new ConnectError(
        `${path.posix.join(pkg.rel, local)}: its js_tsconfig name ${name} is also derived from ${clash}; declare a js_tsconfig with another name for one of them`,
        Code.InvalidArgument,
      );
    }
    names.set(name, local);
    const sources = rules[0]?.attributes["srcs"];
    const keptEmpty =
      sources?.kept === true &&
      sources.value?.value.case === "list" &&
      sources.value.value.value.items.length === 0;
    const raw = config.parsed.raw as { files?: unknown; include?: unknown };
    const declaresNone =
      Array.isArray(raw.files) &&
      raw.files.length === 0 &&
      (!Array.isArray(raw.include) || raw.include.length === 0);
    const compilations = pkg.rules
      .filter((rule) => rule.kind === "js_tsc" && localAttribute(rule, "config", pkg.rel) === name)
      .map((rule) => rule.name);
    // A config only an existing rule names is an entry unless it is a base of
    // another config that nothing compiles, like one the plugin created.
    const named = existing.has(local) && (!bases.has(local) || compilations.length > 0);
    const entry =
      kind === "js_tsconfig" && (entries.has(local) || named) && !keptEmpty && !declaresNone;
    projects.push({
      kind,
      local,
      file: path.posix.join(pkg.rel, local),
      parsed: config.parsed,
      extended: config.extended,
      bases: config.bases,
      name,
      entry,
      existing: rules[0],
      compilations: entry
        ? compilations.length > 0
          ? compilations
          : [role ? `${role}_tsc` : "tsc"]
        : [],
    });
  }
  return projects;
}

// The role a configuration's rule names start with: `tsconfig.lib.json` is
// `lib`, `tsconfig.json` has none and SvelteKit's generated config is `kit`.
export function projectRole(local: string): string {
  if (local === kitConfig) {
    return "kit";
  }
  const directory = path.posix.dirname(local);
  let stem = path.posix.basename(local, ".json");
  if (stem === "tsconfig" && directory !== ".") {
    stem =
      path.posix.basename(directory) === ".svelte-kit" ? "kit" : path.posix.basename(directory);
  } else {
    stem = stem.replace(/^tsconfig(?:\.|$)/v, "");
  }
  return stem.replace(/^\.+/v, "").replaceAll(/[^\w]/gv, "_");
}

function parseConfig(pkg: Package, local: string) {
  const { workspace } = pkg;
  // TypeScript's own spelling: its JSON parser normalizes the names of its
  // diagnostics, and asserts they match the file's.
  const file = normalize(workspace.absolute(path.posix.join(pkg.rel, local)));
  const shown = path.posix.join(pkg.rel, local);
  const entries = directoryEntries(pkg);
  // Configurations, SvelteKit's generated one among them, come from the
  // checkout. A failure after looking for a missing generated file means the
  // checkout has not synced.
  let missing = false;
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => workspace.root,
    fileExists: (name) => {
      const found =
        workspace.inside(path.resolve(name)) &&
        Boolean(fs.statSync(name, { throwIfNoEntry: false })?.isFile());
      missing ||=
        !found && inKit(packagePath(pkg.rel, workspace.relative(path.resolve(name))) ?? "");
      return found;
    },
    readFile: (name) => (host.fileExists(name) ? fs.readFileSync(name, "utf8") : undefined),
    // Sources come from the host's inventory, so exclusions and package
    // boundaries match Gazelle's walk.
    readDirectory: (directory, extensions, excludes, includes, depth) =>
      internal.matchFiles(
        directory,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        workspace.root,
        depth,
        (name) => entries.get(normalize(name)) ?? { files: [], directories: [] },
        (name) => name,
      ),
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      if (missing) {
        throw unsynced(pkg, shown);
      }
      throw new ConnectError(
        `${shown}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        Code.InvalidArgument,
      );
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    host,
    undefined,
    undefined,
    extraExtensions,
  );
  if (!parsed) {
    throw new ConnectError(
      `${shown}: TypeScript cannot read this configuration`,
      Code.InvalidArgument,
    );
  }
  // The config's own JSON syntax errors are not among `parsed.errors`. An
  // empty inventory is reported through the project's rules, not here.
  const problems = ts
    .getConfigFileParsingDiagnostics(parsed)
    .filter((item) => item.code !== 18002 && item.code !== 18003);
  if (problems.length > 0 && missing) {
    throw unsynced(pkg, shown);
  }
  if (problems.length > 0) {
    throw new ConnectError(
      `${shown}: ${problems.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n")}`,
      Code.InvalidArgument,
    );
  }
  if (parsed.projectReferences?.length) {
    throw new ConnectError(
      `${shown}: project references are unsupported; import other packages through their pnpm dependencies`,
      Code.InvalidArgument,
    );
  }
  const source = parsed.options["configFile"];
  const extended =
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "extendedSourceFiles" in source
      ? (source.extendedSourceFiles ?? [])
      : [];
  return { parsed, extended, bases: directBases(parsed, file, host) };
}

// What a configuration's `extends` names, resolved as TypeScript does and in
// its spelling: a relative path gains `.json` when needed, and a package
// specifier goes through its JSON configuration resolver.
function directBases(parsed: ts.ParsedCommandLine, file: string, host: ts.ModuleResolutionHost) {
  const named = (parsed.raw as { extends?: unknown }).extends;
  const directory = path.dirname(file);
  return (Array.isArray(named) ? named : [named])
    .filter((specifier) => typeof specifier === "string")
    .flatMap((specifier) => {
      const normalized = specifier.replaceAll("\\", "/");
      if (
        normalized.startsWith("./") ||
        normalized.startsWith("../") ||
        path.isAbsolute(normalized)
      ) {
        const candidate = normalize(directory, normalized);
        return [
          host.fileExists(candidate) || candidate.endsWith(".json")
            ? candidate
            : `${candidate}.json`,
        ];
      }
      const resolved = internal.nodeNextJsonConfigResolver(
        specifier,
        path.join(directory, "tsconfig.json"),
        host,
      ).resolvedModule;
      return resolved ? [normalize(resolved.resolvedFileName)] : [];
    });
}

const trees = new WeakMap<Package, Map<string, { files: string[]; directories: string[] }>>();
function directoryEntries(pkg: Package) {
  let tree = trees.get(pkg);
  if (tree) {
    return tree;
  }
  tree = new Map();
  const directory = normalize(pkg.workspace.absolute(pkg.rel));
  const entry = (name: string) => {
    let item = tree!.get(name);
    if (!item) {
      item = { files: [], directories: [] };
      tree!.set(name, item);
    }
    return item;
  };
  entry(directory);
  for (const file of pkg.inventory.files) {
    const parts = file.split("/");
    let current = directory;
    for (const part of parts.slice(0, -1)) {
      const next = `${current}/${part}`;
      if (!tree.has(next)) {
        entry(current).directories.push(part);
      }
      entry(next);
      current = next;
    }
    entry(current).files.push(parts.at(-1)!);
  }
  trees.set(pkg, tree);
  return tree;
}

// An absolute path with forward slashes, as TypeScript spells file names.
function normalize(...segments: string[]) {
  return path
    .resolve(...segments)
    .split(path.sep)
    .join("/");
}

// The output-affecting options a configuration contributes, with paths
// relative to it: where its effective options differ from what the rules it
// extends provide, null resetting an inherited one. That is what the file sets,
// minus what it repeats from its bases, plus a derived value where it changes
// and the options of installed configurations, which no rule provides.
export function compilerOptions(project: Project, pkg: Package): Map<string, Scalar> {
  const contributed = contribution(
    project.parsed.options,
    inheritedOptions(project.bases, pkg, new Map()),
  );
  const directory = path.dirname(pkg.workspace.absolute(project.file));
  const result = new Map<string, Scalar>();
  for (const [key, value] of contributed) {
    if (value === undefined) {
      result.set(key, null);
      continue;
    }
    if (pathOptions.has(key) && typeof value === "string") {
      result.set(key, path.relative(directory, value).split(path.sep).join("/") || ".");
      continue;
    }
    const declaration = internal.optionDeclarations.find((option) => option.name === key);
    if (declaration?.type instanceof Map) {
      const name = [...declaration.type].find(([, candidate]) => candidate === value)?.[0];
      if (name !== undefined) {
        result.set(key, name);
        continue;
      }
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      result.set(key, value);
    }
  }
  return result;
}

// Output options as the rules model them, with TypeScript's values: absolute
// paths and enum numbers.
type OutputOptions = Map<string, unknown>;

// What the rules providing a configuration's bases pass on, overlaid in its
// `extends` order. An installed configuration has no rule.
function inheritedOptions(
  bases: readonly string[],
  pkg: Package,
  provided: Map<string, OutputOptions>,
): OutputOptions {
  const result: OutputOptions = new Map();
  for (const file of bases) {
    if (pkg.workspace.installation(file)) {
      continue;
    }
    for (const [key, value] of providedOptions(file, pkg, provided)) {
      result.set(key, value);
    }
  }
  return result;
}

// The effective set the rule of a base configuration provides: what the rules
// of its own bases provide, overlaid by what it contributes.
function providedOptions(
  file: string,
  pkg: Package,
  provided: Map<string, OutputOptions>,
): OutputOptions {
  const known = provided.get(file);
  if (known) {
    return known;
  }
  // A cycle, which TypeScript reports, contributes nothing twice.
  provided.set(file, new Map());
  // Options never depend on the files a configuration includes, so no
  // directory is read (a root base would include the whole repository).
  const host = {
    ...ts.sys,
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, host);
  const inherited = inheritedOptions(parsed ? directBases(parsed, file, host) : [], pkg, provided);
  const result = new Map(inherited);
  for (const [key, value] of contribution(parsed?.options ?? {}, inherited)) {
    if (value === undefined) {
      result.delete(key);
    } else {
      result.set(key, value);
    }
  }
  provided.set(file, result);
  return result;
}

// Where a configuration's effective output options differ from what it
// inherits, undefined where it resets one. For an option nothing provides, the
// checker assumes what TypeScript derives from no options: resolveJsonModule's
// default, and nothing for the others.
function contribution(options: ts.CompilerOptions, inherited: OutputOptions): OutputOptions {
  const result: OutputOptions = new Map();
  for (const key of outputOptions) {
    const value =
      key === "resolveJsonModule" ? internal.getResolveJsonModule(options) : options[key];
    const base = inherited.has(key)
      ? inherited.get(key)
      : key === "resolveJsonModule"
        ? internal.getResolveJsonModule({})
        : undefined;
    if (JSON.stringify(value) !== JSON.stringify(base)) {
      result.set(key, value);
    }
  }
  return result;
}

// The project's include and exclude patterns relative to the package, for
// proposing a source glob.
export function projectPatterns(project: Project, pkg: Package): Patterns {
  const raw = project.parsed.raw as { include?: unknown; exclude?: unknown; files?: unknown };
  const options = project.parsed.options;
  const directory = path.posix.dirname(project.local);
  const configDirectory = path.dirname(pkg.workspace.absolute(project.file));
  const relative = (pattern: string) =>
    path.posix.normalize(path.posix.join(directory, pattern.replace(/^\$\{configDir\}\/?/v, "")));
  const include = Array.isArray(raw.include)
    ? raw.include.filter((item) => typeof item === "string")
    : raw.files === undefined
      ? ["**/*"]
      : [];
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((item) => typeof item === "string")
    : [options.outDir, options.declarationDir]
        .filter((item) => item !== undefined)
        .map((item) => path.relative(configDirectory, item).split(path.sep).join("/"));
  // SvelteKit's generated files come through `extends`; a glob never sees them.
  return {
    include: include.map((pattern) => relative(pattern)).filter((pattern) => !inKit(pattern)),
    exclude: exclude.map((pattern) => relative(pattern)).filter((pattern) => !inKit(pattern)),
    extensions: internal
      .getSupportedExtensions(options, extraExtensions)
      .flat()
      .filter((extension) => !extension.startsWith(".d.")),
  };
}

// Files the project emits, mapped to their sources.
export function projectOutputs(project: Project, pkg: Package): Map<string, Emission> {
  const outputs = new Map<string, Emission>();
  if (!project.entry || project.parsed.options.noEmit) {
    return outputs;
  }
  for (const input of project.parsed.fileNames) {
    if (!emitted.test(input) || declarationFile.test(input)) {
      continue;
    }
    for (const output of ts.getOutputFileNames(
      project.parsed,
      input,
      !ts.sys.useCaseSensitiveFileNames,
    )) {
      outputs.set(pkg.workspace.relative(output), {
        project: project.name,
        source: pkg.workspace.relative(input),
      });
    }
  }
  return outputs;
}

// Whether an imported file is one TypeScript resolves into its program, rather
// than a component or asset only a bundler reads.
export function programInput(project: Project, file: string) {
  const options = project.parsed.options;
  return (
    /\.[cm]?tsx?$/v.test(file) ||
    (Boolean(options.allowJs) && /\.[cm]?jsx?$/v.test(file)) ||
    (internal.getResolveJsonModule(options) && file.endsWith(".json"))
  );
}
