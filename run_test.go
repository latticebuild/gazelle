package gazelle

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

// captureStdout redirects os.Stdout, where Gazelle prints and diffs BUILD
// files, for the rest of the test and returns a reader of what was written.
func captureStdout(t *testing.T) func() string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	previous := os.Stdout
	os.Stdout = file
	t.Cleanup(func() {
		os.Stdout = previous
		_ = file.Close()
	})
	return func() string {
		contents, err := os.ReadFile(file.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(contents)
	}
}

func TestRunAbortsBeforeWritingInEveryMode(t *testing.T) {
	existing := "filegroup(name = \"authored\")\n"
	for _, mode := range []string{"fix", "diff", "print"} {
		t.Run(mode, func(t *testing.T) {
			root := workspace(t, map[string]string{"ok/a.txt": "", "pkg/BUILD.bazel": existing})
			fake := &fakeLanguage{
				initialize: fakeInitialize("ok", "pkg"),
				generate: func(request *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
					if request.GetPackage() == "pkg" {
						return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("pkg/fake.toml: invalid; fix it"))
					}
					return &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
						fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": listOf("a.txt")}),
					}}, nil
				},
			}
			stdout := captureStdout(t)
			err := runFakes(t, root, []string{"-mode=" + mode}, map[string]*fakeLanguage{"fake": fake})
			if want := "fake: //pkg: pkg/fake.toml: invalid; fix it"; err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("Run = %v, want an error containing %q", err, want)
			}
			if out := stdout(); out != "" {
				t.Errorf("Gazelle wrote to standard output:\n%s", out)
			}
			if _, err := os.Stat(filepath.Join(root, "ok", "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
				t.Errorf("ok/BUILD.bazel was written: %v", err)
			}
			if got := readFile(t, root, "pkg/BUILD.bazel"); got != existing {
				t.Errorf("pkg/BUILD.bazel changed to:\n%s", got)
			}
		})
	}
}

func TestRunReportsInternalPluginErrorsWithTheirCode(t *testing.T) {
	root := workspace(t, nil)
	fake := &fakeLanguage{
		initialize: fakeInitialize(""),
		generate: func(*gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			return nil, connect.NewError(connect.CodeInternal, errors.New("index out of range"))
		},
	}
	err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": fake})
	if want := "fake: //: internal: index out of range"; err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
}

func TestRunRejectsInvalidPlugins(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "fake")
	for _, tc := range []struct {
		name    string
		plugins []Plugin
		want    string
	}{
		{"unnamed", []Plugin{{Executable: executable}}, "no language name"},
		{"duplicate", []Plugin{{Name: "fake", Executable: executable}, {Name: "fake", Executable: executable}}, `two plugins implement language "fake"`},
		{"relative executable", []Plugin{{Name: "fake", Executable: "fake"}}, `executable "fake" is not an absolute path`},
	} {
		if err := Run(t.Context(), t.TempDir(), nil, tc.plugins...); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("Run(%s) = %v, want an error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestRunRejectsInvalidInitializeResponses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		other *gazellev1.InitializeResponse
		want  string
	}{
		{
			name:  "a kind two languages declare",
			other: &gazellev1.InitializeResponse{Kinds: []*gazellev1.Kind{{Name: "fake_library"}}},
			want:  "other: initialize: kind fake_library is also declared by the fake language",
		},
		{
			name:  "an attribute both mergeable and resolved",
			other: &gazellev1.InitializeResponse{Kinds: []*gazellev1.Kind{{Name: "other_library", MergeableAttributes: []string{"deps"}, ResolveAttributes: []string{"deps"}}}},
			want:  "kind other_library declares deps as both a mergeable and a resolve attribute",
		},
		{
			name:  "a non-empty attribute the kind does not own",
			other: &gazellev1.InitializeResponse{Kinds: []*gazellev1.Kind{{Name: "other_library", NonEmptyAttributes: []string{"srcs"}}}},
			want:  "kind other_library declares non-empty attribute srcs, which it does not own",
		},
		{
			name:  "a package outside the repository",
			other: &gazellev1.InitializeResponse{Packages: []string{"../outside"}},
			want:  `package "../outside" is not a slash-separated path relative to the repository root`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := workspace(t, nil)
			err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": {initialize: fakeInitialize()}, "other": {initialize: tc.other}})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Run = %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestRunRejectsInvalidGenerateResponses(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response *gazellev1.GenerateResponse
		want     string
	}{
		{
			name:     "an undeclared kind",
			response: &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{fakeRule("go_library", "lib", nil)}},
			want:     `rule "lib" has kind "go_library", which Initialize did not declare`,
		},
		{
			name:     "an invalid name",
			response: &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "a:b", nil)}},
			want:     `invalid rule name "a:b"`,
		},
		{
			name:     "a reference in a mergeable attribute",
			response: &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", map[string]*gazellev1.Value{"srcs": list(reference("lib:a", ""))})}},
			want:     `rule "lib" attribute srcs: references are allowed only in the kind's resolve attributes`,
		},
		{
			name: "a rule both generated and stale",
			response: &gazellev1.GenerateResponse{
				Rules:      []*gazellev1.GeneratedRule{fakeRule("fake_library", "lib", nil)},
				StaleRules: []*gazellev1.RuleName{{Kind: "fake_library", Name: "lib"}},
			},
			want: `rule fake_library "lib" is both generated and stale`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := workspace(t, nil)
			err := runFakes(t, root, nil, map[string]*fakeLanguage{"fake": generating("", tc.response)})
			if want := "fake: //: invalid Generate response: " + tc.want; err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("Run = %v, want an error containing %q", err, want)
			}
		})
	}
}

func TestRunReportsAPluginThatCannotStart(t *testing.T) {
	root := workspace(t, nil)
	missing := filepath.Join(t.TempDir(), "missing")
	err := Run(t.Context(), root, []string{"-repo_root=" + root}, Plugin{Name: "fake", Executable: missing})
	for _, want := range []string{"fake: initialize:", "fake: plugin"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Run = %v, want an error containing %q", err, want)
		}
	}
	if err == nil || (!strings.Contains(err.Error(), missing) && !strings.Contains(err.Error(), strconv.Quote(missing))) {
		t.Errorf("Run = %v, want the missing executable path %q", err, missing)
	}
}
