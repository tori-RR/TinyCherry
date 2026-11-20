package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const nousTestBinding = "nous-portal:synthetic-owner"

type nousMemoryStorage struct {
	mu        sync.Mutex
	state     nousOAuthSnapshot
	before    func()
	saveError error
}

func copyNousSnapshot(value nousOAuthSnapshot) nousOAuthSnapshot {
	if value.Credential != nil {
		credential := *value.Credential
		value.Credential = &credential
	}
	return value
}
func (storage *nousMemoryStorage) Load(string) (nousOAuthSnapshot, error) {
	if storage.before != nil {
		storage.before()
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	return copyNousSnapshot(storage.state), nil
}
func (storage *nousMemoryStorage) Advance(_ string, expected *uint64) (nousOAuthSnapshot, error) {
	if storage.before != nil {
		storage.before()
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if expected == nil || *expected == storage.state.Generation {
		storage.state.Generation++
	}
	return copyNousSnapshot(storage.state), nil
}
func (storage *nousMemoryStorage) Save(_ string, expected uint64, credential nousOAuthCredential, replacement bool) (bool, error) {
	if storage.before != nil {
		storage.before()
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if storage.saveError != nil {
		return false, storage.saveError
	}
	if expected != storage.state.Generation {
		return false, nil
	}
	storage.state.Credential = &credential
	if replacement {
		storage.state.Generation++
	}
	return true, nil
}
func (storage *nousMemoryStorage) Delete(string) error {
	if storage.before != nil {
		storage.before()
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	storage.state.Generation++
	storage.state.Credential = nil
	return nil
}

type nousRoundTrip func(*http.Request) (*http.Response, error)

func (roundTrip nousRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func nousJSONResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func newNousTestRuntime(t *testing.T, handler nousRoundTrip) (*nousOAuthRuntime, *nousMemoryStorage) {
	t.Helper()
	storage := &nousMemoryStorage{state: nousOAuthSnapshot{Generation: 1}}
	ctx, cancel := context.WithCancel(context.Background())
	runtime := newNousOAuthRuntime(ctx, storage, func() (*http.Client, error) { return &http.Client{Transport: handler}, nil })
	t.Cleanup(func() {
		cancel()
		waitCtx, waitCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer waitCancel()
		if err := runtime.Wait(waitCtx); err != nil {
			t.Error("OAuth workers did not terminate after cancellation")
		}
	})
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC).UnixNano())
	runtime.now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	runtime.wait = func(ctx context.Context, delay time.Duration) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		clock.Add(int64(delay))
		return nil
	}
	return runtime, storage
}

func nousTestJWT(now time.Time, subject string) string {
	payload, _ := json.Marshal(map[string]any{"exp": now.Add(time.Hour).Unix(), "scope": nousOAuthScope, "sub": subject})
	return "eyJhbGciOiJSUzI1NiJ9." + base64.RawURLEncoding.EncodeToString(payload) + ".synthetic-signature"
}

func nousTestTokenBody(now time.Time, refresh, subject string) string {
	body, _ := json.Marshal(nousTokenResponse{AccessToken: nousTestJWT(now, subject), RefreshToken: refresh, TokenType: "Bearer", Scope: nousOAuthScope, ExpiresIn: 3600, InferenceBaseURL: nousInferenceBaseURL})
	return string(body)
}

func nousTestDeviceBody(expires, interval int) string {
	return fmt.Sprintf(`{"device_code":"backend-only-device-secret","user_code":"ABCD-EFGH","verification_uri":"https://portal.nousresearch.com/oauth/device","verification_uri_complete":"https://portal.nousresearch.com/oauth/device?user_code=ABCD-EFGH","expires_in":%d,"interval":%d}`, expires, interval)
}

func awaitNousStatus(t *testing.T, runtime *nousOAuthRuntime, requestID, wanted string) nousDeviceStatus {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		status, err := runtime.Status(nousTestBinding, requestID)
		if err != nil {
			t.Fatal(err)
		}
		if status.Status == wanted {
			return status
		}
		if status.Status != "pending" {
			t.Fatalf("status=%+v, wanted %s", status, wanted)
		}
		select {
		case <-deadline:
			t.Fatal("authorization did not finish")
		case <-time.After(time.Millisecond):
		}
	}
}

func seedExpiredNousCredential(storage *nousMemoryStorage, now time.Time) {
	storage.state.Credential = &nousOAuthCredential{AccessToken: nousTestJWT(now.Add(-2*time.Hour), "previous-account"), RefreshToken: "old-single-use-refresh", TokenType: "Bearer", Scope: nousOAuthScope, ClientID: defaultNousOAuthClientID, InferenceBaseURL: nousInferenceBaseURL, ObtainedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)}
}

