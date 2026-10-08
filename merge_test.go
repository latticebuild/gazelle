package gazelle

import (
	"strings"
	"testing"

	gzmerger "github.com/bazel-contrib/bazel-gazelle/v2/merger"
	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
)

// mergeValue merges a host merger into an existing rule's "value" attribute
// with both of Gazelle's MergeFile passes and returns the formatted file. A
// mergeable attribute merges before resolution; a resolve attribute is set
// between the passes, as Resolve sets it, and merges after resolution.
func mergeValue(t *testing.T, old string, value rule.Merger, resolveAttribute bool) string {
	t.Helper()
	logs := captureLog(t)
	f, err := rule.LoadData("BUILD.bazel", "", []byte("fake_library(\n    name = \"lib\",\n    value = "+old+",\n)\n"))
	if err != nil {
		t.Fatal(err)
	}
	info := rule.KindInfo{MergeableAttrs: map[string]bool{}, ResolveAttrs: map[string]bool{}}
	generated := rule.NewRule("fake_library", "lib")
	if resolveAttribute {
		info.ResolveAttrs["value"] = true
	} else {
		info.MergeableAttrs["value"] = true
		generated.SetAttr("value", value)
	}
	kinds := map[string]rule.KindInfo{"fake_library": info}
	gzmerger.MergeFile(f, nil, []*rule.Rule{generated}, gzmerger.PreResolve, kinds, nil)
	if resolveAttribute {
		generated.SetAttr("value", value)
	}
	gzmerger.MergeFile(f, nil, []*rule.Rule{generated}, gzmerger.PostResolve, kinds, nil)
	if strings.Contains(logs.String(), "could not merge expression") {
		t.Errorf("Gazelle could not merge %s:\n%s", old, logs)
	}
	return string(f.Format())
}

