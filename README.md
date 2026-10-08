# gazelle

[![CI](https://github.com/latticebuild/gazelle/actions/workflows/ci.yml/badge.svg)](https://github.com/latticebuild/gazelle/actions/workflows/ci.yml)
[![Bazel](https://img.shields.io/badge/Bazel-9.2.0-43A047?logo=bazel&logoColor=white)](MODULE.bazel)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A Gazelle host and JavaScript plugin for generating Bazel BUILD files from a prepared pnpm workspace. A per-kind load map selects the caller’s JavaScript rule facade; the installed index supplies exact dependency and executable labels.

## Setup

Use Bazel 9.2 with Bzlmod. Until the module is registered in the Bazel Central
Registry, pin a source revision in your root MODULE.bazel:

```starlark
bazel_dep(name = "latticebuild_gazelle", version = "0.1.2")
git_override(
    module_name = "latticebuild_gazelle",
    remote = "https://github.com/latticebuild/gazelle.git",
    commit = "FULL_COMMIT_SHA",
)
```

Replace FULL_COMMIT_SHA with the full commit hash of that revision. Also pin any
unregistered Latticebuild modules in the production dependency graph from
[MODULE.bazel](MODULE.bazel); dependency overrides do not propagate. Development
dependencies are ignored when this repository is consumed as a module.

## Usage

```starlark
load("@latticebuild_gazelle//gazelle:defs.bzl", "gazelle_binary")
gazelle_binary(name = "gazelle", plugin = "@latticebuild_gazelle//js/plugin:gazelle", index = "@npm//:workspace.json", loads = "loads.json")
```

```json
[
  {"kind": "js_tsconfig", "label": "@my_js//js:defs.bzl"},
  {"kind": "js_tsc", "label": "@my_js//js:defs.bzl"}
]
```

See [docs/usage.md](docs/usage.md) for attributes, required tool inputs and
consumer setup. The public API lives in [gazelle/](gazelle/);
the Go host lives at the repository root and the JavaScript plugin in js/plugin/.

Prepare this checkout’s plugin dependencies with `mise run bootstrap` before
building `//js/plugin:gazelle`. External source consumers use that prepared checkout
as their Gazelle module or supply another prepared plugin executable. A source
archive alone has no installed node_modules. Each JavaScript load-map kind points to the
single js/defs.bzl facade. Consumers select the npm tools they need. Run the host twice to
verify that generation settles to a clean diff.

Regenerate and verify the committed protocol with `mise run verify-generated`.
The generator owns Go and TypeScript output; style tools exclude those files.

<details>
<summary>Repository map</summary>

| Area | Location |
| --- | --- |
| Command composition | [gazelle/defs.bzl](gazelle/defs.bzl) |
| Go host | [language.go](language.go) |
| JavaScript plugin | [js/plugin/](js/plugin/) |
| Protocol | [proto/gazelle/v1/language.proto](proto/gazelle/v1/language.proto) |
| Consumer guide | [docs/usage.md](docs/usage.md) |

</details>

## Documentation and examples

See the [generated API reference](docs/README.md) and [runnable examples](examples/README.md).

## Development

Install [Mise](https://mise.jdx.dev/), then prepare this checkout:

```sh
mise trust
mise run bootstrap
hk validate
hk test
hk check --all --slow
bazel build //:artifacts
bazel test //:test
```

Tools and dependency versions are pinned in [mise.toml](mise.toml) and
[MODULE.bazel](MODULE.bazel). CI runs these gates on native Linux, macOS and
Windows runners. Repositories with a race suite also run it on Linux and macOS.
See [docs/development.md](docs/development.md) for owning checks and platform
constraints, and [ARCHITECTURE.md](ARCHITECTURE.md) for implementation decisions.

## License

[Apache License 2.0](LICENSE).

[Sponsor us](https://github.com/mathematic-inc) · [Discuss questions and ideas](https://github.com/latticebuild/gazelle/discussions)

Pull requests are limited to repository collaborators. Use Discussions for bugs,
feature requests and support. Changes merge as squash commits.
