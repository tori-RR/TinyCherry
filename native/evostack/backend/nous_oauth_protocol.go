package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	nousPortalBaseURL        = "https://portal.nousresearch.com"
	nousInferenceBaseURL     = "https://inference-api.nousresearch.com/v1"
	defaultNousOAuthClientID = "hermes-cli"
	nousOAuthScope           = "inference:invoke"
	nousDeviceGrant          = "urn:ietf:params:oauth:grant-type:device_code"
	nousOAuthRequestTimeout  = 8 * time.Second
	nousOAuthResponseLimit   = 128 * 1024
)

type nousOAuthError struct {
	code          string
	message       string
	requiresLogin bool
	ambiguous     bool
	retryAfter    time.Duration
}

func (err *nousOAuthError) Error() string { return err.message }
func nousError(code, message string) *nousOAuthError {
	return &nousOAuthError{code: code, message: message}
}
func nousLoginRequired() *nousOAuthError {
	return &nousOAuthError{code: "login_required", message: "Sign in to Nous Portal again.", requiresLogin: true}
}
func nousCancelledError() *nousOAuthError {
	return nousError("cancelled", "Nous sign-in was cancelled.")
}
func nousStorageError() *nousOAuthError {
	return nousError("storage_error", "Nous protected credential storage is unavailable.")
}

func validateNousOAuthClientID(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return defaultNousOAuthClientID, nil
	}
	if len(value) > 256 {
		return "", nousError("invalid_client", "Invalid Nous OAuth client ID.")
	}
	for _, c := range value {
		if c < 33 || c > 126 {
			return "", nousError("invalid_client", "Invalid Nous OAuth client ID.")
		}
	}
	return value, nil
}

func validNousToken(value string) bool {
	if value == "" || len(value) > 64*1024 {
		return false
	}
	for _, character := range value {
		if character < 33 || character > 126 {
			return false
		}
	}
	return true
}

func nousHTTPSURL(raw string) (*url.URL, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Opaque != "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return nil, false
	}
	return parsed, true
}

func validateNousInferenceURL(raw string) (string, error) {
	if raw == "" {
		raw = nousInferenceBaseURL
	}
	parsed, ok := nousHTTPSURL(raw)
	if !ok || parsed.RawQuery != "" || parsed.RawPath != "" || strings.TrimRight(parsed.Path, "/") != "/v1" {
		return "", nousError("invalid_endpoint", "Nous returned an unsupported inference endpoint.")
	}
	switch parsed.Hostname() {
	case "inference-api.nousresearch.com", "welcome-api.nousresearch.com":
		return "https://" + parsed.Hostname() + "/v1", nil
	default:
		return "", nousError("invalid_endpoint", "Nous returned an unsupported inference endpoint.")
	}
}

func validateNousVerificationURL(raw string) bool {
	parsed, ok := nousHTTPSURL(raw)
	return ok && parsed.Hostname() == "portal.nousresearch.com"
}

type nousDeviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int64  `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type nousTokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	TokenType        string `json:"token_type"`
	Scope            string `json:"scope"`
	ExpiresIn        int64  `json:"expires_in"`
	InferenceBaseURL string `json:"inference_base_url"`
	Error            string `json:"error"`
}

// Fixed endpoints and a copied no-redirect client prevent custom provider headers,
// edited base URLs, or a redirect from receiving OAuth credentials.
func (runtime *nousOAuthRuntime) post(ctx context.Context, path string, form url.Values, refreshToken string, result any) error {
	if path != "/api/oauth/device/code" && path != "/api/oauth/token" {
		return nousError("invalid_endpoint", "Invalid Nous OAuth endpoint.")
	}
	client, err := runtime.clientFactory()
	if err != nil || client == nil {
		return nousError("network_error", "Nous connection settings are unavailable.")
	}
	owned := *client
	owned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, nousPortalBaseURL+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nousError("invalid_request", "Invalid Nous OAuth request.")
	}
	request.GetBody = nil // A consumed single-use grant must never be replayed by transport.
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if refreshToken != "" {
		request.Header.Set("x-nous-refresh-token", refreshToken)
	}
	response, err := owned.Do(request)
	if err != nil {
		return &nousOAuthError{code: "network_error", message: "The Nous authorization response could not be confirmed. Try signing in again.", ambiguous: refreshToken != ""}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, nousOAuthResponseLimit+1))
	if err != nil || len(body) > nousOAuthResponseLimit {
		return &nousOAuthError{code: "invalid_response", message: "Nous returned an unreadable authorization response.", ambiguous: refreshToken != ""}
	}
	if response.StatusCode != http.StatusOK {
		// Only static classifications leave the backend. Upstream error descriptions,
		// HTTP errors and URLs may contain credentials and must never be forwarded.
		if response.StatusCode >= 500 {
			// A gateway failure can hide a refresh that already rotated the grant.
			return &nousOAuthError{code: "temporarily_unavailable", message: "Nous Portal is temporarily unavailable.", ambiguous: refreshToken != ""}
		}
		if response.StatusCode == http.StatusTooManyRequests || response.Header.Get("x-vercel-mitigated") != "" {
			limited := nousError("rate_limited", "Nous Portal temporarily limited authorization requests.")
			if seconds, parseErr := strconv.Atoi(response.Header.Get("Retry-After")); parseErr == nil && seconds > 0 && seconds <= 1800 {
				limited.retryAfter = time.Duration(seconds) * time.Second
			} else if date, parseErr := http.ParseTime(response.Header.Get("Retry-After")); parseErr == nil {
				limited.retryAfter = min(max(0, date.Sub(runtime.now())), 30*time.Minute)
			}
			return limited
		}
		var failure struct {
			Code string `json:"error"`
		}
		_ = json.Unmarshal(body, &failure)
		switch failure.Code {
		case "authorization_pending":
			return nousError("authorization_pending", "Waiting for Nous authorization.")
		case "slow_down":
			return nousError("slow_down", "Nous requested slower authorization polling.")
		case "expired_token":
			return nousError("expired_token", "The Nous authorization code expired.")
		case "access_denied":
			return nousError("access_denied", "Nous authorization was declined.")
		case "invalid_client", "unauthorized_client":
			return nousError("invalid_client", "Nous did not accept this OAuth client ID.")
		case "invalid_grant", "refresh_token_reused", "invalid_token":
			return nousLoginRequired()
		}
		if refreshToken != "" && (response.StatusCode == 401 || response.StatusCode == 403) {
			return nousLoginRequired()
		}
		// An unexpected HTTP response does not confirm the refresh grant is reusable.
		return &nousOAuthError{code: "authorization_failed", message: "Nous did not accept the authorization request.", ambiguous: refreshToken != ""}
	}
	if json.Unmarshal(body, result) != nil {
		return &nousOAuthError{code: "invalid_response", message: "Nous returned an invalid authorization response.", ambiguous: refreshToken != ""}
	}
	return nil
}

func (runtime *nousOAuthRuntime) requestDeviceCode(ctx context.Context, clientID string) (nousDeviceCodeResponse, error) {
	data := nousDeviceCodeResponse{}
	err := runtime.post(ctx, "/api/oauth/device/code", url.Values{"client_id": {clientID}, "scope": {nousOAuthScope}}, "", &data)
	if err != nil {
		return data, err
	}
	if !validNousToken(data.DeviceCode) || data.UserCode == "" || len(data.UserCode) > 256 || strings.ContainsAny(data.UserCode, "\r\n\x00") ||
		!validateNousVerificationURL(data.VerificationURI) || (data.VerificationURIComplete != "" && !validateNousVerificationURL(data.VerificationURIComplete)) || data.ExpiresIn <= 0 || data.ExpiresIn > 1800 || data.Interval < 0 || data.Interval > 300 {
		return nousDeviceCodeResponse{}, nousError("invalid_response", "Nous returned invalid device authorization details.")
	}
	if data.Interval == 0 {
		data.Interval = 5
	}
	return data, nil
}

func (runtime *nousOAuthRuntime) exchange(ctx context.Context, clientID, deviceCode, refreshToken string) (nousTokenResponse, error) {
	form := url.Values{"client_id": {clientID}}
	if refreshToken == "" {
		form.Set("grant_type", nousDeviceGrant)
		form.Set("device_code", deviceCode)
	} else {
		form.Set("grant_type", "refresh_token")
	}
	data := nousTokenResponse{}
	err := runtime.post(ctx, "/api/oauth/token", form, refreshToken, &data)
	return data, err
}

func parseNousCredential(data nousTokenResponse, previous *nousOAuthCredential, clientID string, now time.Time) (nousOAuthCredential, error) {
	if data.Error != "" || !validNousToken(data.AccessToken) || (data.TokenType != "" && !strings.EqualFold(data.TokenType, "Bearer")) || data.ExpiresIn <= 0 || data.ExpiresIn > 90*24*60*60 {
		return nousOAuthCredential{}, nousError("invalid_token", "Nous returned an unusable access token.")
	}
	parts := strings.Split(data.AccessToken, ".")
	if len(parts) != 3 {
		return nousOAuthCredential{}, nousError("invalid_token", "Nous returned an unusable access token.")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		Scope   string          `json:"scope"`
		Scopes  json.RawMessage `json:"scp"`
		Expires int64           `json:"exp"`
		Subject string          `json:"sub"`
	}
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return nousOAuthCredential{}, nousError("invalid_token", "Nous returned an unusable access token.")
	}
	scopes := append(strings.Fields(data.Scope), strings.Fields(claims.Scope)...)
	if len(claims.Scopes) > 0 {
		var list []string
		var single string
		if json.Unmarshal(claims.Scopes, &list) == nil {
			scopes = append(scopes, list...)
		} else if json.Unmarshal(claims.Scopes, &single) == nil {
			scopes = append(scopes, strings.Fields(single)...)
		}
	}
	found := false
	for _, value := range scopes {
		if value == nousOAuthScope {
			found = true
		}
	}
	if !found {
		return nousOAuthCredential{}, nousError("invalid_scope", "Nous did not grant model inference access.")
	}
	base := data.InferenceBaseURL
	if base == "" && previous != nil {
		base = previous.InferenceBaseURL
	}
	base, err = validateNousInferenceURL(base)
	if err != nil {
		return nousOAuthCredential{}, err
	}
	refresh := data.RefreshToken
	if refresh == "" && previous != nil {
		refresh = previous.RefreshToken
	}
	if !validNousToken(refresh) {
		return nousOAuthCredential{}, nousError("invalid_token", "Nous did not return a renewable session.")
	}
	expires := now.Add(time.Duration(data.ExpiresIn) * time.Second)
	if claims.Expires > 0 && time.Unix(claims.Expires, 0).Before(expires) {
		expires = time.Unix(claims.Expires, 0)
	}
	if !expires.After(now) {
		return nousOAuthCredential{}, nousError("invalid_token", "Nous returned an expired access token.")
	}
	if len(claims.Subject) > 512 || strings.ContainsAny(claims.Subject, "\r\n\x00") {
		claims.Subject = ""
	}
	return nousOAuthCredential{AccessToken: data.AccessToken, RefreshToken: refresh, TokenType: "Bearer", Scope: nousOAuthScope,
		ClientID: clientID, InferenceBaseURL: base, ObtainedAt: now, ExpiresAt: expires, AccountID: claims.Subject}, nil
}
