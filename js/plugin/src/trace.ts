// Import tracing. TypeScript supplies erased imports and resolution semantics;
// @vercel/nft follows runtime imports and file references. Package imports end
// at their pnpm binding, and files in other Bazel packages end at a reference.
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

import { nodeFileTrace, resolve as resolveNode } from "@vercel/nft";
import { exports as resolveExports, imports as resolveImports } from "resolve.exports";
import { parse as parseSvelte } from "svelte/compiler";
import ts from "typescript";

import { inKit, kitConfig } from "./kit.js";
import { Dependencies, text } from "./values.js";
import type { Package } from "./workspace.js";
import { owner, realpath } from "./workspace.js";

// A file another TypeScript project in the package emits.
export interface Emission {
  // The js_tsconfig rule name of the emitting project.
  project: string;
  // The repository-relative source the output is compiled from.
  source?: string;
}

// What a trace may resolve within its package.
export interface Scope {
  pkg: Package;
  // Outputs of the package's TypeScript projects, by repository-relative path.
  emissions: ReadonlyMap<string, Emission>;
  // Configuration files provided by rules of this package, by
  // repository-relative path, to the rule name.
  providers: ReadonlyMap<string, string>;
  // Options whose `paths` also apply outside a project: the package's editor
  // project, which carries framework aliases such as SvelteKit's `$lib`.
  aliases?: ts.CompilerOptions;
}

// A TypeScript project whose types are traced along with runtime imports.
export interface TracedProject {
  // The js_tsconfig rule name.
  name: string;
  file: string;
  options: ts.CompilerOptions;
  // js_tsc rule names compiling the project.
  compilations: readonly string[];
  // Whether the project's configuration extends the package's generated
  // SvelteKit configuration, and so inherits what sync writes.
  kit: boolean;
}

export interface Trace {
  // Repository-relative files in the package inventory reached by the trace.
  files: Set<string>;
  deps: Dependencies;
  aliases: Map<string, string>;
  // Imports the trace could not resolve; errors unless the owning attribute is
  // kept.
  problems: string[];
}

const defaultResolution: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  allowJs: true,
  resolveJsonModule: true,
};
const traced = /\.(?:[cm]?[jt]sx?|svelte)$/v;
const declaration = /\.d\.[cm]?ts$/v;

