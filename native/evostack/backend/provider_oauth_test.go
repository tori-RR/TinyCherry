package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func nativeNousFixture(t *testing.T, s *server) object {
	t.Helper()
	provider, err := s.store.get("providers", nativeNousProviderID)
	if err != nil {
		t.Fatal("generate the native defaults before testing Nous Portal:", err)
	}
	if !isNativeNousOAuthProvider(provider) || nativeNousBinding(provider) == "" {
		t.Fatal("Nous preset did not receive a per-profile OAuth owner")
	}
	return provider
}

func putSyntheticSealedSecret(t *testing.T, s *server, id string) {
	t.Helper()
	// No decryption is used by ownership/cleanup tests. These bytes are neither
	// user credentials nor a substitute for Windows DPAPI in production.
	if _, err := s.store.connection().Exec("INSERT INTO secret(id,sealed) VALUES(?,?)", id, []byte("synthetic-sealed-fixture")); err != nil {
		t.Fatal(err)
	}
}

func TestNativeNousPresetMigrationPreservesSavedChoices(t *testing.T) {
	s, directory := testServer(t)
	provider := nativeNousFixture(t, s)
	provider["name"] = "My Portal"
	provider["isEnabled"] = true
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	if err := s.store.delete("desktop-migrations", "nous-portal-provider-v1"); err != nil {
		t.Fatal(err)
	}
	if err := s.store.transaction(func(repository *store) error { return repository.ensureNativeNousProvider() }); err != nil {
		t.Fatal(err)
	}
	preserved := nativeNousFixture(t, s)
	if preserved["name"] != "My Portal" || preserved["isEnabled"] != true || nativeNousBinding(preserved) != nativeNousBinding(provider) {
		t.Fatal("migration overwrote an existing provider")
	}
	if err := s.store.delete("providers", nativeNousProviderID); err != nil {
		t.Fatal(err)
	}
	if err := s.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if _, err := reopened.get("providers", nativeNousProviderID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("a deliberately deleted preset was recreated", err)
	}
	// Simulate a pre-feature version-four profile: it has neither the provider
	// nor the one-time marker. Its existing settings and schema remain usable.
	if err := reopened.delete("desktop-migrations", "nous-portal-provider-v1"); err != nil {
		t.Fatal(err)
	}
	if err := reopened.transaction(func(repository *store) error { return repository.ensureNativeNousProvider() }); err != nil {
		t.Fatal(err)
	}
	added, err := reopened.get("providers", nativeNousProviderID)
	if err != nil || !isNativeNousOAuthProvider(added) || added["isEnabled"] != false || nativeNousBinding(added) == "" {
		t.Fatal("existing profile did not receive the disabled OAuth preset", err)
	}
}

func TestNativeNousSecretsFollowTheirProviderOwner(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	binding := nativeNousBinding(provider)
	secretID := nativeNousSecretID(binding)
	putSyntheticSealedSecret(t, s, secretID)
	if err := s.store.put("providers", object{"id": "unrelated", "apiKeys": []any{}}); err != nil {
		t.Fatal(err)
	}
	if err := s.deleteEntity("providers", "unrelated"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.store.connection().QueryRow("SELECT count(*) FROM secret WHERE id=?", secretID).Scan(&count); err != nil || count != 1 {
		t.Fatal("deleting another provider removed the OAuth session", err)
	}
	if err := s.deleteEntity("providers", nativeNousProviderID); err != nil {
		t.Fatal(err)
	}
	if err := s.store.connection().QueryRow("SELECT count(*) FROM secret WHERE id=?", secretID).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleting the owner retained its credentials", err)
	}
	initializeNativeNousProvider(provider)
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	if nativeNousBinding(provider) == binding {
		t.Fatal("recreated provider reused the old credential owner")
	}
	stored, err := (nativeNousOAuthStorage{server: s}).Save(binding, 0, nousOAuthCredential{ClientID: defaultNousOAuthClientID}, true)
	if err != nil || stored {
		t.Fatal("a late response resurrected a deleted session", err)
	}
}

