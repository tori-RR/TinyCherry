package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
)

func providerChatEndpoint(provider object) string {
	if isNativeChatGPTProvider(provider) {
		return "openai-responses"
	}
	return "openai-chat-completions"
}

func providerChatResource(provider object) string {
	if isNativeChatGPTProvider(provider) {
		return "responses"
	}
	return "chat/completions"
}

func chatGPTPayload(model string, messages []object) object {
	input := make([]object, 0, len(messages))
	var instructions []string
	for _, message := range messages {
		content := text(message["content"])
		if strings.TrimSpace(content) == "" {
			continue
		}
		switch message["role"] {
		case "system":
			instructions = append(instructions, content)
		case "user", "assistant":
			// A conversation may contain text from models that exposed tools.
			// The subscription text route only receives the visible history.
			input = append(input, object{"role": message["role"], "content": content})
		}
	}
	payload := object{"model": model, "input": input, "store": false, "stream": true}
	if len(instructions) != 0 {
		payload["instructions"] = strings.Join(instructions, "\n\n")
	}
	return payload
}

func decodeChatGPTModels(reader io.Reader) ([]object, error) {
	const limit = 4 * 1024 * 1024
	payload, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || len(payload) > limit {
		return nil, errors.New("ChatGPT model catalog exceeds its limit or could not be read")
	}
	var catalog struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Visibility  string `json:"visibility"`
		} `json:"models"`
	}
	if json.Unmarshal(payload, &catalog) != nil || catalog.Models == nil {
		return nil, errors.New("invalid ChatGPT account model catalog")
	}
	models := make([]object, 0, len(catalog.Models))
	seen := map[string]bool{}
	for _, item := range catalog.Models {
		if item.Visibility != "list" || !chatGPTOpaque(item.Slug, 512) || seen[item.Slug] {
			continue
		}
		seen[item.Slug] = true
		name := strings.TrimSpace(item.DisplayName)
		if name == "" || len(name) > 512 {
			name = item.Slug
		}
		models = append(models, newModel(object{
			"providerId": nativeChatGPTProviderID, "modelId": item.Slug, "name": name, "endpointTypes": []any{"openai-responses"},
		}))
	}
	return models, nil
}

func chatGPTProviderFailure(status int, header http.Header, body []byte) error {
	var frame struct {
		Code     string                                `json:"code"`
		Error    struct{ Code string }                 `json:"error"`
		Response struct{ Error struct{ Code string } } `json:"response"`
	}
	_ = json.Unmarshal(body, &frame)
	code := frame.Response.Error.Code
	if code == "" {
		code = frame.Error.Code
	}
	if code == "" {
		code = frame.Code
	}
	var message string
	switch {
	case status == http.StatusTooManyRequests || code == "subscription_sharing_usage_limit_exceeded":
		message = "ChatGPT plan or app usage limit reached. Manage usage at " + chatGPTUsageURL
		if status == 0 {
			status = http.StatusTooManyRequests
		}
	case code == "subscription_sharing_user_not_eligible":
		message = "ChatGPT plan usage is unavailable to this account or workspace."
	case code == "subscription_sharing_usage_unavailable" || code == "subscription_sharing_user_unavailable":
		message = "ChatGPT plan usage is temporarily unavailable. Try again later."
	case code == "subscription_sharing_unsupported_capability":
		message = "This request includes an input or model unsupported by ChatGPT plan usage."
	case status == http.StatusUnauthorized || code == "subscription_sharing_invalid_user":
		message = "OpenAI did not accept this ChatGPT session. Check the account in ChatGPT Sub settings."
	case status == http.StatusForbidden:
		message = "OpenAI did not allow ChatGPT plan usage for this request."
	}
	if message == "" {
		return providerFailure(status, body)
	}
	requestID := header.Get("X-Request-Id")
	if strings.HasPrefix(requestID, "req_") && chatGPTOpaque(requestID, 128) {
		message += fmt.Sprintf(" Request ID %s.", requestID)
	}
	return &providerResponseIssue{name: "AI_APICallError", message: message, status: status}
}

