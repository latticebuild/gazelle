package gazelle

import (
	"maps"
	"slices"
	"strings"
	"testing"

	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

// resolving returns a fake whose fake_library rules provide "lib:<package>"
// and whose rules named "dup" provide "lib:dup". It generates the rules given
// for each package.
func resolving(rules map[string][]*gazellev1.GeneratedRule) *fakeLanguage {
	return &fakeLanguage{
		initialize: fakeInitialize(slices.Sorted(maps.Keys(rules))...),
		generate: func(request *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			return &gazellev1.GenerateResponse{Rules: rules[request.GetPackage()]}, nil
		},
		index: func(request *gazellev1.IndexRequest) (*gazellev1.IndexResponse, error) {
			response := &gazellev1.IndexResponse{}
			for _, r := range request.GetRules() {
				provided := &gazellev1.RuleImports{Name: r.GetName()}
				switch {
				case r.GetName() == "dup":
					provided.Imports = []*gazellev1.ImportSpec{{Import: "lib:dup"}}
				case r.GetKind() == "fake_library":
					provided.Imports = []*gazellev1.ImportSpec{{Import: "lib:" + request.GetPackage()}}
				}
				response.Rules = append(response.Rules, provided)
			}
			return response, nil
		},
	}
}

func library(name string, attributes map[string]*gazellev1.Value) *gazellev1.GeneratedRule {
	attributes["srcs"] = listOf("x.txt")
	return fakeRule("fake_library", name, attributes)
}

func TestResolveTurnsReferencesIntoRelativeLabels(t *testing.T) {
	root := workspace(t, map[string]string{
		"BUILD.bazel": "# gazelle:resolve fake lib:override //elsewhere:target\n",
		"a/x.txt":     "",
		"b/x.txt":     "",
		// Gazelle indexes packages it does not update, such as ignored ones.
		"ignored/BUILD.bazel": `# gazelle:ignore
load("//tools:fake.bzl", "fake_library")

fake_library(name = "lib")
`,
	})
	fake := resolving(map[string][]*gazellev1.GeneratedRule{
		"a": {
			library("lib", map[string]*gazellev1.Value{
				"deps": list(
					reference("lib:b", ""),
					reference("lib:ignored", ""),
					reference("lib:override", ""),
					reference("lib:missing", "@external//pkg:target"),
					reference("lib:a", ""),
				),
				"aliases": dict(entry(reference("lib:b", ""), stringValue("renamed"))),
			}),
			fakeRule("fake_test", "test", map[string]*gazellev1.Value{"srcs": listOf("x.txt"), "deps": list(reference("lib:a", ""))}),
		},
		"b": {library("lib", map[string]*gazellev1.Value{})},
	})
	if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
		t.Fatal(err)
	}
	want := `load("//tools:fake.bzl", "fake_library", "fake_test")

fake_library(
    name = "lib",
    srcs = ["x.txt"],
    aliases = {
        "//b:lib": "renamed",
    },
    deps = [
        "//b:lib",
        "//elsewhere:target",
        "//ignored:lib",
        "@external//pkg:target",
    ],
)

fake_test(
    name = "test",
    srcs = ["x.txt"],
    deps = [":lib"],
)
`
	if got := readFile(t, root, "a/BUILD.bazel"); got != want {
		t.Errorf("a/BUILD.bazel:\n%s\nwant:\n%s", got, want)
	}
	_, indexed := fake.packages()
	slices.Sort(indexed)
	if want := []string{"a", "b", "ignored"}; !slices.Equal(indexed, want) {
		t.Errorf("Index ran for %q, want one call per BUILD file %q", indexed, want)
	}
}

func TestResolveReportsMissingAndAmbiguousProviders(t *testing.T) {
	for _, tc := range []struct {
		name string
		ref  *gazellev1.Value
		want string
	}{
		{"missing", reference("lib:missing", ""), `fake: //a: rule "lib": no rule provides fake import "lib:missing"; add a rule that provides it or a gazelle:resolve directive`},
		{"ambiguous", reference("lib:dup", ""), `fake: //a: rule "lib": fake import "lib:dup" is provided by //b:dup, //c:dup; add a gazelle:resolve directive to choose one`},
		{"invalid fallback", reference("lib:missing", "//a:b:c"), `fake: //a: rule "lib": fallback label for fake import "lib:missing"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := workspace(t, map[string]string{"a/x.txt": "", "b/x.txt": "", "c/x.txt": ""})
			fake := resolving(map[string][]*gazellev1.GeneratedRule{
				"a": {library("lib", map[string]*gazellev1.Value{"deps": list(tc.ref)})},
				"b": {library("dup", map[string]*gazellev1.Value{})},
				"c": {library("dup", map[string]*gazellev1.Value{})},
			})
			err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Run = %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestResolveMergesResolvedValuesWithExistingContent(t *testing.T) {
	for _, tc := range []struct {
		name     string
		existing string
		deps     *gazellev1.Value
		want     string
	}{
		{
			name: "a select with conditions that are not Go platforms",
			existing: `    deps = select({
        "@crates_io//:aarch64-apple-darwin": [
            "//stale:mac",
            "//kept:mac",  # keep
        ],
        "@crates_io//:x86_64-pc-windows-msvc": ["//stale:windows"],
        "//conditions:default": ["//stale:default"],
    }),
`,
			deps: selection(
				when("@crates_io//:aarch64-apple-darwin", list(reference("lib:b", ""))),
				when("//conditions:default", list()),
			),
			want: `    deps = select({
        "@crates_io//:aarch64-apple-darwin": [
            "//b:lib",
            "//kept:mac",  # keep
        ],
        "//conditions:default": [],
    }),
`,
		},
		{
			name: "a value that resolves to nothing keeps kept items",
			existing: `    deps = [
        "//kept:dep",  # keep
        "//stale:dep",
    ],
`,
			deps: list(reference("lib:a", "")),
			want: `    deps = [
        "//kept:dep",  # keep
    ],
`,
		},
		{
			name: "a value that resolves to nothing removes the attribute",
			existing: `    deps = select({
        "@crates_io//:aarch64-apple-darwin": ["//stale:mac"],
        "//conditions:default": [],
    }),
`,
			deps: list(reference("lib:a", "")),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rule := func(deps string) string {
				return "load(\"//tools:fake.bzl\", \"fake_library\")\n\nfake_library(\n    name = \"lib\",\n    srcs = [\"x.txt\"],\n" + deps + ")\n"
			}
			root := workspace(t, map[string]string{"a/BUILD.bazel": rule(tc.existing), "b/x.txt": ""})
			fake := resolving(map[string][]*gazellev1.GeneratedRule{
				"a": {library("lib", map[string]*gazellev1.Value{"deps": tc.deps})},
				"b": {library("lib", map[string]*gazellev1.Value{})},
			})
			for range 2 {
				if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
					t.Fatal(err)
				}
				if got, want := readFile(t, root, "a/BUILD.bazel"), rule(tc.want); got != want {
					t.Fatalf("a/BUILD.bazel:\n%s\nwant:\n%s", got, want)
				}
			}
		})
	}
}
