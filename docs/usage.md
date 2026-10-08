# Compose a JavaScript Gazelle command

Prepare this source checkout with `mise run bootstrap`, then build
`//js/plugin:gazelle`. Bootstrap installs the frozen npm graph. `mise run verify-generated` checks
protocol regeneration against committed files. The plugin build requires that prepared installation. When composing a command
in another workspace, use the prepared checkout as the Gazelle module through
a caller-owned `local_path_override`. A Git archive contains no node_modules.
The other toolkit modules can use immutable Git pins. You may also supply a
separately prepared executable through `plugin`.

Root consumers pin the selected Latticebuild modules with immutable
`git_override` commits; inspect this checkout's MODULE.bazel for dependency
pins. There is no BCR release yet. Compose the public Go host with declared
plugin, workspace-index, and load-map inputs:

```starlark
load("@latticebuild_gazelle//gazelle:defs.bzl", "gazelle_binary")
gazelle_binary(name = "gazelle", plugin = "@latticebuild_gazelle//js/plugin:gazelle", index = "@npm//:workspace.json", loads = "loads.json")
```

The npm index must have version 3. `loads.json` is an array of kind-to-facade
records. A TypeScript-only workspace can use:

```json
[
  {"kind": "js_tsconfig", "label": "@my_js//js:defs.bzl"},
  {"kind": "js_tsc", "label": "@my_js//js:defs.bzl"}
]
```

Keep js_package rules authored, loading them from rules_js. Add each generated
kind's explicit map entry when needed. Every `js_*` kind is owned by the single
`@latticebuild_js//js:defs.bzl` facade; a caller may alias that module. The map
still controls which kinds the plugin may generate.

Run `bazel run :gazelle -- -repo_root . -strict`. Select `-mode=diff` to review
changes or `-mode=print` to print proposed files. A clean second run produces no
diff. Existing whole-rule and attribute keep comments, custom tool expressions,
and hand-written package rules remain authored. Installed bindings fill new
required tool attributes; missing commands fail instead of guessing a label.

The JavaScript plugin alone accepts `--index <file>` and `--loads <file>`.
The Go executable resolves all three declared inputs through runfiles and starts
the plugin under process supervision. Cargo and Rust plugins are outside this
repository's scope.