func TestNousDeviceAuthorizationPendingSlowDownAndPrivateTokens(t *testing.T) {
	var runtime *nousOAuthRuntime
	var polls atomic.Int32
	var waits []time.Duration
	var waitsMu sync.Mutex
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Scheme != "https" || request.URL.Host != "portal.nousresearch.com" {
			t.Errorf("unexpected target: %s", request.URL)
		}
		if request.GetBody != nil {
			t.Error("OAuth POST permits transport replay")
		}
		if err := request.ParseForm(); err != nil {
			t.Error(err)
		}
		if request.Form.Get("client_id") != defaultNousOAuthClientID {
			t.Error("missing client identity")
		}
		if request.URL.Path == "/api/oauth/device/code" {
			if request.Form.Get("scope") != nousOAuthScope {
				t.Error("unexpected scope")
			}
			return nousJSONResponse(200, nousTestDeviceBody(120, 3)), nil
		}
		if request.Form.Get("device_code") != "backend-only-device-secret" || request.Form.Get("grant_type") != nousDeviceGrant {
			t.Error("incorrect device grant")
		}
		switch polls.Add(1) {
		case 1:
			return nousJSONResponse(400, `{"error":"authorization_pending"}`), nil
		case 2:
			return nousJSONResponse(400, `{"error":"slow_down"}`), nil
		default:
			return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "rotated-private-token", "synthetic-account")), nil
		}
	})
	baseWait := runtime.wait
	runtime.wait = func(ctx context.Context, delay time.Duration) error {
		waitsMu.Lock()
		waits = append(waits, delay)
		waitsMu.Unlock()
		return baseWait(ctx, delay)
	}
	// This re-entrant read would deadlock if a runtime lock were held across a
	// storage callback, as the real adapter acquires the server state lock.
	storage.before = func() { _, _ = runtime.Status(nousTestBinding, "one") }
	authorization, err := runtime.Start(context.Background(), nousTestBinding, "one", "")
	if err != nil {
		t.Fatal(err)
	}
	status := awaitNousStatus(t, runtime, "one", "completed")
	if status.AccountID == nil || *status.AccountID != "synthetic-account" {
		t.Fatalf("account=%+v", status)
	}
	waitsMu.Lock()
	actual := append([]time.Duration(nil), waits...)
	waitsMu.Unlock()
	if !reflect.DeepEqual(actual, []time.Duration{3 * time.Second, 3 * time.Second, 8 * time.Second}) {
		t.Fatalf("poll intervals=%v", actual)
	}
	encoded, _ := json.Marshal(authorization)
	for _, secret := range []string{"backend-only-device-secret", "rotated-private-token", "accessToken", "refreshToken", "deviceCode"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("authorization DTO contains %s", secret)
		}
	}
	if authorization.Interval != 3 || authorization.ExpiresAt <= 0 {
		t.Fatalf("invalid public authorization: %+v", authorization)
	}
	loaded, _ := storage.Load(nousTestBinding)
	if loaded.Credential == nil || loaded.Credential.RefreshToken != "rotated-private-token" {
		t.Fatal("protected token was not saved")
	}
}