func TestNativeNousClientChangeInvalidatesSecretsAndRollsBackInvalidInput(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	provider["isEnabled"] = true
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	oldBinding := nativeNousBinding(provider)
	putSyntheticSealedSecret(t, s, nativeNousSecretID(oldBinding))
	patch := func(clientID any) object {
		result, err, after := s.invoke("data-api:request", []any{object{"method": "PATCH", "path": "/providers/" + nativeNousProviderID, "body": object{"providerSettings": object{"oauthClientId": clientID}}}})
		if err != nil {
			t.Fatal(err)
		}
		if after != nil {
			after()
		}
		return obj(result)
	}
	if result := patch("tinycherry-test"); result["error"] != nil {
		t.Fatal(result)
	}
	updated := nativeNousFixture(t, s)
	if nativeNousBinding(updated) == oldBinding || updated["isEnabled"] != false || obj(updated["settings"])["oauthClientId"] != "tinycherry-test" {
		t.Fatal("client change did not rotate the credential owner")
	}
	var count int
	if err := s.store.connection().QueryRow("SELECT count(*) FROM secret WHERE id=?", nativeNousSecretID(oldBinding)).Scan(&count); err != nil || count != 0 {
		t.Fatal("old client credentials remained", err)
	}
	if result := patch("bad client"); result["error"] == nil {
		t.Fatal("invalid client ID was accepted")
	}
	unchanged := nativeNousFixture(t, s)
	if nativeNousBinding(unchanged) != nativeNousBinding(updated) || obj(unchanged["settings"])["oauthClientId"] != "tinycherry-test" {
		t.Fatal("failed settings change was not rolled back")
	}
	if result := patch(nil); result["error"] != nil {
		t.Fatal(result)
	}
	reset := nativeNousFixture(t, s)
	if _, present := obj(reset["settings"])["oauthClientId"]; present {
		t.Fatal("clearing client ID persisted null instead of removing the optional setting")
	}
	if clientID, err := nativeNousClientID(reset); err != nil || clientID != defaultNousOAuthClientID || nativeNousBinding(reset) == nativeNousBinding(updated) {
		t.Fatal("clearing the override did not invalidate its session", err)
	}
}

// This opt-in verbose fixture is read by the shared TypeScript/Zod contract
// check. It exercises actual Go handlers and JSON encoding without weakening
// the production executable's Windows-only profile ownership guard.
func TestNativeNousWireContractJSON(t *testing.T) {
	s, _ := testServer(t)
	invoke := func(channel string, args ...any) any {
		result, err, after := s.invoke(channel, args)
		if err != nil {
			t.Fatal(err)
		}
		if after != nil {
			after()
		}
		return result
	}
	data := func(method, suffix string, body any) any {
		result := invoke("data-api:request", object{"id": newID(), "method": method, "path": "/providers/" + nativeNousProviderID + suffix, "body": body})
		if obj(result)["error"] != nil {
			t.Fatal(result)
		}
		return result
	}
	command := func(route string, observation bool) any {
		input := object{"providerId": nativeNousProviderID}
		if observation {
			input["requestId"] = "native-contract-observation"
		}
		result := invoke("ipc-api:request", route, input)
		if obj(result)["ok"] != true {
			t.Fatal(result)
		}
		return result
	}
	fixtures := object{
		"provider":     data("GET", "", nil),
		"authConfig":   data("GET", "/auth-config", nil),
		"hasToken":     command("oauth.has_token", false),
		"account":      command("oauth.get_account", false),
		"deviceStatus": command("oauth.device.status", true),
		"cancel":       command("oauth.device.cancel", true),
		"logout":       command("oauth.logout", false),
		"apiKeys":      data("GET", "/api-keys", nil),
	}
	fixtures["changed"] = data("PATCH", "", object{"providerSettings": object{"oauthClientId": "tinycherry-contract-client"}})
	fixtures["changedAuthConfig"] = data("GET", "/auth-config", nil)
	fixtures["reset"] = data("PATCH", "", object{"providerSettings": object{"oauthClientId": nil}})
	fixtures["resetAuthConfig"] = data("GET", "/auth-config", nil)
	encoded, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("NOUS_CONTRACT_JSON=%s", encoded)
}

