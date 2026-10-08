# Runnable examples

Prepare the repository with `mise run bootstrap`, then run:

```sh
bazel build //examples:artifacts
bazel test //examples:test
```

Gazelle also runs both separate consumer modules with `nu scripts/check-examples.nu`.
The runner prepares SvelteKit types in disposable callers, checks generation twice,
and removes each caller and its Bazel server after verification.

| Feature | Source | Command | Expected result |
| --- | --- | --- | --- |
| TS-only renamed consumer and prepared plugin | [typescript/README.md](typescript/README.md) | `nu scripts/check-examples.nu` | Generates, compiles and executes TypeScript using only its declared TypeScript npm tools. |
| All eleven generated kinds | [all/loads.json](all/loads.json) | `nu scripts/check-examples.nu` | Builds TypeScript, Vite, typed Svelte routes and Storybook; runs Vitest, Oxlint, Oxfmt, Knip and Prettier. |
| Authored inputs and idempotence | [all/app/BUILD.bazel](all/app/BUILD.bazel) | `nu scripts/check-examples.nu` | Keeps authored package/Vitest srcs and produces a clean second diff. |
| Keep/select/tool preservation and transactional refusal | [../js/plugin/src](../js/plugin/src) | `bazel test //:test` | Unit/e2e cases retain explicit input ownership and missing-map fix/diff/print refusal coverage. |

CI runs the root gates and both independent consumer modules. Deliberately invalid subjects
remain in test fixtures; their owner tests require the expected refusals. Fix and
editor-write commands modify the invoking checkout only when run explicitly.
Automated mutation cases use disposable invoking workspaces.