func TestNousDeviceDeniedAndExpired(t *testing.T) {
	for _, test := range []struct {
		name, wanted      string
		expires, interval int
	}{
		{"denied", "error", 120, 1}, {"deadline", "expired", 1, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			var polls atomic.Int32
			runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
				if strings.HasSuffix(request.URL.Path, "/device/code") {
					return nousJSONResponse(200, nousTestDeviceBody(test.expires, test.interval)), nil
				}
				polls.Add(1)
				return nousJSONResponse(400, `{"error":"access_denied","error_description":"secret-token-in-server-error"}`), nil
			})
			if _, err := runtime.Start(context.Background(), nousTestBinding, "one", ""); err != nil {
				t.Fatal(err)
			}
			status := awaitNousStatus(t, runtime, "one", test.wanted)
			encoded, _ := json.Marshal(status)
			if strings.Contains(string(encoded), "secret-token") {
				t.Fatal("upstream error escaped")
			}
			if test.wanted == "expired" && polls.Load() != 0 {
				t.Fatal("poll sent after device deadline")
			}
			snapshot, _ := storage.Load(nousTestBinding)
			if snapshot.Credential != nil {
				t.Fatal("failed flow persisted credentials")
			}
		})
	}
}

func TestNousDeviceCancelAndDuplicateStart(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var runtime *nousOAuthRuntime
	var deviceCalls atomic.Int32
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/device/code") {
			deviceCalls.Add(1)
			return nousJSONResponse(200, nousTestDeviceBody(120, 1)), nil
		}
		close(started)
		<-release
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "late-refresh", "late-account")), nil
	})
	if _, err := runtime.Start(context.Background(), nousTestBinding, "one", ""); err != nil {
		t.Fatal(err)
	}
	<-started
	for _, id := range []string{"one", "two"} {
		if _, err := runtime.Start(context.Background(), nousTestBinding, id, ""); err == nil {
			t.Fatal("concurrent/duplicate login accepted")
		}
	}
	if deviceCalls.Load() != 1 {
		t.Fatal("duplicate flow sent another device request")
	}
	if err := runtime.Cancel(nousTestBinding, "one"); err != nil {
		t.Fatal(err)
	}
	close(release)
	awaitNousStatus(t, runtime, "one", "cancelled")
	waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Second)
	defer waitCancel()
	if err := runtime.Wait(waitCtx); err != nil {
		t.Fatal(err)
	}
	snapshot, _ := storage.Load(nousTestBinding)
	if snapshot.Credential != nil {
		t.Fatal("cancelled flow saved credentials")
	}
}

func TestNousRefreshSingleFlightAndHeaderRotation(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var runtime *nousOAuthRuntime
	var refreshes atomic.Int32
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		if refreshes.Add(1) == 1 {
			close(started)
		}
		_ = request.ParseForm()
		if request.Header.Get("x-nous-refresh-token") != "old-single-use-refresh" || request.Form.Get("refresh_token") != "" || request.Form.Get("grant_type") != "refresh_token" {
			t.Error("refresh grant/header mismatch")
		}
		<-release
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "new-single-use-refresh", "account")), nil
	})
	seedExpiredNousCredential(storage, runtime.now())
	const callers = 16
	results := make(chan error, callers)
	for range callers {
		go func() {
			credential, err := runtime.Credential(context.Background(), nousTestBinding, "")
			if err == nil && credential.RefreshToken != "new-single-use-refresh" {
				err = errors.New("stale refresh returned")
			}
			results <- err
		}()
	}
	<-started
	close(release)
	for range callers {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if refreshes.Load() != 1 {
		t.Fatalf("spent single-use token %d times", refreshes.Load())
	}
	if _, err := runtime.Credential(context.Background(), nousTestBinding, ""); err != nil {
		t.Fatal(err)
	}
	if refreshes.Load() != 1 {
		t.Fatal("fresh access token refreshed again")
	}
}

func TestNousLogoutDiscardsDelayedRefresh(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var runtime *nousOAuthRuntime
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		close(started)
		<-release
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "late-refresh", "old-account")), nil
	})
	seedExpiredNousCredential(storage, runtime.now())
	done := make(chan error, 1)
	go func() { _, err := runtime.Credential(context.Background(), nousTestBinding, ""); done <- err }()
	<-started
	if err := runtime.Logout(nousTestBinding); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("late refresh survived logout")
	}
	snapshot, _ := storage.Load(nousTestBinding)
	if snapshot.Credential != nil {
		t.Fatal("refresh resurrected logged-out account")
	}
}