func TestNativeNousCredentialSurfaceNeverReturnsTokens(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	putSyntheticSealedSecret(t, s, nativeNousSecretID(nativeNousBinding(provider)))
	if _, err := (nativeNousOAuthStorage{server: s}).Advance(nativeNousBinding(provider), nil); err != nil {
		t.Fatal("an unreadable previous credential prevented a fresh authorization", err)
	}
	config, err := s.data("GET", "/providers/"+nativeNousProviderID+"/auth-config", object{}, nil)
	if err != nil || obj(config)["type"] != "oauth" || obj(config)["clientId"] != defaultNousOAuthClientID || len(obj(config)) != 2 {
		t.Fatal("auth-config must expose only its type and public client ID", err)
	}
	keys, err := s.providerKeys("GET", provider, nil, object{}, object{})
	if err != nil || len(array(obj(keys)["keys"])) != 0 {
		t.Fatal("OAuth credentials reached the API key editor", err)
	}
	if _, err := s.providerKeys("PUT", provider, nil, object{}, object{"keys": []any{}}); err == nil {
		t.Fatal("API key editing was enabled for the OAuth provider")
	}
	if _, err := s.providerKey(provider, "synthetic-override"); err == nil {
		t.Fatal("model check could override an OAuth account with an API key")
	}
}

func TestNativeNousRequestPinsEndpointAndManagedAuthorization(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	config, err := s.resolveProviderRequest(provider, nousInferenceBaseURL, "", "models")
	if err != nil || config.oauthBinding == "" {
		t.Fatal(err)
	}
	if _, err := config.request(context.Background(), http.MethodGet, nil, false); err == nil {
		t.Fatal("an unresolved OAuth request could be sent")
	}
	if _, err := s.resolveProviderRequest(provider, "https://example.invalid/v1", "", "models"); err == nil {
		t.Fatal("OAuth accepted a custom inference destination")
	}
	provider["settings"] = object{"extraHeaders": object{"authorization": "Bearer synthetic-override"}}
	if _, err := s.resolveProviderRequest(provider, nousInferenceBaseURL, "", "models"); err == nil {
		t.Fatal("custom headers could replace OAuth authorization")
	}
}

