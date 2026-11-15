package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

// Retain a diagnosis, not a provider response body: upstream errors can echo
// prompts, URLs or credentials. The renderer understands this SerializedError.
type providerResponseIssue struct {
	name, message, category string
	status                  int
}

func (e *providerResponseIssue) Error() string { return e.message }

func invalidProviderResponse(message string) error {
	return &providerResponseIssue{name: "AI_TypeValidationError", message: message, category: "parse"}
}

var contextLimitPattern = regexp.MustCompile(`context[_ ]length[_ ]exceeded|model_context_window_exceeded|too many tokens|prompt is too long|input exceeds the context limit|maximum context length is [\d,]+ tokens|input.{0,80}(?:longer than|exceeds).{0,80}context length`)

func contextLimitText(value string) bool {
	text := strings.ToLower(value)
	return contextLimitPattern.MatchString(text) ||
		(strings.Contains(text, "maximum context length") && (strings.Contains(text, "exceed") || strings.Contains(text, "too long") || strings.Contains(text, "too large"))) ||
		(strings.Contains(text, "context window") && (strings.Contains(text, "exceed") || strings.Contains(text, "too long") || strings.Contains(text, "too large"))) ||
		(strings.Contains(text, "input is too long") && (strings.Contains(text, "model") || strings.Contains(text, "context") || strings.Contains(text, "token")))
}

func providerIssueContext(payload []byte) bool {
	var value any
	if json.Unmarshal(payload, &value) != nil {
		return contextLimitText(string(payload))
	}
	var inspect func(any, int) bool
	inspect = func(value any, depth int) bool {
		if depth > 3 {
			return false
		}
		if message, ok := value.(string); ok {
			return contextLimitText(message)
		}
		entry, ok := value.(map[string]any)
		if !ok {
			return false
		}
		for _, key := range []string{"error", "detail", "message", "code", "type"} {
			if inspect(entry[key], depth+1) {
				return true
			}
		}
		return false
	}
	return inspect(value, 0)
}

func providerFailure(status int, payload []byte) error {
	issue := &providerResponseIssue{name: "AI_APICallError", status: status, message: "Provider returned a stream error. Retry or check the provider endpoint and model."}
	if status != 0 {
		issue.message = fmt.Sprintf("Provider returned HTTP %d. Check the provider settings and retry.", status)
	}
	// Match the shared classifier: an actual server/auth status outranks text.
	if status != 401 && status != 403 && status != 404 && status != 402 && status != 429 && status < 500 && providerIssueContext(payload) {
		issue.category = "context_length"
		issue.message = "Input exceeds the context limit. Reduce the conversation history or input size, then retry."
	}
	return issue
}

func serializedGenerationError(err error) object {
	result := object{"name": "Error", "message": err.Error(), "stack": nil}
	var issue *providerResponseIssue
	if errors.As(err, &issue) {
		result["name"] = issue.name
		result["message"] = issue.message
		if issue.category != "" {
			result["providerErrorCategory"] = issue.category
		}
		if issue.status != 0 {
			result["statusCode"] = float64(issue.status)
		}
	}
	return result
}

func appendGenerationError(parts []any, err error) []any {
	serialized := serializedGenerationError(err)
	for _, value := range parts {
		part := obj(value)
		if part["type"] == "data-error" && reflect.DeepEqual(part["data"], serialized) {
			return parts
		}
	}
	return append(append([]any{}, parts...), object{"type": "data-error", "data": serialized})
}
