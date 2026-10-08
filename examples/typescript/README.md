# TypeScript-only consumer

This is a separate Bzlmod workspace with renamed module and npm repository aliases.
Prepare the parent checkout first, then run from this directory:

```sh
pnpm install --frozen-lockfile
bazel run //:gazelle -- -repo_root . -strict -mode=diff
bazel build //:artifacts
bazel test //:test
```

The generated BUILD files are committed. A clean generation diff is required.
Only JS, TS and the prepared host/plugin are first-party dependencies.
Runtime inputs and dynamic configuration dependencies are declared explicitly.
