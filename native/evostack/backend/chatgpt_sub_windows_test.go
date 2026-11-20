//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func signFixtureChatGPTIdentity(t *testing.T, key *rsa.PrivateKey, nonce string) string {
	t.Helper()
	encode := func(value object) string {
		data, _ := json.Marshal(value)
		return base64.RawURLEncoding.EncodeToString(data)
	}
	compact := encode(object{"alg": "RS256", "kid": "fixture-key"}) + "." + encode(object{
		"iss": chatGPTIssuer, "aud": "oaiapp_fixture", "sub": "fixture-user",
		"email": "fixture@example.invalid", "nonce": nonce, "exp": time.Now().Add(time.Hour).Unix(),
	})
	digest := sha256.Sum256([]byte(compact))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return compact + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func TestChatGPTSubBrowserCatalogAndMultiTurn(t *testing.T) {
	s, _ := testServer(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	type expectedLogin struct{ redirect, digest, token, scope string }
	var expected atomic.Pointer[expectedLogin]
	var refreshes, revocations, posts atomic.Int32
	var useRotated atomic.Bool
	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Host {
		case "auth.openai.com":
			switch r.URL.Path {
			case "/.well-known/openid-configuration":
				_ = json.NewEncoder(w).Encode(chatGPTDiscovery{
					Issuer: chatGPTIssuer, JWKS: chatGPTIssuer + "/fixture-jwks", Revocation: chatGPTIssuer + "/fixture-revoke",
				})
			case "/fixture-jwks":
				_ = json.NewEncoder(w).Encode(object{"keys": []object{{
					"kid": "fixture-key", "kty": "RSA", "alg": "RS256", "use": "sig",
					"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
					"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
				}}})
			case "/api/accounts/oauth/token":
				if r.Method != http.MethodPost || r.ParseForm() != nil || r.PostForm.Get("resource") != chatGPTResource ||
					r.PostForm.Get("client_id") != "oaiapp_fixture" || r.PostForm.Has("client_secret") {
					t.Error("unexpected ChatGPT token request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				switch r.PostForm.Get("grant_type") {
				case "authorization_code":
					spec := expected.Load()
					digest := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
					if spec == nil || r.PostForm.Get("redirect_uri") != spec.redirect ||
						base64.RawURLEncoding.EncodeToString(digest[:]) != spec.digest || r.PostForm.Get("code") != "fixture-code" {
						t.Error("code exchange did not use matching state-bound parameters")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					_ = json.NewEncoder(w).Encode(object{
						"id_token": spec.token, "scope": spec.scope, "access_token": "fixture-access",
						"refresh_token": "fixture-refresh", "token_type": "Bearer", "expires_in": 3600,
					})
				case "refresh_token":
					if r.PostForm.Get("refresh_token") != "fixture-refresh" || r.PostForm.Has("scope") {
						t.Error("unexpected refresh grant")
					}
					refreshes.Add(1)
					useRotated.Store(true)
					_ = json.NewEncoder(w).Encode(object{
						"access_token": "fixture-access-rotated", "refresh_token": "fixture-refresh-rotated", "token_type": "Bearer", "expires_in": 3600,
					})
				default:
					t.Error("unexpected grant")
					w.WriteHeader(http.StatusBadRequest)
				}
			case "/fixture-revoke":
				revocations.Add(1)
				if r.ParseForm() != nil || r.PostForm.Get("token") != "fixture-refresh-rotated" ||
					r.PostForm.Get("token_type_hint") != "refresh_token" || r.PostForm.Get("client_id") != "oaiapp_fixture" {
					t.Error("logout did not revoke the latest rotating grant")
				}
			default:
				t.Error("unexpected authorization path")
				http.NotFound(w, r)
			}
		case "api.openai.com":
			bearer := "Bearer fixture-access"
			if useRotated.Load() {
				bearer = "Bearer fixture-access-rotated"
			}
			if r.Header.Get("Authorization") != bearer || r.UserAgent() != "TinyCherry/"+appVersion {
				t.Error("request did not use managed ChatGPT authorization")
			}
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
				fmt.Fprint(w, `{"models":[{"slug":"hidden","visibility":"hidden"},{"slug":"fixture-chat","display_name":"Fixture Chat","visibility":"list"},{"slug":"fixture-other","display_name":"Fixture Other","visibility":"list"}]}`)
			case r.Method == http.MethodPost && r.URL.Path == "/v1/responses":
				n := posts.Add(1)
				var body object
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					t.Error("invalid Responses body")
				}
				input := array(body["input"])
				for _, field := range []string{"previous_response_id", "temperature", "max_output_tokens", "max_tokens", "tools", "messages"} {
					if _, present := body[field]; present {
						t.Errorf("unsupported field %s was sent", field)
					}
				}
				if body["store"] != false || body["stream"] != true || body["model"] != "fixture-chat" ||
					r.Header.Get("Accept") != "text/event-stream" || len(input) != int(2*n-1) ||
					obj(input[0])["role"] != "user" ||
					(n == 2 && (obj(input[1])["role"] != "assistant" || obj(input[1])["content"] != "fixture answer" || obj(input[2])["content"] != "follow-up")) {
					t.Error("Responses request did not carry the expected conversation history")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture \"}\n\n"+
					"data: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\n\n"+
					"data: {\"type\":\"response.completed\"}\n\n")
			default:
				t.Error("unexpected inference route")
				http.NotFound(w, r)
			}
		default:
			t.Error("unexpected test host")
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	network, err := resolveNetworkSettings(s.store)
	if err != nil {
		t.Fatal(err)
	}
	s.networkTransports.entries[network.fingerprint()] = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // Owned loopback test certificate only.
		DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
			if address != "auth.openai.com:443" && address != "api.openai.com:443" {
				return nil, errors.New("test refused non-fixture endpoint")
			}
			return (&net.Dialer{}).DialContext(ctx, "tcp", api.Listener.Addr().String())
		},
	}

	command := func(route string, input object) object {
		t.Helper()
		input["providerId"] = nativeChatGPTProviderID
		raw, err, _ := s.invoke("ipc-api:request", []any{"oauth.chatgpt." + route, input})
		envelope := obj(raw)
		if err != nil || envelope["ok"] != true {
			t.Fatalf("ChatGPT %s failed: %v %v", route, err, envelope["error"])
		}
		return obj(envelope["data"])
	}
	browserLogin := func(id, accountID, scopes string) (object, url.Values) {
		t.Helper()
		start := command("start", object{"requestId": id, "accountId": accountID})
		authorize, err := url.Parse(text(start["authorizationUrl"]))
		if err != nil || "https://"+authorize.Host+authorize.Path != chatGPTAuthorizeURL {
			t.Fatal("unexpected browser authorization address")
		}
		query := authorize.Query()
		if query.Get("scope") != chatGPTScopes || query.Get("resource") != chatGPTResource || query.Get("code_challenge_method") != "S256" ||
			!strings.HasPrefix(query.Get("redirect_uri"), "http://127.0.0.1:") || !strings.HasSuffix(query.Get("redirect_uri"), "/auth/callback") {
			t.Fatal("incorrect initial OAuth parameters")
		}
		expected.Store(&expectedLogin{
			redirect: query.Get("redirect_uri"), digest: query.Get("code_challenge"),
			token: signFixtureChatGPTIdentity(t, key, query.Get("nonce")), scope: scopes,
		})
		callback := func(state string, status int) {
			t.Helper()
			values := url.Values{"state": {state}, "code": {"fixture-code"}}
			if accountID == "" {
				values.Set("client_id", "oaiapp_fixture")
			}
			client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
			response, err := client.Get(query.Get("redirect_uri") + "?" + values.Encode())
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != status {
				t.Fatalf("callback returned status %d, want %d", response.StatusCode, status)
			}
		}
		callback("wrong-state", http.StatusBadRequest)
		callback(query.Get("state"), http.StatusOK)
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			status := command("status", object{"requestId": id})
			if status["status"] != "pending" {
				return status, query
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("OAuth result did not become available")
		return nil, nil
	}

	first, initial := browserLogin("first-sign-in", "", "openid profile email")
	if first["status"] != "completed" || first["firstUse"] != false || initial.Get("client_id") != chatGPTInitialClient ||
		initial.Get("agent_name_hint") != "TinyCherry" {
		t.Fatal("identity-only registration did not complete", first)
	}
	listInput := object{"providerId": nativeChatGPTProviderID}
	if _, err := s.modelOperation("ai.provider.model.list", listInput); err == nil {
		t.Fatal("identity-only sign-in allowed subscription requests")
	}
	accounts := command("accounts", object{})
	activeID := text(accounts["activeAccountId"])
	second, returning := browserLogin("reconsent", activeID, chatGPTScopes)
	if second["status"] != "completed" || second["firstUse"] != true || returning.Get("ext_agent_host_id") != initial.Get("ext_agent_host_id") ||
		returning.Get("client_id") != "oaiapp_fixture" || returning.Get("prompt") != "consent" || returning.Has("agent_name_hint") {
		t.Fatal("regular OAuth reauthorization did not reuse the registration", second)
	}
	_, owner, err := s.chatGPTProviderLocked()
	if err != nil || owner == "" {
		t.Fatal("missing ChatGPT provider owner", err)
	}
	var sealed []byte
	if err := s.store.connection().QueryRow("SELECT sealed FROM secret WHERE id=?", chatGPTSecretID(owner)).Scan(&sealed); err != nil ||
		bytes.Contains(sealed, []byte("fixture-access")) || bytes.Contains(sealed, []byte("fixture-refresh")) {
		t.Fatal("ChatGPT credentials were not protected by DPAPI", err)
	}
	accountsJSON, _ := json.Marshal(command("accounts", object{}))
	if bytes.Contains(accountsJSON, []byte("fixture-access")) || bytes.Contains(accountsJSON, []byte("fixture-refresh")) ||
		bytes.Contains(accountsJSON, []byte("oaiapp_fixture")) {
		t.Fatal("authorization material reached the account DTO")
	}
	listed, err := s.modelOperation("ai.provider.model.list", listInput)
	if err != nil {
		t.Fatal(err)
	}
	models := obj(listed)["models"].([]object)
	if len(models) != 2 || models[0]["apiModelId"] != "fixture-chat" || models[0]["name"] != "Fixture Chat" ||
		models[1]["apiModelId"] != "fixture-other" {
		t.Fatal("model catalog selection or ordering was incorrect")
	}
	topic := seedChat(t, s, "http://127.0.0.1")
	if err := s.store.put("models", models[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference("chat.default_model_id", models[0]["id"]); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference(computerPreference, true); err != nil {
		t.Fatal(err)
	}
	g := launch(t, s, topic)
	waitDone(t, g)
	if g.answer != "fixture answer" || g.row["status"] != "success" {
		t.Fatal("first subscription turn failed")
	}
	s.mu.Lock()
	_, err, after := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "parentAnchorId": g.row["id"],
		"userMessageParts": []any{object{"type": "text", "text": "follow-up"}}})
	next := s.active[text(topic["id"])]
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	after()
	waitDone(t, next)
	if next.answer != "fixture answer" || next.row["status"] != "success" || posts.Load() != 2 {
		t.Fatal("follow-up failed or repeated")
	}
	vault, err := loadChatGPTVault(s.store, owner)
	if err != nil {
		t.Fatal(err)
	}
	vault.Accounts[0].ExpiresAt = time.Now().Add(-time.Minute)
	if err := saveChatGPTVault(s.store, owner, vault); err != nil {
		t.Fatal(err)
	}
	var callers sync.WaitGroup
	for range 2 {
		callers.Go(func() {
			if _, err := s.modelOperation("ai.provider.model.list", listInput); err != nil {
				t.Error("request after refresh failed", err)
			}
		})
	}
	callers.Wait()
	if refreshes.Load() != 1 {
		t.Fatal("concurrent requests exchanged the same refresh token more than once")
	}
	if err := s.store.pruneUnusedSecrets(); err != nil {
		t.Fatal(err)
	}
	if result := command("logout", object{}); result["revoked"] != true || revocations.Load() != 1 {
		t.Fatal("logout did not revoke the protected credential")
	}
	if _, err := s.modelOperation("ai.provider.model.list", listInput); err == nil {
		t.Fatal("logged-out provider still made an authenticated request")
	}
}

func TestChatGPTResponsesRequiresCompletedEvent(t *testing.T) {
	const delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
	for _, tc := range []struct{ name, terminal, message string }{
		{"complete", "data: {\"type\":\"response.completed\"}\n\n", ""},
		{"EOF", "", "before response.completed"},
		{"completions-sentinel", "data: [DONE]\n\n", "before response.completed"},
		{"incomplete", "data: {\"type\":\"response.incomplete\"}\n\n", "incomplete answer"},
		{"usage-limit", "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n", chatGPTUsageURL},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var answer strings.Builder
			err := readChatGPTStream(strings.NewReader(delta+tc.terminal), nil, func(value string) error {
				answer.WriteString(value)
				return nil
			})
			if (tc.message == "" && err != nil) || (tc.message != "" && (err == nil || !strings.Contains(err.Error(), tc.message))) || answer.String() != "partial" {
				t.Fatal("wrong terminal outcome", err)
			}
		})
	}
}
