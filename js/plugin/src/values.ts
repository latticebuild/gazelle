// Plain attribute values exchanged with the Gazelle host. The plugin never sees
// Starlark syntax: it builds values for generated rules and reads the literal
// parts of existing ones.
import path from "node:path";

import { create } from "@bufbuild/protobuf";

import { ValueSchema } from "./generated/gazelle/v1/language_pb.js";
import type { Rule, Value } from "./generated/gazelle/v1/language_pb.js";

export type Scalar = string | number | boolean | null;

export function string(value: string): Value {
  return create(ValueSchema, { value: { case: "stringValue", value } });
}

export function scalar(value: Scalar): Value {
  if (value === null) {
    return create(ValueSchema, { value: { case: "nullValue", value: {} } });
  }
  if (typeof value === "boolean") {
    return create(ValueSchema, { value: { case: "boolValue", value } });
  }
  if (typeof value === "number") {
    return create(ValueSchema, { value: { case: "intValue", value: BigInt(value) } });
  }
  return string(value);
}

export function list(items: Value[]): Value {
  return create(ValueSchema, { value: { case: "list", value: { items } } });
}

export function strings(items: Iterable<string>): Value {
  return list([...items].map((item) => string(item)));
}

export function dict(entries: Iterable<[string, Value]>): Value {
  return create(ValueSchema, {
    value: {
      case: "dict",
      value: { entries: [...entries].map(([key, value]) => ({ key: string(key), value })) },
    },
  });
}

export function glob(include: string[], exclude: string[], allowEmpty: boolean): Value {
  return create(ValueSchema, {
    value: {
      case: "glob",
      value: { include, exclude, ...(allowEmpty ? { allowEmpty } : {}) },
    },
  });
}

// Joins list-like operands with `+`, dropping empty lists.
export function concatenation(operands: Value[]): Value {
  const present = operands.filter(
    (operand) => operand.value.case !== "list" || operand.value.value.items.length > 0,
  );
  if (present.length === 0) {
    return list([]);
  }
  if (present.length === 1) {
    return present[0]!;
  }
  return create(ValueSchema, {
    value: { case: "concatenation", value: { operands: present } },
  });
}

// A repository-relative file another package's rule provides, or else its
// fallback label.
export function reference(file: string, fallback: string): Value {
  return create(ValueSchema, {
    value: { case: "reference", value: { spec: { import: fileImport(file) }, fallback } },
  });
}

// The import a js_tsconfig or js_vite_config provides for its config file.
export function fileImport(file: string) {
  return `file:${file}`;
}

// A string literal, or undefined for any other value.
export function text(value: Value | undefined): string | undefined {
  return value?.value.case === "stringValue" ? value.value.value : undefined;
}

export function boolean(value: Value | undefined): boolean | undefined {
  return value?.value.case === "boolValue" ? value.value.value : undefined;
}

// Labels of the current package are written relative to it, and a target named
// like its directory uses Bazel's short form.
export function relativeLabel(label: string, pkg: string): string {
  let result = label.startsWith("@//") ? label.slice(1) : label;
  if (result.startsWith(`//${pkg}:`)) {
    return result.slice(pkg.length + 2);
  }
  const separator = result.lastIndexOf(":");
  if (
    separator > 0 &&
    path.posix.basename(result.slice(0, separator)) === result.slice(separator + 1)
  ) {
    result = result.slice(0, separator);
  }
  return result;
}

// Dependencies collects labels, platform-conditional labels and references and
// renders them as one attribute value.
export class Dependencies {
  readonly always = new Set<string>();
  readonly conditional = new Map<string, Set<string>>();
  readonly references = new Map<string, string>();

  add(label: string, conditions?: readonly string[]) {
    if (!conditions) {
      this.always.add(label);
      for (const labels of this.conditional.values()) {
        labels.delete(label);
      }
      return;
    }
    if (this.always.has(label)) {
      return;
    }
    for (const condition of conditions) {
      const labels = this.conditional.get(condition) ?? new Set();
      labels.add(label);
      this.conditional.set(condition, labels);
    }
  }

  // A repository-relative file in another package, provided by that package's
  // configuration rule or else by its file label.
  reference(file: string, fallback: string) {
    this.references.set(file, fallback);
  }

  value(pkg: string): Value {
    const unconditional = list([
      ...[...this.always]
        .map((label) => relativeLabel(label, pkg))
        .toSorted(compareLabels)
        .map((label) => string(label)),
      ...[...this.references.keys()]
        .toSorted()
        .map((file) => reference(file, this.references.get(file)!)),
    ]);
    const cases = [...this.conditional]
      .filter(([, labels]) => labels.size > 0)
      .toSorted(([left], [right]) => left.localeCompare(right));
    if (cases.length === 0) {
      return unconditional;
    }
    const selected = create(ValueSchema, {
      value: {
        case: "select",
        value: {
          cases: [
            ...cases.map(([condition, labels]) => ({
              condition: condition.startsWith("@//") ? condition.slice(1) : condition,
              value: strings(
                [...labels].map((label) => relativeLabel(label, pkg)).toSorted(compareLabels),
              ),
            })),
            { condition: "//conditions:default", value: list([]) },
          ],
        },
      },
    });
    return concatenation([unconditional, selected]);
  }
}

// Buildifier's order for label lists: package files, then `:` targets, then
// `//` labels, then external labels, each by their `.`- and `:`-separated parts.
function compareLabels(left: string, right: string): number {
  const difference = labelPhase(left) - labelPhase(right);
  if (difference !== 0) {
    return difference;
  }
  const a = left.replaceAll(":", ".").split(".");
  const b = right.replaceAll(":", ".").split(".");
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return a[index]! < b[index]! ? -1 : 1;
    }
  }
  return a.length - b.length || (left < right ? -1 : left > right ? 1 : 0);
}

function labelPhase(label: string) {
  if (label.startsWith(":")) {
    return 1;
  }
  if (label.startsWith("//")) {
    return 2;
  }
  return label.startsWith("@") ? 3 : 0;
}

// The target name a label refers to in package `pkg`, or undefined for a label
// in another package or repository.
export function localName(label: string, pkg: string): string | undefined {
  if (label.startsWith("@//")) {
    label = label.slice(1);
  } else if (label.startsWith("@")) {
    return undefined;
  }
  if (label.startsWith("//")) {
    const separator = label.indexOf(":");
    const directory = label.slice(2, separator < 0 ? undefined : separator);
    if (directory !== pkg) {
      return undefined;
    }
    return separator < 0 ? path.posix.basename(directory) : label.slice(separator + 1);
  }
  return label.startsWith(":") ? label.slice(1) : label;
}

// A rule attribute naming a file or target of the same package.
export function localAttribute(rule: Rule, name: string, pkg: string): string | undefined {
  const label = text(rule.attributes[name]?.value);
  return label === undefined ? undefined : localName(label, pkg);
}
