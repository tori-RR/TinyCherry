//go:build windows

package main

import (
	"bytes"
	"testing"
	"time"
)

func TestNativeNousWindowsProtectedSessionCAS(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	binding := nativeNousBinding(provider)
	storage := nativeNousOAuthStorage{server: s}
	login, err := storage.Advance(binding, nil)
	if err != nil {
		t.Fatal(err)
	}
	credential := nousOAuthCredential{AccessToken: "windows-synthetic-access", RefreshToken: "windows-synthetic-refresh", ClientID: defaultNousOAuthClientID, TokenType: "Bearer", InferenceBaseURL: nousInferenceBaseURL, ObtainedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	if saved, err := storage.Save(binding, login.Generation, credential, true); err != nil || !saved {
		t.Fatal("protected login did not commit", err)
	}
	var sealed []byte
	if err := s.store.connection().QueryRow("SELECT sealed FROM secret WHERE id=?", nativeNousSecretID(binding)).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte(credential.AccessToken)) || bytes.Contains(sealed, []byte(credential.RefreshToken)) {
		t.Fatal("credential bundle was stored without Windows protection")
	}
	current, err := storage.Load(binding)
	if err != nil || current.Credential == nil || current.Credential.AccessToken != credential.AccessToken || current.Generation == login.Generation {
		t.Fatal("committed session did not advance and decrypt", err)
	}
	if saved, err := storage.Save(binding, login.Generation, credential, false); err != nil || saved {
		t.Fatal("old-account refresh overwrote the newly signed-in session", err)
	}
	provider = nativeNousFixture(t, s)
	provider["isEnabled"] = false
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	credential.AccessToken = "windows-synthetic-rotated"
	credential.RefreshToken = "windows-synthetic-rotated-refresh"
	if saved, err := storage.Save(binding, current.Generation, credential, false); err != nil || !saved {
		t.Fatal("rotated credential did not commit", err)
	}
	refreshed, err := storage.Load(binding)
	if err != nil || refreshed.Generation != current.Generation || nativeNousFixture(t, s)["isEnabled"] != false {
		t.Fatal("background refresh altered session generation or provider enablement", err)
	}
	// Cancellation can arrive after the refresh grant was consumed. A draining
	// refresh must preserve its blocked state while a new login remains forbidden.
	s.cancel()
	credential.RequiresLogin = true
	if saved, err := storage.Save(binding, current.Generation, credential, false); err != nil || !saved {
		t.Fatal("shutdown lost the uncertain refresh state", err)
	}
	if saved, err := storage.Save(binding, current.Generation, credential, true); err != nil || saved {
		t.Fatal("new sign-in committed during shutdown", err)
	}
	blocked, err := storage.Load(binding)
	if err != nil || blocked.Credential == nil || !blocked.Credential.RequiresLogin {
		t.Fatal("uncertain grant could be automatically reused after restart", err)
	}
}

func TestNativeNousWindowsLogoutRemovesProtectedSession(t *testing.T) {
	s, _ := testServer(t)
	provider := nativeNousFixture(t, s)
	binding := nativeNousBinding(provider)
	storage := nativeNousOAuthStorage{server: s}
	credential := nousOAuthCredential{AccessToken: "windows-logout-fixture", ClientID: defaultNousOAuthClientID, TokenType: "Bearer", InferenceBaseURL: nousInferenceBaseURL, ObtainedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	if saved, err := storage.Save(binding, 0, credential, true); err != nil || !saved {
		t.Fatal(err)
	}
	result, err, _ := s.invoke("ipc-api:request", []any{"oauth.logout", object{"providerId": nativeNousProviderID}})
	if err != nil || obj(result)["ok"] != true {
		t.Fatal("logout failed", err)
	}
	current, err := storage.Load(binding)
	if err != nil || current.Credential != nil || nativeNousFixture(t, s)["isEnabled"] != false {
		t.Fatal("logout retained credentials or provider enablement", err)
	}
}
