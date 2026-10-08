# Committed documentation is generated from the public Starlark API.
def main [--check] {
  let startup = if ($env.BAZEL_OUTPUT_USER_ROOT? | default "" | is-empty) {
    []
  } else {
    [$"--output_user_root=($env.BAZEL_OUTPUT_USER_ROOT)"]
  }
  ^bazel ...$startup build //docs:api
  if $env.LAST_EXIT_CODE != 0 { error make {msg: "API documentation build failed"} }
  let query = (^bazel ...$startup cquery //docs:api --output=files | complete)
  if $query.exit_code != 0 { error make {msg: $query.stderr} }
  for file in ($query.stdout | lines | where { |line| not ($line | str trim | is-empty) }) {
    let output = ("docs" | path join ($file | path basename | str replace ".generated.md" ".md"))
    let generated = (open --raw $file | str trim --right) + (char nl)
    if $check {
      if not ($output | path exists) { error make {msg: $"Missing generated document: ($output)"} }
      if (open --raw $output) != $generated { error make {msg: $"Stale generated document: ($output); run mise run docs"} }
    } else {
      $generated | save --force $output
    }
  }
}
