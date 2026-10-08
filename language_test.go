package gazelle

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

// generating returns a fake that generates the given response in pkg only.
func generating(pkg string, response *gazellev1.GenerateResponse) *fakeLanguage {
	return &fakeLanguage{
		initialize: fakeInitialize(pkg),
		generate: func(request *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			if request.GetPackage() != pkg {
				return &gazellev1.GenerateResponse{}, nil
			}
			return response, nil
		},
	}
}

func TestGenerateCreatesRulesWithCreationOnlyAttributes(t *testing.T) {
	root := workspace(t, map[string]string{"pkg/a.txt": ""})
	fake := generating("pkg", &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
		fakeRule("fake_library", "lib", map[string]*gazellev1.Value{
			"srcs":       listOf("a.txt"),
			"flags":      dict(entry(stringValue("mode"), stringValue("fast"))),
			"version":    stringValue("1.0"),
			"visibility": listOf("//visibility:public"),
			"deps":       list(),
		}),
		fakeRule("fake_test", "test", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
	}})
	if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
		t.Fatal(err)
	}
	want := `load("//tools:fake.bzl", "fake_library", "fake_test")

fake_library(
    name = "lib",
    srcs = ["a.txt"],
    flags = {
        "mode": "fast",
    },
    version = "1.0",
    visibility = ["//visibility:public"],
)

fake_test(
    name = "test",
    srcs = ["a.txt"],
)
`
	if got := readFile(t, root, "pkg/BUILD.bazel"); got != want {
		t.Errorf("created BUILD file:\n%s\nwant:\n%s", got, want)
	}
}

const fakeLoad = "load(\"//tools:fake.bzl\", \"fake_library\", \"fake_test\")\n\n"

// TestGenerateMaintainsExistingRules runs each case twice: the first run
// produces want and the second leaves it unchanged.
func TestGenerateMaintainsExistingRules(t *testing.T) {
	for _, tc := range []struct {
		name     string
		existing string
		rules    []*gazellev1.GeneratedRule
		stale    []*gazellev1.RuleName
		want     string
	}{
		{
			name: "absent owned attributes keep only kept content",
			existing: `fake_library(
    name = "lib",
    srcs = [
        "a.txt",
        "extra.txt",  # keep
    ],
    flags = {
        "mode": "slow",
    },
    version = "0.1",
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"version": stringValue("1.0")})},
			want: `fake_library(
    name = "lib",
    srcs = [
        "extra.txt",  # keep
    ],
    version = "1.0",
)
`,
		},
		{
			name: "an absent resolve attribute loses a stale select",
			existing: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    aliases = {
        "//old:dep": "renamed",
    },
    deps = select({
        "@platforms//os:linux": ["//old:linux"],
        "//conditions:default": [],
    }),
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")})},
			want: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
)
`,
		},
		{
			name: "an absent resolve attribute keeps a select's kept items",
			existing: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    deps = select({
        "@platforms//os:linux": [
            "//old:linux",
            "//kept:linux",  # keep
        ],
        "@platforms//os:macos": ["//old:macos"],
        "//conditions:default": ["//old:default"],
    }),
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")})},
			want: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    deps = select({
        "@platforms//os:linux": [
            "//kept:linux",  # keep
        ],
        "//conditions:default": [],
    }),
)
`,
		},
		{
			name: "present owned attributes merge with kept content",
			existing: `fake_library(
    name = "lib",
    srcs = [
        "a.txt",
        "extra.txt",  # keep
    ],
    flags = {
        "mode": "slow",  # explains mode
        "old": "x",
        "pinned": "y",  # keep
    },
    deps = [
        "//kept:dep",  # keep
        "//stale:dep",
    ],
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{
				"srcs":  glob("*.txt"),
				"flags": dict(entry(stringValue("mode"), stringValue("fast"))),
				"deps":  listOf("//new:dep"),
			})},
			want: `fake_library(
    name = "lib",
    srcs = glob(["*.txt"]) + [
        "extra.txt",  # keep
    ],
    flags = {
        "mode": "fast",  # explains mode
        "pinned": "y",  # keep
    },
    deps = [
        "//kept:dep",  # keep
        "//new:dep",
    ],
)
`,
		},
		{
			name: "an empty generated value counts as absent",
			existing: `fake_library(
    name = "lib",
    srcs = [
        "a.txt",
        "extra.txt",  # keep
    ],
    deps = ["//old:dep"],
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{
				"srcs": list(),
				"deps": selection(when("//conditions:default", list())),
			})},
			want: `fake_library(
    name = "lib",
    srcs = [
        "extra.txt",  # keep
    ],
)
`,
		},
		{
			name: "attribute-level keep leaves the attribute alone",
			existing: `fake_library(
    name = "lib",
    srcs = ["authored.txt"],  # keep
    flags = {"mode": "slow"},  # keep
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")})},
			want: `fake_library(
    name = "lib",
    srcs = ["authored.txt"],  # keep
    flags = {"mode": "slow"},  # keep
)
`,
		},
		{
			name: "missing unowned attributes are filled without changing authored values",
			existing: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    tags = ["manual"],
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{
				"srcs":       listOf("a.txt"),
				"tags":       listOf("generated"),
				"visibility": listOf("//visibility:public"),
			})},
			want: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    tags = ["manual"],
    visibility = ["//visibility:public"],
)
`,
		},
		{
			name: "a stale rule without kept content is deleted",
			existing: `filegroup(name = "files")

