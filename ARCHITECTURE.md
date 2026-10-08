# A transactional Gazelle host and JavaScript plugin

The Go host owns BUILD-file updates while a declared JavaScript process analyzes
packages through ConnectRPC. Keeping analysis outside the writer lets the host
finish generation and resolution before committing any file changes. A failure
leaves the workspace unchanged in fix, diff, and print modes.

The plugin reads a versioned installed npm index and caller-supplied kind-to-load
mappings. The index carries exact allocated command labels; guessing :bin would
fail for aliases and file-name collisions. Mappings group symbols by their
public owning facade; TS-only workspaces supply only their compiler inputs. All
js_* kinds now share rules_js/js/defs.bzl.
A generated kind without a mapping fails before writing.

Existing tool expressions belong to the author. The plugin infers absent tool
attributes and the host fills them only when the existing rule lacks them.
Literal, select, opaque expressions and keep comments retain their authored
meaning. TypeScript's compiler-package directive remains an owned setting.

The four provider identities stay in rules_js. The plugin's hand-authored
bootstrap declarations compile before generation, and the protocol source owns
the generated Go and TypeScript files. Preparing a source checkout requires its
frozen npm installation; this repository does not ship a prebuilt remote plugin.
