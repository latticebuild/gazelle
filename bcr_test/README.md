# Registry consumer

This separate Bazel module consumes the public `latticebuild_gazelle` API under the
`@subject` alias. Its own-module override resolves to the extracted parent
archive; other Latticebuild modules resolve through the registry.

The BCR presubmit builds `//:artifacts` and runs `//:test`.

Prepare both the declared parent plugin tools and the caller's compiler tools:

```sh
npm exec --yes --package=@pnpm/exe@12.4.2 -- pnpm --dir .. install --frozen-lockfile
npm exec --yes --package=@pnpm/exe@12.4.2 -- pnpm install --frozen-lockfile
bazel run //:gazelle -- -repo_root . -strict -mode=diff
bazel build //:artifacts
bazel test //:test
```

The committed generated BUILD files must remain current. The emitted JavaScript
and declarations compile from the generated targets; the authored Node test
executes the resulting package through its declared package identity.