func TestNativeNousLogoutCancelsOwnedRequestsAndRejectsLateSaves(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	provider["isEnabled"] = true
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	config, err := s.resolveProviderRequest(provider, nousInferenceBaseURL, "", "models")
	if err != nil {
		t.Fatal(err)
	}
	ctx, release, err := s.nativeNousRequestContext(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	storage := nativeNousOAuthStorage{server: s}
	if err := storage.Delete(config.oauthBinding); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() == nil || nativeNousFixture(t, s)["isEnabled"] != false {
		t.Fatal("logout left its provider enabled or its model request running")
	}
	stored, err := storage.Save(config.oauthBinding, config.oauthGeneration, nousOAuthCredential{ClientID: defaultNousOAuthClientID}, false)
	if err != nil || stored {
		t.Fatal("a stale refresh committed after logout", err)
	}
	if _, _, err := s.nativeNousRequestContext(context.Background(), config); err == nil {
		t.Fatal("a prepared request survived logout")
	}
}

func TestNativeNousOAuthIPCIsScopedToImplementedProvider(t *testing.T) {
	s, _ := testServer(t)
	for _, providerID := range []string{"openai-codex", "grok-cli", "unrecognized"} {
		result, err, _ := s.invoke("ipc-api:request", []any{"oauth.has_token", object{"providerId": providerID}})
		if err != nil || obj(result)["ok"] != false {
			t.Fatal("unsupported provider incorrectly claimed native OAuth", err)
		}
	}
	result, err, _ := s.invoke("ipc-api:request", []any{"oauth.has_token", object{"providerId": nativeNousProviderID}})
	if err != nil || obj(result)["ok"] != true || obj(result)["data"] != false {
		t.Fatal("empty OAuth session did not report logged out", err)
	}
	result, err, _ = s.invoke("ipc-api:request", []any{"oauth.device.start", object{"providerId": nativeNousProviderID, "requestId": ""}})
	if err != nil || obj(result)["ok"] != false {
		t.Fatal("invalid authorization input reached the network", err)
	}
}

// The runtime protocol is covered separately. This fixture supplies a synthetic
// already-authorized account so the real list/check/chat paths can be exercised
// on Linux without implementing a weaker fallback for Windows DPAPI.
type nativeNousTestStorage struct {
	mu       sync.Mutex
	server   *server
	binding  string
	snapshot nousOAuthSnapshot
}

func (storage *nativeNousTestStorage) Load(binding string) (nousOAuthSnapshot, error) {
	if !storage.server.mu.TryLock() {
		return nousOAuthSnapshot{}, errors.New("OAuth called while holding the repository lock")
	}
	storage.server.mu.Unlock()
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if binding != storage.binding {
		return nousOAuthSnapshot{}, errors.New("wrong credential owner")
	}
	result := storage.snapshot
	if result.Credential != nil {
		copy := *result.Credential
		result.Credential = &copy
	}
	return result, nil
}
func (storage *nativeNousTestStorage) Advance(string, *uint64) (nousOAuthSnapshot, error) {
	return nousOAuthSnapshot{}, errors.New("unexpected sign-in")
}
func (storage *nativeNousTestStorage) Save(string, uint64, nousOAuthCredential, bool) (bool, error) {
	return false, errors.New("unexpected refresh")
}
func (storage *nativeNousTestStorage) Delete(string) error { return errors.New("unexpected logout") }

func TestNativeNousAuthenticatedListCheckAndChatShareTheCredentialResolver(t *testing.T) {
	var postCount atomic.Int32
	var reject atomic.Bool
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Host != "inference-api.nousresearch.com" || request.Header.Get("Authorization") != "Bearer synthetic-access" {
			t.Error("request did not use the pinned host and synthetic access token")
		}
		if request.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"synthetic-model"}]}`)
			return
		}
		if request.URL.Path != "/v1/chat/completions" || request.Method != http.MethodPost {
			t.Error("unexpected inference route")
			http.NotFound(w, request)
			return
		}
		postCount.Add(1)
		if reject.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body object
		_ = json.NewDecoder(request.Body).Decode(&body)
		if body["stream"] == true {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"authorized\"}}]}\n\ndata: [DONE]\n\n")
		} else {
			fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"authorized"}}]}`)
		}
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	provider["isEnabled"] = true
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	topic := seedChat(t, s, "http://127.0.0.1")
	modelID := nativeNousProviderID + "::synthetic-model"
	if err := s.store.put("models", newModel(object{"providerId": nativeNousProviderID, "modelId": "synthetic-model"})); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference("chat.default_model_id", modelID); err != nil {
		t.Fatal(err)
	}
	network, err := resolveNetworkSettings(s.store)
	if err != nil {
		t.Fatal(err)
	}
	// Every dial is constrained to the owned test listener. No public endpoint,
	// real credential or browser profile is used by this integration test.
	s.networkTransports.entries[network.fingerprint()] = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // Synthetic loopback certificate only.
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if address != "inference-api.nousresearch.com:443" {
				return nil, errors.New("test rejected non-inference destination")
			}
			return (&net.Dialer{}).DialContext(ctx, "tcp", endpoint.Listener.Addr().String())
		},
	}
	credential := &nousOAuthCredential{AccessToken: "synthetic-access", RefreshToken: "synthetic-refresh", TokenType: "Bearer", ClientID: defaultNousOAuthClientID, InferenceBaseURL: nousInferenceBaseURL, ObtainedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	memory := &nativeNousTestStorage{server: s, binding: nativeNousBinding(provider), snapshot: nousOAuthSnapshot{Credential: credential}}
	s.nousOAuth = newNousOAuthRuntime(s.context, memory, s.nativeNousHTTPClient)
	listed, err := s.modelOperation("ai.provider.model.list", object{"providerId": nativeNousProviderID})
	models, ok := obj(listed)["models"].([]object)
	if err != nil || !ok || len(models) != 1 || models[0]["id"] != modelID {
		t.Fatal("authenticated catalog failed", err)
	}
	if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": modelID}); err != nil {
		t.Fatal("authenticated model check failed", err)
	}
	generation := launch(t, s, topic)
	waitDone(t, generation)
	if generation.answer != "authorized" {
		t.Fatal("chat did not use the OAuth credential resolver")
	}
	reject.Store(true)
	if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": modelID}); err == nil {
		t.Fatal("rejected inference was treated as successful")
	}
	if postCount.Load() != 3 {
		t.Fatal("a billable inference POST was replayed")
	}
	config, err := s.data("GET", "/providers/"+nativeNousProviderID+"/auth-config", object{}, nil)
	encoded, _ := json.Marshal(config)
	if err != nil || strings.Contains(string(encoded), "synthetic-access") || strings.Contains(string(encoded), "synthetic-refresh") {
		t.Fatal("token leaked into provider settings")
	}
}
