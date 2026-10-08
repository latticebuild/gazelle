// Vite, Vitest and Storybook configurations: providers, their consumers and
// the TypeScript projects Vitest typechecks.
import fs from "node:fs";
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import ts from "typescript";
import { z } from "zod";

import type { Rule } from "./generated/gazelle/v1/language_pb.js";
import { localAttribute, text } from "./values.js";
import type { Package } from "./workspace.js";

const extensions = ["ts", "mts", "cts", "js", "mjs", "cjs"];
const conventional = ["vite.config", "vitest.config", ".storybook/vite.config"];

// A js_vite_config provider.
export interface Provider {
  local: string;
  file: string;
  name: string;
  existing: Rule | undefined;
}

function first(pkg: Package, stem: string) {
  return extensions.map((extension) => `${stem}.${extension}`).find((file) => pkg.files.has(file));
}

// Conventional Vite and Vitest configs and the configs of existing
// js_vite_config rules.
export function discoverProviders(pkg: Package): Provider[] {
  const existing = new Map<string, Rule[]>();
  for (const rule of pkg.rules) {
    const config =
      rule.kind === "js_vite_config" ? localAttribute(rule, "config", pkg.rel) : undefined;
    if (config !== undefined && pkg.files.has(config)) {
      existing.set(config, [...(existing.get(config) ?? []), rule]);
    }
  }
  const files = new Set([
    ...conventional.flatMap((stem) => first(pkg, stem) ?? []),
    ...existing.keys(),
  ]);
  return [...files].toSorted().map((local) => {
    const rules = existing.get(local) ?? [];
    if (rules.length > 1) {
      throw new ConnectError(
        `${path.posix.join(pkg.rel, local)}: js_vite_config rules ${rules.map((rule) => rule.name).join(", ")} declare the same config; remove all but one`,
        Code.InvalidArgument,
      );
    }
    return {
      local,
      file: path.posix.join(pkg.rel, local),
      name: rules[0]?.name ?? providerName(local),
      existing: rules[0],
    };
  });
}

// The canonical js_vite_config name for a config file: `vite.config.ts` is
// `vite_config`, `.storybook/vite.config.ts` is `storybook_vite_config`.
export function providerName(local: string) {
  return local
    .replace(/\.[cm]?[jt]s$/v, "")
    .replace(/^\.+/v, "")
    .replaceAll(/[^\w]/gv, "_");
}

// Existing consumers of a provider, by kind.
export function consumers(pkg: Package, kind: string, provider: Provider) {
  return pkg.rules.filter(
    (rule) => rule.kind === kind && localAttribute(rule, "config", pkg.rel) === provider.name,
  );
}

// Whether a provider is the conventional Vite build config.
export function isViteConfig(provider: Provider) {
  return /^vite\.config\.[cm]?[jt]s$/v.test(provider.local);
}

// A Storybook configuration directory and its main module.
export interface Storybook {
  name: string;
  directory: string;
  main: string;
  existing: Rule | undefined;
}

// Existing js_storybook rules whose directory holds a main module, or else the
// canonical `storybook` for `.storybook/main.*`. Rules whose directory is not
// a literal package path are authored: they are left alone and suppress the
// canonical rule.
export function discoverStorybooks(pkg: Package): Storybook[] {
  const result: Storybook[] = [];
  let authored = false;
  for (const rule of pkg.rules.filter((candidate) => candidate.kind === "js_storybook")) {
    const directory = storybookDirectory(rule);
    const main =
      directory === undefined ? undefined : first(pkg, path.posix.join(directory, "main"));
    authored ||= directory === undefined;
    if (directory !== undefined && main) {
      result.push({ name: rule.name, directory, main, existing: rule });
    }
  }
  const main = first(pkg, ".storybook/main");
  if (result.length === 0 && !authored && main) {
    result.push({
      name: "storybook",
      directory: ".storybook",
      main,
      existing: pkg.rules.find((rule) => rule.kind === "js_storybook" && rule.name === "storybook"),
    });
  }
  return result;
}