func TestMergersPreserveKeptContentInBothPasses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		old   string
		value rule.Merger // nil for a reducer
		new   string
		want  string
	}{
		{
			name: "list keeps kept items and comments of matched items",
			old: `[
        "a",  # explains a
        "b",  # keep
        "c",
    ]`,
			new: `["a", "d"]`,
			want: `[
        "a",  # explains a
        "b",  # keep
        "d",
    ]`,
		},
		{
			// A tsconfig's later bases override earlier ones.
			name: "list takes the new order of the items both hold",
			old:  `[":kit", "//:base_tsconfig"]`,
			new:  `["//:base_tsconfig", ":kit"]`,
			want: `[
        "//:base_tsconfig",
        ":kit",
    ]`,
		},
		{
			name: "list keeps the first item under a keep comment after the bracket",
			old: `[  # keep
        "a",
        "b",
    ]`,
			new: `["c"]`,
			want: `[
        # keep
        "a",
        "c",
    ]`,
		},
		{
			name: "dict keeps kept entries and comments of matched keys",
			old: `{
        "a": "old",  # explains a
        "b": "x",  # keep
        "c": "y",
    }`,
			new: `{"a": "new", "d": "z"}`,
			want: `{
        "a": "new",  # explains a
        "d": "z",
        "b": "x",  # keep
    }`,
		},
		{
			name: "select merges conditions that are not Go platforms",
			old: `select({
        "@crates_io//:x86_64-unknown-linux-gnu": [
            "a",
            "k",  # keep
        ],
        "@platforms//os:macos": ["m"],
        "//conditions:default": [],
    })`,
			new: `select({
        "@crates_io//:x86_64-unknown-linux-gnu": ["a", "b"],
        "//conditions:default": [],
    })`,
			want: `select({
        "@crates_io//:x86_64-unknown-linux-gnu": [
            "a",
            "k",  # keep
            "b",
        ],
        "//conditions:default": [],
    })`,
		},
		{
			name: "select keeps a kept condition the new value lacks",
			old: `select({
        # keep
        "@crates_io//:wasm32-wasip2": ["w"],
        "//conditions:default": ["d"],
    })`,
			new: `select({
        "//conditions:default": ["e"],
    })`,
			want: `select({
        # keep
        "@crates_io//:wasm32-wasip2": ["w"],
        "//conditions:default": ["e"],
    })`,
		},
		{
			name: "list plus select merges part by part",
			old: `[
        "a",
        "x",  # keep
    ] + select({
        "//c:one": ["b"],
        "//conditions:default": [],
    })`,
			new: `["a"] + select({
        "//c:two": ["c"],
        "//conditions:default": [],
    })`,
			want: `[
        "a",
        "x",  # keep
    ] + select({
        "//c:two": ["c"],
        "//conditions:default": [],
    })`,
		},
		{
			name: "glob replaces a list and kept items follow it",
			old: `[
        "a.rs",
        "gen.rs",  # keep
    ]`,
			new: `glob(["src/**/*.rs"])`,
			want: `glob(["src/**/*.rs"]) + [
        "gen.rs",  # keep
    ]`,
		},
		{
			name: "glob replaces a glob",
			old:  `glob(["*.rs"], exclude = ["x.rs"])`,
			new:  `glob(["src/**/*.rs"])`,
			want: `glob(["src/**/*.rs"])`,
		},
		{
			name: "list replaces a glob",
			old:  `glob(["*.rs"])`,
			new:  `["a.rs"]`,
			want: `["a.rs"]`,
		},
		{
			name: "list replaces an expression the host cannot read",
			old:  `helper()`,
			new:  `["a.rs"]`,
			want: `["a.rs"]`,
		},
		{
			name: "scalar replaces a scalar",
			old:  `"1.0"`,
			new:  `"2.0"`,
			want: `"2.0"`,
		},
		{
			name: "reducer keeps kept list items",
			old: `[
        "a",
        "b",  # keep
    ]`,
			want: `[
        "b",  # keep
    ]`,
		},
		{
			name: "reducer keeps a select's kept items and empties its default",
			old: `select({
        "@crates_io//:aarch64-apple-darwin": [
            "a",
            "k",  # keep
        ],
        "@crates_io//:x86_64-pc-windows-msvc": ["w"],
        "//conditions:default": ["d"],
    })`,
			want: `select({
        "@crates_io//:aarch64-apple-darwin": [
            "k",  # keep
        ],
        "//conditions:default": [],
    })`,
		},
	} {
		for _, resolveAttribute := range []bool{false, true} {
			phase := "PreResolve"
			if resolveAttribute {
				phase = "PostResolve"
			}
			t.Run(tc.name+"/"+phase, func(t *testing.T) {
				var value rule.Merger = reducer{}
				if tc.new != "" {
					value = merger{parseExpr(t, tc.new)}
				}
				got := mergeValue(t, tc.old, value, resolveAttribute)
				want := "fake_library(\n    name = \"lib\",\n    value = " + tc.want + ",\n)\n"
				if got != want {
					t.Errorf("merged file:\n%s\nwant:\n%s", got, want)
				}
			})
		}
	}
}

// Only a resolve attribute can lose all its content to a reducer: before
// resolution the host carries a reducer only for kept content that survived
// pre-cleaning, and Gazelle's post-resolution pass would copy the reducer's
// syntax back onto a rule whose attribute the first pass deleted.
func TestReducerDeletesResolveAttributesWithoutKeptContent(t *testing.T) {
	for _, old := range []string{
		`{"a": "b"}`,
		`glob(["*.rs"])`,
		`select({"@crates_io//:aarch64-apple-darwin": ["a"], "//conditions:default": []})`,
		`["a"] + select({"//c:x": ["b"]})`,
	} {
		if got, want := mergeValue(t, old, reducer{}, true), "fake_library(name = \"lib\")\n"; got != want {
			t.Errorf("reducing %s = %s, want %s", old, got, want)
		}
	}
}
