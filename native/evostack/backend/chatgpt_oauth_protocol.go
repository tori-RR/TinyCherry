package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	chatGPTIssuer        = "https://auth.openai.com"
	chatGPTResource      = "https://api.openai.com/v1"
	chatGPTAuthorizeURL  = chatGPTIssuer + "/api/accounts/authorize"
	chatGPTTokenURL      = chatGPTIssuer + "/api/accounts/oauth/token"
	chatGPTDiscoveryURL  = chatGPTIssuer + "/.well-known/openid-configuration"
	chatGPTInitialClient = "dynamic_agent_client"
	chatGPTScopes        = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
	chatGPTUsageURL      = "https://chatgpt.com/settings/usage"
)

type chatGPTTokenResponse struct {
	AccessToken       string          `json:"access_token"`
	RefreshToken      string          `json:"refresh_token"`
	IDToken           string          `json:"id_token"`
	TokenType         string          `json:"token_type"`
	ExpiresIn         int64           `json:"expires_in"`
	Scope             *string         `json:"scope"`
	EarliestRefreshAt json.RawMessage `json:"earliest_refresh_at"`
}

type chatGPTOAuthFailure struct {
	Status int
	Code   string
}

func (e *chatGPTOAuthFailure) Error() string {
	switch e.Code {
	case "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused":
		return "ChatGPT authorization expired or was revoked. Sign in again."
	case "invalid_client":
		return "OpenAI did not accept the saved ChatGPT registration."
	default:
		return fmt.Sprintf("OpenAI authorization returned HTTP %d.", e.Status)
	}
}

func (e *chatGPTOAuthFailure) terminalRefresh() bool {
	switch e.Code {
	case "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client":
		return true
	default:
		return false
	}
}

type chatGPTDiscovery struct {
	Issuer     string `json:"issuer"`
	JWKS       string `json:"jwks_uri"`
	Revocation string `json:"revocation_endpoint"`
}

func chatGPTAuthEndpoint(value string) bool {
	address, err := url.Parse(value)
	return err == nil && address.Scheme == "https" && address.Host == "auth.openai.com" &&
		address.User == nil && address.Path != "" && address.Fragment == "" && address.RawQuery == ""
}

// Token endpoints and discovery are only accessed on OpenAI's auth origin.
// The provider network client refuses redirects and errors never include bodies.
func chatGPTOAuthRequest(ctx context.Context, client *http.Client, address string, form url.Values, result any) error {
	if !chatGPTAuthEndpoint(address) {
		return errors.New("invalid OpenAI authorization endpoint")
	}
	method := http.MethodGet
	var body io.Reader
	if form != nil {
		method, body = http.MethodPost, strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, address, body)
	if err != nil {
		return errors.New("invalid OpenAI authorization request")
	}
	req.GetBody = nil
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "TinyCherry/"+appVersion)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("could not connect to OpenAI authorization")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Code string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 16*1024)).Decode(&failure)
		return &chatGPTOAuthFailure{Status: resp.StatusCode, Code: failure.Code}
	}
	if result == nil {
		return nil
	}
	const limit = 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || len(data) > limit || json.Unmarshal(data, result) != nil {
		return errors.New("invalid OpenAI authorization response")
	}
	return nil
}

func discoverChatGPT(ctx context.Context, client *http.Client) (chatGPTDiscovery, error) {
	var discovery chatGPTDiscovery
	err := chatGPTOAuthRequest(ctx, client, chatGPTDiscoveryURL, nil, &discovery)
	if err == nil && discovery.Issuer != chatGPTIssuer {
		err = errors.New("invalid OpenAI identity issuer")
	}
	return discovery, err
}

func exchangeChatGPTToken(ctx context.Context, client *http.Client, form url.Values) (chatGPTTokenResponse, error) {
	form.Set("resource", chatGPTResource)
	var response chatGPTTokenResponse
	err := chatGPTOAuthRequest(ctx, client, chatGPTTokenURL, form, &response)
	return response, err
}

func chatGPTPlanGranted(scope string) bool {
	scopes := strings.Fields(scope)
	return slices.Contains(scopes, "chatgpt.tokens.use.direct") && slices.Contains(scopes, "resource.invoke")
}

func chatGPTOpaque(value string, maxLength int) bool {
	return value != "" && len(value) <= maxLength && strings.IndexFunc(value, func(r rune) bool { return r < '!' || r > '~' }) < 0
}

func (t chatGPTTokenResponse) validPlanTokens() bool {
	return strings.EqualFold(t.TokenType, "Bearer") && chatGPTOpaque(t.AccessToken, 32*1024) &&
		chatGPTOpaque(t.RefreshToken, 32*1024) && t.ExpiresIn > 0 && t.ExpiresIn <= int64(24*time.Hour/time.Second)
}

