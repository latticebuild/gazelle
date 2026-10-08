# Development

Install Mise, then run `mise trust` and `mise run bootstrap` in this checkout.
Use the owned MODULE configuration and frozen dependency locks.

```sh
mise run verify-generated
hk check --all --slow
hk validate
hk test
bazel build //:artifacts
bazel test //:test
```

On Linux and macOS also run `bazel test //:race_test`.

Native CI runs these gates on Ubuntu 24.04, macOS 27, and Windows 2025.
See [usage.md](usage.md) for setup and supported inputs.

The renamed-module BCR consumer also runs on all three platforms. It consumes
the exact JavaScript development revision through a private registry, verifies
strict generation before and after compilation, and executes the compiled Node
test. Linux compilation stays in the native namespace sandbox; the bundled test
uses the JavaScript runtime's declared `no-sandbox` requirement. CI retains
uncached first-attempt execution logs, source hashes, and owned Bazel shutdown.

The JavaScript checks also have direct package commands, using the same pinned
compiler, Oxlint and Oxfmt tools as the Bazel targets:

```sh
pnpm --dir js/plugin run check:types
pnpm --dir js/plugin run check:lint
pnpm --dir js/plugin run check:format
```

The production plugin package has only core and TypeScript rule loads. The
parent js package owns Vitest, Ox and Knip development checks.

The separate consumer modules under examples/typescript and examples/all are
prepared by bootstrap. `nu scripts/check-examples.nu` checks clean generation,
builds their artifacts and executes their tests; native CI runs that command.

On Windows, use a temporary root with its canonical long path. Vite rejects 8.3
aliases in served paths. CI selects LOCALAPPDATA/Temp/latticebuild before dependency preparation and
forwards TMP/TEMP through Bazel tests; private runtime trees remain inside that
root. Keep this path out of installed source and dependency directories.

CI uses a short Bazel output root on Windows (`D:/b`) so native linkers can
open deeply nested runfiles. Locally, select a short writable root with
`bazel --output_user_root=C:/b test //:test` when needed. Documentation and
example scripts accept the same root through BAZEL_OUTPUT_USER_ROOT.
