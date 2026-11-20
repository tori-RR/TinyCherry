package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The bundle is only serialized into the protected secret store, never an IPC DTO.
type nousOAuthCredential struct {
	AccessToken      string    `json:"accessToken"`
	RefreshToken     string    `json:"refreshToken"`
	TokenType        string    `json:"tokenType"`
	Scope            string    `json:"scope"`
	ClientID         string    `json:"clientId"`
	InferenceBaseURL string    `json:"inferenceBaseUrl"`
	AccountID        string    `json:"accountId,omitempty"`
	ObtainedAt       time.Time `json:"obtainedAt"`
	ExpiresAt        time.Time `json:"expiresAt"`
	RequiresLogin    bool      `json:"requiresLogin,omitempty"`
}

type nousOAuthSnapshot struct {
	Generation uint64
	Credential *nousOAuthCredential
}

// Callbacks own their short database lock. The runtime never holds its mutex while
// invoking them. The binding identifies one provider incarnation, not just its name.
// Advance(nil) starts a new attempt; a conditional Advance cancels only that attempt.
// Save(..., true) replaces a session and increments its generation atomically, so a
// refresh of the previous session cannot overwrite a newly completed sign-in.
type nousOAuthStorage interface {
	Load(binding string) (nousOAuthSnapshot, error)
	Advance(binding string, expectedGeneration *uint64) (nousOAuthSnapshot, error)
	Save(binding string, expectedGeneration uint64, credential nousOAuthCredential, replaceSession bool) (bool, error)
	Delete(binding string) error
}

type nousDeviceAuthorization struct {
	RequestID               string `json:"requestId"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete,omitempty"`
	ExpiresAt               int64  `json:"expiresAt"`
	Interval                int    `json:"interval"`
}

type nousDeviceStatus struct {
	Status    string  `json:"status"`
	AccountID *string `json:"accountId"`
	Code      string  `json:"code,omitempty"`
	Message   string  `json:"message,omitempty"`
}

