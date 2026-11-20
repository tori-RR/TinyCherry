package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const nativeNousProviderID = "nous-portal"

var errNativeNousProviderChanged = errors.New("Nous provider changed; start sign-in again")

// The owner changes when a provider is recreated or its OAuth client changes.
// It is backend-owned metadata, never an editable credential or an API key.
func isNativeNousOAuthProvider(provider object) bool {
	return provider["id"] == nativeNousProviderID && provider["authType"] == "oauth"
}

func nativeNousClientID(provider object) (string, error) {
	value := obj(provider["settings"])["oauthClientId"]
	if value != nil {
		if _, ok := value.(string); !ok {
			return "", errors.New("Nous OAuth client ID must be text")
		}
	}
	return validateNousOAuthClientID(text(value))
}

func initializeNativeNousProvider(provider object) {
	provider["authType"] = "oauth"
	provider["authMethods"] = []any{"oauth"}
	provider["apiKeys"] = []any{}
	provider["oauthOwnerId"] = newID()
}

func nativeNousBinding(provider object) string {
	owner := text(provider["oauthOwnerId"])
	if !isNativeNousOAuthProvider(provider) || owner == "" || strings.Contains(owner, ":") {
		return ""
	}
	return nativeNousProviderID + ":" + owner
}

func nativeNousSecretID(binding string) string {
	return nativeNousProviderID + ":oauth:" + strings.TrimPrefix(binding, nativeNousProviderID+":")
}

// All callers hold s.mu. Runtime methods are deliberately called after releasing
// that lock: token refresh and device polling must not block the repository.
func (s *server) nativeNousProviderLocked(binding string) (object, string, error) {
	provider, err := s.store.get("providers", nativeNousProviderID)
	if err != nil {
		return nil, "", err
	}
	if binding == "" || binding != nativeNousBinding(provider) {
		return nil, "", errNativeNousProviderChanged
	}
	clientID, err := nativeNousClientID(provider)
	return provider, clientID, err
}

func (s *server) currentNativeNousBindingLocked() string {
	provider, err := s.store.get("providers", nativeNousProviderID)
	if err != nil {
		return ""
	}
	return nativeNousBinding(provider)
}

type nativeNousOAuthStorage struct{ server *server }

func (storage nativeNousOAuthStorage) snapshotLocked(binding string) (nousOAuthSnapshot, error) {
	s := storage.server
	_, clientID, err := s.nativeNousProviderLocked(binding)
	if err != nil {
		return nousOAuthSnapshot{}, err
	}
	snapshot := nousOAuthSnapshot{Generation: s.nousOAuthGenerations[binding]}
	encoded, err := s.store.secret(nativeNousSecretID(binding))
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, errors.New("Nous credentials could not be opened for this Windows user")
	}
	var credential nousOAuthCredential
	if json.Unmarshal([]byte(encoded), &credential) != nil || credential.ClientID != clientID {
		return snapshot, errors.New("Nous credentials are invalid; sign in again")
	}
	snapshot.Credential = &credential
	return snapshot, nil
}

func (storage nativeNousOAuthStorage) Load(binding string) (nousOAuthSnapshot, error) {
	s := storage.server
	s.mu.Lock()
	defer s.mu.Unlock()
	return storage.snapshotLocked(binding)
}

func (storage nativeNousOAuthStorage) Advance(binding string, expected *uint64) (nousOAuthSnapshot, error) {
	s := storage.server
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := s.nativeNousProviderLocked(binding); err != nil {
		return nousOAuthSnapshot{}, err
	}
	// Starting a new authorization must work even if an old DPAPI bundle belongs
	// to a different Windows account or is damaged. Keep its bytes until a new
	// login succeeds, but do not require decryption just to reserve a generation.
	snapshot := nousOAuthSnapshot{Generation: s.nousOAuthGenerations[binding]}
	if expected == nil || snapshot.Generation == *expected {
		s.nousOAuthGenerations[binding]++
		snapshot.Generation = s.nousOAuthGenerations[binding]
	}
	return snapshot, nil
}

