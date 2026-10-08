# Repository guidance

Prepare dependencies with `mise run bootstrap`. Keep the public facade small and
private implementation local. Consumer-owned tool inputs must be explicit.

Run `hk check --all --slow`, `bazel build //:artifacts`, and `bazel test //:test`.
Run `bazel test //:race_test` on Linux and macOS. Preserve platform skips and
regenerate checked-in contract output when its source changes.

Keep checkouts, caches, and build outputs on the external Code drive when working
on the `/Volumes/Code` development installation. Never merge, deploy, change
organization policy, or add credentials. Workflow changes require explicit scope.