func TestNousReloginWinsDelayedOldSessionRefresh(t *testing.T) {
	deviceStarted, refreshStarted := make(chan struct{}), make(chan struct{})
	releaseDevice, releaseRefresh := make(chan struct{}), make(chan struct{})
	var runtime *nousOAuthRuntime
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		_ = request.ParseForm()
		if strings.HasSuffix(request.URL.Path, "/device/code") {
			return nousJSONResponse(200, nousTestDeviceBody(120, 1)), nil
		}
		if request.Form.Get("grant_type") == "refresh_token" {
			close(refreshStarted)
			<-releaseRefresh
			return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "old-account-rotated", "old-account")), nil
		}
		close(deviceStarted)
		<-releaseDevice
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "new-account-refresh", "new-account")), nil
	})
	seedExpiredNousCredential(storage, runtime.now())
	if _, err := runtime.Start(context.Background(), nousTestBinding, "replacement", ""); err != nil {
		t.Fatal(err)
	}
	<-deviceStarted
	refreshDone := make(chan error, 1)
	go func() { _, err := runtime.Credential(context.Background(), nousTestBinding, ""); refreshDone <- err }()
	<-refreshStarted
	close(releaseDevice)
	awaitNousStatus(t, runtime, "replacement", "completed")
	close(releaseRefresh)
	if err := <-refreshDone; err == nil {
		t.Fatal("old-session waiter was not invalidated")
	}
	snapshot, _ := storage.Load(nousTestBinding)
	if snapshot.Credential == nil || snapshot.Credential.RefreshToken != "new-account-refresh" || snapshot.Credential.AccountID != "new-account" {
		t.Fatal("delayed old refresh replaced newly signed-in account")
	}
}

func TestNousStartAndCancelDoNotRedeemInFlightGrantTwice(t *testing.T) {
	refreshStarted, deviceStarted := make(chan struct{}), make(chan struct{})
	releaseRefresh, releaseDevice := make(chan struct{}), make(chan struct{})
	var refreshCalls atomic.Int32
	var runtime *nousOAuthRuntime
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		_ = request.ParseForm()
		if strings.HasSuffix(request.URL.Path, "/device/code") {
			return nousJSONResponse(200, nousTestDeviceBody(120, 1)), nil
		}
		if request.Form.Get("grant_type") == "refresh_token" {
			if refreshCalls.Add(1) == 1 {
				close(refreshStarted)
			}
			<-releaseRefresh
			return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "old-grant-already-consumed", "old-account")), nil
		}
		close(deviceStarted)
		<-releaseDevice
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "cancelled-login-token", "new-account")), nil
	})
	seedExpiredNousCredential(storage, runtime.now())
	results := make(chan error, 2)
	go func() { _, err := runtime.Credential(context.Background(), nousTestBinding, ""); results <- err }()
	<-refreshStarted
	if _, err := runtime.Start(context.Background(), nousTestBinding, "new-attempt", ""); err != nil {
		t.Fatal(err)
	}
	<-deviceStarted
	// A second waiter observes the new generation while the old grant is still
	// in flight. Its storage read is acknowledged before cancellation proceeds.
	secondRead := make(chan struct{})
	var readOnce sync.Once
	storage.before = func() { readOnce.Do(func() { close(secondRead) }) }
	go func() { _, err := runtime.Credential(context.Background(), nousTestBinding, ""); results <- err }()
	<-secondRead
	if err := runtime.Cancel(nousTestBinding, "new-attempt"); err != nil {
		t.Fatal(err)
	}
	close(releaseDevice)
	close(releaseRefresh)
	for range 2 {
		if err := <-results; err == nil {
			t.Fatal("invalidated old session returned credentials")
		}
	}
	if refreshCalls.Load() != 1 {
		t.Fatalf("same grant redeemed %d times across generation change", refreshCalls.Load())
	}
	if _, err := runtime.Credential(context.Background(), nousTestBinding, ""); err == nil {
		t.Fatal("cancelled login exposed consumed old refresh token")
	}
	if refreshCalls.Load() != 1 {
		t.Fatal("consumed old grant was reused after failed CAS")
	}
	if present, err := runtime.HasToken(nousTestBinding); err != nil || present {
		t.Fatal("consumed grant not quarantined")
	}
	snapshot, _ := storage.Load(nousTestBinding)
	if snapshot.Credential == nil || !snapshot.Credential.RequiresLogin {
		t.Fatal("consumed retained grant was not fenced across restart")
	}
}

