package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type generation struct {
	topicID               string
	executionID           string
	attempt               int64
	row                   object
	user                  object
	frames                []object
	sequence              int
	answer                string
	reasoning             string
	answerBuilder         strings.Builder
	reasoningBuilder      strings.Builder
	cancel                context.CancelFunc
	done                  chan struct{}
	parts                 []any
	frameBytes            int
	frameSizes            []int
	computerTaskID        string
	computerEnabled       bool
	computerLabel         string
	computerVisionEnabled bool
	streamingStatusSent   bool
}

func (g *generation) appendAnswer(kind, value string) {
	if kind == "text" {
		g.answerBuilder.WriteString(value)
		g.answer = g.answerBuilder.String()
	} else {
		g.reasoningBuilder.WriteString(value)
		g.reasoning = g.reasoningBuilder.String()
	}
}

func (g *generation) execution() object {
	return object{"executionId": g.executionID, "attemptId": g.attempt, "anchorMessageId": g.row["id"]}
}
func (g *generation) payload(chunk object) object {
	g.sequence++
	payload := g.execution()
	payload["topicId"] = g.topicID
	payload["sequence"] = g.sequence
	payload["firstSequence"] = g.sequence
	payload["chunk"] = chunk
	return payload
}
func (g *generation) snapshot() object {
	// Buffer entries are immutable; copy the slice so concurrent ingestion cannot
	// replace entries while the RPC response is being encoded after unlocking.
	frames := append([]object{}, g.frames...)
	return object{"status": "attached", "bufferedChunks": frames, "replayThrough": object{fmt.Sprint(g.attempt): g.sequence}}
}

func (s *server) providerConfig(modelID string, requireEnabled bool, keyOverride string) (object, object, string, string, error) {
	model, err := s.store.get("models", modelID)
	if err != nil {
		return nil, nil, "", "", err
	}
	provider, err := s.store.get("providers", text(model["providerId"]))
	if err != nil {
		return nil, nil, "", "", err
	}
	if requireEnabled && (provider["isEnabled"] != true || model["isEnabled"] != true) {
		return nil, nil, "", "", errors.New("provider or model is disabled")
	}
	kind := text(provider["defaultChatEndpoint"])
	if kind != "" && kind != "openai-chat-completions" {
		return nil, nil, "", "", notMigrated("provider endpoint " + kind)
	}
	config := obj(obj(provider["endpointConfigs"])["openai-chat-completions"])
	base := text(config["baseUrl"])
	if base == "" {
		return nil, nil, "", "", errors.New("provider base URL is missing")
	}
	key, err := s.providerKey(provider, keyOverride)
	if err != nil {
		return nil, nil, "", "", err
	}
	return provider, model, base, key, nil
}