func (storage nativeNousOAuthStorage) Save(binding string, expected uint64, credential nousOAuthCredential, replaceSession bool) (bool, error) {
	s := storage.server
	s.mu.Lock()
	defer s.mu.Unlock()
	// A cancelled refresh may already have consumed its single-use grant. Let
	// the draining worker persist the new bundle or a RequiresLogin fence before
	// closing SQLite; a new sign-in may not complete during shutdown.
	if (replaceSession && s.context.Err() != nil) || s.nousOAuthGenerations[binding] != expected {
		return false, nil
	}
	provider, clientID, err := s.nativeNousProviderLocked(binding)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errNativeNousProviderChanged) || (err == nil && clientID != credential.ClientID) {
		// The immutable owner also rejects a late login after delete/recreate.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return false, errors.New("Nous credentials could not be serialized")
	}
	err = s.store.transaction(func(repository *store) error {
		if err := repository.setSecret(nativeNousSecretID(binding), string(encoded)); err != nil {
			return errors.New("Nous credentials could not be protected for this Windows user")
		}
		if replaceSession {
			provider["isEnabled"] = true
			return repository.put("providers", provider)
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	if replaceSession {
		s.nousOAuthGenerations[binding]++
		s.changed("/providers", "/providers/"+nativeNousProviderID)
	}
	return true, nil
}

func (storage nativeNousOAuthStorage) Delete(binding string) error {
	s := storage.server
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.store.transaction(func(repository *store) error {
		if _, err := repository.connection().Exec("DELETE FROM secret WHERE id=?", nativeNousSecretID(binding)); err != nil {
			return err
		}
		provider, err := repository.get("providers", nativeNousProviderID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if nativeNousBinding(provider) == binding {
			provider["isEnabled"] = false
			return repository.put("providers", provider)
		}
		return nil
	})
	if err != nil {
		return errors.New("Nous credentials could not be removed")
	}
	// The store lock makes deletion and the generation change one logical commit.
	s.nousOAuthGenerations[binding]++
	s.cancelNativeNousRequestsLocked(binding)
	s.changed("/providers", "/providers/"+nativeNousProviderID)
	return nil
}

func (s *server) cancelNativeNousRequestsLocked(binding string) {
	for _, cancel := range s.nousOAuthRequests[binding] {
		cancel()
	}
	delete(s.nousOAuthRequests, binding)
}

func (s *server) invalidateNativeNous(binding string) {
	s.mu.Lock()
	s.cancelNativeNousRequestsLocked(binding)
	s.mu.Unlock()
	s.nousOAuth.Invalidate(binding)
}

func (s *server) nativeNousRequestContext(ctx context.Context, config providerRequestConfig) (context.Context, context.CancelFunc, error) {
	if config.oauthBinding == "" {
		return ctx, func() {}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, clientID, err := s.nativeNousProviderLocked(config.oauthBinding)
	if err != nil || clientID != config.oauthClientID || s.nousOAuthGenerations[config.oauthBinding] != config.oauthGeneration {
		return nil, nil, errors.New("Nous session changed before the request was sent")
	}
	requestCtx, cancel := context.WithCancel(ctx)
	id := newID()
	if s.nousOAuthRequests[config.oauthBinding] == nil {
		s.nousOAuthRequests[config.oauthBinding] = map[string]context.CancelFunc{}
	}
	s.nousOAuthRequests[config.oauthBinding][id] = cancel
	return requestCtx, func() {
		cancel()
		s.mu.Lock()
		delete(s.nousOAuthRequests[config.oauthBinding], id)
		if len(s.nousOAuthRequests[config.oauthBinding]) == 0 {
			delete(s.nousOAuthRequests, config.oauthBinding)
		}
		s.mu.Unlock()
	}, nil
}

func (s *server) nativeNousHTTPClient() (*http.Client, error) {
	s.mu.Lock()
	settings, err := resolveNetworkSettings(s.store)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return s.networkClient(settings), nil
}

func (s *server) oauthCommand(route string, input object) (any, error) {
	if strings.HasPrefix(route, "oauth.chatgpt.") {
		if input["providerId"] != nativeChatGPTProviderID {
			return nil, notMigrated("OAuth provider")
		}
		return s.chatGPTCommand(route, input)
	}
	switch route {
	case "oauth.device.start", "oauth.device.status", "oauth.device.cancel", "oauth.has_token", "oauth.get_account", "oauth.logout":
	default:
		return nil, notMigrated(route)
	}
	if input["providerId"] != nativeNousProviderID {
		return nil, notMigrated("OAuth provider")
	}
	requestID := text(input["requestId"])
	if strings.HasPrefix(route, "oauth.device.") && (requestID == "" || len(requestID) > 128 || strings.ContainsAny(requestID, "\r\n\x00")) {
		return nil, errors.New("invalid OAuth request ID")
	}
	s.mu.Lock()
	binding := s.currentNativeNousBindingLocked()
	_, clientID, err := s.nativeNousProviderLocked(binding)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	switch route {
	case "oauth.device.start":
		return s.nousOAuth.Start(s.context, binding, requestID, clientID)
	case "oauth.device.status":
		return s.nousOAuth.Status(binding, requestID)
	case "oauth.device.cancel":
		return nil, s.nousOAuth.Cancel(binding, requestID)
	case "oauth.has_token":
		return s.nousOAuth.HasToken(binding)
	case "oauth.get_account":
		return s.nousOAuth.Account(binding)
	case "oauth.logout":
		return nil, s.nousOAuth.Logout(binding)
	}
	return nil, notMigrated(route)
}

// Runs outside s.mu immediately before a model/list request. Each distinct
// model/tool step gets a current token; an already-sent POST is never replayed.
func (s *server) authorizeProviderRequest(ctx context.Context, config providerRequestConfig) (providerRequestConfig, error) {
	if config.chatGPTOwner != "" {
		return s.authorizeChatGPTRequest(ctx, config)
	}
	if config.oauthBinding == "" {
		return config, nil
	}
	credential, err := s.nousOAuth.Credential(ctx, config.oauthBinding, config.oauthClientID)
	if err != nil {
		return providerRequestConfig{}, err
	}
	s.mu.Lock()
	_, currentClient, err := s.nativeNousProviderLocked(config.oauthBinding)
	currentGeneration := s.nousOAuthGenerations[config.oauthBinding]
	s.mu.Unlock()
	if err != nil || currentClient != config.oauthClientID || currentGeneration != config.oauthGeneration || ctx.Err() != nil {
		return providerRequestConfig{}, errors.New("Nous provider changed before the request was sent")
	}
	base, err := validateNousInferenceURL(credential.InferenceBaseURL)
	if err != nil {
		return providerRequestConfig{}, err
	}
	config.address, err = providerEndpoint(nil, base, config.resource)
	if err != nil {
		return providerRequestConfig{}, err
	}
	config.headers = config.headers.Clone()
	config.headers.Set("Authorization", "Bearer "+credential.AccessToken)
	return config, nil
}
