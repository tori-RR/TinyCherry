package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	nativeChatGPTProviderID = "chatgpt-sub"
	chatGPTHostSecret       = "chatgpt-sub-host"
	chatGPTCallbackPath     = "/auth/callback"
	chatGPTAttemptTimeout   = 10 * time.Minute
	chatGPTExchangeTimeout  = 25 * time.Second
	chatGPTAuthTimeout      = 8 * time.Second
)

type chatGPTRegistration struct {
	ID, ClientID, Subject, Email              string
	AccessToken, RefreshToken, IDToken, Scope string
	ExpiresAt, EarliestRefreshAt              time.Time
	Renewing, NeedsSignIn                     bool
}

func (registration chatGPTRegistration) status() string {
	switch {
	case registration.NeedsSignIn || registration.Renewing:
		return "needs-sign-in"
	case registration.IDToken == "":
		return "signed-out"
	case !chatGPTPlanGranted(registration.Scope):
		return "identity-only"
	default:
		return "connected"
	}
}

func (registration *chatGPTRegistration) updateTokens(response chatGPTTokenResponse, scope string) {
	registration.AccessToken = response.AccessToken
	registration.RefreshToken = response.RefreshToken
	registration.Scope = scope
	registration.ExpiresAt = time.Now().Add(time.Duration(response.ExpiresIn) * time.Second)
	registration.EarliestRefreshAt = response.earliestRefresh()
	registration.Renewing = false
	registration.NeedsSignIn = false
}

type chatGPTVault struct {
	Active          string
	Accounts        []chatGPTRegistration
	PlanNoticeShown bool
}

func (vault *chatGPTVault) index(id string) int {
	return slices.IndexFunc(vault.Accounts, func(registration chatGPTRegistration) bool { return registration.ID == id })
}

type chatGPTCallback struct{ code, clientID, failure string }

type chatGPTAttempt struct {
	id, owner, selectedID, state, nonce, verifier, callbackURI string
	ctx                                                        context.Context
	cancel                                                     context.CancelFunc
	callback                                                   chan chatGPTCallback
	received                                                   atomic.Bool
	status                                                     object // Protected by server.mu.
}

// All runtime state is protected by server.mu. Network exchanges run without
// that lock and check the owner/session again before publishing their result.
type chatGPTAuthState struct {
	attempt    *chatGPTAttempt
	epoch      uint64
	requests   map[string]context.CancelFunc
	refresh    *chatGPTRefresh
	signingOut bool
	workers    sync.WaitGroup
}

func isNativeChatGPTProvider(provider object) bool {
	return provider["id"] == nativeChatGPTProviderID && provider["authType"] == "oauth"
}

func initializeNativeChatGPTProvider(provider object) {
	provider["authType"] = "oauth"
	provider["authMethods"] = []any{"oauth"}
	provider["apiKeys"] = []any{}
	provider["oauthOwnerId"] = newID()
}

func chatGPTProviderOwner(provider object) string {
	id := text(provider["oauthOwnerId"])
	if isNativeChatGPTProvider(provider) && id != "" && !strings.Contains(id, ":") {
		return id
	}
	return ""
}

func chatGPTSecretID(owner string) string {
	return nativeChatGPTProviderID + ":oauth:" + owner
}

func (s *server) chatGPTProviderLocked() (object, string, error) {
	provider, err := s.store.get("providers", nativeChatGPTProviderID)
	owner := chatGPTProviderOwner(provider)
	if err != nil || owner == "" {
		return nil, "", errors.New("ChatGPT Sub is unavailable")
	}
	return provider, owner, nil
}

func loadChatGPTVault(repository *store, owner string) (chatGPTVault, error) {
	var vault chatGPTVault
	data, err := repository.secret(chatGPTSecretID(owner))
	if errors.Is(err, sql.ErrNoRows) {
		return vault, nil
	}
	if err != nil || json.Unmarshal([]byte(data), &vault) != nil {
		return chatGPTVault{}, errors.New("ChatGPT credentials could not be opened for this Windows user")
	}
	return vault, nil
}

func saveChatGPTVault(repository *store, owner string, vault chatGPTVault) error {
	data, err := json.Marshal(vault)
	if err != nil {
		return errors.New("ChatGPT credentials could not be serialized")
	}
	if err := repository.setSecret(chatGPTSecretID(owner), string(data)); err != nil {
		return errors.New("ChatGPT credentials could not be stored securely")
	}
	return nil
}