// A js_storybook rule's configuration directory, or undefined when it is not
// a literal package path.
function storybookDirectory(rule: Rule): string | undefined {
  const value = rule.attributes["config_dir"]?.value;
  if (value === undefined) {
    return ".storybook";
  }
  const directory = text(value);
  return directory === undefined || /^(?:[:@]|\/\/)/v.test(directory) ? undefined : directory;
}

// Whether a js_storybook rule's literal directory lacks a main module.
export function storybookGone(pkg: Package, rule: Rule) {
  const directory = storybookDirectory(rule);
  return directory !== undefined && !first(pkg, path.posix.join(directory, "main"));
}

// Vitest configs whose typecheck projects become TypeScript entries: the
// conventional config and those js_vitest rules evaluate.
export function vitestConfigs(pkg: Package, providers: readonly Provider[]) {
  return providers
    .filter(
      (provider) =>
        /^vitest\.config\.[cm]?[jt]s$/v.test(provider.local) ||
        consumers(pkg, "js_vitest", provider).length > 0,
    )
    .map((provider) => provider.local);
}

type Options = Map<string, { values: ts.Expression[]; array: boolean }>;

function optionText(options: Options, name: string) {
  const values = options.get(name)?.values ?? [];
  return values.length === 1 ? literal(values[0], values[0]!.getSourceFile()) : undefined;
}