export async function trace(
  scope: Scope,
  entries: readonly string[],
  project?: TracedProject,
): Promise<Trace> {
  const { pkg, emissions, providers } = scope;
  const { workspace } = pkg;
  const resolution = project?.options ?? defaultResolution;
  const aliasing = project ? resolution : scope.aliases;
  const conditions = ["node", ...(resolution.customConditions ?? [])];
  const deps = new Dependencies();
  const aliases = new Map<string, string>();
  const files = new Set<string>();
  const problems = new Set<string>();
  const pending = new Set(entries);
  const processed = new Set<string>();
  const directory = workspace.absolute(pkg.rel);

  const relative = (file: string) => workspace.relative(path.resolve(file));
  const exists = (file: string, directories: boolean) => {
    if (!workspace.inside(path.resolve(file))) {
      return false;
    }
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return Boolean(stat && (directories ? stat.isDirectory() : stat.isFile()));
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => exists(file, false),
    directoryExists: (file) => exists(file, true),
    readFile: (file) => (exists(file, false) ? fs.readFileSync(file, "utf8") : undefined),
    realpath: (file) => fs.realpathSync(file),
  };

  function binding(name: string) {
    const item = pkg.entry?.bindings.get(name);
    if (!item) {
      return false;
    }
    deps.add(item.label, workspace.conditions(item));
    if (item.workspace && name !== item.name) {
      aliases.set(name, item.label);
    }
    return true;
  }

  // The package's own publication, for imports of outputs another project
  // emits. A project cannot depend on the package its compilation builds.
  function publication(from: string, output: string) {
    const target = pkg.entry?.target;
    const rule = target ? pkg.rules.find((candidate) => candidate.name === target) : undefined;
    if (!target || !rule) {
      problems.add(
        `${relative(from)}: ${output} is a TypeScript output; declare the package's js_package target so imports resolve to it`,
      );
      return;
    }
    const inputs = rule.attributes["srcs"]?.value;
    const items = inputs?.value.case === "list" ? inputs.value.value.items.map(text) : [];
    const own = project?.compilations.find(
      (name) => items.includes(`:${name}`) || items.includes(name),
    );
    if (own) {
      problems.add(
        `${relative(from)}: imports ${output}, which ${target} publishes from ${own}; map the import to source in ${project!.file}`,
      );
      return;
    }
    deps.add(`//${pkg.rel}:${target}`);
  }

  // Resolves a file to trace, or to a sentinel after recording its label.
  function local(file: string, from: string): string {
    file = path.resolve(file);
    const rel = relative(file);
    const emission = emissions.get(rel);
    if (project && emission?.project === project.name) {
      if (!emission.source) {
        problems.add(`${project.file}: self import ${rel} needs a source mapping`);
        return "node:unresolved";
      }
      return workspace.absolute(emission.source);
    }
    const provider = providers.get(rel);
    if (provider && !entries.includes(rel)) {
      deps.add(`//${pkg.rel}:${provider}`);
      return "node:config";
    }
    if (emission) {
      publication(from, rel);
      return "node:package";
    }
    const inPackage = pkg.rel ? path.posix.relative(pkg.rel, rel) : rel;
    // SvelteKit's generated files, such as the route types TypeScript finds
    // through the generated rootDirs, come from js_svelte_kit and are never
    // traced.
    if (inKit(inPackage)) {
      if (project && !project.kit) {
        problems.add(
          `${relative(from)}: ${rel} is generated by SvelteKit; extend ${path.posix.join(pkg.rel, kitConfig)} in ${project.file} to inherit it`,
        );
      }
      return "node:kit";
    }
    const installation = workspace.installation(file);
    if (installation) {
      deps.add(installation);
      return "node:package";
    }
    if (!workspace.inside(file)) {
      problems.add(`${relative(from)}: ${file} is outside the repository`);
      return "node:unresolved";
    }
    if (pkg.files.has(inPackage)) {
      return file;
    }
    if (
      !inPackage.startsWith("../") &&
      pkg.inventory.excluded.some(
        (entry) => inPackage === entry || inPackage.startsWith(entry + "/"),
      )
    ) {
      problems.add(
        `${relative(from)}: ${rel} is excluded by Gazelle; stop excluding it or keep the attribute`,
      );
      return "node:unresolved";
    }
    const other = owner(workspace.root, rel);
    if (other === pkg.rel || !fs.existsSync(file)) {
      problems.add(`${relative(from)}: ${rel} is not a file of package //${pkg.rel}`);
      return "node:unresolved";
    }
    deps.reference(rel, `//${other}:${path.posix.relative(other, rel)}`);
    return "node:reference";
  }

  // Declarations another workspace member publishes, reached through its
  // node_modules link, are provided by that member's package.
  function member(file: string, from: string) {
    const rel = relative(realpath(file));
    const found = [...workspace.packages.keys()]
      .filter((candidate) => candidate && rel.startsWith(candidate + "/"))
      .toSorted((left, right) => right.length - left.length)[0];
    if (found === undefined || found === pkg.rel) {
      return false;
    }
    const item = [...(pkg.entry?.bindings.values() ?? [])].find(
      (candidate) => candidate.workspace && candidate.path === found,
    );
    const target = workspace.packages.get(found)?.target;
    if (item) {
      deps.add(item.label, workspace.conditions(item));
    } else if (target) {
      deps.add(`//${found}:${target}`);
    } else {
      problems.add(
        `${relative(from)}: ${rel} belongs to //${found}, which declares no js_package target`,
      );
    }
    return true;
  }

  function resolvedType(file: string, from: string) {
    if (member(file, from)) {
      return;
    }
    const target = local(file, from);
    if (!target.startsWith("node:")) {
      pending.add(relative(target));
    }
  }

  function typeReference(name: string, from: string) {
    const result = ts.resolveTypeReferenceDirective(
      name,
      from,
      resolution,
      host,
    ).resolvedTypeReferenceDirective;
    if (result?.resolvedFileName) {
      resolvedType(result.resolvedFileName, from);
    } else if (!binding(name) && !binding(`@types/${name.replace(/^@/v, "").replace("/", "__")}`)) {
      problems.add(`${relative(from)}: unresolved type reference ${name}`);
    }
  }

  function sourceResolution(
    specifier: string,
    from: string,
    types: boolean,
    mode: ts.ResolutionMode = ts.ModuleKind.ESNext,
  ): string | undefined {
    if (isBuiltin(specifier)) {
      if (types) {
        binding("@types/node");
      }
      return "node:builtin";
    }
    if (/^\$(?:app|env)\//v.test(specifier) || specifier === "$service-worker") {
      if (!binding("@sveltejs/kit")) {
        problems.add(`${relative(from)}: ${specifier} needs a @sveltejs/kit dependency`);
      }
      return "node:framework";
    }
    specifier = specifier.split(specifier.startsWith("#") ? /[?]/v : /[?#]/v, 1)[0]!;
    const usage = [...conditions, mode === ts.ModuleKind.CommonJS ? "require" : "import"];
    const resolved = ts.resolveModuleName(
      specifier,
      from,
      types ? resolution : { ...resolution, noDtsResolution: true },
      host,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    if (types && resolved?.isExternalLibraryImport) {
      resolvedType(resolved.resolvedFileName, from);
    }
    if (resolved && !resolved.isExternalLibraryImport) {
      return local(resolved.resolvedFileName, from);
    }
    const aliased = mapped(specifier);
    if (aliased) {
      return local(aliased, from);
    }
    const manifest = pkg.manifest();
    if (specifier.startsWith("#")) {
      const targets = resolveImports(
        { name: manifest.name, imports: manifest.imports } as never,
        specifier,
        { conditions: types ? ["types", ...usage] : usage, unsafe: true },
      );
      if (targets?.length === 1) {
        const target = targets[0]!;
        return sourceResolution(
          target.startsWith(".") ? path.resolve(directory, target) : target,
          from,
          types,
          mode,
        );
      }
      problems.add(`${relative(from)}: package import ${specifier} has no unambiguous target`);
      return "node:unresolved";
    }
    if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0]!;
      if (manifest.name === name) {
        if (!project) {
          publication(from, specifier);
          return "node:package";
        }
        const targets = resolveExports({ name, exports: manifest.exports } as never, specifier, {
          conditions: types ? ["types", ...usage] : usage,
          unsafe: true,
        });
        if (targets?.length === 1) {
          return local(path.resolve(directory, targets[0]!), from);
        }
        problems.add(`${relative(from)}: self import ${specifier} needs an unambiguous export`);
        return "node:unresolved";
      }
      if (binding(name)) {
        return "node:package";
      }
      if (resolved) {
        return local(resolved.resolvedFileName, from);
      }
      problems.add(`${relative(from)}: ${specifier} has no pnpm binding in //${pkg.rel}`);
      return "node:unresolved";
    }
    const candidate = path.resolve(path.dirname(from), specifier);
    if (emissions.has(relative(candidate))) {
      return local(candidate, from);
    }
    if (resolved) {
      return local(resolved.resolvedFileName, from);
    }
    if (host.fileExists(candidate)) {
      return local(candidate, from);
    }
    return undefined;
  }

  // A `paths` mapping to a file TypeScript does not resolve itself, such as a
  // Svelte component under SvelteKit's `$lib`.
  function mapped(specifier: string) {
    const base = aliasing?.["pathsBasePath"];
    const candidates = Object.entries(aliasing?.paths ?? {}).flatMap(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      const prefix = star < 0 ? pattern : pattern.slice(0, star);
      const suffix = star < 0 ? "" : pattern.slice(star + 1);
      const matched =
        star < 0
          ? specifier === pattern
          : specifier.startsWith(prefix) &&
            specifier.endsWith(suffix) &&
            specifier.length >= prefix.length + suffix.length;
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      return matched
        ? targets.map((target) =>
            path.resolve(
              typeof base === "string" ? base : (aliasing?.baseUrl ?? directory),
              target.replace("*", captured),
            ),
          )
        : [];
    });
    return candidates.find((file) => host.fileExists(file));
  }

  function follow(specifier: string, from: string, types: boolean, mode?: ts.ResolutionMode) {
    const resolved = sourceResolution(specifier, from, types, mode);
    if (resolved && !resolved.startsWith("node:")) {
      pending.add(relative(resolved));
    }
  }

  // A computed path under a local #imports mapping names package data, not
  // an external dependency.
  function localTemplate(argument: ts.Expression) {
    if (!ts.isTemplateExpression(argument) || !argument.head.text.startsWith("#")) {
      return false;
    }
    const manifest = pkg.manifest();
    const targets = resolveImports(
      { name: manifest.name, imports: manifest.imports } as never,
      argument.head.text + "*",
      { conditions: [...conditions, "import"], unsafe: true },
    );
    return Boolean(targets?.length) && targets!.every((target) => target.startsWith("."));
  }

  // Records erased and literal-resolved imports, then returns JavaScript for
  // nft to follow runtime imports.
  function inspectSource(contents: string, file: string) {
    const source = ts.createSourceFile(
      file,
      contents,
      {
        languageVersion: ts.ScriptTarget.Latest,
        impliedNodeFormat: ts.getImpliedNodeFormatForFile(file, undefined, host, resolution),
      },
      true,
      /\.[jt]sx$/v.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const info = project ? ts.preProcessFile(contents, true, true) : undefined;
    for (const reference of info?.typeReferenceDirectives ?? []) {
      typeReference(reference.fileName, file);
    }
    for (const reference of info?.referencedFiles ?? []) {
      const target = local(path.resolve(path.dirname(file), reference.fileName), file);
      if (!target.startsWith("node:")) {
        pending.add(relative(target));
      }
    }
    const computed = (kind: string) =>
      problems.add(`${relative(file)}: computed ${kind} needs its dependencies declared and kept`);
    function visit(node: ts.Node) {
      if (project) {
        const specifier =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : ts.isExternalModuleReference(node)
              ? node.expression
              : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
                ? node.argument.literal
                : undefined;
        if (
          specifier &&
          ts.isStringLiteralLike(specifier) &&
          !info?.ambientExternalModules?.includes(specifier.text)
        ) {
          follow(
            specifier.text,
            file,
            true,
            ts.getModeForUsageLocation(source, specifier, resolution),
          );
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const argument = node.arguments[0];
        const dynamic =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require");
        if (dynamic && argument) {
          if (ts.isStringLiteralLike(argument)) {
            if (project) {
              follow(
                argument.text,
                file,
                true,
                ts.getModeForUsageLocation(source, argument, resolution),
              );
            }
          } else {
            computed(callee.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()");
          }
        }
        if (callee.getText(source) === "import.meta.resolve") {
          if (argument && ts.isStringLiteralLike(argument)) {
            follow(argument.text, file, false);
          } else if (!(argument && localTemplate(argument))) {
            computed("import.meta.resolve()");
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (declaration.test(file)) {
      return "";
    }
    return ts.transpileModule(contents, {
      fileName: file.endsWith(".svelte") ? file + ".ts" : file,
      // transpileModule cannot read package.json; keep the project's module
      // format for compiled sources.
      transformers: project
        ? {
            before: [
              () => (transformed) => {
                transformed.impliedNodeFormat = source.impliedNodeFormat;
                return transformed;
              },
            ],
          }
        : undefined,
      compilerOptions: {
        ...resolution,
        noEmit: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        inlineSourceMap: false,
        module: project ? resolution.module : ts.ModuleKind.Preserve,
        // Keep imports whose bindings only markup or runtime reflection uses,
        // as Svelte and Vite do.
        verbatimModuleSyntax: true,
        target: ts.ScriptTarget.ESNext,
        jsx:
          resolution.jsx === ts.JsxEmit.ReactJSX || resolution.jsx === ts.JsxEmit.ReactJSXDev
            ? resolution.jsx
            : ts.JsxEmit.React,
      },
    }).outputText;
  }

  function svelteScripts(contents: string, file: string) {
    let ast;
    try {
      ast = parseSvelte(contents, { modern: true });
    } catch (error) {
      problems.add(`${relative(file)}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
    return [ast.instance, ast.module]
      .filter((script) => script !== null && script !== undefined)
      .map((script) => {
        const { start, end } = script.content as unknown as { start: number; end: number };
        return inspectSource(contents.slice(start, end), file);
      })
      .join("\n");
  }

  if (project) {
    for (const name of ts.getAutomaticTypeDirectiveNames(resolution, host)) {
      typeReference(name, workspace.absolute(project.file));
    }
  }
  // Imports found while tracing one batch form the next.
  async function drain(): Promise<void> {
    const batch = [...pending].filter((file) => !processed.has(file)).toSorted();
    pending.clear();
    if (batch.length === 0) {
      return;
    }
    for (const file of batch) {
      processed.add(file);
    }
    const result = await nodeFileTrace(
      batch.map((file) => workspace.absolute(file)),
      {
        base: workspace.root,
        processCwd: directory,
        conditions,
        exportsOnly: true,
        analysis: { emitGlobs: false, computeFileReferences: !project },
        fileIOConcurrency: 64,
        stat: (file) =>
          workspace.inside(path.resolve(file))
            ? fs.promises.stat(file).catch(() => null)
            : Promise.resolve(null),
        readlink: (file) =>
          workspace.inside(path.resolve(file))
            ? fs.promises.readlink(file).catch(() => null)
            : Promise.resolve(null),
        async readFile(file) {
          if (!exists(file, false)) {
            return null;
          }
          const contents = await fs.promises.readFile(file, "utf8");
          if (file.endsWith(".json")) {
            return contents;
          }
          if (file.endsWith(".svelte")) {
            return svelteScripts(contents, file);
          }
          return traced.test(file) ? inspectSource(contents, file) : "";
        },
        async resolve(specifier, from, job, cjs) {
          const source = sourceResolution(
            specifier,
            from,
            false,
            cjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
          );
          if (source !== undefined) {
            return source;
          }
          const resolved = await resolveNode(specifier, from, job, cjs);
          return Array.isArray(resolved)
            ? resolved.map((file) => local(file, from))
            : local(resolved, from);
        },
      },
    );
    for (const entry of result.fileList) {
      const file = entry.split(path.sep).join("/");
      processed.add(file);
      const inPackage = pkg.rel ? path.posix.relative(pkg.rel, file) : file;
      if (pkg.files.has(inPackage)) {
        files.add(file);
      }
    }
    for (const warning of result.warnings) {
      problems.add(warning.message);
    }
    await drain();
  }
  await drain();
  return { files, deps, aliases, problems: [...problems].toSorted() };
}