func TestNousUncertainRefreshDoesNotReplayOldGrant(t *testing.T) {
	for _, mode := range []string{"transport", "gateway-failure", "unexpected-status", "bad-success"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			var runtime *nousOAuthRuntime
			runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
				calls.Add(1)
				switch mode {
				case "transport":
					return nil, errors.New("private-token-must-not-escape")
				case "gateway-failure":
					return nousJSONResponse(http.StatusBadGateway, `{ "error_description": "private-token-must-not-escape" }`), nil
				case "unexpected-status":
					return nousJSONResponse(http.StatusAccepted, `{}`), nil
				}
				body := nousTestTokenBody(runtime.now(), "rotated-before-invalid-endpoint", "account")
				return nousJSONResponse(200, strings.ReplaceAll(body, nousInferenceBaseURL, "https://attacker.invalid/v1")), nil
			})
			seedExpiredNousCredential(storage, runtime.now())
			_, err := runtime.Credential(context.Background(), nousTestBinding, "")
			if err == nil || strings.Contains(err.Error(), "private-token") {
				t.Fatalf("unsafe refresh error: %v", err)
			}
			if _, err = runtime.Credential(context.Background(), nousTestBinding, ""); err == nil {
				t.Fatal("uncertain single-use grant replayed")
			}
			if calls.Load() != 1 {
				t.Fatal("automatic retry spent old refresh token")
			}
			snapshot, _ := storage.Load(nousTestBinding)
			if snapshot.Credential == nil || !snapshot.Credential.RequiresLogin {
				t.Fatal("uncertain session not marked for re-login")
			}
			if mode == "bad-success" && snapshot.Credential.RefreshToken != "rotated-before-invalid-endpoint" {
				t.Fatal("rotated token lost after later validation failed")
			}
		})
	}
}

func TestNousRefreshPersistenceFailureQuarantinesConsumedGrant(t *testing.T) {
	var calls atomic.Int32
	var runtime *nousOAuthRuntime
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/device/code") {
			return nousJSONResponse(200, nousTestDeviceBody(120, 1)), nil
		}
		calls.Add(1)
		return nousJSONResponse(200, nousTestTokenBody(runtime.now(), "rotated-but-not-persisted", "account")), nil
	})
	seedExpiredNousCredential(storage, runtime.now())
	storage.saveError = errors.New("synthetic storage failure")
	if _, err := runtime.Credential(context.Background(), nousTestBinding, ""); err == nil {
		t.Fatal("failed token persistence reported success")
	}
	// Even a new sign-in attempt that has not completed must not resurrect the
	// consumed old refresh token by merely changing the lifecycle generation.
	_, _ = storage.Advance(nousTestBinding, nil)
	if _, err := runtime.Credential(context.Background(), nousTestBinding, ""); err == nil {
		t.Fatal("consumed refresh token remained usable")
	}
	if calls.Load() != 1 {
		t.Fatal("consumed refresh token was replayed after storage failure")
	}
	if present, err := runtime.HasToken(nousTestBinding); err != nil || present {
		t.Fatal("quarantined session still reports signed in")
	}
	storage.mu.Lock()
	storage.saveError = nil
	storage.mu.Unlock()
	if _, err := runtime.Start(context.Background(), nousTestBinding, "recovered", ""); err != nil {
		t.Fatal(err)
	}
	awaitNousStatus(t, runtime, "recovered", "completed")
	if _, err := runtime.Credential(context.Background(), nousTestBinding, ""); err != nil {
		t.Fatal("independent login did not clear quarantine", err)
	}
}