func (s *server) saveChatGPTSessionLocked(provider object, owner string, vault chatGPTVault, enabled bool) error {
	err := s.store.transaction(func(repository *store) error {
		if err := saveChatGPTVault(repository, owner, vault); err != nil {
			return err
		}
		provider["isEnabled"] = enabled
		return repository.put("providers", provider)
	})
	if err == nil {
		s.invalidateChatGPTSessionLocked()
		s.changed("/providers", "/providers/"+nativeChatGPTProviderID)
	}
	return err
}

func (s *server) invalidateChatGPTSessionLocked() {
	s.chatGPT.epoch++
	for _, cancel := range s.chatGPT.requests {
		cancel()
	}
	clear(s.chatGPT.requests)
}

func (s *server) cancelChatGPTAttemptLocked() {
	if attempt := s.chatGPT.attempt; attempt != nil && attempt.status["status"] == "pending" {
		attempt.status = object{"status": "cancelled"}
		attempt.cancel()
	}
}

func (s *server) chatGPTCommand(route string, input object) (any, error) {
	switch route {
	case "oauth.chatgpt.logout":
		return s.logoutChatGPT()
	case "oauth.chatgpt.accounts", "oauth.chatgpt.start", "oauth.chatgpt.status", "oauth.chatgpt.cancel":
	default:
		return nil, notMigrated(route)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, owner, err := s.chatGPTProviderLocked()
	if err != nil {
		return nil, err
	}
	switch route {
	case "oauth.chatgpt.start":
		return s.startChatGPTLocked(owner, text(input["requestId"]), text(input["accountId"]))
	case "oauth.chatgpt.status", "oauth.chatgpt.cancel":
		attempt := s.chatGPT.attempt
		if attempt == nil || attempt.owner != owner || attempt.id != input["requestId"] {
			if route == "oauth.chatgpt.cancel" {
				return nil, nil
			}
			return object{"status": "cancelled"}, nil
		}
		if route == "oauth.chatgpt.cancel" {
			s.cancelChatGPTAttemptLocked()
			return nil, nil
		}
		return attempt.status, nil
	default:
		vault, err := loadChatGPTVault(s.store, owner)
		if err != nil {
			return nil, err
		}
		accounts := make([]object, 0, len(vault.Accounts))
		for _, registration := range vault.Accounts {
			status := registration.status()
			if refresh := s.chatGPT.refresh; refresh != nil && refresh.owner == owner && refresh.accountID == registration.ID {
				status = "connected"
			}
			accounts = append(accounts, object{"id": registration.ID, "email": registration.Email, "status": status})
		}
		return object{"activeAccountId": vault.Active, "accounts": accounts}, nil
	}
}

func (s *server) startChatGPTLocked(owner, requestID, accountID string) (object, error) {
	if !chatGPTOpaque(requestID, 128) {
		return nil, errors.New("invalid ChatGPT sign-in request")
	}
	if s.context.Err() != nil || s.chatGPT.signingOut {
		return nil, errors.New("ChatGPT sign-in is unavailable right now")
	}
	if current := s.chatGPT.attempt; current != nil && (current.status["status"] == "pending" || current.id == requestID) {
		return nil, errors.New("finish or cancel the current ChatGPT sign-in first")
	}
	vault, err := loadChatGPTVault(s.store, owner)
	if err != nil {
		return nil, err
	}
	query := url.Values{"client_id": {chatGPTInitialClient}, "agent_name_hint": {"TinyCherry"}}
	if accountID != "" {
		index := vault.index(accountID)
		if index < 0 {
			return nil, errors.New("ChatGPT registration is unavailable")
		}
		registration := vault.Accounts[index]
		query.Del("agent_name_hint")
		query.Set("client_id", registration.ClientID)
		// The browser selects the account; the verified subject must still match.
		// Identity tokens and email stay out of the IPC URL.
		if registration.status() == "identity-only" {
			query.Set("prompt", "consent")
		}
	}
	hostID, err := s.store.secret(chatGPTHostSecret)
	if errors.Is(err, sql.ErrNoRows) {
		hostID = "urn:uuid:" + newID()
		err = s.store.setSecret(chatGPTHostSecret, hostID)
	}
	if err != nil {
		return nil, errors.New("could not store this host's ChatGPT registration")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, errors.New("could not open the ChatGPT sign-in callback")
	}
	ctx, cancel := context.WithTimeout(s.context, chatGPTAttemptTimeout)
	random := func() string {
		var bytes [32]byte
		rand.Read(bytes[:])
		return base64.RawURLEncoding.EncodeToString(bytes[:])
	}
	attempt := &chatGPTAttempt{
		id: requestID, owner: owner, selectedID: accountID, state: random(), nonce: random(), verifier: random(),
		callbackURI: "http://" + listener.Addr().String() + chatGPTCallbackPath, ctx: ctx, cancel: cancel,
		callback: make(chan chatGPTCallback, 1), status: object{"status": "pending"},
	}
	challenge := sha256.Sum256([]byte(attempt.verifier))
	query.Set("ext_agent_host_id", hostID)
	query.Set("response_type", "code")
	query.Set("resource", chatGPTResource)
	query.Set("redirect_uri", attempt.callbackURI)
	query.Set("scope", chatGPTScopes)
	query.Set("state", attempt.state)
	query.Set("nonce", attempt.nonce)
	query.Set("code_challenge_method", "S256")
	query.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
	s.chatGPT.attempt = attempt
	s.chatGPT.workers.Add(1)
	go s.runChatGPTAttempt(listener, attempt, query.Get("client_id"))
	return object{"requestId": attempt.id, "authorizationUrl": chatGPTAuthorizeURL + "?" + query.Encode()}, nil
}

func (attempt *chatGPTAttempt) receiveCallback(host string, w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if request.Method != http.MethodGet || request.URL.Path != chatGPTCallbackPath || request.Host != host {
		http.NotFound(w, request)
		return
	}
	params, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(params["state"]) != 1 || subtle.ConstantTimeCompare([]byte(params.Get("state")), []byte(attempt.state)) != 1 {
		http.Error(w, "Invalid TinyCherry sign-in state.", http.StatusBadRequest)
		return
	}
	if attempt.ctx.Err() != nil || !attempt.received.CompareAndSwap(false, true) {
		http.Error(w, "This TinyCherry sign-in attempt has already ended.", http.StatusGone)
		return
	}
	result := chatGPTCallback{code: params.Get("code"), clientID: params.Get("client_id"), failure: params.Get("error")}
	if len(params["code"]) > 1 || len(params["client_id"]) > 1 || len(params["error"]) > 1 {
		result.failure = "invalid_callback"
	}
	_, _ = io.WriteString(w, "Return to TinyCherry to see the sign-in result. You can close this tab.")
	attempt.callback <- result
}

func (s *server) runChatGPTAttempt(listener net.Listener, attempt *chatGPTAttempt, requestedClientID string) {
	defer s.chatGPT.workers.Done()
	defer attempt.cancel()
	host := listener.Addr().String()
	callbackServer := &http.Server{
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { attempt.receiveCallback(host, w, r) }),
		ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 4 * time.Second, MaxHeaderBytes: 16 * 1024,
	}
	served := make(chan error, 1)
	go func() { served <- callbackServer.Serve(listener) }()
	defer callbackServer.Close()
	var status object
	select {
	case result := <-attempt.callback:
		status = s.finishChatGPTAuthorization(attempt, requestedClientID, result)
	case <-attempt.ctx.Done():
		status = object{"status": "expired"}
	case <-served:
		status = object{"status": "error", "message": "The ChatGPT sign-in callback stopped. Try again."}
	}
	s.mu.Lock()
	if attempt.status["status"] == "pending" {
		attempt.status = status
	}
	s.mu.Unlock()
}