// The tsconfig files Vitest typechecks with, relative to the package. Static
// configuration is folded for mode "test" without evaluating any module;
// anything computed is skipped because authored js_tsconfig rules can still
// name such projects.
export function typecheckConfigs(pkg: Package, configs: readonly string[]): string[] {
  const { workspace } = pkg;
  const directory = workspace.absolute(pkg.rel);
  const results = new Set<string>();
  const sources = new Map<string, ts.SourceFile>();
  const major = vitestMajor(pkg);

  function local(file: string) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    return relative.startsWith("../") || path.isAbsolute(relative) ? undefined : relative;
  }
  function candidate(file: string) {
    return [file, ...extensions.map((extension) => `${file}.${extension}`)].find((choice) => {
      const relative = local(choice);
      return relative !== undefined && pkg.files.has(relative);
    });
  }
  function load(file: string): ts.SourceFile {
    let source = sources.get(file);
    if (!source) {
      const parsed = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      // A cyclic import sees the unfolded module.
      sources.set(file, parsed);
      source = fold(parsed, "test", importer);
      sources.set(file, source);
    }
    return source;
  }
  function importer(specifier: string, from: ts.SourceFile) {
    const target = candidate(path.resolve(path.dirname(from.fileName), specifier));
    return target ? load(target) : undefined;
  }
  function readOptions(source: ts.SourceFile): Options {
    return exportedConfigs(source, importer).reduce<Options>(
      (merged, object) => mergeOptions(merged, objectOptions(object)),
      new Map(),
    );
  }
  function project(options: Options, base: string, chain: string[], runnable = false) {
    // Projects nest only as deep as their files; a longer chain is a cycle.
    if (chain.length > 32) {
      return;
    }
    const root = path.resolve(
      base,
      optionText(options, "test.root") ?? optionText(options, "root") ?? ".",
    );
    const definitions = options.get("test.projects");
    if (definitions && !runnable) {
      projects(definitions.values, options, root, chain);
      return;
    }
    const instances = options.get("test.browser.instances")?.values ?? [];
    if (optionBoolean(options, "test.browser.enabled") === true && instances.length > 0) {
      for (const expression of instances) {
        const instance = unwrap(expression, expression.getSourceFile());
        if (!ts.isObjectLiteralExpression(instance)) {
          continue;
        }
        const inherited = new Map(options);
        for (const name of ["root", "test.root", "test.projects", "test.browser.instances"]) {
          inherited.delete(name);
        }
        project(
          mergeOptions(inherited, objectOptions(instance, "test.", new Map(), ["browser"])),
          root,
          chain,
          true,
        );
      }
      return;
    }
    if (optionBoolean(options, "test.typecheck.enabled") !== true) {
      return;
    }
    const configured = optionText(options, "test.typecheck.tsconfig");
    const target =
      configured === undefined
        ? ts.findConfigFile(
            root,
            (file) => local(file) !== undefined && pkg.files.has(local(file)!),
          )
        : path.resolve(root, configured);
    const relative = target ? local(target) : undefined;
    if (relative !== undefined && pkg.files.has(relative)) {
      results.add(relative);
    }
  }
  function projects(values: ts.Expression[], options: Options, root: string, chain: string[]) {
    const patterns: string[] = [];
    const files = new Set<string>();
    const directories = new Set<string>();
    for (const input of values) {
      const value = unwrap(input, input.getSourceFile());
      const pattern = literal(value, value.getSourceFile());
      if (pattern !== undefined) {
        const resolved = pattern.replace("<rootDir>", root);
        if (/[*?\[\]\{\}!]/v.test(resolved)) {
          patterns.push(resolved);
          continue;
        }
        const target = path.resolve(root, resolved);
        const relative = local(target);
        if (relative !== undefined && pkg.files.has(relative)) {
          files.add(target);
        } else if (relative !== undefined) {
          directories.add(target);
        }
      } else if (ts.isObjectLiteralExpression(value)) {
        const own = objectOptions(value);
        const inherited = inheritedOptions(own, options, root);
        if (inherited) {
          project(mergeOptions(inherited, own), root, [...chain, "inline"], true);
        }
      }
    }
    const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
    const negative = patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1));
    const selected = (file: string) => {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const test = (pattern: string) =>
        path.posix.matchesGlob(
          relative,
          path.isAbsolute(pattern)
            ? path.relative(root, pattern).split(path.sep).join("/")
            : pattern,
        );
      return (
        positive.some((pattern) => test(pattern)) && !negative.some((pattern) => test(pattern))
      );
    };
    for (const file of pkg.files) {
      const absolute = path.join(directory, file);
      if (positive.length > 0 && selected(absolute)) {
        files.add(absolute);
      }
      const parts = file.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = path.join(directory, ...parts.slice(0, index));
        if (positive.length > 0 && selected(parent)) {
          directories.add(parent);
        }
      }
    }
    for (const folder of directories) {
      const config = ["vitest.config", "vite.config"]
        .flatMap((stem) => extensions.map((extension) => path.join(folder, `${stem}.${extension}`)))
        .find((file) => candidate(file) === file);
      if (config) {
        files.add(config);
      } else {
        project(new Map(), folder, [...chain, folder], true);
      }
    }
    for (const file of files) {
      if (
        !/^vite(?:st)?(?:\.[\w\-]+)?\.config\./v.test(path.basename(file)) ||
        chain.includes(file)
      ) {
        continue;
      }
      const own = readOptions(load(file));
      // Vite's inline root for a file project is its directory.
      own.delete("root");
      project(own, path.dirname(file), [...chain, file]);
    }
  }
  function inheritedOptions(own: Options, options: Options, root: string): Options | undefined {
    const extension = own.get("extends")?.values[0];
    const extended = extension ? literal(extension, extension.getSourceFile()) : undefined;
    let inherited: Options;
    if (extended !== undefined) {
      const target = candidate(path.resolve(root, extended));
      if (!target) {
        return undefined;
      }
      inherited = readOptions(load(target));
    } else if (extension?.kind === ts.SyntaxKind.TrueKeyword || (!extension && major >= 5)) {
      inherited = new Map(options);
    } else if (!extension || extension.kind === ts.SyntaxKind.FalseKeyword) {
      inherited = new Map();
    } else {
      return undefined;
    }
    for (const name of ["root", "test.root", "test.projects", "test.name"]) {
      inherited.delete(name);
    }
    return inherited;
  }

  for (const config of configs) {
    const file = path.join(directory, config);
    project(readOptions(load(file)), path.dirname(file), [file]);
  }
  return [...results].toSorted();
}

function vitestMajor(pkg: Package) {
  const binding = pkg.entry?.bindings.get("vitest");
  if (!binding) {
    return 5;
  }
  try {
    const manifest = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          fs.readFileSync(
            pkg.workspace.absolute(path.posix.join(binding.path, "package.json")),
            "utf8",
          ),
        ),
      );
    return Number(manifest.version.split(".")[0]);
  } catch {
    return 5;
  }
}

