package gazelle

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
	"github.com/latticebuild/gazelle/generated/gazelle/v1/gazellev1connect"
)

// The test binary doubles as a plugin process and as a whole-Run process, so
// lifecycle tests exercise real pipes, graceproc and exit statuses:
//
//	<test binary> gazelle-test-plugin <language> <behavior> <pid file>
//	<test binary> gazelle-test-run <repository root> <pid file>
const (
	pluginCommand = "gazelle-test-plugin"
	runCommand    = "gazelle-test-run"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case pluginCommand:
			os.Exit(pluginMain(os.Args[2], os.Args[3], os.Args[4]))
		case runCommand:
			os.Exit(runMain(os.Args[2], os.Args[3]))
		}
	}
	if temporary := os.Getenv("TEST_TMPDIR"); temporary != "" {
		for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
			if err := os.Setenv(name, temporary); err != nil {
				panic(err)
			}
		}
	}
	os.Exit(m.Run())
}

// pluginMain serves a helper plugin on standard input and output. It records
// its process ID first so tests can prove it is gone.
func pluginMain(name, behavior, pidFile string) int {
	if err := appendLine(pidFile, fmt.Sprint(os.Getpid())); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fake := helperLanguage(name, behavior, filepath.Dir(pidFile))
	if err := serve(&pipeConn{reader: os.Stdin, writer: os.Stdout}, fake); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// runMain runs Gazelle with -strict and one helper plugin, for the test that
// proves the plugin ends when Gazelle exits the process directly.
func runMain(root, pidFile string) int {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	plugin := Plugin{Name: "fake", Executable: executable, Args: []string{pluginCommand, "fake", "generate", pidFile}}
	if err := Run(context.Background(), root, []string{"-repo_root=" + root, "-strict"}, plugin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func appendLine(file, line string) error {
	out, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, line)
	return errors.Join(err, out.Close())
}

// helperLanguage returns the behavior of a helper plugin for language name,
// which generates in the root package. dir receives marker files the tests
// wait for.
func helperLanguage(name, behavior, dir string) *fakeLanguage {
	fake := &fakeLanguage{
		initialize: languageInitialize(name, ""),
		generate: func(*gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			return &gazellev1.GenerateResponse{Rules: []*gazellev1.GeneratedRule{
				fakeRule(name+"_library", name, map[string]*gazellev1.Value{"srcs": listOf("generated.txt")}),
			}}, nil
		},
	}
	switch behavior {
	case "reject":
		fake.initializeErr = connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s.toml: rejected; fix the fixture", name))
	case "invalid":
		fake.generate = func(*gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s.toml: invalid; fix it", name))
		}
	case "crash":
		fake.generate = func(*gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			os.Exit(3)
			return nil, nil
		}
	case "hang":
		fake.generateContext = func(ctx context.Context, _ *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error) {
			if err := os.WriteFile(filepath.Join(dir, "generating"), nil, 0o600); err != nil {
				return nil, err
			}
			<-ctx.Done()
			return nil, ctx.Err()
		}
	}
	return fake
}

// fakeLanguage is a plugin implemented in Go. Unset functions answer with
// empty responses; every request is recorded.
type fakeLanguage struct {
	initialize      *gazellev1.InitializeResponse
	initializeErr   error
	generate        func(*gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error)
	generateContext func(context.Context, *gazellev1.GenerateRequest) (*gazellev1.GenerateResponse, error)
	index           func(*gazellev1.IndexRequest) (*gazellev1.IndexResponse, error)

	mu        sync.Mutex
	generated []*gazellev1.GenerateRequest
	indexed   []*gazellev1.IndexRequest
}

func (f *fakeLanguage) Initialize(context.Context, *connect.Request[gazellev1.InitializeRequest]) (*connect.Response[gazellev1.InitializeResponse], error) {
	if f.initializeErr != nil {
		return nil, f.initializeErr
	}
	return connect.NewResponse(f.initialize), nil
}

func (f *fakeLanguage) Generate(ctx context.Context, request *connect.Request[gazellev1.GenerateRequest]) (*connect.Response[gazellev1.GenerateResponse], error) {
	f.mu.Lock()
	f.generated = append(f.generated, request.Msg)
	f.mu.Unlock()
	var response *gazellev1.GenerateResponse
	var err error
	switch {
	case f.generateContext != nil:
		response, err = f.generateContext(ctx, request.Msg)
	case f.generate != nil:
		response, err = f.generate(request.Msg)
	default:
		response = &gazellev1.GenerateResponse{}
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(response), nil
}

func (f *fakeLanguage) Index(_ context.Context, request *connect.Request[gazellev1.IndexRequest]) (*connect.Response[gazellev1.IndexResponse], error) {
	f.mu.Lock()
	f.indexed = append(f.indexed, request.Msg)
	f.mu.Unlock()
	if f.index == nil {
		return connect.NewResponse(&gazellev1.IndexResponse{}), nil
	}
	response, err := f.index(request.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(response), nil
}

// packages returns the packages of the recorded Generate and Index requests.
func (f *fakeLanguage) packages() (generated, indexed []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, request := range f.generated {
		generated = append(generated, request.GetPackage())
	}
	for _, request := range f.indexed {
		indexed = append(indexed, request.GetPackage())
	}
	return generated, indexed
}

// generateRequest returns the recorded Generate request for a package.
func (f *fakeLanguage) generateRequest(t *testing.T, pkg string) *gazellev1.GenerateRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, request := range f.generated {
		if request.GetPackage() == pkg {
			return request
		}
	}
	t.Fatalf("no Generate request for package %q", pkg)
	return nil
}

// serve runs handler as an HTTP/2 server on conn until the connection closes,
// as a plugin does on its standard input and output.
func serve(conn *pipeConn, handler gazellev1connect.LanguageServiceHandler) error {
	_, service := gazellev1connect.NewLanguageServiceHandler(handler)
	protocols := new(http.Protocols)
	protocols.SetUnencryptedHTTP2(true)
	listener := &connListener{conn: conn, closed: make(chan struct{})}
	server := &http.Server{
		Handler:   service,
		Protocols: protocols,
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateClosed {
				_ = listener.Close()
			}
		},
	}
	if err := server.Serve(listener); !errors.Is(err, net.ErrClosed) {
		return err
	}
	return nil
}

// connListener accepts one connection and then waits until it is closed.
type connListener struct {
	conn     net.Conn
	accepted bool
	closed   chan struct{}
	once     sync.Once
}

func (l *connListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.conn, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}

func (l *connListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *connListener) Addr() net.Addr { return pipeAddr("plugin") }

// launchFakes serves each plugin from the fake of the same name, in process,
// over the same pipes and transport a plugin process uses.
func launchFakes(fakes map[string]*fakeLanguage) launcher {
	return func(_ context.Context, p Plugin, _ string) (*process, error) {
		fake, ok := fakes[p.Name]
		if !ok {
			return nil, fmt.Errorf("no fake plugin %q", p.Name)
		}
		inputReader, inputWriter, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		outputReader, outputWriter, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		server := &pipeConn{reader: inputReader, writer: outputWriter}
		proc := newProcess(p.Name, &pipeConn{reader: outputReader, writer: inputWriter}, func() { _ = server.Close() })
		go func() { proc.exit(errors.Join(serve(server, fake), server.Close())) }()
		return proc, nil
	}
}

// runFakes runs Gazelle over root with in-process plugins named after the
// keys of fakes, in key order. It fails the test if Gazelle logs that it could
// not merge an expression, which the host mergers exist to prevent.
func runFakes(t *testing.T, root string, args []string, fakes map[string]*fakeLanguage) error {
	t.Helper()
	logs := captureLog(t)
	var plugins []Plugin
	for _, name := range slices.Sorted(maps.Keys(fakes)) {
		plugins = append(plugins, Plugin{Name: name, Executable: filepath.Join(root, "fake", name)})
	}
	err := run(context.Background(), root, append([]string{"-repo_root=" + root}, args...), launchFakes(fakes), plugins)
	if strings.Contains(logs.String(), "could not merge expression") {
		t.Errorf("Gazelle could not merge an expression:\n%s", logs)
	}
	return err
}

// captureLog collects Gazelle's log output for the rest of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &logs
}

// workspace writes files under a new repository root and returns the root's
// canonical path, which is the path Gazelle reports.
func workspace(t *testing.T, files map[string]string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files = maps.Clone(files)
	if files == nil {
		files = map[string]string{}
	}
	if _, ok := files["MODULE.bazel"]; !ok {
		files["MODULE.bazel"] = "module(name = \"fixture\")\n"
	}
	for name, contents := range files {
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func readFile(t *testing.T, root, name string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

// fakeInitialize declares the fake language's kinds and the packages to
// generate in.
func fakeInitialize(packages ...string) *gazellev1.InitializeResponse {
	return languageInitialize("fake", packages...)
}

// languageInitialize declares a language's kinds, loaded from
// //tools:<name>.bzl, and its directives. <name>_library owns srcs, flags (a
// dict) and version (a scalar), and resolves deps and aliases; <name>_test
// owns srcs and resolves deps.
func languageInitialize(name string, packages ...string) *gazellev1.InitializeResponse {
	return &gazellev1.InitializeResponse{
		Kinds: []*gazellev1.Kind{
			{
				Name:                name + "_library",
				MergeableAttributes: []string{"srcs", "flags", "version"},
				ResolveAttributes:   []string{"deps", "aliases"},
				NonEmptyAttributes:  []string{"srcs", "deps"},
			},
			{
				Name:                name + "_test",
				MergeableAttributes: []string{"srcs"},
				ResolveAttributes:   []string{"deps"},
				NonEmptyAttributes:  []string{"srcs"},
			},
		},
		Loads:      []*gazellev1.Load{{Label: "//tools:" + name + ".bzl", Symbols: []string{name + "_library", name + "_test"}}},
		Directives: []*gazellev1.Directive{{Name: name + "_inherited", Inherited: true}, {Name: name + "_local"}},
		Packages:   packages,
	}
}

func fakeRule(kind, name string, attributes map[string]*gazellev1.Value) *gazellev1.GeneratedRule {
	return &gazellev1.GeneratedRule{Kind: kind, Name: name, Attributes: attributes}
}

// listOf returns a list of strings.
func listOf(values ...string) *gazellev1.Value {
	list := &gazellev1.List{}
	for _, v := range values {
		list.Items = append(list.Items, stringValue(v))
	}
	return &gazellev1.Value{Value: &gazellev1.Value_List{List: list}}
}

func list(items ...*gazellev1.Value) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_List{List: &gazellev1.List{Items: items}}}
}

func reference(spec, fallback string) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_Reference{Reference: &gazellev1.Reference{
		Spec:     &gazellev1.ImportSpec{Import: spec},
		Fallback: fallback,
	}}}
}

func dict(entries ...*gazellev1.DictEntry) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_Dict{Dict: &gazellev1.Dict{Entries: entries}}}
}

func entry(key, value *gazellev1.Value) *gazellev1.DictEntry {
	return &gazellev1.DictEntry{Key: key, Value: value}
}

func selection(cases ...*gazellev1.SelectCase) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_Select{Select: &gazellev1.Select{Cases: cases}}}
}

func when(condition string, value *gazellev1.Value) *gazellev1.SelectCase {
	return &gazellev1.SelectCase{Condition: condition, Value: value}
}

func glob(include ...string) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_Glob{Glob: &gazellev1.Glob{Include: include}}}
}
