// Command gazelle generates BUILD files for the repository's JavaScript and
// packages in one Gazelle walk.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/bazel-contrib/bazel-gazelle/v2/cmd/gazelle/update"
	"github.com/bazelbuild/rules_go/go/runfiles"
	"github.com/latticebuild/gazelle"
)

// Runfile paths of the plugins and their declared inputs, set by x_defs.
var (
	jsPlugin  string
	pnpmIndex string
	loadMap   string
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil {
		if !errors.Is(err, update.ErrDiff) && !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(os.Stderr, "gazelle:", err)
		}
		if !errors.Is(err, flag.ErrHelp) {
			os.Exit(1)
		}
	}
}

func run(ctx context.Context) error {
	dir := os.Getenv("BUILD_WORKSPACE_DIRECTORY")
	if dir == "" {
		var err error
		if dir, err = os.Getwd(); err != nil {
			return err
		}
	}
	files, err := runfiles.New()
	if err != nil {
		return fmt.Errorf("locate runfiles: %w", err)
	}
	paths := map[string]string{}
	for _, path := range []string{jsPlugin, pnpmIndex, loadMap} {
		location, err := files.Rlocation(path)
		if err != nil {
			return fmt.Errorf("locate runfile %q: %w", path, err)
		}
		paths[path] = location
	}
	return gazelle.Run(ctx, dir, os.Args[1:],
		gazelle.Plugin{
			Name:       "js",
			Executable: paths[jsPlugin],
			Args:       []string{"--index", paths[pnpmIndex], "--loads", paths[loadMap]},
		},
	)
}