func (status nousDeviceStatus) MarshalJSON() ([]byte, error) {
	switch status.Status {
	case "completed":
		return json.Marshal(struct {
			Status    string  `json:"status"`
			AccountID *string `json:"accountId"`
		}{status.Status, status.AccountID})
	case "error":
		return json.Marshal(struct {
			Status  string `json:"status"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}{status.Status, status.Code, status.Message})
	default:
		return json.Marshal(struct {
			Status string `json:"status"`
		}{status.Status})
	}
}

type nousOAuthAccount struct {
	AccountID *string `json:"accountId"`
}

type nousDeviceFlow struct {
	requestID    string
	generation   uint64
	initializing bool
	status       nousDeviceStatus
	cancel       context.CancelFunc
}

type nousRefreshCall struct {
	generation       uint64
	grantFingerprint [32]byte
	done             chan struct{}
	cancel           context.CancelFunc
	credential       nousOAuthCredential
	err              error
}

type nousOAuthRuntime struct {
	context        context.Context
	storage        nousOAuthStorage
	clientFactory  func() (*http.Client, error)
	mu             sync.Mutex
	flows          map[string]*nousDeviceFlow
	refreshes      map[string]*nousRefreshCall
	blockedRefresh map[string]map[[32]byte]struct{}
	workers        sync.WaitGroup
	// Tests replace these on a private runtime before it starts. Production always
	// uses the real clock and a cancellation-aware timer, never a busy polling loop.
	now  func() time.Time
	wait func(context.Context, time.Duration) error
}

func newNousOAuthRuntime(ctx context.Context, storage nousOAuthStorage, factory func() (*http.Client, error)) *nousOAuthRuntime {
	return &nousOAuthRuntime{context: ctx, storage: storage, clientFactory: factory,
		flows: map[string]*nousDeviceFlow{}, refreshes: map[string]*nousRefreshCall{}, blockedRefresh: map[string]map[[32]byte]struct{}{}, now: time.Now, wait: nousOAuthWait}
}

func (runtime *nousOAuthRuntime) refreshBlocked(binding, token string) bool {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	_, blocked := runtime.blockedRefresh[binding][sha256.Sum256([]byte(token))]
	return blocked
}

func (runtime *nousOAuthRuntime) blockRefresh(binding, token string) {
	runtime.mu.Lock()
	if runtime.blockedRefresh[binding] == nil {
		runtime.blockedRefresh[binding] = map[[32]byte]struct{}{}
	}
	runtime.blockedRefresh[binding][sha256.Sum256([]byte(token))] = struct{}{}
	runtime.mu.Unlock()
}

// A Start/Cancel can change the generation without changing the retained grant.
// Fence only that exact consumed grant in the latest storage snapshot. Independent
// logins replace the token and advance the CAS generation, so this cannot mark a
// newly signed-in account as invalid. This is one best-effort storage write, not
// another token exchange; the in-process block remains if storage is unavailable.
func (runtime *nousOAuthRuntime) quarantineRefresh(binding, token string) {
	runtime.blockRefresh(binding, token)
	latest, err := runtime.storage.Load(binding)
	if err != nil || latest.Credential == nil || latest.Credential.RefreshToken != token {
		return
	}
	credential := *latest.Credential
	credential.RequiresLogin = true
	_, _ = runtime.storage.Save(binding, latest.Generation, credential, false)
}

// Called after incoming IPC workers have drained. It lets shutdown finish short
// credential commits before the database closes; it never resumes network work.
func (runtime *nousOAuthRuntime) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { runtime.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func nousOAuthWait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func validateNousRequestID(requestID string) error {
	if strings.TrimSpace(requestID) == "" || len(requestID) > 128 || strings.ContainsAny(requestID, "\r\n\x00") {
		return nousError("invalid_request", "Invalid Nous sign-in request.")
	}
	return nil
}

func (runtime *nousOAuthRuntime) Start(ctx context.Context, binding, requestID, clientID string) (nousDeviceAuthorization, error) {
	if err := validateNousRequestID(requestID); err != nil {
		return nousDeviceAuthorization{}, err
	}
	clientID, err := validateNousOAuthClientID(clientID)
	if err != nil {
		return nousDeviceAuthorization{}, err
	}
	// A duplicate Start must not mint a second device code, even while the first
	// response is in flight. The caller observes the same attempt through Status.
	flowCtx, cancel := context.WithCancel(runtime.context)
	flow := &nousDeviceFlow{requestID: requestID, initializing: true, status: nousDeviceStatus{Status: "pending"}, cancel: cancel}
	runtime.mu.Lock()
	previous := runtime.flows[binding]
	if previous != nil && previous.requestID == requestID {
		runtime.mu.Unlock()
		cancel()
		return nousDeviceAuthorization{}, nousError("duplicate_request", "This Nous sign-in request has already started.")
	}
	if previous != nil && (previous.initializing || previous.status.Status == "pending") {
		runtime.mu.Unlock()
		cancel()
		return nousDeviceAuthorization{}, nousError("sign_in_in_progress", "Cancel the current Nous sign-in before starting another.")
	}
	if previous != nil {
		previous.cancel()
	}
	runtime.flows[binding] = flow
	runtime.mu.Unlock()
	snapshot, err := runtime.storage.Advance(binding, nil)
	if err != nil {
		runtime.mu.Lock()
		flow.initializing = false
		runtime.mu.Unlock()
		runtime.finishFlow(binding, flow, nousFailureStatus("storage_error", "Nous sign-in could not access protected storage."))
		return nousDeviceAuthorization{}, nousStorageError()
	}
	runtime.mu.Lock()
	current := runtime.flows[binding] == flow && flow.status.Status == "pending"
	flow.generation = snapshot.Generation
	flow.initializing = false
	runtime.mu.Unlock()
	if !current {
		cancel()
		return nousDeviceAuthorization{}, nousCancelledError()
	}
	// The short initial call has its own IPC-safe deadline. Parent cancellation
	// cancels only this initialization; the authorization poll belongs to the app.
	requestCtx, requestCancel := context.WithTimeout(ctx, nousOAuthRequestTimeout)
	stop := context.AfterFunc(flowCtx, requestCancel)
	data, err := runtime.requestDeviceCode(requestCtx, clientID)
	stop()
	requestCancel()
	if err != nil {
		cancel()
		runtime.finishFlow(binding, flow, nousStatusForError(err))
		return nousDeviceAuthorization{}, err
	}
	deadline := runtime.now().Add(time.Duration(data.ExpiresIn) * time.Second)
	result := nousDeviceAuthorization{RequestID: requestID, UserCode: data.UserCode,
		VerificationURI: data.VerificationURI, VerificationURIComplete: data.VerificationURIComplete,
		ExpiresAt: deadline.UnixMilli(), Interval: data.Interval}
	runtime.mu.Lock()
	current = runtime.flows[binding] == flow && flow.status.Status == "pending" && flowCtx.Err() == nil
	runtime.mu.Unlock()
	if !current {
		cancel()
		return nousDeviceAuthorization{}, nousCancelledError()
	}
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		runtime.pollDevice(flowCtx, binding, flow, clientID, data.DeviceCode, deadline, time.Duration(data.Interval)*time.Second)
	}()
	return result, nil
}

func nousFailureStatus(code, message string) nousDeviceStatus {
	return nousDeviceStatus{Status: "error", Code: code, Message: message}
}

func nousStatusForError(err error) nousDeviceStatus {
	var authError *nousOAuthError
	if errors.As(err, &authError) {
		if authError.code == "expired_token" {
			return nousDeviceStatus{Status: "expired"}
		}
		if authError.code == "cancelled" {
			return nousDeviceStatus{Status: "cancelled"}
		}
		return nousFailureStatus(authError.code, authError.message)
	}
	return nousFailureStatus("sign_in_failed", "Nous sign-in could not be completed.")
}

func (runtime *nousOAuthRuntime) finishFlow(binding string, flow *nousDeviceFlow, status nousDeviceStatus) {
	runtime.mu.Lock()
	if runtime.flows[binding] == flow && flow.status.Status == "pending" {
		flow.status = status
	}
	runtime.mu.Unlock()
	flow.cancel()
}

func (runtime *nousOAuthRuntime) pollDevice(ctx context.Context, binding string, flow *nousDeviceFlow, clientID, deviceCode string, deadline time.Time, interval time.Duration) {
	for {
		remaining := deadline.Sub(runtime.now())
		if remaining <= 0 {
			runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "expired"})
			return
		}
		if err := runtime.wait(ctx, min(interval, remaining)); err != nil {
			runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "cancelled"})
			return
		}
		if !runtime.now().Before(deadline) {
			runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "expired"})
			return
		}
		requestCtx, cancel := context.WithTimeout(ctx, min(nousOAuthRequestTimeout, deadline.Sub(runtime.now())))
		payload, err := runtime.exchange(requestCtx, clientID, deviceCode, "")
		cancel()
		if ctx.Err() != nil {
			runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "cancelled"})
			return
		}
		var authError *nousOAuthError
		if errors.As(err, &authError) {
			switch authError.code {
			case "authorization_pending":
				continue
			case "slow_down":
				interval += 5 * time.Second
				continue
			case "temporarily_unavailable", "rate_limited":
				interval = max(interval, 5*time.Second, authError.retryAfter)
				continue
			}
		}
		if err != nil {
			runtime.finishFlow(binding, flow, nousStatusForError(err))
			return
		}
		credential, err := parseNousCredential(payload, nil, clientID, runtime.now())
		if err != nil {
			runtime.finishFlow(binding, flow, nousStatusForError(err))
			return
		}
		// Storage is authoritative: Cancel, Logout, replacing this provider, or a
		// newer Start can invalidate this generation while HTTP is in flight.
		saved, err := runtime.storage.Save(binding, flow.generation, credential, true)
		if err != nil {
			runtime.finishFlow(binding, flow, nousFailureStatus("storage_error", "Nous sign-in could not save protected credentials."))
			return
		}
		if !saved {
			runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "cancelled"})
			return
		}
		runtime.finishFlow(binding, flow, nousDeviceStatus{Status: "completed", AccountID: nousAccountID(credential.AccountID)})
		return
	}
}

func (runtime *nousOAuthRuntime) Status(binding, requestID string) (nousDeviceStatus, error) {
	if err := validateNousRequestID(requestID); err != nil {
		return nousDeviceStatus{}, err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	flow := runtime.flows[binding]
	if flow == nil || flow.requestID != requestID {
		return nousDeviceStatus{Status: "cancelled"}, nil
	}
	return flow.status, nil
}

func (runtime *nousOAuthRuntime) Cancel(binding, requestID string) error {
	if err := validateNousRequestID(requestID); err != nil {
		return err
	}
	runtime.mu.Lock()
	flow := runtime.flows[binding]
	if flow == nil || flow.requestID != requestID || flow.status.Status != "pending" {
		runtime.mu.Unlock()
		return nil
	}
	flow.status = nousDeviceStatus{Status: "cancelled"}
	flow.cancel()
	generation := flow.generation
	runtime.mu.Unlock()
	// Initialization may still be reserving its generation. The cancelled flag is
	// checked before it starts HTTP; generation zero must not cancel a newer flow.
	if generation == 0 {
		return nil
	}
	if _, err := runtime.storage.Advance(binding, &generation); err != nil {
		return nousStorageError()
	}
	return nil
}

func (runtime *nousOAuthRuntime) Invalidate(binding string) {
	runtime.mu.Lock()
	if flow := runtime.flows[binding]; flow != nil {
		flow.cancel()
		if flow.status.Status == "pending" {
			flow.status = nousDeviceStatus{Status: "cancelled"}
		}
	}
	if call := runtime.refreshes[binding]; call != nil {
		call.cancel()
	}
	runtime.mu.Unlock()
}

func (runtime *nousOAuthRuntime) Logout(binding string) error {
	// Delete advances the storage generation before cancellation so a late HTTP
	// response cannot restore a logged-out account.
	if err := runtime.storage.Delete(binding); err != nil {
		return nousStorageError()
	}
	runtime.Invalidate(binding)
	return nil
}

func nousAccountID(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (runtime *nousOAuthRuntime) HasToken(binding string) (bool, error) {
	snapshot, err := runtime.storage.Load(binding)
	if err != nil {
		return false, nousStorageError()
	}
	credential := snapshot.Credential
	return credential != nil && !credential.RequiresLogin && credential.AccessToken != "" &&
		!runtime.refreshBlocked(binding, credential.RefreshToken) &&
		(credential.ExpiresAt.After(runtime.now()) || credential.RefreshToken != ""), nil
}

func (runtime *nousOAuthRuntime) Account(binding string) (*nousOAuthAccount, error) {
	snapshot, err := runtime.storage.Load(binding)
	if err != nil {
		return nil, nousStorageError()
	}
	account := &nousOAuthAccount{}
	if snapshot.Credential != nil && !snapshot.Credential.RequiresLogin && !runtime.refreshBlocked(binding, snapshot.Credential.RefreshToken) {
		account.AccountID = nousAccountID(snapshot.Credential.AccountID)
	}
	return account, nil
}

func nousCredentialFresh(credential nousOAuthCredential, now time.Time) bool {
	lifetime := credential.ExpiresAt.Sub(credential.ObtainedAt)
	skew := 120 * time.Second
	if lifetime > 0 {
		skew = min(skew, max(time.Second, lifetime/10))
	}
	return credential.ExpiresAt.After(now.Add(skew))
}

func (runtime *nousOAuthRuntime) Credential(ctx context.Context, binding, clientID string) (nousOAuthCredential, error) {
	clientID, err := validateNousOAuthClientID(clientID)
	if err != nil {
		return nousOAuthCredential{}, err
	}
	snapshot, err := runtime.storage.Load(binding)
	if err != nil {
		return nousOAuthCredential{}, nousStorageError()
	}
	credential := snapshot.Credential
	if credential == nil || credential.RequiresLogin || credential.ClientID != clientID || credential.AccessToken == "" || runtime.refreshBlocked(binding, credential.RefreshToken) {
		return nousOAuthCredential{}, nousLoginRequired()
	}
	if _, err := validateNousInferenceURL(credential.InferenceBaseURL); err != nil {
		return nousOAuthCredential{}, err
	}
	if !validNousToken(credential.AccessToken) {
		return nousOAuthCredential{}, nousLoginRequired()
	}
	if nousCredentialFresh(*credential, runtime.now()) {
		return *credential, nil
	}
	if !validNousToken(credential.RefreshToken) {
		return nousOAuthCredential{}, nousLoginRequired()
	}
	if err := ctx.Err(); err != nil {
		return nousOAuthCredential{}, nousCancelledError()
	}
	runtime.mu.Lock()
	call := runtime.refreshes[binding]
	fingerprint := sha256.Sum256([]byte(credential.RefreshToken))
	// Start/Cancel advance the lifecycle generation while retaining the previous
	// session. They do not make its single-use refresh token spendable twice.
	if call == nil || call.grantFingerprint != fingerprint {
		// Refresh belongs to the runtime, not the first waiter. Cancelling a chat
		// must not discard a newly rotated single-use token from an in-flight reply.
		refreshCtx, cancel := context.WithTimeout(runtime.context, nousOAuthRequestTimeout)
		call = &nousRefreshCall{generation: snapshot.Generation, grantFingerprint: fingerprint, done: make(chan struct{}), cancel: cancel}
		runtime.refreshes[binding] = call
		runtime.workers.Add(1)
		go func() {
			defer runtime.workers.Done()
			runtime.refresh(refreshCtx, binding, call, *credential)
		}()
	}
	runtime.mu.Unlock()
	select {
	case <-ctx.Done():
		return nousOAuthCredential{}, nousCancelledError()
	case <-call.done:
		if call.err != nil {
			return nousOAuthCredential{}, call.err
		}
		// Re-read after the worker's commit: logout can race a waiting model call.
		latest, err := runtime.storage.Load(binding)
		if err != nil {
			return nousOAuthCredential{}, nousStorageError()
		}
		if latest.Generation != snapshot.Generation || latest.Credential == nil || latest.Credential.RequiresLogin {
			return nousOAuthCredential{}, nousLoginRequired()
		}
		return *latest.Credential, nil
	}
}

func (runtime *nousOAuthRuntime) refresh(ctx context.Context, binding string, call *nousRefreshCall, previous nousOAuthCredential) {
	defer call.cancel()
	defer func() {
		runtime.mu.Lock()
		if runtime.refreshes[binding] == call {
			delete(runtime.refreshes, binding)
		}
		close(call.done)
		runtime.mu.Unlock()
	}()
	// Another request may have already rotated the token between our initial Load
	// and becoming the single-flight owner. Never spend that stale token again.
	snapshot, err := runtime.storage.Load(binding)
	if err != nil {
		call.err = nousStorageError()
		return
	}
	if snapshot.Generation != call.generation || snapshot.Credential == nil || snapshot.Credential.RequiresLogin || runtime.refreshBlocked(binding, snapshot.Credential.RefreshToken) {
		call.err = nousLoginRequired()
		return
	}
	if snapshot.Credential.RefreshToken != previous.RefreshToken || nousCredentialFresh(*snapshot.Credential, runtime.now()) {
		call.credential = *snapshot.Credential
		return
	}
	payload, err := runtime.exchange(ctx, previous.ClientID, "", previous.RefreshToken)
	if err != nil {
		var authError *nousOAuthError
		if errors.As(err, &authError) && (authError.requiresLogin || authError.ambiguous) {
			runtime.quarantineRefresh(binding, previous.RefreshToken)
		}
		call.err = err
		return
	}
	credential, parseErr := parseNousCredential(payload, &previous, previous.ClientID, runtime.now())
	if parseErr != nil {
		// A successful exchange may have consumed the old refresh token even when
		// the payload is incomplete. Persist the rotated token when present and
		// block further automatic use rather than replaying an uncertain grant.
		credential = previous
		if validNousToken(payload.RefreshToken) {
			credential.RefreshToken = payload.RefreshToken
		}
		credential.RequiresLogin = true
	}
	saved, err := runtime.storage.Save(binding, call.generation, credential, false)
	if err != nil {
		runtime.quarantineRefresh(binding, previous.RefreshToken)
		call.err = nousStorageError()
		return
	}
	if !saved {
		// A generation change can reject a successful exchange without a storage
		// error. The old grant was still consumed; never offer it to another chat.
		runtime.quarantineRefresh(binding, previous.RefreshToken)
		call.err = nousLoginRequired()
		return
	}
	call.credential, call.err = credential, parseErr
}
