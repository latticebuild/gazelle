// Package e2e checks the real JavaScript plugin through Gazelle's Go host.
// Fixtures use .in suffixes so each test can copy a complete isolated workspace.
package e2e

import (
	"bytes"
	"io"
	"io/fs"
	"log"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/bazelbuild/buildtools/build"
	"github.com/bazelbuild/rules_go/go/runfiles"
	"github.com/latticebuild/gazelle"
)

// TestGeneration generates the fixture workspace once and then checks the
// result, a second run and a partial run in order, since each step starts
// from the previous one's BUILD files.
func TestGeneration(t *testing.T) {
	fixture := loadFixture(t)
	root := fixture.copy(t)
	plugins := []gazelle.Plugin{jsPlugin(t, fixture.pnpmIndex)}
	if _, err := run(t, root, plugins, "-strict"); err != nil {
		t.Fatalf("generating the fixture workspace failed: %v", err)
	}
	generated := buildFiles(t, root)

	t.Run("every BUILD file matches its golden", func(t *testing.T) {
		if got, want := slices.Sorted(maps.Keys(generated)), slices.Sorted(maps.Keys(fixture.goldens)); !slices.Equal(got, want) {
			t.Errorf("BUILD files = %q, want one per golden: %q", got, want)
		}
		for file, want := range fixture.goldens {
			if got, ok := generated[file]; ok && got != want {
				t.Errorf("%s differs from its golden%s; got:\n%s\nwant:\n%s", file, saveOutput(t, file, got), got, want)
			}
		}
	})

	t.Run("kept and authored attributes survive", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			file string
			kind string
			rule string
			// lines are consecutive attribute lines as the rule shows them,
			// with their trailing comments.
			lines string
		}{
			{
				name: "an attribute-level keep on an owned JavaScript attribute",
				file: "BUILD.bazel", kind: "js_tsconfig", rule: "base_tsconfig",
				lines: "srcs = [],  # keep",
			},
			{
				name: "authored attributes of a maintained Vitest rule",
				file: "js/app/BUILD.bazel", kind: "js_vitest", rule: "vitest_test",
				lines: `size = "small",
srcs = glob(["src/**/*.test.ts"]),`,
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				// A standalone attribute would lose its trailing comment, so the
				// lines are found in the formatted rule.
				got := formatRule(t, generated, tc.file, tc.kind, tc.rule)
				if !strings.Contains(got, "\n    "+strings.ReplaceAll(tc.lines, "\n", "\n    ")+"\n") {
					t.Errorf("%s %s %q:\n%s\nwant it to show:\n%s", tc.file, tc.kind, tc.rule, got, tc.lines)
				}
			})
		}
	})

	t.Run("hand-written rules are left alone", func(t *testing.T) {
		for _, tc := range []struct{ file, kind, rule, want string }{
			{
				file: "js/lib/BUILD.bazel", kind: "js_package", rule: "lib",
				want: `js_package(
    name = "lib",
    package_name = "@fixture/lib",
    srcs = [":lib_tsc"],
    visibility = ["//js:__subpackages__"],
)`,
			},
		} {
			if got := formatRule(t, generated, tc.file, tc.kind, tc.rule); got != tc.want {
				t.Errorf("%s %s %q:\n%s\nwant:\n%s", tc.file, tc.kind, tc.rule, got, tc.want)
			}
		}
	})

	t.Run("stale rules are removed unless they keep content", func(t *testing.T) {
		for _, stale := range []struct{ file, kind, rule string }{
			// tsconfig.test.json does not exist, so neither its project nor
			// its compilation remains.
			{"js/lib/BUILD.bazel", "js_tsconfig", "test_tsconfig"},
		} {
			if lookup(t, generated, stale.file, stale.kind, stale.rule) != nil {
				t.Errorf("%s still has the stale %s %q", stale.file, stale.kind, stale.rule)
			}
		}

	})

	t.Run("a second run changes nothing", func(t *testing.T) {
		diff, err := run(t, root, plugins, "-strict", "-mode=diff")
		if err != nil || diff != "" {
			t.Errorf("second run = %v with diff:\n%s", err, diff)
		}
		if !maps.Equal(buildFiles(t, root), generated) {
			t.Error("the second run changed BUILD files")
		}
	})

	t.Run("a partial run resolves references through other packages' index", func(t *testing.T) {
		// The app's editor project now also checks its Vitest config, which
		// imports the config the unchanged lib package provides.
		writeFile(t, root, "js/app/tsconfig.json", `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*.ts", "vitest.config.ts"]
}
`)
		if _, err := run(t, root, plugins, "-strict", "js/app"); err != nil {
			t.Fatalf("partial run failed: %v", err)
		}
		updated := buildFiles(t, root)
		others, unchanged := maps.Clone(updated), maps.Clone(generated)
		delete(others, "js/app/BUILD.bazel")
		delete(unchanged, "js/app/BUILD.bazel")
		if !maps.Equal(others, unchanged) {
			t.Errorf("the partial run changed BUILD files outside js/app: %q", slices.Sorted(maps.Keys(others)))
		}
		tsconfig := lookup(t, updated, "js/app/BUILD.bazel", "js_tsconfig", "tsconfig")
		if tsconfig == nil {
			t.Fatal("js/app/BUILD.bazel has no js_tsconfig \"tsconfig\"")
		}
		// lib's index names the rule providing the config; without it the
		// reference would fall back to the file label //js/lib:vitest.config.ts.
		if deps := tsconfig.AttrStrings("deps"); !slices.Contains(deps, "//js/lib:vitest_config") {
			t.Errorf("tsconfig deps = %q, want //js/lib:vitest_config from lib's index", deps)
		}
		// The root's index names the rule providing the extended config, whose
		// inheritance replaces the file label //:tsconfig.base.json.
		if bases := tsconfig.AttrStrings("extends"); !slices.Equal(bases, []string{"//:base_tsconfig"}) {
			t.Errorf("tsconfig extends = %q, want //:base_tsconfig from the root's index", bases)
		}
	})
}