function mergeOptions(base: Options, own: Options): Options {
  const result = new Map(base);
  for (const [name, value] of own) {
    const previous = result.get(name);
    result.set(
      name,
      previous && (previous.array || value.array)
        ? { values: [...previous.values, ...value.values], array: true }
        : value,
    );
  }
  return result;
}

function optionBoolean(options: Options, name: string) {
  const kind = options.get(name)?.values[0]?.kind;
  return kind === ts.SyntaxKind.TrueKeyword
    ? true
    : kind === ts.SyntaxKind.FalseKeyword
      ? false
      : undefined;
}

const nested = new Set(["test", "test.coverage", "test.typecheck", "test.browser"]);

function objectOptions(
  object: ts.ObjectLiteralExpression,
  prefix = "",
  result: Options = new Map(),
  skipped: readonly string[] = [],
): Options {
  const properties = object.properties.filter(
    (property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
  );
  const last = new Map(properties.map((property) => [propertyKey(property.name), property]));
  for (const property of properties) {
    const key = propertyKey(property.name);
    if (key === undefined || last.get(key) !== property || skipped.includes(key)) {
      continue;
    }
    const name = prefix + key;
    for (const configured of result.keys()) {
      if (configured === name || configured.startsWith(name + ".")) {
        result.delete(configured);
      }
    }
    const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    const value = unwrap(expression, expression.getSourceFile());
    if (nested.has(name)) {
      if (ts.isObjectLiteralExpression(value)) {
        result.set(name, { values: [], array: false });
        objectOptions(value, name + ".", result);
      }
    } else {
      result.set(name, {
        values: ts.isArrayLiteralExpression(value) ? [...value.elements] : [value],
        array: ts.isArrayLiteralExpression(value),
      });
    }
  }
  return result;
}

// The object literals a config module exports, through defineConfig,
// mergeConfig, factory functions and imported relative configs.
function exportedConfigs(
  source: ts.SourceFile,
  load: (specifier: string, from: ts.SourceFile) => ts.SourceFile | undefined,
): ts.ObjectLiteralExpression[] {
  const objects: ts.ObjectLiteralExpression[] = [];
  function collect(
    expression: ts.Expression,
    file: ts.SourceFile,
    depth: number,
    environment?: string,
  ) {
    // Imported configs can import each other; depth ends such a cycle.
    if (depth > 64) {
      return;
    }
    const value = unwrap(expression, file);
    if (ts.isObjectLiteralExpression(value)) {
      objects.push(value);
    } else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      const parameter = value.parameters[0]?.name;
      const name = parameter && ts.isIdentifier(parameter) ? parameter.text : undefined;
      if (ts.isBlock(value.body)) {
        for (const statement of flattened(value.body)) {
          if (ts.isReturnStatement(statement) && statement.expression) {
            collect(statement.expression, file, depth + 1, name);
          }
        }
      } else {
        collect(value.body, file, depth + 1, name);
      }
    } else if (
      ts.isCallExpression(value) &&
      wrapper(value, file, ["defineConfig", "defineProject", "mergeConfig"])
    ) {
      for (const argument of value.arguments) {
        collect(argument, file, depth + 1, environment);
      }
    } else if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.arguments.length === 1 &&
      value.arguments[0]!.getText(file) === environment
    ) {
      const imported = importedConfig(value.expression, file, load);
      if (imported) {
        collect(imported.expression, imported.source, depth + 1);
      }
    } else if (ts.isIdentifier(value)) {
      const imported = importedConfig(value, file, load);
      if (imported) {
        collect(imported.expression, imported.source, depth + 1);
      }
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      collect(statement.expression, source, 0);
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.left.getText(source) === "module.exports"
    ) {
      collect(statement.expression.right, source, 0);
    }
  }
  return objects;
}

// Whether a call invokes one of the named Vite or Vitest config helpers.
function wrapper(call: ts.CallExpression, source: ts.SourceFile, names: readonly string[]) {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      ["vite", "vitest/config"].includes(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          names.includes((element.propertyName ?? element.name).text) &&
          element.name.text === call.expression.getText(source),
      ),
  );
}