func (s *server) chatGPTHTTPClient() (*http.Client, error) {
	s.mu.Lock()
	network, err := resolveNetworkSettings(s.store)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return s.networkClient(network), nil
}

func (s *server) finishChatGPTAuthorization(attempt *chatGPTAttempt, requestedClientID string, callback chatGPTCallback) object {
	failure := func(message string) object { return object{"status": "error", "message": message} }
	if callback.failure == "access_denied" {
		return object{"status": "denied"}
	}
	if callback.failure != "" || !chatGPTOpaque(callback.code, 8192) {
		return failure("OpenAI did not return a valid authorization code.")
	}
	clientID := requestedClientID
	if clientID == chatGPTInitialClient {
		clientID = callback.clientID
	} else if callback.clientID != "" && callback.clientID != clientID {
		return failure("OpenAI returned a different ChatGPT registration.")
	}
	if clientID == chatGPTInitialClient || !chatGPTOpaque(clientID, 512) {
		return failure("OpenAI did not return an issued ChatGPT client ID.")
	}
	ctx, cancel := context.WithTimeout(attempt.ctx, chatGPTExchangeTimeout)
	defer cancel()
	client, err := s.chatGPTHTTPClient()
	if err != nil {
		return failure(err.Error())
	}
	response, err := exchangeChatGPTToken(ctx, client, url.Values{
		"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {callback.code},
		"code_verifier": {attempt.verifier}, "redirect_uri": {attempt.callbackURI},
	})
	if err != nil {
		return failure(err.Error())
	}
	identity, err := validateChatGPTIDToken(ctx, client, response.IDToken, clientID, attempt.nonce, time.Now())
	if err != nil {
		return failure(err.Error())
	}
	scope := ""
	if response.Scope != nil {
		scope = *response.Scope
	}
	plan := chatGPTPlanGranted(scope)
	if plan && !response.validPlanTokens() {
		return failure("OpenAI returned incomplete ChatGPT plan credentials.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	provider, owner, err := s.chatGPTProviderLocked()
	if err != nil || owner != attempt.owner || s.chatGPT.attempt != attempt || attempt.ctx.Err() != nil || ctx.Err() != nil ||
		attempt.status["status"] != "pending" || s.chatGPT.signingOut {
		return object{"status": "cancelled"}
	}
	vault, err := loadChatGPTVault(s.store, owner)
	if err != nil {
		return failure(err.Error())
	}
	index := slices.IndexFunc(vault.Accounts, func(registration chatGPTRegistration) bool { return registration.ClientID == clientID })
	if (attempt.selectedID != "" && (index < 0 || vault.Accounts[index].ID != attempt.selectedID)) ||
		(index >= 0 && vault.Accounts[index].Subject != identity.Subject) {
		return failure("The selected ChatGPT account did not match the verified sign-in.")
	}
	account := chatGPTRegistration{ClientID: clientID, Subject: identity.Subject, Email: identity.Email, IDToken: response.IDToken}
	account.updateTokens(response, scope)
	if index >= 0 {
		account.ID = vault.Accounts[index].ID
		vault.Accounts[index] = account
	} else {
		account.ID = newID()
		vault.Accounts = append(vault.Accounts, account)
	}
	vault.Active = account.ID
	firstUse := plan && !vault.PlanNoticeShown
	vault.PlanNoticeShown = vault.PlanNoticeShown || plan
	if err := s.saveChatGPTSessionLocked(provider, owner, vault, plan); err != nil {
		return failure(err.Error())
	}
	status := object{"status": "completed", "firstUse": firstUse}
	// Commit the session and terminal status under the same lock as cancel.
	attempt.status = status
	return status
}

func (s *server) logoutChatGPT() (object, error) {
	ctx, cancel := context.WithTimeout(s.context, 11*time.Second)
	defer cancel()
	s.mu.Lock()
	_, owner, err := s.chatGPTProviderLocked()
	if err != nil || s.chatGPT.signingOut {
		s.mu.Unlock()
		return nil, errors.New("ChatGPT sign-out is unavailable right now")
	}
	s.chatGPT.signingOut = true
	s.cancelChatGPTAttemptLocked()
	s.invalidateChatGPTSessionLocked()
	refresh := s.chatGPT.refresh
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.chatGPT.signingOut = false
		s.mu.Unlock()
	}()
	if refresh != nil {
		select {
		case <-refresh.done:
		case <-ctx.Done():
		}
	}
	s.mu.Lock()
	provider, currentOwner, err := s.chatGPTProviderLocked()
	if err != nil || currentOwner != owner {
		s.mu.Unlock()
		return nil, errors.New("ChatGPT provider changed during sign-out")
	}
	vault, err := loadChatGPTVault(s.store, owner)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	var record chatGPTRegistration
	if i := vault.index(vault.Active); i >= 0 {
		record = vault.Accounts[i]
		vault.Accounts[i] = chatGPTRegistration{ID: record.ID, ClientID: record.ClientID, Subject: record.Subject, Email: record.Email}
	}
	vault.Active = ""
	err = s.saveChatGPTSessionLocked(provider, owner, vault, false)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	revoked := record.RefreshToken == "" || s.revokeChatGPT(ctx, record)
	return object{"revoked": revoked}, nil
}

func (s *server) revokeChatGPT(ctx context.Context, record chatGPTRegistration) bool {
	client, err := s.chatGPTHTTPClient()
	if err != nil {
		return false
	}
	for range 2 {
		callCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		discovery, err := discoverChatGPT(callCtx, client)
		if err == nil {
			err = chatGPTOAuthRequest(callCtx, client, discovery.Revocation, url.Values{
				"token": {record.RefreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {record.ClientID},
			}, nil)
		}
		cancel()
		if err == nil {
			return true
		}
		var failure *chatGPTOAuthFailure
		if errors.As(err, &failure) && failure.Status < 500 {
			return false
		}
		timer := time.NewTimer(700 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-timer.C:
		}
	}
	return false
}

func (s *server) waitChatGPTWorkers(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.chatGPT.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("ChatGPT authorization did not shut down: %w", ctx.Err())
	}
}