func TestRunAbortsBeforeWriting(t *testing.T) {
	fixture := loadFixture(t)
	plugins := []gazelle.Plugin{jsPlugin(t, fixture.pnpmIndex)}
	for _, tc := range []struct {
		name string
		// file is replaced with contents before the run.
		file     string
		contents string
		// dirs are the directories to update; empty updates every one.
		dirs []string
		want string
	}{
		{
			name:     "a tsconfig with invalid JSON",
			file:     "js/app/tsconfig.json",
			contents: `{ "extends": "../../tsconfig.base.json",`,
			want:     "js: //js/app: js/app/tsconfig.json: '}' expected.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := fixture.copy(t)
			writeFile(t, root, tc.file, tc.contents)
			before := buildFiles(t, root)
			_, err := run(t, root, plugins, append([]string{"-strict"}, tc.dirs...)...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Run = %v, want an error containing %q", err, tc.want)
			}
			if after := buildFiles(t, root); !maps.Equal(after, before) {
				t.Errorf("BUILD files changed although the run failed: %q, want %q", slices.Sorted(maps.Keys(after)), slices.Sorted(maps.Keys(before)))
			}
		})
	}
}

// fixture is the checked-in fixture workspace and the indexes the plugins
// read for it.
type fixture struct {
	// files are the workspace's files by slash-separated path, without the
	// .in suffix.
	files map[string]string
	// goldens are the expected BUILD files by path.
	goldens   map[string]string
	pnpmIndex string
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	f := fixture{files: map[string]string{}, goldens: map[string]string{}}
	for _, location := range strings.Fields(requireEnv(t, "FIXTURES")) {
		_, rel, ok := strings.Cut(location, "/testdata/e2e/")
		if !ok {
			t.Fatalf("fixture %s is outside testdata/e2e", location)
		}
		switch rel {
		case "workspace.json":
			f.pnpmIndex = runfile(t, location)
			continue
		}
		file, ok := strings.CutPrefix(rel, "workspace/")
		if !ok {
			t.Fatalf("fixture %s is neither an index nor a workspace file", rel)
		}
		contents := readFile(t, runfile(t, location))
		if buildFile, ok := strings.CutSuffix(file, ".golden"); ok {
			f.goldens[buildFile] = contents
		} else {
			f.files[strings.TrimSuffix(file, ".in")] = contents
		}
	}
	if f.pnpmIndex == "" || len(f.goldens) == 0 {
		t.Fatal("the fixtures lack an index or goldens")
	}
	return f
}

