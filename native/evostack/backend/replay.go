package main

import (
	"bytes"
	"encoding/json"
	"errors"
)

const maxReplayDelta = 16 * 1024

func copyReplayObject(value object) object {
	result := object{}
	for key, entry := range value {
		result[key] = entry
	}
	return result
}

func wireEncodedSize(value any) (int, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	return buffer.Len(), err
}

func deltaField(chunk object) string {
	switch chunk["type"] {
	case "text-delta", "reasoning-delta":
		return "delta"
	case "tool-input-delta":
		return "inputTextDelta"
	default:
		return ""
	}
}

func replaySequence(value any) int64 {
	switch value := value.(type) {
	case int:
		return int64(value)
	case int64:
		return value
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func mergeReplayDelta(previous, incoming object) (object, bool) {
	before, next := obj(previous["chunk"]), obj(incoming["chunk"])
	field := deltaField(next)
	if field == "" || before["type"] != next["type"] || before["id"] != next["id"] || before["toolCallId"] != next["toolCallId"] {
		return nil, false
	}
	if replaySequence(previous["sequence"])+1 != replaySequence(incoming["firstSequence"]) {
		return nil, false
	}
	value := text(before[field]) + text(next[field])
	if len(value) > maxReplayDelta {
		return nil, false
	}
	chunk := copyReplayObject(before)
	chunk[field] = value
	if metadata := next["providerMetadata"]; metadata != nil {
		chunk["providerMetadata"] = metadata
	}
	payload := copyReplayObject(previous)
	payload["sequence"] = incoming["sequence"]
	payload["chunk"] = chunk
	return payload, true
}

func replayMergeIndex(frames []object, incoming object) (int, object) {
	if deltaField(obj(incoming["chunk"])) == "" {
		return -1, nil
	}
	// Only consecutive deltas for one part share a coverage interval. Crossing
	// another part would make firstSequence..sequence claim unrelated events.
	if len(frames) > 0 {
		index := len(frames) - 1
		if merged, ok := mergeReplayDelta(frames[index], incoming); ok {
			return index, merged
		}
	}
	return -1, nil
}

func (s *server) chunk(g *generation, chunk object) error {
	payload := g.payload(copyReplayObject(chunk))
	index, buffered := replayMergeIndex(g.frames, payload)
	if index < 0 {
		buffered = payload
	}
	size, err := wireEncodedSize(buffered)
	if err != nil {
		g.sequence--
		return err
	}
	if len(g.frameSizes) != len(g.frames) {
		g.frameSizes = make([]int, len(g.frames))
		g.frameBytes = 0
		for position, frame := range g.frames {
			g.frameSizes[position], err = wireEncodedSize(frame)
			if err != nil {
				g.sequence--
				return err
			}
			g.frameBytes += g.frameSizes[position]
		}
	}
	previousSize := 0
	if index >= 0 {
		previousSize = g.frameSizes[index]
	}
	if g.frameBytes-previousSize+size > maxFrame-65536 || (index < 0 && len(g.frames) >= 8192) {
		g.sequence--
		return errors.New("stream replay exceeds the bounded protocol budget")
	}
	g.frameBytes += size - previousSize
	if index >= 0 {
		g.frames[index], g.frameSizes[index] = buffered, size
	} else {
		g.frames = append(g.frames, buffered)
		g.frameSizes = append(g.frameSizes, size)
	}
	// Live consumers still receive the original delta and sequence exactly once.
	s.event("ai.stream.chunk", payload)
	return nil
}
