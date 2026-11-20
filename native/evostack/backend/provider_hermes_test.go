package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProviderUpgradesPreserveNousSession(t *testing.T) {
	for _, scenario := range []struct {
		oldName, wantName  string
		beforeHermesPreset bool
	}{
		{oldName: "NousResearch", wantName: "Nous Portal"},
		{oldName: "Nous Portal", wantName: "Nous Portal", beforeHermesPreset: true},
		{oldName: "My Nous", wantName: "My Nous"},
	} {
		t.Run(scenario.oldName, func(t *testing.T) {
			s, directory := testServer(t)
			nous := nativeNousFixture(t, s)
			nous["name"], nous["isEnabled"] = scenario.oldName, true
			obj(nous["settings"])["oauthClientId"] = "local-fixture-client"
			binding := nativeNousBinding(nous)
			if err := s.store.put("providers", nous); err != nil {
				t.Fatal(err)
			}
			putSyntheticSealedSecret(t, s, nativeNousSecretID(binding))
			if err := s.store.delete("desktop-migrations", "nous-portal-display-name-v1"); err != nil {
				t.Fatal(err)
			}
			if scenario.beforeHermesPreset {
				if err := s.store.delete("providers", nativeHermesProviderID); err != nil {
					t.Fatal(err)
				}
				if err := s.store.delete("desktop-migrations", "hermes-subscription-provider-v1"); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.store.db.Close(); err != nil {
				t.Fatal(err)
			}
			upgraded, err := openStore(directory)
			if err != nil {
				t.Fatal(err)
			}
			defer upgraded.db.Close()
			preserved, err := upgraded.get("providers", nativeNousProviderID)
			if err != nil || preserved["name"] != scenario.wantName || preserved["isEnabled"] != true || nativeNousBinding(preserved) != binding || obj(preserved["settings"])["oauthClientId"] != "local-fixture-client" {
				t.Fatal("upgrading changed the saved Nous provider identity or settings", err)
			}
			var count int
			if err := upgraded.connection().QueryRow("SELECT count(*) FROM secret WHERE id=?", nativeNousSecretID(binding)).Scan(&count); err != nil || count != 1 {
				t.Fatal("upgrading removed the Nous OAuth credential", err)
			}
			hermes, err := upgraded.get("providers", nativeHermesProviderID)
			if err != nil || hermes["name"] != "Hermes" || hermes["isEnabled"] != false || hermes["authOptional"] != true {
				t.Fatal("upgrading did not seed the disabled Hermes preset", err)
			}
			if err := upgraded.delete("providers", nativeHermesProviderID); err != nil {
				t.Fatal(err)
			}
			if err := upgraded.transaction(func(tx *store) error { return tx.migrateHermesProvider() }); err != nil {
				t.Fatal(err)
			}
			if _, err := upgraded.get("providers", nativeHermesProviderID); !errors.Is(err, sql.ErrNoRows) {
				t.Fatal("upgrading recreated a deliberately deleted Hermes preset", err)
			}
			preserved["name"] = "NousResearch"
			if err := upgraded.put("providers", preserved); err != nil {
				t.Fatal(err)
			}
			if err := upgraded.transaction(func(tx *store) error { return tx.migrateNousPortalName() }); err != nil {
				t.Fatal(err)
			}
			renamed, err := upgraded.get("providers", nativeNousProviderID)
			if err != nil || renamed["name"] != "NousResearch" {
				t.Fatal("migration ran again after a user rename", err)
			}
		})
	}
}

func TestHermesProviderListsAndStreamsWithoutAnAPIKey(t *testing.T) {
	const rawID = "openai/proxy-fixture"
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.UserAgent() != "TinyCherry/"+appVersion {
			t.Error("Hermes request did not send the expected app identity and empty credentials")
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/models":
			fmt.Fprintf(w, `{"data":[{"id":%q}]}`, rawID)
		case "POST /v1/chat/completions":
			var body object
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["model"] != rawID || body["stream"] != true {
				t.Error("Hermes received an incorrect chat request", err)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"from the proxy\"}}]}\n\ndata: [DONE]\n\n")
		default:
			t.Error("unexpected Hermes route", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	hermes, err := s.store.get("providers", nativeHermesProviderID)
	if err != nil {
		t.Fatal(err)
	}
	obj(obj(hermes["endpointConfigs"])["openai-chat-completions"])["baseUrl"] = endpoint.URL + "/v1"
	hermes["isEnabled"] = true
	if err := s.store.put("providers", hermes); err != nil {
		t.Fatal(err)
	}
	listed, err := s.modelOperation("ai.provider.model.list", object{"providerId": nativeHermesProviderID})
	models, ok := obj(listed)["models"].([]object)
	if err != nil || !ok || len(models) != 1 || models[0]["apiModelId"] != rawID {
		t.Fatal("keyless Hermes model discovery did not preserve the upstream ID", err)
	}
	if err := s.store.put("models", models[0]); err != nil {
		t.Fatal(err)
	}
	topic := seedChat(t, s, endpoint.URL)
	if err := s.store.setPreference("chat.default_model_id", models[0]["id"]); err != nil {
		t.Fatal(err)
	}
	stream := launch(t, s, topic)
	waitDone(t, stream)
	if stream.answer != "from the proxy" || stream.row["status"] != "success" {
		t.Fatal("keyless Hermes chat did not complete")
	}
}