// Wait for the typed terminal event. A transport EOF or a Completions-style
// [DONE] cannot confirm a successful subscription request.
func readChatGPTStream(reader io.Reader, header http.Header, onDelta func(string) error) error {
	const limit = 1024 * 1024
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), limit)
	var data []string
	size := 0
	hasText := false
	event := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			size += len(line)
			if size > limit {
				return errors.New("ChatGPT Responses event exceeds the 1 MiB limit")
			}
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			continue
		}
		if line != "" {
			continue
		}
		kind := event
		event = ""
		if size == 0 {
			continue
		}
		value := strings.Join(data, "\n")
		data, size = nil, 0
		if strings.TrimSpace(value) == "[DONE]" {
			break
		}
		var frame struct{ Type, Delta string }
		if kind == "error" {
			return chatGPTProviderFailure(0, header, []byte(value))
		}
		if json.Unmarshal([]byte(value), &frame) != nil || frame.Type == "" {
			return invalidProviderResponse("Invalid data in the ChatGPT Responses stream.")
		}
		switch frame.Type {
		case "response.output_text.delta", "response.refusal.delta":
			if frame.Delta != "" {
				hasText = hasText || strings.TrimSpace(frame.Delta) != ""
				if err := onDelta(frame.Delta); err != nil {
					return err
				}
			}
		case "response.completed":
			if !hasText {
				return invalidProviderResponse("ChatGPT completed without any text output.")
			}
			return nil
		case "response.failed", "error":
			return chatGPTProviderFailure(0, header, []byte(value))
		case "response.incomplete":
			return invalidProviderResponse("ChatGPT returned an incomplete answer. Any partial text is shown above.")
		}
	}
	if scanner.Err() != nil {
		return invalidProviderResponse("ChatGPT Responses stream was interrupted.")
	}
	return invalidProviderResponse("ChatGPT Responses stream ended before response.completed.")
}

func (s *server) sendChatGPTResponse(ctx context.Context, config providerRequestConfig, payload object, onDelta func(string) error) error {
	ctx, release, err := s.providerRequestContext(ctx, config)
	if err != nil {
		return err
	}
	defer release()
	config, err = s.authorizeProviderRequest(ctx, config)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := config.request(ctx, http.MethodPost, bytes.NewReader(encoded), true)
	if err != nil {
		return err
	}
	response, err := s.networkClient(config.network).Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("could not connect to OpenAI Responses")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return chatGPTProviderFailure(response.StatusCode, response.Header, body)
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType != "text/event-stream" {
		return invalidProviderResponse("OpenAI did not return a Responses event stream.")
	}
	err = readChatGPTStream(response.Body, response.Header, onDelta)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func (s *server) generateChatGPTStep(ctx context.Context, g *generation, config providerRequestConfig, payload object) error {
	s.mu.Lock()
	err := s.chunk(g, object{"type": "start", "messageId": g.row["id"]})
	if err == nil {
		err = s.chunk(g, object{"type": "start-step"})
	}
	g.parts = append(g.parts, object{"type": "step-start"})
	s.mu.Unlock()
	if err != nil {
		return err
	}
	const partID = "text-0"
	var part object
	lastSave := time.Now()
	err = s.sendChatGPTResponse(ctx, config, payload, func(delta string) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(g.answer)+len(delta) > 1024*1024 {
			return errors.New("answer exceeds the 1 MiB trial limit")
		}
		if part == nil {
			if err := s.chunk(g, object{"type": "text-start", "id": partID}); err != nil {
				return err
			}
			part = object{"type": "text", "text": "", "state": "streaming"}
			g.parts = append(g.parts, part)
			s.cache("topic.stream.statuses."+g.topicID, object{"status": "streaming", "activeExecutions": []object{g.execution()}, "awaitingApprovalAnchors": []any{}})
		}
		if err := s.chunk(g, object{"type": "text-delta", "id": partID, "delta": delta}); err != nil {
			return err
		}
		g.appendAnswer("text", delta)
		part["text"] = g.answer
		s.updateProjection(g, "active", nil, false)
		if time.Since(lastSave) > 250*time.Millisecond {
			lastSave = time.Now()
			return s.persistGeneration(g, "pending")
		}
		return nil
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if part != nil {
		part["state"] = "done"
		_ = s.chunk(g, object{"type": "text-end", "id": partID})
	}
	if errors.Is(err, context.Canceled) {
		g.cancel()
	}
	if err != nil {
		return err
	}
	return s.chunk(g, object{"type": "finish-step"})
}