function importedConfig(
  input: ts.Identifier,
  source: ts.SourceFile,
  load: (specifier: string, from: ts.SourceFile) => ts.SourceFile | undefined,
) {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const named =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.find((element) => element.name.text === input.text)
        : undefined;
    const name =
      clause?.name?.text === input.text
        ? "default"
        : named
          ? (named.propertyName ?? named.name).text
          : undefined;
    if (!name) {
      continue;
    }
    const target = load(statement.moduleSpecifier.text, source);
    const expression = target && exportedExpression(target, name);
    return target && expression ? { source: target, expression, name } : null;
  }
  return null;
}

// The expression a module exports under a name, when it is a literal export.
function exportedExpression(source: ts.SourceFile, name: string) {
  for (const declaration of source.statements) {
    if (name === "default" && ts.isExportAssignment(declaration)) {
      return declaration.expression;
    }
    if (
      ts.isVariableStatement(declaration) &&
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const binding = declaration.declarationList.declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      if (binding?.initializer) {
        return binding.initializer;
      }
    }
  }
  return null;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isComputedPropertyName(name)
    ? literal(name.expression, name.getSourceFile())
    : ts.isPrivateIdentifier(name)
      ? undefined
      : name.text;
}

function unwrap(input: ts.Expression, source: ts.SourceFile, depth = 0): ts.Expression {
  if (depth > 64) {
    return input;
  }
  if (
    ts.isParenthesizedExpression(input) ||
    ts.isAsExpression(input) ||
    ts.isSatisfiesExpression(input)
  ) {
    return unwrap(input.expression, source, depth + 1);
  }
  if (ts.isIdentifier(input)) {
    const declaration = source.statements
      .flatMap((statement) =>
        ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
      )
      .find((item) => ts.isIdentifier(item.name) && item.name.text === input.text);
    if (declaration?.initializer) {
      return unwrap(declaration.initializer, source, depth + 1);
    }
  }
  return input;
}

// A string a config expression names: literals, the module's directory and
// fileURLToPath(new URL("…", import.meta.url)).
function literal(input: ts.Expression | undefined, source: ts.SourceFile): string | undefined {
  const value = input ? unwrap(input, source) : undefined;
  if (!value) {
    return undefined;
  }
  const code = value.getText(source);
  if (code === "import.meta.dirname" || code === "__dirname") {
    return path.dirname(source.fileName);
  }
  if (ts.isCallExpression(value) && value.arguments.length === 1) {
    const url = value.arguments[0]!;
    const imported = source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        ["node:url", "url"].includes(statement.moduleSpecifier.text) &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (element) =>
            (element.propertyName ?? element.name).text === "fileURLToPath" &&
            element.name.text === value.expression.getText(source),
        ),
    );
    if (
      imported &&
      ts.isNewExpression(url) &&
      url.expression.getText(source) === "URL" &&
      url.arguments?.length === 2 &&
      ts.isStringLiteralLike(url.arguments[0]!) &&
      url.arguments[1]!.getText(source) === "import.meta.url"
    ) {
      return path.resolve(path.dirname(source.fileName), url.arguments[0]!.text);
    }
  }
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

// A block's statements with nested blocks inlined.
function flattened(block: ts.Block): ts.Statement[] {
  return block.statements.flatMap((statement) =>
    ts.isBlock(statement) ? flattened(statement) : [statement],
  );
}

type Scalar = string | boolean | number;

function constant(value: Scalar) {
  return typeof value === "string"
    ? ts.factory.createStringLiteral(value)
    : typeof value === "number"
      ? ts.factory.createNumericLiteral(value)
      : value
        ? ts.factory.createTrue()
        : ts.factory.createFalse();
}

