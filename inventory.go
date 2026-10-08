package gazelle

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/language"
	"github.com/bazelbuild/bazel-gazelle/walk"
	bzl "github.com/bazelbuild/buildtools/build"
	"github.com/bmatcuk/doublestar/v4"
)

// inventory lists a package's files as Gazelle's walk sees them, including
// files in subdirectories that are not packages, and the package-relative
// paths on disk that Gazelle excluded but a Bazel glob would still match:
// entries omitted by gazelle:exclude, -exclude or the .git rule, and directory
// symlinks the walk lists as files. Paths Bazel ignores are neither.
func (l *Language) inventory(args language.GenerateArgs) (files, excluded []string) {
	root := args.Config.RepoRoot
	buildFileNames := args.Config.ValidBuildFileNames
	relative := func(p string) string {
		if args.Rel == "" {
			return p
		}
		return strings.TrimPrefix(p, args.Rel+"/")
	}
	var visit func(dir string, subdirs, regularFiles []string)
	visit = func(dir string, subdirs, regularFiles []string) {
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
		if err != nil {
			l.fail(args.Rel, fmt.Errorf("list %s: %w", dir, err))
			return
		}
		for _, entry := range entries {
			name := entry.Name()
			p := path.Join(dir, name)
			full := filepath.Join(root, filepath.FromSlash(p))
			switch {
			case slices.Contains(subdirs, name):
			case slices.Contains(regularFiles, name):
				if entry.Type()&fs.ModeSymlink != 0 && isDirectory(full) {
					excluded = append(excluded, relative(p))
				} else {
					files = append(files, relative(p))
				}
			default:
				directory := entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 && isDirectory(full)
				if l.ignored.matches(p, directory) || directory && hasBuildFile(full, buildFileNames) {
					continue
				}
				excluded = append(excluded, relative(p))
			}
		}
		for _, subdir := range subdirs {
			rel := path.Join(dir, subdir)
			info, err := walk.GetDirInfo(rel)
			switch {
			case info.File != nil:
				// A subpackage: Bazel globs stop at its boundary.
			case err != nil && slices.ContainsFunc(info.RegularFiles, func(name string) bool { return slices.Contains(buildFileNames, name) }):
				l.fail(args.Rel, fmt.Errorf("the BUILD file of subpackage %s does not parse, so its files are left out: %w", rel, err))
			case err != nil:
				l.fail(args.Rel, fmt.Errorf("list %s: %w", rel, err))
			default:
				visit(rel, info.Subdirs, info.RegularFiles)
			}
		}
	}
	// In update_only generation mode the walk also lists nested entries,
	// which the recursion below finds by itself.
	visit(args.Rel, direct(args.Subdirs), direct(args.RegularFiles))
	slices.Sort(files)
	slices.Sort(excluded)
	return files, excluded
}

func direct(names []string) []string {
	return slices.DeleteFunc(slices.Clone(names), func(name string) bool { return strings.Contains(name, "/") })
}

func isDirectory(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func hasBuildFile(dir string, names []string) bool {
	for _, name := range names {
		if info, err := os.Stat(filepath.Join(dir, name)); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

// bazelIgnore holds the paths Bazel itself ignores, read the way Gazelle's
// walk reads them (walk/config.go), whose filter is unexported: exact paths
// from .bazelignore, and REPO.bazel ignore_directories patterns for
// directories. Gazelle logs unreadable files and patterns; the host skips them
// the same way.
type bazelIgnore struct {
	paths       map[string]bool
	directories []string
}

func readBazelIgnore(root string) bazelIgnore {
	ignore := bazelIgnore{paths: map[string]bool{}}
	if file, err := os.Open(filepath.Join(root, ".bazelignore")); err == nil {
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") || strings.ContainsAny(line, "*?[") {
				continue
			}
			ignore.paths[path.Clean(line)] = true
		}
		_ = file.Close()
	}
	contents, err := os.ReadFile(filepath.Join(root, "REPO.bazel"))
	if err != nil {
		return ignore
	}
	repo, err := bzl.Parse(root, contents)
	if err != nil {
		return ignore
	}
	for _, stmt := range repo.Stmt {
		call, ok := stmt.(*bzl.CallExpr)
		if !ok {
			continue
		}
		if name, ok := call.X.(*bzl.Ident); !ok || name.Name != "ignore_directories" {
			continue
		}
		if len(call.List) != 1 {
			break
		}
		patterns, _ := call.List[0].(*bzl.ListExpr)
		if patterns == nil {
			break
		}
		for _, item := range patterns.List {
			if pattern, ok := item.(*bzl.StringExpr); ok {
				if _, err := doublestar.Match(pattern.Value, "x"); err == nil {
					ignore.directories = append(ignore.directories, pattern.Value)
				}
			}
		}
		// Gazelle reads only the first ignore_directories call.
		break
	}
	return ignore
}

// matches reports whether Bazel ignores the slash-separated repository path p.
func (b bazelIgnore) matches(p string, directory bool) bool {
	if b.paths[p] {
		return true
	}
	return directory && slices.ContainsFunc(b.directories, func(pattern string) bool {
		return doublestar.MatchUnvalidated(pattern, p)
	})
}
