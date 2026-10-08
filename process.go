package gazelle

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/latticebuild/gazelle/generated/gazelle/v1/gazellev1connect"
	"github.com/latticebuild/graceproc"
)

// shutdownGrace is how long a plugin may take to exit after its standard input
// closes before the host interrupts it.
const shutdownGrace = 5 * time.Second

// launcher starts one plugin with the repository root as its working
// directory. Tests replace it with an in-process plugin.
type launcher func(ctx context.Context, p Plugin, root string) (*process, error)

// process is one running plugin and the Connect client bound to its standard
// input and output.
type process struct {
	name      string
	conn      *pipeConn
	transport *http.Transport
	client    gazellev1connect.LanguageServiceClient
	interrupt func()

	exited chan struct{}
	// status is the exit status as an error, nil for a zero exit. It is valid
	// once exited is closed.
	status error
}

// startProcess starts a plugin through graceproc with its standard input and
// output as one HTTP/2 connection and its standard error passed through.
// Cancelling ctx interrupts the plugin.
func startProcess(ctx context.Context, p Plugin, root string) (*process, error) {
	inputReader, inputWriter, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		_ = inputReader.Close()
		_ = inputWriter.Close()
		return nil, err
	}
	cmd := exec.Command(p.Executable, p.Args...)
	cmd.Dir = root
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inputReader, outputWriter, os.Stderr
	signals := make(chan os.Signal, 1)
	interrupt := func() {
		select {
		case signals <- os.Interrupt:
		default:
		}
	}
	proc := newProcess(p.Name, &pipeConn{reader: outputReader, writer: inputWriter}, interrupt)
	go func() {
		code, err := graceproc.Run(cmd, signals)
		// The child holds its own copies; closing ours lets the host read end
		// of standard output reach EOF.
		_ = inputReader.Close()
		_ = outputWriter.Close()
		if err == nil && code != 0 {
			err = fmt.Errorf("exited with status %d", code)
		}
		proc.exit(err)
	}()
	go func() {
		select {
		case <-ctx.Done():
			proc.interrupt()
		case <-proc.exited:
		}
	}()
	return proc, nil
}

// newProcess binds a Connect client to conn. The transport consumes conn as
// its only connection: it has no dialer, proxy or reconnect path, so a broken
// connection fails every later call instead of reaching anything else.
func newProcess(name string, conn *pipeConn, interrupt func()) *process {
	protocols := new(http.Protocols)
	protocols.SetUnencryptedHTTP2(true)
	var dialed atomic.Bool
	transport := &http.Transport{
		Protocols: protocols,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if dialed.Swap(true) {
				return nil, errors.New("the plugin connection is closed")
			}
			return conn, nil
		},
	}
	client := gazellev1connect.NewLanguageServiceClient(&http.Client{Transport: transport}, "http://plugin")
	return &process{
		name:      name,
		conn:      conn,
		transport: transport,
		client:    client,
		interrupt: interrupt,
		exited:    make(chan struct{}),
	}
}

// exit records the exit status. It is called once, when the plugin exits.
func (p *process) exit(status error) {
	p.status = status
	close(p.exited)
}

// stop closes the plugin's standard input, which asks it to exit, and waits
// for it. A plugin still running after the grace period is interrupted, and
// graceproc kills it if it does not stop. It returns the exit status.
func (p *process) stop() error {
	_ = p.conn.CloseWrite()
	timer := time.NewTimer(shutdownGrace)
	defer timer.Stop()
	select {
	case <-p.exited:
	case <-timer.C:
		p.interrupt()
		<-p.exited
	}
	p.transport.CloseIdleConnections()
	_ = p.conn.Close()
	return p.status
}

// pipeConn is a net.Conn over the pipes connected to a plugin's standard
// output (reader) and standard input (writer).
type pipeConn struct {
	reader *os.File
	writer *os.File

	closeReader, closeWriter sync.Once
	readerErr, writerErr     error
}

func (c *pipeConn) Read(b []byte) (int, error)  { return c.reader.Read(b) }
func (c *pipeConn) Write(b []byte) (int, error) { return c.writer.Write(b) }

// CloseWrite closes the plugin's standard input, so the plugin reads EOF.
func (c *pipeConn) CloseWrite() error {
	c.closeWriter.Do(func() { c.writerErr = c.writer.Close() })
	return c.writerErr
}

func (c *pipeConn) Close() error {
	c.closeReader.Do(func() { c.readerErr = c.reader.Close() })
	return errors.Join(c.CloseWrite(), c.readerErr)
}

func (c *pipeConn) LocalAddr() net.Addr  { return pipeAddr("host") }
func (c *pipeConn) RemoteAddr() net.Addr { return pipeAddr("plugin") }

func (c *pipeConn) SetDeadline(t time.Time) error {
	return errors.Join(c.SetReadDeadline(t), c.SetWriteDeadline(t))
}

func (c *pipeConn) SetReadDeadline(t time.Time) error  { return c.reader.SetReadDeadline(t) }
func (c *pipeConn) SetWriteDeadline(t time.Time) error { return c.writer.SetWriteDeadline(t) }

type pipeAddr string

func (pipeAddr) Network() string  { return "pipe" }
func (a pipeAddr) String() string { return string(a) }