fake_library(
    name = "old",
    srcs = glob(["*.txt"]),
    flags = {"mode": "slow"},
    visibility = ["//visibility:public"],
    deps = ["//old:dep"],
)
`,
			stale: []*gazellev1.RuleName{{Kind: "fake_library", Name: "old"}},
			want: `filegroup(name = "files")
`,
		},
		{
			name: "a stale rule keeps its kept content",
			existing: `fake_library(
    name = "old",
    srcs = [
        "a.txt",
        "extra.txt",  # keep
    ],
    flags = {"mode": "slow"},
)
`,
			stale: []*gazellev1.RuleName{{Kind: "fake_library", Name: "old"}},
			want: `fake_library(
    name = "old",
    srcs = [
        "extra.txt",  # keep
    ],
)
`,
		},
		{
			name: "a kept stale rule is untouched",
			existing: `# keep
fake_library(
    name = "old",
    srcs = ["a.txt"],
)
`,
			stale: []*gazellev1.RuleName{{Kind: "fake_library", Name: "old"}},
			want: `# keep
fake_library(
    name = "old",
    srcs = ["a.txt"],
)
`,
		},
		{
			name: "a kind change recreates the rule",
			existing: `fake_library(
    name = "lib",
    srcs = ["a.txt"],
    deps = ["//old:dep"],
)
`,
			rules: []*gazellev1.GeneratedRule{fakeRule("fake_test", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")})},
			stale: []*gazellev1.RuleName{{Kind: "fake_library", Name: "lib"}},
			want: `fake_test(
    name = "lib",
    srcs = ["a.txt"],
)
`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := workspace(t, map[string]string{"pkg/BUILD.bazel": fakeLoad + tc.existing})
			fake := generating("pkg", &gazellev1.GenerateResponse{Rules: tc.rules, StaleRules: tc.stale})
			for range 2 {
				if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
					t.Fatal(err)
				}
				if got, want := readFile(t, root, "pkg/BUILD.bazel"), wantWithLoad(tc.want); got != want {
					t.Fatalf("BUILD file:\n%s\nwant:\n%s", got, want)
				}
			}
		})
	}
}

// wantWithLoad prefixes the fake load when the file still uses a fake kind.
func wantWithLoad(want string) string {
	if strings.Contains(want, "fake_library(") && strings.Contains(want, "fake_test(") {
		return fakeLoad + want
	}
	if strings.Contains(want, "fake_library(") {
		return "load(\"//tools:fake.bzl\", \"fake_library\")\n\n" + want
	}
	if strings.Contains(want, "fake_test(") {
		return "load(\"//tools:fake.bzl\", \"fake_test\")\n\n" + want
	}
	return want
}

func TestGenerateReportsAKindCollision(t *testing.T) {
	existing := "filegroup(name = \"lib\")\n"
	root := workspace(t, map[string]string{"pkg/BUILD.bazel": existing})
	fake := generating("pkg", &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
		fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
	}})
	err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake})
	want := `fake: //pkg: ` + filepath.Join(root, "pkg", "BUILD.bazel") + `: rule "lib" is a filegroup, but the fake language generates fake_library "lib"; rename or remove the existing rule`
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
	if got := readFile(t, root, "pkg/BUILD.bazel"); got != existing {
		t.Errorf("BUILD file changed to:\n%s", got)
	}
}

