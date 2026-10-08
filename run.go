// Package gazelle runs Gazelle's update driver with languages implemented by
// plugin processes. The host keeps Gazelle's walk, directives, merging,
// indexing, resolution and writing; each plugin owns one language's semantics
// and speaks gazelle.v1.LanguageService over its standard input and output.
package gazelle

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/bazel-contrib/bazel-gazelle/v2/cmd/gazelle/update"
	"github.com/bazelbuild/bazel-gazelle/language"
)

// Plugin names a language and the executable that implements it.
type Plugin struct {
	// Name is the Gazelle language name, such as "js".
	Name string
	// Executable is the absolute path of the plugin executable.
	Executable string
	// Args are passed to the executable; paths among them must be absolute.
	Args []string
}

// Gazelle's walker, logger and merge settings are process-global, so runs in
// one process take turns.
var runMu sync.Mutex

// Run runs Gazelle's update command in dir with args and one language per
// plugin. It starts each plugin when Gazelle checks its flags and stops every
// started plugin before it returns, whatever the outcome. Any plugin,
// conversion or resolution problem stops the run before Gazelle writes, prints
// or diffs a BUILD file, and the returned error lists every problem.
func Run(ctx context.Context, dir string, args []string, plugins ...Plugin) error {
	return run(ctx, dir, args, startProcess, plugins)
}

func run(ctx context.Context, dir string, args []string, launch launcher, plugins []Plugin) (err error) {
	if err := checkPlugins(plugins); err != nil {
		return err
	}
	runMu.Lock()
	defer runMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	s := &session{ctx: ctx, launch: launch, owners: map[string]string{}}
	languages := make([]language.Language, len(plugins))
	for i, p := range plugins {
		languages[i] = &Language{plugin: p, session: s}
	}
	defer func() {
		recovered := recover()
		s.stop()
		if _, aborted := recovered.(abort); recovered != nil && !aborted {
			panic(recovered)
		}
		err = s.result(err)
	}()
	// update.Run replaces its context with context.Background() before the
	// walk, so plugin processes and calls use the session's context instead.
	return update.Run(ctx, languages, dir, args)
}

func checkPlugins(plugins []Plugin) error {
	var names []string
	for _, p := range plugins {
		switch {
		case p.Name == "":
			return errors.New("a plugin has no language name")
		case slices.Contains(names, p.Name):
			return fmt.Errorf("two plugins implement language %q", p.Name)
		case !filepath.IsAbs(p.Executable):
			return fmt.Errorf("plugin %s: executable %q is not an absolute path", p.Name, p.Executable)
		}
		names = append(names, p.Name)
	}
	return nil
}

// abort is the panic that stops Gazelle between resolution and emission. Run
// recovers it.
type abort struct{}

// session is shared by the languages of one run: it owns their processes and
// collects their diagnostics.
type session struct {
	ctx    context.Context
	launch launcher

	// owners maps each rule kind to the language that declares it.
	owners map[string]string

	mu          sync.Mutex
	processes   []*process
	diagnostics []string
	stopped     bool
}

// start launches a plugin and registers it for shutdown.
func (s *session) start(p Plugin, root string) (*process, error) {
	proc, err := s.launch(s.ctx, p, root)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.processes = append(s.processes, proc)
	return proc, nil
}

// report records a diagnostic. After cancellation it records nothing: every
// later failure is a consequence, and the result reports the cancellation.
func (s *session) report(format string, args ...any) {
	if s.ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.diagnostics = append(s.diagnostics, fmt.Sprintf(format, args...))
}

// failed reports whether the run must stop before emission.
func (s *session) failed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.diagnostics) > 0 || s.ctx.Err() != nil
}

// stop closes every started plugin, waits for each to exit and records a
// failing exit as a diagnostic. Only the first call does anything.
func (s *session) stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	processes := slices.Clone(s.processes)
	s.mu.Unlock()
	statuses := make([]error, len(processes))
	var wg sync.WaitGroup
	for i, proc := range processes {
		wg.Go(func() { statuses[i] = proc.stop() })
	}
	wg.Wait()
	for i, status := range statuses {
		if status != nil {
			s.report("%s: plugin %v", processes[i].name, status)
		}
	}
}

// result combines the driver's error with cancellation and diagnostics.
func (s *session) result(err error) error {
	s.mu.Lock()
	diagnostics := slices.Clone(s.diagnostics)
	s.mu.Unlock()
	var errs []error
	if err != nil {
		errs = append(errs, err)
	}
	if ctxErr := s.ctx.Err(); ctxErr != nil && !errors.Is(err, ctxErr) {
		errs = append(errs, ctxErr)
	}
	if len(diagnostics) > 0 {
		errs = append(errs, diagnosticsError(diagnostics))
	}
	if len(errs) == 1 {
		return errs[0]
	}
	return errors.Join(errs...)
}

// diagnosticsError lists every problem found before Gazelle wrote BUILD files.
type diagnosticsError []string

func (d diagnosticsError) Error() string {
	return "no BUILD files were written:\n  " + strings.Join(d, "\n  ")
}
