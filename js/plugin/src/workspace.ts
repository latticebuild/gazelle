// The pnpm workspace index (`@pnpm//:workspace.json`) and package manifests.
// Only the fields generation reads are validated.
import fs from "node:fs";
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";

import type { Rule } from "./generated/gazelle/v1/language_pb.js";
import type { Inventory } from "./sources.js";

// Parses a JSON object into a Map through its entries: z.record drops
// `__proto__`, which must stay visible at a JSON boundary.
function dictionary<T>(values: z.ZodType<T>) {
  return z
    .preprocess(
      (value, context) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          context.issues.push({ code: "custom", input: value, message: "expected an object" });
          return z.NEVER;
        }
        return Object.entries(value);
      },
      z.array(z.tuple([z.string(), values])),
    )
    .transform((entries) => new Map<string, T>(entries));
}

const bindingSchema = z.object({
  label: z.string().min(1),
  name: z.string().min(1),
  path: z.string(),
  platforms: z.array(z.string()),
  workspace: z.boolean(),
  binaries: dictionary(z.string().min(1)),
});
export type Binding = z.infer<typeof bindingSchema>;

const packageSchema = z.object({
  name: z.string().min(1),
  target: z.string(),
  bindings: dictionary(bindingSchema),
});
export type PackageEntry = z.infer<typeof packageSchema>;

const indexSchema = z.object({
  version: z.literal(3),
  repository: z.string().min(1),
  platforms: z.array(z.array(z.string())),
  packages: dictionary(packageSchema),
  installed: dictionary(z.string()),
});

const manifestSchema = z.object({
  name: z.string().optional(),
  exports: z.json().optional(),
  imports: z.json().optional(),
  // Declared packages by the name the member imports them under.
  dependencies: dictionary(z.string()).optional(),
  devDependencies: dictionary(z.string()).optional(),
  peerDependencies: dictionary(z.string()).optional(),
  optionalDependencies: dictionary(z.string()).optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

export class Workspace {
  readonly #installations: { label: string; directory: string }[];

  constructor(
    // Absolute, canonical repository root.
    readonly root: string,
    readonly repository: string,
    readonly platforms: number,
    // Workspace members by slash-separated package directory.
    readonly packages: Map<string, PackageEntry>,
    installed: Map<string, string>,
  ) {
    this.#installations = [...installed]
      .map(([label, directory]) => ({ label, directory: path.resolve(root, directory) }))
      .toSorted((left, right) => right.directory.length - left.directory.length);
  }

  static load(root: string, file: string) {
    let index;
    try {
      index = indexSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      throw new ConnectError(
        `${file}: invalid pnpm workspace index; rebuild @pnpm//:workspace.json`,
        Code.InvalidArgument,
        undefined,
        undefined,
        error,
      );
    }
    return new Workspace(
      root,
      index.repository,
      index.platforms.length,
      index.packages,
      index.installed,
    );
  }

  // The installation containing an absolute path, by its label. The path may be
  // in TypeScript's forward-slash spelling, which resolving makes native.
  installation(file: string): string | undefined {
    for (const candidates of [path.resolve(file), realpath(file)]) {
      const found = this.#installations.find(
        (item) => candidates === item.directory || candidates.startsWith(item.directory + path.sep),
      );
      if (found) {
        return found.label;
      }
    }
    return undefined;
  }

  // Platform conditions for a binding, or undefined when it applies everywhere.
  conditions(binding: Binding): string[] | undefined {
    return binding.platforms.length >= this.platforms ? undefined : binding.platforms;
  }

  relative(file: string) {
    return path.relative(this.root, file).split(path.sep).join("/");
  }

  absolute(file: string) {
    return path.join(this.root, file);
  }

  inside(file: string) {
    const relative = path.relative(this.root, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
}

// One Bazel package the plugin generates in.
export interface Package {
  workspace: Workspace;
  // Slash-separated package directory; the empty string is the root package.
  rel: string;
  // Package-relative files of the inventory.
  files: ReadonlySet<string>;
  inventory: Inventory;
  // The pnpm workspace member, when the package is one.
  entry: PackageEntry | undefined;
  // Every rule of the existing BUILD file.
  rules: readonly Rule[];
  // The `js_typescript` directive in effect.
  typescript: string | undefined;
  manifest(): Manifest;
}

export function createPackage(
  workspace: Workspace,
  rel: string,
  inventory: Inventory,
  rules: readonly Rule[],
  typescript?: string,
): Package {
  let manifest: Manifest | undefined;
  return {
    workspace,
    rel,
    files: new Set(inventory.files),
    inventory,
    entry: workspace.packages.get(rel),
    rules,
    typescript,
    manifest() {
      if (!manifest) {
        const file = workspace.absolute(path.posix.join(rel, "package.json"));
        manifest = fs.existsSync(file) ? readManifest(file) : {};
      }
      return manifest;
    },
  };
}

// Converts a repository-relative path to one relative to a package, or
// undefined when the path is outside it.
export function packagePath(pkg: string, file: string): string | undefined {
  if (!pkg) {
    return file;
  }
  return file.startsWith(pkg + "/") ? file.slice(pkg.length + 1) : undefined;
}

export function realpath(file: string) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// Reads a package manifest's module and dependency fields.
function readManifest(file: string): Manifest {
  try {
    return manifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new ConnectError(
      `${file}: invalid package manifest; fix its JSON`,
      Code.InvalidArgument,
      undefined,
      undefined,
      error,
    );
  }
}

// The Bazel package that owns a repository-relative path: the nearest
// directory with a BUILD file.
export function owner(root: string, file: string): string {
  for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
    const current = directory === "." ? "" : directory;
    if (
      current === "" ||
      ["BUILD.bazel", "BUILD"].some((name) =>
        fs.statSync(path.join(root, current, name), { throwIfNoEntry: false })?.isFile(),
      )
    ) {
      return current;
    }
  }
}
