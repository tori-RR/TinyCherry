package main

import "math"

// A clear marker changes the model-facing view, never the stored message tree.
func (s *server) contextHistory(history []object, settings object) ([]object, error) {
	start := 0
	for index, row := range history {
		for _, value := range array(obj(row["data"])["parts"]) {
			if obj(value)["type"] == "data-clear" {
				start = index + 1
				break
			}
		}
	}
	history = history[start:]
	value, err := s.store.preference("chat.context_settings.max_messages")
	if err != nil {
		return nil, err
	}
	// Presence matters: null explicitly removes a finite inherited window.
	if override, present := obj(settings["contextSettings"])["maxMessages"]; present {
		value = override
	}
	limit := normalizeMaxMessages(value)
	if limit == 0 || len(history) <= limit {
		return history, nil
	}
	start = len(history) - limit
	// Match the original row-level window: never leave a reply without its user.
	// This limit is independent of the unsupported overflow/compression switch.
	for start > 0 && history[start]["role"] != "user" {
		start--
	}
	return history[start:], nil
}

func normalizeMaxMessages(value any) int {
	var count float64
	switch v := value.(type) {
	case float64:
		count = v
	case int:
		count = float64(v)
	case int64:
		count = float64(v)
	default:
		return 0
	}
	if math.IsNaN(count) || math.IsInf(count, 0) || count < 1 || count >= float64(math.MaxInt) {
		return 0
	}
	return int(math.Floor(count))
}
