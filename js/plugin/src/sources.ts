// Source inventories and the decision between a glob and an explicit list.
// Globs use only literal segments, `*` within a segment and `**` as a whole
// segment, matched with Bazel's semantics over the host's package inventory.
import path from "node:path";

import type { Value } from "./generated/gazelle/v1/language_pb.js";
import { concatenation, glob, strings } from "./values.js";

// A package's files as Gazelle's walk sees them, relative to the package.
export interface Inventory {
  files: readonly string[];
  // Paths on disk that Gazelle excluded; Bazel globs would still match them.
  excluded: readonly string[];
}

// Whether a glob pattern uses only the syntax this module matches.
export function supported(pattern: string) {
  return (
    pattern !== "" &&
    !pattern.startsWith("/") &&
    !/[?\[\]\{\}\\]/v.test(pattern) &&
    pattern
      .split("/")
      .every(
        (part) =>
          part !== "" && part !== "." && part !== ".." && (part === "**" || !part.includes("**")),
      )
  );
}

export function matches(pattern: string, file: string): boolean {
  return matchSegments(pattern.split("/"), 0, file.split("/"), 0);
}

function matchSegments(pattern: string[], i: number, file: string[], j: number): boolean {
  if (i === pattern.length) {
    return j === file.length;
  }
  if (pattern[i] === "**") {
    for (let end = j; end <= file.length; end++) {
      if (matchSegments(pattern, i + 1, file, end)) {
        return true;
      }
    }
    return false;
  }
  return (
    j < file.length &&
    segment(pattern[i]!).test(file[j]!) &&
    matchSegments(pattern, i + 1, file, j + 1)
  );
}

const segments = new Map<string, RegExp>();
function segment(part: string) {
  let expression = segments.get(part);
  if (!expression) {
    expression = new RegExp(
      `^${part
        .split("*")
        .map((text) => RegExp.escape(text))
        .join(".*")}$`,
      "sv",
    );
    segments.set(part, expression);
  }
  return expression;
}

// Whether a pattern can match the directory itself or any path beneath it.
function reaches(pattern: string, directory: string): boolean {
  return matches(pattern, directory) || beneath(pattern, directory);
}

// Whether a pattern can match a path beneath the directory.
export function beneath(pattern: string, directory: string): boolean {
  const parts = pattern.split("/");
  const names = directory.split("/");
  for (const [index, name] of names.entries()) {
    const part = parts[index];
    if (part === undefined) {
      return false;
    }
    if (part === "**") {
      return true;
    }
    if (!segment(part).test(name)) {
      return false;
    }
  }
  return parts.length > names.length;
}

// Selects inventory files like Bazel's glob(include, exclude).
export function expand(
  files: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
) {
  return files.filter(
    (file) =>
      include.some((pattern) => matches(pattern, file)) &&
      !exclude.some((pattern) => matches(pattern, file)),
  );
}

// The literal segments before a pattern's first wildcard.
function prefix(pattern: string) {
  const parts = pattern.split("/");
  const wildcard = parts.findIndex((part) => part.includes("*"));
  return (wildcard < 0 ? parts : parts.slice(0, wildcard)).join("/");
}

function overlaps(left: string, right: string) {
  const a = prefix(left);
  const b = prefix(right);
  return !a || !b || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export interface Patterns {
  // Package-relative include patterns, as the configuration wrote them.
  include: readonly string[];
  exclude: readonly string[];
  // Extensions a wildcard without its own extension selects.
  extensions: readonly string[];
}

// Renders an exact file set as `[literal files] + glob(...)` when a glob built
// from the configuration's own patterns selects exactly the remaining files;
// otherwise as a sorted list.
export function sources(set: readonly string[], inventory: Inventory, patterns?: Patterns): Value {
  const selected = [...new Set(set)].toSorted();
  const listed = strings(selected);
  if (!patterns) {
    return listed;
  }
  const wanted = new Set(selected);
  const include: string[] = [];
  const optional: string[] = [];
  for (const pattern of patterns.include) {
    // A literal file is listed, whatever characters its name has.
    if (!pattern.includes("*") && path.posix.basename(pattern).includes(".")) {
      continue;
    }
    // Every emitted pattern has only literal segments free of glob
    // metacharacters, `*` and `**`; file names may contain anything.
    if (!supported(pattern)) {
      return listed;
    }
    const base = pattern.includes("*") ? pattern : `${pattern}/**/*`;
    if (patterns.extensions.some((extension) => base.endsWith(extension))) {
      include.push(base);
      continue;
    }
    // TypeScript filters an extensionless wildcard by its supported extensions,
    // which Bazel cannot express; one pattern per extension in use can.
    for (const extension of patterns.extensions) {
      const candidate = base + extension;
      if (selected.some((file) => matches(candidate, file))) {
        optional.push(candidate);
      }
    }
  }
  const globs = [...new Set([...include, ...optional])];
  if (globs.length === 0) {
    return listed;
  }
  const exclude: string[] = [];
  for (const pattern of patterns.exclude) {
    if (!supported(pattern)) {
      return listed;
    }
    // A literal exclusion names a file or a directory; keep the reading a glob
    // could select.
    if (pattern.includes("*")) {
      if (globs.some((item) => overlaps(item, pattern))) {
        exclude.push(pattern);
      }
      continue;
    }
    const directory =
      !inventory.files.includes(pattern) &&
      (inventory.files.some((file) => file.startsWith(pattern + "/")) ||
        !path.posix.basename(pattern).includes("."));
    if (directory && globs.some((item) => beneath(item, pattern))) {
      exclude.push(`${pattern}/**`);
    } else if (!directory && globs.some((item) => matches(item, pattern))) {
      exclude.push(pattern);
    }
  }
  const excludes = [...new Set(exclude)].toSorted();
  const matched = expand(inventory.files, globs, excludes);
  if (
    matched.length === 0 ||
    matched.some((file) => !wanted.has(file)) ||
    inventory.excluded.some(
      (entry) =>
        globs.some((pattern) => reaches(pattern, entry)) &&
        !excludes.some((pattern) => matches(pattern, entry) || matches(pattern, `${entry}/_`)),
    ) ||
    // Hidden names under a wildcard are a corner of glob semantics this matcher
    // does not rely on.
    globs.some((pattern) => {
      const scope = prefix(pattern);
      return inventory.files.some(
        (file) =>
          (!scope || file.startsWith(scope + "/")) &&
          file
            .slice(scope ? scope.length + 1 : 0)
            .split("/")
            .some((part) => part.startsWith(".")) &&
          matches(pattern, file),
      );
    })
  ) {
    return listed;
  }
  const allowEmpty = include.some(
    (pattern) => expand(inventory.files, [pattern], excludes).length === 0,
  );
  const matchedSet = new Set(matched);
  return concatenation([
    strings(selected.filter((file) => !matchedSet.has(file))),
    glob(globs.toSorted(), excludes, allowEmpty),
  ]);
}