func TestNousCancellationDuringDeviceInitialization(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var tokenCalls atomic.Int32
	runtime, storage := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(request.URL.Path, "/device/code") {
			tokenCalls.Add(1)
			return nousJSONResponse(500, `{}`), nil
		}
		deadline, ok := request.Context().Deadline()
		if !ok || time.Until(deadline) > nousOAuthRequestTimeout {
			t.Error("initial request is not bounded by IPC budget")
		}
		close(started)
		<-release
		return nousJSONResponse(200, nousTestDeviceBody(120, 1)), nil
	})
	done := make(chan error, 1)
	go func() {
		_, err := runtime.Start(context.Background(), nousTestBinding, "initializing", "")
		done <- err
	}()
	<-started
	if err := runtime.Cancel(nousTestBinding, "initializing"); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("cancelled initial request started authorization")
	}
	if err := runtime.Cancel(nousTestBinding, "initializing"); err != nil {
		t.Fatal("repeated cancellation failed")
	}
	if tokenCalls.Load() != 0 {
		t.Fatal("cancelled initial request started token polling")
	}
	snapshot, _ := storage.Load(nousTestBinding)
	if snapshot.Credential != nil {
		t.Fatal("cancelled initialization stored credentials")
	}
}

func TestNousEndpointsAndRedirectsAreConstrained(t *testing.T) {
	for _, address := range []string{"http://inference-api.nousresearch.com/v1", "https://inference-api.nousresearch.com.evil.invalid/v1", "https://evil.invalid/v1", "https://user@inference-api.nousresearch.com/v1", "https://inference-api.nousresearch.com:444/v1", "https://inference-api.nousresearch.com/v1?key=secret", "https://inference-api.nousresearch.com/v1/../../leak", "https://inference-api.nousresearch.com/%76%31"} {
		if _, err := validateNousInferenceURL(address); err == nil {
			t.Errorf("accepted %s", address)
		}
	}
	for _, address := range []string{"https://portal.nousresearch.com.evil.invalid/oauth/device", "http://portal.nousresearch.com/oauth/device", "https://portal.nousresearch.com:444/oauth/device", "https://user@portal.nousresearch.com/oauth/device"} {
		if validateNousVerificationURL(address) {
			t.Errorf("accepted verification URL %s", address)
		}
	}
	var calls atomic.Int32
	runtime, _ := newNousTestRuntime(t, func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		response := nousJSONResponse(302, `{}`)
		response.Header.Set("Location", "https://attacker.invalid/leak")
		return response, nil
	})
	if _, err := runtime.Start(context.Background(), nousTestBinding, "redirect", ""); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls.Load() != 1 {
		t.Fatal("OAuth redirect followed")
	}
	if _, err := validateNousOAuthClientID("bad\r\nclient"); err == nil {
		t.Fatal("invalid client ID accepted")
	}
}

func TestNousStatusJSONHasExactPublicKeys(t *testing.T) {
	for _, test := range []struct {
		status nousDeviceStatus
		want   string
	}{
		{nousDeviceStatus{Status: "pending"}, `{"status":"pending"}`},
		{nousDeviceStatus{Status: "cancelled"}, `{"status":"cancelled"}`},
		{nousDeviceStatus{Status: "expired"}, `{"status":"expired"}`},
		{nousDeviceStatus{Status: "completed"}, `{"status":"completed","accountId":null}`},
		{nousDeviceStatus{Status: "error", Code: "access_denied", Message: "Denied"}, `{"status":"error","code":"access_denied","message":"Denied"}`},
	} {
		actual, err := json.Marshal(test.status)
		if err != nil || string(actual) != test.want {
			t.Errorf("status JSON %s; wanted %s (%v)", actual, test.want, err)
		}
	}
}