func (s *server) openGeneration(input object) (any, error, func()) {
	topicID := text(input["topicId"])
	if topicID == "" {
		return nil, errors.New("topicId required"), nil
	}
	if s.context.Err() != nil {
		return nil, errors.New("backend is closing"), nil
	}
	if s.active[topicID] != nil {
		return nil, errors.New("TOPIC_BUSY: stop the current reply before sending again"), nil
	}
	if input["retryMessageId"] != nil || input["appendToLiveGroupMessageId"] != nil || input["targetMode"] == "reserved-branch" {
		return nil, notMigrated("live-group/retry/reserved branch"), nil
	}
	if effort := text(input["reasoningEffort"]); effort != "" && effort != "default" {
		return nil, notMigrated("reasoning request controls"), nil
	}
	if tier := text(input["serviceTier"]); tier != "" && tier != "standard" {
		return nil, notMigrated("service tier controls"), nil
	}
	if input["fastMode"] == true {
		return nil, notMigrated("Fast mode"), nil
	}
	topic, err := s.store.get("topics", topicID)
	if err != nil {
		return nil, err, nil
	}
	if topic["deletedAt"] != nil {
		return nil, errors.New("topic is archived"), nil
	}
	assistant := object{"id": "", "name": "", "emoji": "🍒", "settings": clone(s.store.defaults.AssistantSettings)}
	if assistantID := text(topic["assistantId"]); assistantID != "" {
		assistant, err = s.store.get("assistants", assistantID)
		if err != nil {
			return nil, err, nil
		}
	}
	settings := obj(assistant["settings"])
	computerValue, err := s.store.preference(computerPreference)
	if err != nil {
		return nil, err, nil
	}
	computerEnabled := computerValue == true
	if len(array(assistant["mcpServerIds"])) > 0 || settings["mcpMode"] == "auto" || settings["enableWebSearch"] == true || settings["enableBrowser"] == true || settings["enableGenerateImage"] == true || len(array(settings["customParameters"])) > 0 {
		return nil, notMigrated("assistant tools, context sources or custom parameters"), nil
	}
	selected := array(input["mentionedModelIds"])
	if len(selected) > 1 {
		return nil, notMigrated("multi-model fan-out"), nil
	}
	modelID := text(assistant["modelId"])
	if len(selected) == 1 {
		modelID = text(selected[0])
	}
	if modelID == "" {
		value, err := s.store.preference("chat.default_model_id")
		if err != nil {
			return nil, err, nil
		}
		modelID = text(value)
	}
	if modelID == "" {
		return nil, errors.New("select a default model first"), nil
	}
	provider, model, base, key, err := s.providerConfig(modelID, true, "")
	if err != nil {
		return nil, err, nil
	}
	requestConfig, err := s.resolveProviderRequest(provider, base, key, "chat/completions")
	if err != nil {
		return nil, err, nil
	}
	parts := array(input["userMessageParts"])
	for _, part := range parts {
		if obj(part)["type"] != "text" && obj(part)["type"] != "data-knowledge-scope" {
			return nil, notMigrated("non-text message parts"), nil
		}
	}
	var user, reply object
	trigger := text(input["trigger"])
	if trigger != "submit-message" && trigger != "regenerate-message" {
		return nil, errors.New("invalid stream trigger"), nil
	}
	knowledgeParts := parts
	if trigger == "regenerate-message" {
		previous, e := s.store.get("messages", text(input["parentAnchorId"]))
		if e != nil {
			return nil, e, nil
		}
		knowledgeParts = array(obj(previous["data"])["parts"])
	}
	knowledgeContext, err := s.knowledgeContext(assistant, knowledgeParts)
	if err != nil {
		return nil, err, nil
	}
	err = s.transaction(func(s *server) error {
		parent := text(input["parentAnchorId"])
		if trigger == "submit-message" {
			if strings.TrimSpace(knowledgeMessageText(parts)) == "" {
				return errors.New("empty message")
			}
			if text(topic["activeNodeId"]) != "" && parent == "" {
				return errors.New("parentAnchorId required for a non-empty topic")
			}
			created, err := s.createMessage(topic, object{"role": "user", "parentId": parent, "data": object{"parts": parts}})
			if err != nil {
				return err
			}
			user = created
		} else {
			existing, err := s.store.get("messages", parent)
			if err != nil {
				return err
			}
			if existing["role"] != "user" || existing["topicId"] != topicID {
				return errors.New("regeneration requires a user message in this topic")
			}
			user = existing
		}
		snapshot := object{"id": assistant["id"], "name": assistant["name"], "emoji": assistant["emoji"], "model": object{"id": model["id"], "name": model["name"], "provider": provider["id"]}}
		reply, err = s.createMessage(topic, object{"role": "assistant", "parentId": user["id"], "data": object{"parts": []any{}}, "modelId": modelID, "messageSnapshot": snapshot})
		return err
	})
	if err != nil {
		return nil, err, nil
	}
	rows, err := s.topicRows(topicID)
	if err != nil {
		return nil, err, nil
	}
	history, err := pathTo(rows, text(user["id"]))
	if err != nil {
		return nil, err, nil
	}
	history, err = s.contextHistory(history, settings)
	if err != nil {
		return nil, err, nil
	}
	messages := []object{}
	if prompt := text(assistant["prompt"]); prompt != "" {
		messages = append(messages, object{"role": "system", "content": prompt})
	}
	if knowledgeContext != "" {
		messages = append(messages, object{"role": "system", "content": knowledgeContext})
	}
	if computerEnabled {
		messages = append(messages, object{"role": "system", "content": computerInstructions})
	}
	for _, row := range history {
		messages = append(messages, computerHistoryMessages(row)...)
	}
	ctx, cancel := context.WithTimeout(s.context, 10*time.Minute)
	s.attempt++
	g := &generation{topicID: topicID, executionID: modelID, attempt: s.attempt, row: reply, user: user, frames: []object{}, parts: []any{}, cancel: cancel, done: make(chan struct{}), computerTaskID: newID(), computerEnabled: computerEnabled, computerLabel: text(assistant["name"]), computerVisionEnabled: computerModelImages(model)}
	s.active[topicID] = g
	s.registerGenerationCancel(topicID, cancel)
	s.cache("topic.stream.statuses."+topicID, object{"status": "pending", "turnId": newID(), "activeExecutions": []object{g.execution()}, "awaitingApprovalAnchors": []any{}})
	s.changed("/topics", "/topics/:topicId/messages", "/topics/:topicId/tree")
	modelName := text(model["apiModelId"])
	if modelName == "" {
		modelName = strings.SplitN(modelID, "::", 2)[1]
	}
	payload := object{"model": modelName, "messages": messages, "stream": true}
	if computerEnabled {
		payload["tools"] = computerToolDefinitions
		payload["parallel_tool_calls"] = false
	}
	if settings["enableTemperature"] == true {
		payload["temperature"] = settings["temperature"]
	}
	if settings["enableTopP"] == true {
		payload["top_p"] = settings["topP"]
	}
	if settings["enableMaxTokens"] == true {
		payload["max_tokens"] = settings["maxTokens"]
	}
	return object{"mode": "started", "activeExecutions": []object{g.execution()}, "reservedMessages": []object{toUIMessage(user), toUIMessage(reply)}}, nil, func() { go s.generate(ctx, g, requestConfig, payload) }
}

