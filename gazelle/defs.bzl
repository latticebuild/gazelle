"""Compose a Gazelle executable with the prepared JavaScript plugin."""

load("@io_bazel_rules_go//go:def.bzl", "go_binary")

visibility("public")

def gazelle_binary(name, plugin, index, loads, **kwargs):
    """Build the host with caller-owned declared plugin inputs.

    Args:
      name: Executable target name.
      plugin: Prepared executable JavaScript plugin.
      index: Version-3 pnpm workspace index.
      loads: JSON array of {kind, label} records for the selected rule owners.
      **kwargs: Standard go_binary attributes.
    """
    go_binary(
        name = name,
        srcs = [Label("//cmd/gazelle:main.go")],
        deps = [Label("//:gazelle"), Label("@gazelle//v2/cmd/gazelle/update"), Label("@io_bazel_rules_go//go/runfiles")],
        data = [plugin, index, loads],
        x_defs = {
            "main.jsPlugin": "$(rlocationpath %s)" % plugin,
            "main.pnpmIndex": "$(rlocationpath %s)" % index,
            "main.loadMap": "$(rlocationpath %s)" % loads,
        },
        **kwargs
    )
