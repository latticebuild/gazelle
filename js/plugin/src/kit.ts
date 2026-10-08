// SvelteKit's generated configuration. Bazel ignores a checkout's
// generated directories: a js_svelte_kit rule provides their tsconfig,
// and every project whose configuration extends that tsconfig inherits what
// sync writes. A package uses SvelteKit exactly when one of its configurations
// extends `$app/tsconfig`.
import path from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";

import type { Package } from "./workspace.js";

const directory = ".svelte-kit";
// The generated configuration, by package-relative path.
export const kitConfig = "node_modules/$app/tsconfig.json";
// The conventional default, then Vite's other supported configuration names.
export const kitConfigs = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];
// Environment declarations, matchers, library, routes and static assets.
// `.env*` files stay out: they can hold secrets, and action
// inputs become build artifacts.
export const kitInputs = ["src/*", "src/lib/**", "src/routes/**", "static/**"];
// The packages the generated declarations import: route types import both,
// and $app/types augments `svelte/elements`.
export const kitImports = ["@sveltejs/kit", "svelte"];

// Whether a package-relative path lies in SvelteKit's output directory.
export function inKit(local: string) {
  return (
    local === directory ||
    local.startsWith(`${directory}/`) ||
    local === "node_modules/$app" ||
    local.startsWith("node_modules/$app/")
  );
}

// The error for a configuration that reads the checkout's `.svelte-kit`, which
// only `svelte-kit sync` writes, before its Bazel outputs have been published.
export function unsynced(pkg: Package, shown: string) {
  const target = pkg.rules.find((rule) => rule.kind === "js_svelte_kit");
  // A new package needs sync once before Gazelle can create its first kit rule.
  const command = target
    ? `\`bazel run //${pkg.rel}:${target.name}_write\``
    : `\`svelte-kit sync\` in //${pkg.rel} to create the first js_svelte_kit rule`;
  return new ConnectError(
    `${shown}: reads ${path.posix.join(pkg.rel, kitConfig)}, which this checkout has not generated; run ${command}`,
    Code.InvalidArgument,
  );
}