func (s *server) abort(topicID string) error {
	s.mu.Lock()
	g := s.active[topicID]
	if g != nil {
		g.cancel()
	}
	s.mu.Unlock()
	if g != nil {
		select {
		case <-g.done:
			return nil
		case <-time.After(10 * time.Second):
			return errors.New("generation cancellation did not drain")
		}
	}
	return nil
}
func (s *server) generate(ctx context.Context, g *generation, config providerRequestConfig, payload object) {
	defer close(g.done)
	defer g.cancel()
	var generationErr error
	finishReason := "stop"
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		status := "success"
		topicStatus := "done"
		if generationErr != nil {
			status = "error"
			topicStatus = "error"
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			status = "paused"
			topicStatus = "aborted"
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = "error"
			topicStatus = "error"
			generationErr = errors.New("generation deadline exceeded")
		}
		if err := s.persistGeneration(g, status); err != nil {
			status = "error"
			topicStatus = "error"
			generationErr = errors.New("failed to persist generated answer")
		}
		if generationErr != nil && status == "error" {
			event := g.execution()
			event["topicId"] = g.topicID
			event["isTopicDone"] = true
			event["topicAttemptWatermark"] = g.attempt
			event["error"] = object{"name": "Error", "message": generationErr.Error()}
			s.event("ai.stream.error", event)
		} else {
			_ = s.chunk(g, object{"type": "finish", "finishReason": finishReason})
			event := g.execution()
			event["topicId"] = g.topicID
			event["isTopicDone"] = true
			event["topicAttemptWatermark"] = g.attempt
			event["status"] = "success"
			if status == "paused" {
				event["status"] = "paused"
			}
			s.event("ai.stream.done", event)
		}
		delete(s.active, g.topicID)
		s.unregisterGenerationCancel(g.topicID)
		s.cache("topic.stream.statuses."+g.topicID, object{"status": topicStatus, "activeExecutions": []any{}, "awaitingApprovalAnchors": []any{}, "lastCompletedAt": time.Now().UnixMilli()})
		s.changed("/topics", "/topics/:topicId/messages", "/topics/:topicId/tree")
	}()
	defer func() {
		if g.computerEnabled {
			if err := s.closeComputerTask(g.computerTaskID); err != nil {
				generationErr = errors.Join(generationErr, err)
			}
		}
	}()
	generationErr, finishReason = s.generateComputerSteps(ctx, g, config, payload)
}

func (s *server) persistGeneration(g *generation, status string) error {
	if status != "pending" {
		finalizeComputerParts(g.parts)
	}
	g.row["data"] = object{"parts": g.parts}
	g.row["searchableText"] = g.answer
	g.row["status"] = status
	g.row["updatedAt"] = timestamp()
	return s.store.put("messages", g.row)
}

func (s *server) modelOperation(route string, input object) (any, error) {
	s.mu.Lock()
	modelID := text(input["uniqueModelId"])
	if route == "ai.provider.model.list" {
		provider, err := s.store.get("providers", text(input["providerId"]))
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		endpointConfig := obj(obj(provider["endpointConfigs"])["openai-chat-completions"])
		base := text(endpointConfig["baseUrl"])
		key, err := s.providerKey(provider, "")
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		config, err := s.resolveProviderRequest(provider, base, key, "models")
		s.mu.Unlock()
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(s.context, 30*time.Second)
		defer cancel()
		request, err := config.request(ctx, http.MethodGet, nil, false)
		if err != nil {
			return nil, err
		}
		client := s.networkClient(config.network)
		response, err := client.Do(request)
		if err != nil {
			return nil, errors.New("model catalog connection failed")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return nil, fmt.Errorf("provider returned HTTP %d", response.StatusCode)
		}
		var catalog struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 4*1024*1024)).Decode(&catalog); err != nil {
			return nil, errors.New("invalid model catalog")
		}
		models := []object{}
		for _, item := range catalog.Data {
			if item.ID != "" {
				models = append(models, newModel(object{"providerId": provider["id"], "modelId": item.ID}))
			}
		}
		return object{"models": models}, nil
	}
	provider, model, base, key, err := s.providerConfig(modelID, false, text(input["apiKeyOverride"]))
	var config providerRequestConfig
	if err == nil {
		config, err = s.resolveProviderRequest(provider, base, key, "chat/completions")
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(s.context, probeTimeout(input["timeout"]))
	defer cancel()
	encoded, _ := json.Marshal(object{"model": model["apiModelId"], "messages": []object{{"role": "user", "content": "Hi"}}, "max_tokens": 1, "stream": false})
	request, err := config.request(ctx, http.MethodPost, bytes.NewReader(encoded), false)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	client := s.networkClient(config.network)
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("model check connection failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("provider returned HTTP %d", response.StatusCode)
	}
	if err := validateProbeBody(response.Body); err != nil {
		return nil, err
	}
	return object{"latency": time.Since(start).Milliseconds()}, nil
}