// Folds literal configuration: mode conditions, constants, templates, spreads
// of literal objects and imported literal settings. Imported modules are
// parsed, never evaluated; everything else is left as written.
function fold(
  source: ts.SourceFile,
  mode: string,
  load: (specifier: string, from: ts.SourceFile) => ts.SourceFile | undefined,
): ts.SourceFile {
  const active = new Set<string>();
  const wrappers = new Set(
    source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      ["vite", "vitest/config"].includes(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
            .filter((element) =>
              ["defineConfig", "defineProject"].includes(
                (element.propertyName ?? element.name).text,
              ),
            )
            .map((element) => element.name.text)
        : [],
    ),
  );
  // Only exported config factories receive Vite's mode argument.
  const factories = new Set<ts.Node>();
  const pending = source.statements
    .filter(ts.isExportAssignment)
    .map((statement) => statement.expression);
  while (pending.length > 0) {
    const value = unwrap(pending.pop()!, source);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      factories.add(value);
    } else if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      wrappers.has(value.expression.text)
    ) {
      pending.push(...value.arguments);
    }
  }

  function imported(
    input: ts.Identifier,
    file: ts.SourceFile,
    depth: number,
  ): ts.Expression | undefined {
    const resolved = importedConfig(input, file, load);
    if (!resolved) {
      return undefined;
    }
    const identity = `${resolved.source.fileName}:${resolved.name}`;
    if (active.has(identity)) {
      return undefined;
    }
    active.add(identity);
    try {
      return literalTree(resolved.expression, resolved.source, depth + 1);
    } finally {
      active.delete(identity);
    }
  }
  function literalTree(
    input: ts.Expression,
    file: ts.SourceFile,
    depth: number,
  ): ts.Expression | undefined {
    if (depth > 64) {
      return undefined;
    }
    const value = unwrap(input, file);
    if (ts.isStringLiteralLike(value)) {
      return ts.factory.createStringLiteral(value.text);
    }
    if (ts.isNumericLiteral(value)) {
      return ts.factory.createNumericLiteral(value.text);
    }
    if (value.kind === ts.SyntaxKind.TrueKeyword) {
      return ts.factory.createTrue();
    }
    if (value.kind === ts.SyntaxKind.FalseKeyword) {
      return ts.factory.createFalse();
    }
    if (ts.isIdentifier(value)) {
      return imported(value, file, depth + 1);
    }
    if (ts.isArrayLiteralExpression(value)) {
      const elements = value.elements.map((item) => literalTree(item, file, depth + 1));
      return elements.every((item) => item !== undefined)
        ? ts.factory.createArrayLiteralExpression(elements)
        : undefined;
    }
    if (ts.isObjectLiteralExpression(value)) {
      const properties: ts.ObjectLiteralElementLike[] = [];
      for (const property of value.properties) {
        if (ts.isSpreadAssignment(property)) {
          const object = literalTree(property.expression, file, depth + 1);
          if (!object || !ts.isObjectLiteralExpression(object)) {
            return undefined;
          }
          properties.push(...object.properties);
        } else if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const item = literalTree(
            ts.isPropertyAssignment(property) ? property.initializer : property.name,
            file,
            depth + 1,
          );
          const key = propertyKey(property.name);
          if (!item || key === undefined) {
            return undefined;
          }
          properties.push(
            ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(key), item),
          );
        } else {
          return undefined;
        }
      }
      return ts.factory.createObjectLiteralExpression(properties);
    }
    return undefined;
  }
  function scalar(
    input: ts.Expression,
    environment: Map<string, Scalar>,
    depth = 0,
  ): Scalar | undefined {
    if (depth > 64) {
      return undefined;
    }
    const value = unwrap(input, source);
    if (ts.isIdentifier(value)) {
      return environment.get(value.text);
    }
    if (ts.isPropertyAccessExpression(value)) {
      return environment.get(value.getText(source));
    }
    if (ts.isStringLiteralLike(value)) {
      return value.text;
    }
    if (ts.isNumericLiteral(value)) {
      return Number(value.text);
    }
    if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
      return value.kind === ts.SyntaxKind.TrueKeyword;
    }
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = scalar(value.operand, environment, depth + 1);
      return operand === undefined ? undefined : !operand;
    }
    if (ts.isBinaryExpression(value)) {
      const left = scalar(value.left, environment, depth + 1);
      const right = scalar(value.right, environment, depth + 1);
      if (left === undefined || right === undefined) {
        return undefined;
      }
      switch (value.operatorToken.kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          return left === right;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          return left !== right;
        case ts.SyntaxKind.AmpersandAmpersandToken:
          return left && right;
        case ts.SyntaxKind.BarBarToken:
          return left || right;
      }
    }
    return undefined;
  }
  function parameters(node: ts.SignatureDeclaration, inherited: Map<string, Scalar>) {
    const environment = new Map(inherited);
    for (const parameter of node.parameters) {
      if (ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (!ts.isIdentifier(element.name)) {
            continue;
          }
          environment.delete(element.name.text);
          if (
            factories.has(node) &&
            (element.propertyName ?? element.name).getText(source) === "mode"
          ) {
            environment.set(element.name.text, mode);
          }
        }
      } else if (ts.isIdentifier(parameter.name)) {
        environment.delete(parameter.name.text);
        environment.delete(parameter.name.text + ".mode");
        if (factories.has(node)) {
          environment.set(parameter.name.text + ".mode", mode);
        }
      }
    }
    return environment;
  }
  function constants(node: ts.Block, inherited: Map<string, Scalar>) {
    const environment = new Map(inherited);
    for (const statement of node.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const value = scalar(declaration.initializer, environment);
          if (value !== undefined) {
            environment.set(declaration.name.text, value);
          }
        }
      }
    }
    return environment;
  }
  const transformed = ts.transform(source, [
    (context) => {
      function visit(node: ts.Node, environment: Map<string, Scalar>): ts.VisitResult<ts.Node> {
        if (ts.isImportDeclaration(node)) {
          return node;
        }
        if (
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node)
        ) {
          environment = parameters(node, environment);
        }
        if (ts.isBlock(node)) {
          environment = constants(node, environment);
        }
        if (ts.isComputedPropertyName(node)) {
          const key = scalar(node.expression, environment);
          if (key !== undefined) {
            return ts.factory.createStringLiteral(String(key));
          }
        }
        if (ts.isBinaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
          const value = scalar(node, environment);
          if (value !== undefined) {
            return constant(value);
          }
        }
        if (ts.isShorthandPropertyAssignment(node)) {
          const value = environment.get(node.name.text);
          const folded = value === undefined ? imported(node.name, source, 0) : constant(value);
          if (folded) {
            return ts.factory.createPropertyAssignment(node.name.text, folded);
          }
        }
        if (ts.isConditionalExpression(node) || ts.isIfStatement(node)) {
          const condition = scalar(
            ts.isIfStatement(node) ? node.expression : node.condition,
            environment,
          );
          if (condition !== undefined) {
            const selected = ts.isIfStatement(node)
              ? condition
                ? node.thenStatement
                : node.elseStatement
              : condition
                ? node.whenTrue
                : node.whenFalse;
            return selected ? visit(selected, environment) : ts.factory.createEmptyStatement();
          }
        }
        if (
          ts.isIdentifier(node) &&
          node.parent &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !ts.isShorthandPropertyAssignment(node.parent) &&
          !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
          !ts.isBindingElement(node.parent) &&
          !ts.isParameter(node.parent) &&
          !ts.isPropertyAccessExpression(node.parent)
        ) {
          const value = environment.get(node.text);
          if (value !== undefined) {
            return constant(value);
          }
          const folded = imported(node, source, 0);
          if (folded) {
            return folded;
          }
        }
        if (ts.isTemplateExpression(node)) {
          let result = node.head.text;
          let known = true;
          for (const span of node.templateSpans) {
            const value = scalar(span.expression, environment);
            known &&= value !== undefined;
            result += String(value) + span.literal.text;
          }
          if (known) {
            return ts.factory.createStringLiteral(result);
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const properties = node.properties.flatMap((property) => {
            if (ts.isSpreadAssignment(property)) {
              const local = unwrap(property.expression, source);
              const object = ts.isObjectLiteralExpression(local)
                ? local
                : literalTree(property.expression, source, 0);
              if (object && ts.isObjectLiteralExpression(object)) {
                return [...object.properties];
              }
            }
            return [property];
          });
          node = ts.factory.updateObjectLiteralExpression(node, properties);
        }
        return ts.visitEachChild(node, (child) => visit(child, environment), context);
      }
      return (file) => ts.visitNode(file, (node) => visit(node, new Map()), ts.isSourceFile)!;
    },
  ]);
  try {
    return ts.createSourceFile(
      source.fileName,
      ts.createPrinter().printFile(transformed.transformed[0]!),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  } finally {
    transformed.dispose();
  }
}