// copy writes the workspace into a new temporary repository root and returns
// the root.
func (f fixture) copy(t *testing.T) string {
	t.Helper()
	root := temporaryRoot(t)
	for file, contents := range f.files {
		writeFile(t, root, file, contents)
	}
	return root
}

// temporaryRoot returns a new directory by its canonical path, which is the
// repository root Gazelle and the plugins report.
func temporaryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func jsPlugin(t *testing.T, pnpmIndex string) gazelle.Plugin {
	t.Helper()
	return gazelle.Plugin{
		Name:       "js",
		Executable: runfile(t, requireEnv(t, "JS_PLUGIN")),
		Args:       []string{"--index", pnpmIndex, "--loads", runfile(t, requireEnv(t, "LOADS"))},
	}
}

// run runs Gazelle over root and returns what it printed, which is the diff
// in diff mode. It fails the test if Gazelle logged that it could not merge an
// expression, which the host merger exists to prevent.
func run(t *testing.T, root string, plugins []gazelle.Plugin, args ...string) (string, error) {
	t.Helper()
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(io.MultiWriter(previous, &logs))
	defer log.SetOutput(previous)
	output, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = output.Close() }()
	stdout := os.Stdout
	os.Stdout = output
	defer func() { os.Stdout = stdout }()

	err = gazelle.Run(t.Context(), root, append([]string{"-repo_root=" + root}, args...), plugins...)
	if strings.Contains(logs.String(), "could not merge expression") {
		t.Errorf("Gazelle could not merge an expression:\n%s", logs.String())
	}
	return readFile(t, output.Name()), err
}

// buildFiles returns every BUILD file under root by slash-separated path.
func buildFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() || (entry.Name() != "BUILD.bazel" && entry.Name() != "BUILD") {
			return err
		}
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = readFile(t, file)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// formatRule returns a rule of a BUILD file of files as buildifier writes it,
// with the comments above it. It fails the test when the file has no such
// rule.
func formatRule(t *testing.T, files map[string]string, file, kind, name string) string {
	t.Helper()
	r := lookup(t, files, file, kind, name)
	if r == nil {
		t.Fatalf("%s has no %s %q:\n%s", file, kind, name, files[file])
	}
	return strings.TrimSpace(build.FormatString(r.Call))
}

// lookup parses a BUILD file of files and returns its rule of kind and name,
// or nil when it has none.
func lookup(t *testing.T, files map[string]string, file, kind, name string) *build.Rule {
	t.Helper()
	parsed, err := build.ParseBuild(file, []byte(files[file]))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range parsed.Rules(kind) {
		if r.Name() == name {
			return r
		}
	}
	return nil
}

// saveOutput keeps a mismatching BUILD file among the test's undeclared
// outputs, so it can replace the golden after review, and describes where.
func saveOutput(t *testing.T, file, contents string) string {
	t.Helper()
	outputs := os.Getenv("TEST_UNDECLARED_OUTPUTS_DIR")
	if outputs == "" {
		return ""
	}
	writeFile(t, outputs, file, contents)
	return " (saved to " + filepath.Join(outputs, filepath.FromSlash(file)) + ")"
}

// runfile returns the absolute path of a runfile.
func runfile(t *testing.T, rlocation string) string {
	t.Helper()
	location, err := runfiles.Rlocation(rlocation)
	if err != nil {
		t.Fatalf("locate runfile %s: %v", rlocation, err)
	}
	location, err = filepath.Abs(location)
	if err != nil {
		t.Fatal(err)
	}
	return location
}

// requireEnv returns an input location the Bazel test target sets.
func requireEnv(t *testing.T, name string) string {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		t.Fatalf("%s is unset; run the test with bazel test", name)
	}
	return value
}

func readFile(t *testing.T, file string) string {
	t.Helper()
	contents, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func writeFile(t *testing.T, root, file, contents string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(file))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}
