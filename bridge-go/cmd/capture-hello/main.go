// capture-hello: raw TCP listener that dumps the first TLS record (ClientHello)
// bytes that any client sends. Run: capture-hello <listen-addr> <outfile>
// It never answers with TLS; the client's own error is fine.
package main

import (
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: capture-hello <listen-addr>")
		os.Exit(1)
	}
	addr := os.Args[1]
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("listening on %s (one capture)\n", addr)
	conn, err := ln.Accept()
	if err != nil {
		fmt.Fprintf(os.Stderr, "accept: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()
	fmt.Printf("conn from %s\n", conn.RemoteAddr())

	var all []byte
	buf := make([]byte, 16384)
	conn.SetReadDeadline(time.Now().Add(4 * time.Second))
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			all = append(all, buf[:n]...)
			if err != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	if n := conn.(*net.TCPConn); true {
		_ = n
	}
	fmt.Printf("captured %d bytes\n", len(all))
	fmt.Println(hex.Dump(all[:min(len(all), 500)]))
	dumpName := os.Args[2]
	_ = os.WriteFile(dumpName, all, 0o644)
	fmt.Printf("full dump saved to %s\n", dumpName)
	time.Sleep(200 * time.Millisecond)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ = io.Discard
