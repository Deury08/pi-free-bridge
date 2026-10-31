package httpx

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

// BunTransportOptions configures a BunTransport.
type BunTransportOptions struct {
	Proxy                 *url.URL
	DialContext           func(ctx context.Context, network, addr string) (net.Conn, error)
	ConnectTimeout        time.Duration
	ResponseHeaderTimeout time.Duration
	IdleConnTimeout       time.Duration
	MaxIdleConnsPerHost   int
	DisableKeepAlives     bool
}

// bunConn wraps a uTLS connection with HTTP/1.1 enforcement.
type bunConn struct {
	conn      net.Conn
	transport *BunTransport
	mu        sync.Mutex
	closed    bool
}

func (c *bunConn) Read(b []byte) (int, error)  { return c.conn.Read(b) }
func (c *bunConn) Write(b []byte) (int, error) { return c.conn.Write(b) }
func (c *bunConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.conn.Close()
}
func (c *bunConn) LocalAddr() net.Addr  { return c.conn.LocalAddr() }
func (c *bunConn) RemoteAddr() net.Addr { return c.conn.RemoteAddr() }
func (c *bunConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *bunConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *bunConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }

// BunTransport is an http.RoundTripper that speaks like Bun's fetch:
// uTLS with Bun ClientHello, HTTP/1.1 only, header ordering like Bun.
type BunTransport struct {
	proxy                 *url.URL
	dialContext           func(context.Context, string, string) (net.Conn, error)
	dialer                *net.Dialer
	responseHeaderTimeout time.Duration
	idleTimeout           time.Duration
	maxIdlePerHost        int
	keepAlive             bool

	mu   sync.Mutex
	idle map[string][]*bunConn
}

func NewBunTransport(opts BunTransportOptions) (*BunTransport, error) {
	if opts.Proxy != nil {
		switch opts.Proxy.Scheme {
		case "http", "https", "socks5", "socks5h":
		default:
			return nil, fmt.Errorf("unsupported proxy scheme %q", opts.Proxy.Scheme)
		}
	}
	if opts.DialContext == nil {
		opts.DialContext = BunDialer().DialContext
	}
	if opts.ConnectTimeout == 0 {
		opts.ConnectTimeout = 10 * time.Second
	}
	if opts.ResponseHeaderTimeout == 0 {
		opts.ResponseHeaderTimeout = 30 * time.Second
	}
	if opts.IdleConnTimeout == 0 {
		opts.IdleConnTimeout = 90 * time.Second
	}
	if opts.MaxIdleConnsPerHost == 0 {
		opts.MaxIdleConnsPerHost = 256
	}
	t := &BunTransport{
		proxy:                 opts.Proxy,
		dialContext:           opts.DialContext,
		dialer:                BunDialer(),
		responseHeaderTimeout: opts.ResponseHeaderTimeout,
		idleTimeout:           opts.IdleConnTimeout,
		maxIdlePerHost:        opts.MaxIdleConnsPerHost,
		keepAlive:             !opts.DisableKeepAlives,
		idle:                  make(map[string][]*bunConn),
	}
	return t, nil
}

func (t *BunTransport) dialTLS(ctx context.Context, network, addr string) (net.Conn, error) {
	var conn net.Conn
	var err error
	if t.proxy != nil {
		conn, err = t.dialContext(ctx, network, addr)
	} else {
		conn, err = t.dialContext(ctx, network, addr)
	}
	if err != nil {
		return nil, err
	}
	host, _, _ := net.SplitHostPort(addr)
	uconn := utls.UClient(conn, BunTLSConfig(host), utls.HelloCustom)
	// Set the ClientHello spec after creation
	if err := uconn.ApplyPreset(BunClientHelloSpec()); err != nil { conn.Close(); return nil, err }
	if err := uconn.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	if uconn.ConnectionState().NegotiatedProtocol != "http/1.1" {
		uconn.Close()
		return nil, fmt.Errorf("ALPN negotiation failed: got %q, want http/1.1", uconn.ConnectionState().NegotiatedProtocol)
	}
	return uconn, nil
}

func (t *BunTransport) getConn(ctx context.Context, addr string) (*bunConn, error) {
	t.mu.Lock()
	if conns, ok := t.idle[addr]; ok && len(conns) > 0 {
		bc := conns[len(conns)-1]
		t.idle[addr] = conns[:len(conns)-1]
		t.mu.Unlock()
		bc.conn.SetReadDeadline(time.Now().Add(1 * time.Millisecond))
		_, err := bc.conn.Read(make([]byte, 1))
		bc.conn.SetReadDeadline(time.Time{})
		if err == nil || err == io.EOF {
			bc.Close()
			return t.getConn(ctx, addr)
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return bc, nil
		}
		bc.Close()
		return t.getConn(ctx, addr)
	}
	t.mu.Unlock()

	conn, err := t.dialTLS(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return &bunConn{conn: conn, transport: t}, nil
}

func (t *BunTransport) putConn(addr string, bc *bunConn) {
	if bc.closed {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.idle[addr]) >= t.maxIdlePerHost {
		bc.Close()
		return
	}
	t.idle[addr] = append(t.idle[addr], bc)
}

func (t *BunTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		return nil, fmt.Errorf("BunTransport only supports https")
	}
	addr := req.URL.Host
	if req.URL.Port() == "" {
		addr += ":443"
	}

	bc, err := t.getConn(req.Context(), addr)
	if err != nil {
		return nil, err
	}

	if err := t.writeRequest(bc, req); err != nil {
		bc.Close()
		return nil, err
	}

	resp, err := http.ReadResponse(bufio.NewReader(bc), req)
	if err != nil {
		bc.Close()
		return nil, err
	}

	if resp.Header.Get("Connection") == "close" || !t.keepAlive {
		bc.Close()
	} else {
		t.putConn(addr, bc)
	}
	return resp, nil
}

func (t *BunTransport) writeRequest(bc *bunConn, req *http.Request) error {
	buf := make([]byte, 0, 1024)
	buf = append(buf, fmt.Sprintf("%s %s HTTP/1.1\r\n", req.Method, req.URL.RequestURI())...)
	buf = append(buf, fmt.Sprintf("Host: %s\r\n", req.URL.Host)...)
	if ua := req.Header.Get("User-Agent"); ua != "" {
		buf = append(buf, fmt.Sprintf("User-Agent: %s\r\n", ua)...)
	}
	if accept := req.Header.Get("Accept"); accept != "" {
		buf = append(buf, fmt.Sprintf("Accept: %s\r\n", accept)...)
	}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		buf = append(buf, fmt.Sprintf("Content-Type: %s\r\n", ct)...)
	}
	if req.ContentLength >= 0 && req.Body != nil {
		// The body is fully buffered below; the length is known and must be
		// declared or the upstream cannot parse the request.
		buf = append(buf, fmt.Sprintf("Content-Length: %d\r\n", req.ContentLength)...)
	}
	for k, vv := range req.Header {
		cl := strings.ToLower(k)
		if cl == "host" || cl == "user-agent" || cl == "accept" || cl == "content-type" || cl == "content-length" {
			continue
		}
		for _, v := range vv {
			buf = append(buf, fmt.Sprintf("%s: %s\r\n", k, v)...)
		}
	}
	buf = append(buf, "\r\n"...)
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return err
		}
		buf = append(buf, body...)
	}
	_, err := bc.Write(buf)
	return err
}

func (t *BunTransport) CloseIdleConnections() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for addr, conns := range t.idle {
		for _, bc := range conns {
			bc.Close()
		}
		delete(t.idle, addr)
	}
}
