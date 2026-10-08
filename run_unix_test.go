//go:build unix

package gazelle

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// These tests run plugins as real child processes of the test binary, so
// pipes, graceproc supervision and exit statuses are the production ones.

// helperPlugins returns one helper plugin per "language:behavior" pair and
// the file where each records its process ID when it starts.
func helperPlugins(t *testing.T, specs ...string) ([]Plugin, string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "pids")
	var plugins []Plugin
	for _, spec := range specs {
		name, behavior, _ := strings.Cut(spec, ":")
		plugins = append(plugins, Plugin{Name: name, Executable: executable, Args: []string{pluginCommand, name, behavior, pidFile}})
	}
	return plugins, pidFile
}

// requireExited fails the test unless every plugin recorded in pidFile has
// exited within wait. It polls with a bounded interval and reports the
// processes still running at the deadline.
func requireExited(t *testing.T, pidFile string, started int, wait time.Duration) {
	t.Helper()
	contents, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, line := range strings.Fields(string(contents)) {
		pid, err := strconv.Atoi(line)
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pid)
	}
	if len(pids) != started {
		t.Fatalf("%d plugins started, want %d", len(pids), started)
	}
	deadline := time.Now().Add(wait)
	for {
		var running []int
		for _, pid := range pids {
			if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
				running = append(running, pid)
			}
		}
		if len(running) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("plugin processes %v are still running", running)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func runHelpers(t *testing.T, ctx context.Context, root string, plugins []Plugin) error {
	t.Helper()
	return Run(ctx, root, []string{"-repo_root=" + root}, plugins...)
}

func TestRunStopsPluginsAfterSuccess(t *testing.T) {
	root := workspace(t, nil)
	plugins, pids := helperPlugins(t, "fake:generate", "other:generate")
	if err := runHelpers(t, t.Context(), root, plugins); err != nil {
		t.Fatal(err)
	}
	requireExited(t, pids, 2, 0)
	got := readFile(t, root, "BUILD.bazel")
	for _, want := range []string{`fake_library(`, `other_library(`} {
		if !strings.Contains(got, want) {
			t.Errorf("BUILD.bazel lacks %s:\n%s", want, got)
		}
	}
}

func TestRunStopsEveryPluginAndCollectsDiagnosticsOnAbort(t *testing.T) {
	root := workspace(t, nil)
	plugins, pids := helperPlugins(t, "fake:invalid", "other:invalid")
	err := runHelpers(t, t.Context(), root, plugins)
	for _, want := range []string{"fake: //: fake.toml: invalid; fix it", "other: //: other.toml: invalid; fix it"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Run = %v, want an error containing %q", err, want)
		}
	}
	requireExited(t, pids, 2, 0)
	if _, err := os.Stat(filepath.Join(root, "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("BUILD.bazel was written: %v", err)
	}
}

func TestRunStopsPluginsWhenTheWalkFails(t *testing.T) {
	root := workspace(t, map[string]string{"broken/BUILD.bazel": "filegroup(\n"})
	plugins, pids := helperPlugins(t, "fake:generate")
	if err := runHelpers(t, t.Context(), root, plugins); err == nil || !strings.Contains(err.Error(), "broken/BUILD.bazel") {
		t.Fatalf("Run = %v, want the walk's parse error", err)
	}
	requireExited(t, pids, 1, 0)
}

func TestRunStopsStartedPluginsWhenALaterPluginFailsToInitialize(t *testing.T) {
	root := workspace(t, nil)
	plugins, pids := helperPlugins(t, "fake:generate", "other:reject")
	err := runHelpers(t, t.Context(), root, plugins)
	if want := "other: initialize: other.toml: rejected; fix the fixture"; err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
	requireExited(t, pids, 2, 0)
}

func TestRunReportsAPluginCrash(t *testing.T) {
	root := workspace(t, nil)
	plugins, pids := helperPlugins(t, "fake:crash")
	err := runHelpers(t, t.Context(), root, plugins)
	if want := "fake: plugin exited with status 3"; err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("Run = %v, want an error containing %q", err, want)
	}
	requireExited(t, pids, 1, 0)
	if _, err := os.Stat(filepath.Join(root, "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("BUILD.bazel was written: %v", err)
	}
}

func TestRunStopsPluginsOnCancellation(t *testing.T) {
	root := workspace(t, nil)
	plugins, pids := helperPlugins(t, "fake:hang")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- runHelpers(t, ctx, root, plugins) }()
	// The plugin marks that Generate has started; cancel only then.
	marker := filepath.Join(filepath.Dir(pids), "generating")
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, err := os.Stat(marker)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Generate did not start: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run = %v, want context.Canceled", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
	requireExited(t, pids, 1, 0)
	if _, err := os.Stat(filepath.Join(root, "BUILD.bazel")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("BUILD.bazel was written: %v", err)
	}
}

// With -strict, Gazelle calls log.Fatal on an unknown directive, which exits
// the process without running Run's cleanup. The plugin must still end,
// because its standard input closes with the process.
func TestRunEndsPluginsWhenStrictModeExitsTheProcess(t *testing.T) {
	root := workspace(t, map[string]string{"BUILD.bazel": "# gazelle:no_such_directive value\n"})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "pids")
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, runCommand, root, pidFile)
	// The plugin inherits standard error; stop waiting for it if it lingers.
	cmd.WaitDelay = 10 * time.Second
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || !strings.Contains(string(output), "unknown directive: gazelle:no_such_directive") {
		t.Fatalf("Gazelle run = %v, want a failing exit after the unknown directive:\n%s", err, output)
	}
	requireExited(t, pidFile, 1, 10*time.Second)
}
