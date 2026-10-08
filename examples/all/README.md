# All-adapter consumer

This is a separate Bzlmod workspace with renamed module and npm repository aliases.
Prepare the parent checkout first, then run from this directory:

```sh
pnpm install --frozen-lockfile
bazel run //site:kit_write
bazel run //:gazelle -- -repo_root . -strict -mode=diff
bazel build //:artifacts
bazel test //:test
```

The generated BUILD files are committed. A clean generation diff is required.
The load map spans all eleven kinds; js_package and Vitest runtime inputs remain authored.
Runtime inputs and dynamic configuration dependencies are declared explicitly.

The SvelteKit write prerequisite generates ignored node_modules/$app types in
this caller checkout. Run `nu scripts/check-examples.nu` from the repository root
to prepare and verify both examples in disposable workspaces automatically.