func TestGenerateSeesAnotherLanguagesCleanedFile(t *testing.T) {
	root := workspace(t, map[string]string{"pkg/BUILD.bazel": fakeLoad + `fake_library(
    name = "shared",
    srcs = ["a.txt"],
)
`})
	fake := generating("pkg", &gazellev1.GenerateResponse{
		Rules:      []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")})},
		StaleRules: []*gazellev1.RuleName{{Kind: "fake_library", Name: "shared"}},
	})
	other := generating("pkg", &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
		fakeRule("other_library", "shared", map[string]*gazellev1.Value{"srcs": listOf("b.txt")}),
	}})
	other.initialize = languageInitialize("other", "pkg")
	if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake, "other": other}); err != nil {
		t.Fatal(err)
	}
	if rules := other.generateRequest(t, "pkg").GetBuildFile().GetRules(); len(rules) != 0 {
		t.Errorf("the second language saw rules the first deleted: %v", rules)
	}
	want := `load("//tools:fake.bzl", "fake_library")
load("//tools:other.bzl", "other_library")

fake_library(
    name = "lib",
    srcs = ["a.txt"],
)

other_library(
    name = "shared",
    srcs = ["b.txt"],
)
`
	if got := readFile(t, root, "pkg/BUILD.bazel"); got != want {
		t.Errorf("BUILD file:\n%s\nwant:\n%s", got, want)
	}
}

func TestGenerateReportsANameTwoLanguagesGenerate(t *testing.T) {
	root := workspace(t, map[string]string{"pkg/a.txt": ""})
	fake := generating("pkg", &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
		fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
	}})
	other := generating("pkg", &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
		fakeRule("other_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
	}})
	other.initialize = languageInitialize("other", "pkg")
	err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake, "other": other})
	want := `other: //pkg: rule "lib" is generated both as other_library by this language and as fake_library by another`
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
	if _, err := os.Stat(filepath.Join(root, "pkg", "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a BUILD file was written: %v", err)
	}
}

func TestGenerateRunsOnlyInDeclaredPackages(t *testing.T) {
	root := workspace(t, map[string]string{"pkg/a.txt": "", "other/b.txt": ""})
	fake := &fakeLanguage{
		initialize: fakeInitialize("pkg"),
		generate: func(request *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			return &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
				fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
			}}, nil
		},
	}
	if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
		t.Fatal(err)
	}
	if packages, _ := fake.packages(); !slices.Equal(packages, []string{"pkg"}) {
		t.Errorf("Generate ran in %q, want only pkg", packages)
	}
	if _, err := os.Stat(filepath.Join(root, "other", "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a BUILD file was written outside the declared packages: %v", err)
	}
}

