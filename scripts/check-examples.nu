# Stage each caller before running commands that write generated SvelteKit types.
def main [] {
  let root = (pwd | path expand)
  let startup = if ($env.BAZEL_OUTPUT_USER_ROOT? | default "" | is-empty) { [] } else { [$"--output_user_root=($env.BAZEL_OUTPUT_USER_ROOT)"] }
  let flags = ($env.BAZEL_EXAMPLE_FLAGS? | default "[]" | from json)
  for directory in [examples/typescript examples/all] {
    let source = ($root | path join $directory)
    let created = (^node --input-type=module -e 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; console.log(mkdtempSync(join(tmpdir(), "gazelle-example-")));' | complete)
    if $created.exit_code != 0 { error make {msg: $"Cannot create an example workspace: ($created.stderr)"} }
    let scratch = ($created.stdout | str trim)
    if ($scratch | is-empty) or (($scratch | path type) != "dir") or (not ($scratch | path basename | str starts-with "gazelle-example-")) {
      error make {msg: "Example staging did not create an owned workspace"}
    }
    try {
      let files = (^git ls-files --cached --others --exclude-standard -- $directory | lines | uniq)
      for file in $files {
        let input = ($root | path join $file)
        if (($input | path type) == "file") {
          let output = ($scratch | path join ($input | path relative-to $source))
          mkdir ($output | path dirname)
          cp $input $output
        }
      }
      let module_file = ($scratch | path join MODULE.bazel)
      let parent = ($root | to json --raw)
      open --raw $module_file | str replace 'path = "../.."' $'path = ($parent)' | save --force $module_file
      cd $scratch
      ^pnpm install --frozen-lockfile
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"Example bootstrap failed: ($directory)"} }
      if $directory == examples/all {
        ^bazel ...$startup run //site:kit_write ...$flags
        if $env.LAST_EXIT_CODE != 0 { error make {msg: "Example SvelteKit preparation failed"} }
      }
      ^bazel ...$startup run //:gazelle ...$flags -- -repo_root . -strict -mode=diff
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"Stale example BUILD files: ($directory)"} }
      ^bazel ...$startup build //:artifacts ...$flags
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"Example build failed: ($directory)"} }
      ^bazel ...$startup test //:test ...$flags --test_env=TMP --test_env=TEMP
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"Example tests failed: ($directory)"} }
      ^bazel ...$startup run //:gazelle ...$flags -- -repo_root . -strict -mode=diff
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"Example generation did not settle: ($directory)"} }
    } catch { |failure|
      cleanup $root $scratch $startup
      error make {msg: $failure.msg}
    }
    cleanup $root $scratch $startup
  }
}

# Expunge shuts down this caller's server and removes its temporary build outputs.
def --env cleanup [root: string, scratch: string, startup: list<string>] {
  if ($scratch | path join MODULE.bazel | path exists) {
    cd $scratch
    let stopped = (^bazel ...$startup clean --expunge | complete)
    cd $root
    if $stopped.exit_code != 0 { error make {msg: $"Cannot clean example workspace ($scratch): ($stopped.stderr)"} }
  } else {
    cd $root
  }
  rm --recursive --force $scratch
}