func (t chatGPTTokenResponse) earliestRefresh() time.Time {
	var unixSeconds int64
	if json.Unmarshal(t.EarliestRefreshAt, &unixSeconds) == nil && unixSeconds > 0 {
		return time.Unix(unixSeconds, 0)
	}
	var value string
	if json.Unmarshal(t.EarliestRefreshAt, &value) == nil {
		if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds > 0 {
			return time.Unix(seconds, 0)
		}
		parsed, _ := time.Parse(time.RFC3339, value)
		return parsed
	}
	return time.Time{}
}

type chatGPTIdentity struct {
	Subject string `json:"sub"`
	Email   string `json:"email"`
}

func validateChatGPTIDToken(ctx context.Context, client *http.Client, token, clientID, nonce string, now time.Time) (chatGPTIdentity, error) {
	invalid := errors.New("OpenAI identity could not be verified. Start sign-in again.")
	pieces := strings.Split(token, ".")
	if len(pieces) != 3 || len(token) > 64*1024 {
		return chatGPTIdentity{}, invalid
	}
	header, headerErr := base64.RawURLEncoding.DecodeString(pieces[0])
	payload, payloadErr := base64.RawURLEncoding.DecodeString(pieces[1])
	signature, signatureErr := base64.RawURLEncoding.DecodeString(pieces[2])
	var jwtHeader struct {
		Algorithm string `json:"alg"`
		KeyID     string `json:"kid"`
	}
	if headerErr != nil || payloadErr != nil || signatureErr != nil || json.Unmarshal(header, &jwtHeader) != nil ||
		jwtHeader.Algorithm != "RS256" || jwtHeader.KeyID == "" {
		return chatGPTIdentity{}, invalid
	}
	discovery, err := discoverChatGPT(ctx, client)
	if err != nil {
		return chatGPTIdentity{}, err
	}
	var jwks struct {
		Keys []struct {
			KeyID     string `json:"kid"`
			Type      string `json:"kty"`
			Algorithm string `json:"alg"`
			Use       string `json:"use"`
			Modulus   string `json:"n"`
			Exponent  string `json:"e"`
		} `json:"keys"`
	}
	if err := chatGPTOAuthRequest(ctx, client, discovery.JWKS, nil, &jwks); err != nil {
		return chatGPTIdentity{}, err
	}
	digest := sha256.Sum256([]byte(pieces[0] + "." + pieces[1]))
	verified := false
	for _, key := range jwks.Keys {
		if key.KeyID != jwtHeader.KeyID || key.Type != "RSA" ||
			(key.Algorithm != "" && key.Algorithm != "RS256") || (key.Use != "" && key.Use != "sig") {
			continue
		}
		n, nErr := base64.RawURLEncoding.DecodeString(key.Modulus)
		e, eErr := base64.RawURLEncoding.DecodeString(key.Exponent)
		if nErr != nil || eErr != nil || len(n) < 256 || len(n) > 1024 || len(e) == 0 || len(e) > 4 {
			continue
		}
		public := rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Uint64())}
		if public.N.BitLen() >= 2048 && rsa.VerifyPKCS1v15(&public, crypto.SHA256, digest[:], signature) == nil {
			verified = true
			break
		}
	}
	var claims struct {
		chatGPTIdentity
		Issuer    string          `json:"iss"`
		Audience  json.RawMessage `json:"aud"`
		Party     string          `json:"azp"`
		ExpiresAt int64           `json:"exp"`
		NotBefore int64           `json:"nbf"`
		Nonce     string          `json:"nonce"`
	}
	if !verified || json.Unmarshal(payload, &claims) != nil || claims.Issuer != chatGPTIssuer ||
		claims.ExpiresAt <= now.Unix() || claims.NotBefore > now.Unix() || claims.Nonce != nonce ||
		!chatGPTOpaque(claims.Subject, 512) || len(claims.Email) > 512 {
		return chatGPTIdentity{}, invalid
	}
	var audience []string
	var single string
	if json.Unmarshal(claims.Audience, &single) == nil {
		audience = []string{single}
	} else if json.Unmarshal(claims.Audience, &audience) != nil {
		return chatGPTIdentity{}, invalid
	}
	if !slices.Contains(audience, clientID) || (len(audience) > 1 && claims.Party != clientID) ||
		(claims.Party != "" && claims.Party != clientID) {
		return chatGPTIdentity{}, invalid
	}
	return claims.chatGPTIdentity, nil
}
