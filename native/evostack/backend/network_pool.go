package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
)

type transportPool struct {
	mu         sync.Mutex
	entries    map[[32]byte]*http.Transport
	order      [][32]byte
	closed     bool
	current    [32]byte
	hasCurrent bool
}

func newTransportPool() *transportPool {
	return &transportPool{entries: map[[32]byte]*http.Transport{}}
}

func (settings networkSettings) fingerprint() [32]byte {
	address := ""
	if settings.url != nil {
		address = settings.url.String()
	}
	encoded, _ := json.Marshal([]any{settings.mode, address, settings.bypass})
	return sha256.Sum256(encoded)
}

type closedNetworkTransport struct{}

func (closedNetworkTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("backend network is closed")
}

func (pool *transportPool) transport(settings networkSettings) http.RoundTripper {
	key := settings.fingerprint()
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.closed {
		return closedNetworkTransport{}
	}
	// A settings change retires old idle connections; active requests drain normally.
	if !pool.hasCurrent || pool.current != key {
		for _, transport := range pool.entries {
			transport.CloseIdleConnections()
		}
		pool.current, pool.hasCurrent = key, true
	}
	if transport := pool.entries[key]; transport != nil {
		return transport
	}
	if len(pool.entries) >= 8 {
		oldest := pool.order[0]
		pool.entries[oldest].CloseIdleConnections()
		delete(pool.entries, oldest)
		pool.order = pool.order[1:]
	}
	transport := newNetworkTransport(settings)
	pool.entries[key] = transport
	pool.order = append(pool.order, key)
	return transport
}

func (pool *transportPool) close() {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	pool.closed = true
	for _, transport := range pool.entries {
		transport.CloseIdleConnections()
	}
	pool.entries = map[[32]byte]*http.Transport{}
	pool.order = nil
}

func (s *server) networkClient(settings networkSettings) *http.Client {
	return &http.Client{Transport: s.networkTransports.transport(settings), CheckRedirect: noProviderRedirect}
}
func (s *server) closeNetworkTransports() { s.networkTransports.close() }

func noProviderRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