func TestGenerateSendsInheritedAndLocalDirectives(t *testing.T) {
	root := workspace(t, map[string]string{
		"BUILD.bazel":            "# gazelle:fake_inherited root\n# gazelle:fake_local here\n",
		"sub/BUILD.bazel":        "# gazelle:fake_inherited sub\n",
		"sub/deeper/BUILD.bazel": "",
	})
	fake := &fakeLanguage{initialize: fakeInitialize("", "sub", "sub/deeper")}
	if err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake}); err != nil {
		t.Fatal(err)
	}
	for pkg, want := range map[string][]string{
		"":           {"fake_inherited=root", "fake_local=here"},
		"sub":        {"fake_inherited=root", "fake_inherited=sub"},
		"sub/deeper": {"fake_inherited=root", "fake_inherited=sub"},
	} {
		var got []string
		for _, d := range fake.generateRequest(t, pkg).GetDirectives() {
			got = append(got, d.GetName()+"="+d.GetValue())
		}
		if !slices.Equal(got, want) {
			t.Errorf("directives in //%s = %q, want %q", pkg, got, want)
		}
	}
}

func TestGenerateRejectsMappingAnOwnedKind(t *testing.T) {
	root := workspace(t, map[string]string{"BUILD.bazel": "# gazelle:map_kind fake_library my_library //tools:my.bzl\n"})
	err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": {initialize: fakeInitialize("")}})
	want := "fake: //: gazelle:map_kind fake_library my_library //tools:my.bzl: the fake language owns kind fake_library"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
}

func TestGenerateSendsTheInventoryGazelleSees(t *testing.T) {
	root := workspace(t, map[string]string{
		".bazelignore": "pkg/ignored\npkg/ignored.txt\n",
		"REPO.bazel":   "ignore_directories([\"**/node_modules\"])\n",
		"pkg/BUILD.bazel": `# gazelle:exclude excluded
# gazelle:exclude excluded_package
# gazelle:exclude sub/skip.txt
`,
		"pkg/a.txt":                          "",
		"pkg/cli.txt":                        "",
		"pkg/sub/b.txt":                      "",
		"pkg/sub/skip.txt":                   "",
		"pkg/sub/deep/c.txt":                 "",
		"pkg/child/BUILD.bazel":              "",
		"pkg/child/d.txt":                    "",
		"pkg/excluded/e.txt":                 "",
		"pkg/excluded_package/BUILD.bazel":   "",
		"pkg/ignored/f.txt":                  "",
		"pkg/ignored.txt":                    "",
		"pkg/node_modules/dependency/g.js":   "",
		"pkg/sub/node_modules/dependency.js": "",
	})
	for link, target := range map[string]string{"pkg/directory_link": "sub", "pkg/file_link": "a.txt"} {
		if err := os.Symlink(target, filepath.Join(root, filepath.FromSlash(link))); err != nil {
			t.Fatal(err)
		}
	}
	fake := &fakeLanguage{initialize: fakeInitialize("pkg")}
	if err := runFakes(t, root, []string{"-exclude=pkg/cli.txt"}, map[string]*fakeLanguage{"fake": fake}); err != nil {
		t.Fatal(err)
	}
	request := fake.generateRequest(t, "pkg")
	if want := []string{"BUILD.bazel", "a.txt", "file_link", "sub/b.txt", "sub/deep/c.txt"}; !slices.Equal(request.GetFiles(), want) {
		t.Errorf("files = %q, want %q", request.GetFiles(), want)
	}
	// Bazel ignores .bazelignore paths and ignore_directories matches as
	// Gazelle does, so they are not excluded paths.
	if want := []string{"cli.txt", "directory_link", "excluded", "sub/skip.txt"}; !slices.Equal(request.GetExcludedPaths(), want) {
		t.Errorf("excluded paths = %q, want %q", request.GetExcludedPaths(), want)
	}
}

func TestGenerateTreatsAnUnparsableSubpackageAsABoundary(t *testing.T) {
	root := workspace(t, map[string]string{
		"pkg/a.txt":              "",
		"pkg/broken/BUILD.bazel": "fake_library(\n",
		"pkg/broken/b.txt":       "",
	})
	fake := &fakeLanguage{initialize: fakeInitialize("pkg")}
	err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake})
	want := "fake: //pkg: the BUILD file of subpackage pkg/broken does not parse, so its files are left out"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
	if got := fake.generateRequest(t, "pkg").GetFiles(); !slices.Equal(got, []string{"a.txt"}) {
		t.Errorf("files = %q, want only a.txt", got)
	}
}
