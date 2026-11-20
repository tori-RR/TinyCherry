package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"
)

type chatGPTRefresh struct {
	owner, accountID string
	done             chan struct{}
	err              error // Published by closing done.
}

func (s *server) resolveChatGPTRequestLocked(provider object, base, resource string) (providerRequestConfig, error) {
	owner := chatGPTProviderOwner(provider)
	if owner == "" || base != chatGPTResource || (resource != "models" && resource != "responses") {
		return providerRequestConfig{}, errors.New("ChatGPT Sub requires its official OpenAI endpoint")
	}
	network, err := resolveNetworkSettings(s.store)
	if err != nil {
		return providerRequestConfig{}, err
	}
	return providerRequestConfig{
		address: chatGPTResource + "/" + resource, network: network, resource: resource,
		headers:      http.Header{"Content-Type": {"application/json"}, "User-Agent": {"TinyCherry/" + appVersion}},
		chatGPTOwner: owner, oauthGeneration: s.chatGPT.epoch,
	}, nil
}

func (s *server) providerRequestContext(ctx context.Context, config providerRequestConfig) (context.Context, context.CancelFunc, error) {
	if config.chatGPTOwner == "" {
		return s.nativeNousRequestContext(ctx, config)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkChatGPTRequestLocked(config); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	id := newID()
	s.chatGPT.requests[id] = cancel
	return ctx, func() {
		cancel()
		s.mu.Lock()
		delete(s.chatGPT.requests, id)
		s.mu.Unlock()
	}, nil
}

func (s *server) checkChatGPTRequestLocked(config providerRequestConfig) error {
	_, owner, err := s.chatGPTProviderLocked()
	if err != nil || owner != config.chatGPTOwner || s.chatGPT.epoch != config.oauthGeneration || s.chatGPT.signingOut {
		return errors.New("ChatGPT session changed; select the model and try again")
	}
	return nil
}

func (s *server) authorizeChatGPTRequest(ctx context.Context, config providerRequestConfig) (providerRequestConfig, error) {
	refreshed := false
	for {
		s.mu.Lock()
		if err := s.checkChatGPTRequestLocked(config); err != nil {
			s.mu.Unlock()
			return providerRequestConfig{}, err
		}
		vault, err := loadChatGPTVault(s.store, config.chatGPTOwner)
		if err != nil {
			s.mu.Unlock()
			return providerRequestConfig{}, err
		}
		i := vault.index(vault.Active)
		if i < 0 {
			s.mu.Unlock()
			return providerRequestConfig{}, errors.New("sign in to ChatGPT Sub first")
		}
		account := vault.Accounts[i]
		if refresh := s.chatGPT.refresh; refresh != nil {
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return providerRequestConfig{}, ctx.Err()
			case <-refresh.done:
				if refresh.owner == config.chatGPTOwner && refresh.accountID == account.ID {
					if refresh.err != nil {
						return providerRequestConfig{}, refresh.err
					}
					refreshed = true
				}
			}
			continue
		}
		if account.status() != "connected" {
			s.mu.Unlock()
			return providerRequestConfig{}, errors.New("ChatGPT plan authorization is required. Continue with ChatGPT in provider settings.")
		}
		now := time.Now()
		if account.ExpiresAt.After(now) && (refreshed || account.ExpiresAt.After(now.Add(time.Minute)) || account.EarliestRefreshAt.After(now)) {
			s.mu.Unlock()
			if err := ctx.Err(); err != nil {
				return providerRequestConfig{}, err
			}
			config.headers = config.headers.Clone()
			config.headers.Set("Authorization", "Bearer "+account.AccessToken)
			return config, nil
		}
		if account.EarliestRefreshAt.After(now) {
			s.mu.Unlock()
			return providerRequestConfig{}, errors.New("ChatGPT authorization cannot be renewed yet; try again shortly")
		}
		if err := ctx.Err(); err != nil {
			s.mu.Unlock()
			return providerRequestConfig{}, err
		}
		refresh := &chatGPTRefresh{owner: config.chatGPTOwner, accountID: account.ID, done: make(chan struct{})}
		// Persist a fence before spending a rotating grant. An interrupted
		// exchange or failed commit cannot replay that grant after restart.
		vault.Accounts[i].Renewing = true
		err = saveChatGPTVault(s.store, refresh.owner, vault)
		if err != nil {
			s.mu.Unlock()
			return providerRequestConfig{}, err
		}
		s.chatGPT.refresh = refresh
		s.chatGPT.workers.Add(1)
		s.mu.Unlock()
		go s.refreshChatGPT(refresh, account, s.networkClient(config.network))
		select {
		case <-ctx.Done():
			return providerRequestConfig{}, ctx.Err()
		case <-refresh.done:
			if refresh.err != nil {
				return providerRequestConfig{}, refresh.err
			}
			refreshed = true
		}
	}
}

func (s *server) refreshChatGPT(call *chatGPTRefresh, previous chatGPTRegistration, client *http.Client) {
	defer s.chatGPT.workers.Done()
	ctx, cancel := context.WithTimeout(s.context, chatGPTAuthTimeout)
	defer cancel()
	response, err := exchangeChatGPTToken(ctx, client, url.Values{
		"grant_type": {"refresh_token"}, "client_id": {previous.ClientID}, "refresh_token": {previous.RefreshToken},
	})
	replacement := previous
	if err == nil {
		scope := previous.Scope // OAuth permits omission when scope is unchanged.
		if response.Scope != nil {
			scope = *response.Scope
		}
		if chatGPTPlanGranted(scope) && !response.validPlanTokens() {
			replacement.NeedsSignIn = true
			err = errors.New("OpenAI returned incomplete renewed credentials. Sign in again.")
		} else {
			replacement.updateTokens(response, scope)
		}
	} else {
		var failure *chatGPTOAuthFailure
		switch {
		case errors.As(err, &failure) && failure.terminalRefresh():
			replacement.AccessToken, replacement.RefreshToken, replacement.IDToken, replacement.Scope = "", "", "", ""
			replacement.NeedsSignIn = true
		case failure != nil:
			// An explicit temporary rejection leaves the previous grant usable.
		default:
			replacement.NeedsSignIn = true
		}
	}
	replacement.Renewing = false

	s.mu.Lock()
	defer s.mu.Unlock()
	defer close(call.done)
	s.chatGPT.refresh = nil
	call.err = err
	_, owner, providerErr := s.chatGPTProviderLocked()
	if providerErr != nil || owner != call.owner {
		return
	}
	vault, loadErr := loadChatGPTVault(s.store, owner)
	if loadErr != nil {
		call.err = loadErr
		return
	}
	i := vault.index(call.accountID)
	if i < 0 || vault.Accounts[i].RefreshToken != previous.RefreshToken || !vault.Accounts[i].Renewing {
		return
	}
	vault.Accounts[i] = replacement
	if saveErr := saveChatGPTVault(s.store, owner, vault); saveErr != nil {
		call.err = saveErr
	}
}
