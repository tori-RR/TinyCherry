package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestAuditReplaySnapshotFitsProtocolBudget(t *testing.T) {
	s, _ := testServer(t)
	g := &generation{topicID: newID(), executionID: "openrouter::anthropic/claude-sonnet-4.5", attempt: 1, row: object{"id": newID()}}
	for count := 0; count < 8190; count++ {
		if err := s.chunk(g, object{"type": "text-delta", "id": "text", "delta": strings.Repeat("\\", 128)}); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	writer := &wireWriter{output: &output}
	if err := writer.send(object{"jsonrpc": "2.0", "id": 1, "result": ipcResult(g.snapshot(), nil)}); err != nil {
		t.Fatal(err)
	}
	var response object
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["error"] != nil || output.Len() > maxFrame {
		t.Fatalf("valid live reply cannot attach: %#v bytes=%d", response["error"], output.Len())
	}
	var text strings.Builder
	for _, frame := range g.frames {
		text.WriteString(fmt.Sprint(obj(frame["chunk"])["delta"]))
	}
	if text.Len() != 8190*128 || g.sequence != 8190 || len(g.frames) > 65 {
		t.Fatalf("replay lost data or failed to compact: bytes=%d sequence=%d frames=%d", text.Len(), g.sequence, len(g.frames))
	}
}

func TestReplayPreservesUnicodeIndependentPartsAndImmutableSnapshots(t *testing.T) {
	s, _ := testServer(t)
	g := &generation{topicID: newID(), executionID: strings.Repeat("model-\"🎵", 64), attempt: 1234, row: object{"id": newID()}}
	for _, kind := range []string{"reasoning", "text"} {
		if err := s.chunk(g, object{"type": kind + "-start", "id": kind}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.chunk(g, object{"type": "text-delta", "id": "text", "delta": "before"}); err != nil {
		t.Fatal(err)
	}
	before := g.snapshot()
	encodedBefore, _ := json.Marshal(before)
	for index := 0; index < 1000; index++ {
		kind := "text"
		if index%2 == 0 {
			kind = "reasoning"
		}
		if err := s.chunk(g, object{"type": kind + "-delta", "id": kind, "delta": strings.Repeat("中\"\\", 16)}); err != nil {
			t.Fatal(err)
		}
	}
	encodedAgain, _ := json.Marshal(before)
	if !bytes.Equal(encodedBefore, encodedAgain) {
		t.Fatal("later live deltas mutated an already attached snapshot")
	}
	values := map[string]string{}
	for _, frame := range g.frames {
		chunk := obj(frame["chunk"])
		if deltaField(chunk) != "" {
			values[text(chunk["id"])] += text(chunk["delta"])
		}
	}
	if values["text"] != "before"+strings.Repeat("中\"\\", 500*16) || values["reasoning"] != strings.Repeat("中\"\\", 500*16) {
		t.Fatal("coalescing changed independent SDK part text")
	}
	size, err := wireEncodedSize(object{"jsonrpc": "2.0", "id": 1, "result": ipcResult(g.snapshot(), nil)})
	if err != nil || size > maxFrame {
		t.Fatalf("escaped Unicode/long ID snapshot does not fit: %d %v", size, err)
	}
	if obj(g.snapshot()["replayThrough"])["1234"] != g.sequence {
		t.Fatal("snapshot watermark lost live coverage")
	}
}

func TestReplayNeverMergesAcrossAnotherPartsSequence(t *testing.T) {
	s, _ := testServer(t)
	g := &generation{topicID: newID(), executionID: "test::local", attempt: 1, row: object{"id": newID()}}
	for _, chunk := range []object{{"type": "text-start", "id": "a"}, {"type": "text-start", "id": "b"}, {"type": "text-delta", "id": "a", "delta": "A"}, {"type": "text-delta", "id": "b", "delta": "B"}, {"type": "text-delta", "id": "a", "delta": "C"}} {
		if err := s.chunk(g, chunk); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.frames) != 5 {
		t.Fatalf("cross-part delta was merged: %#v", g.frames)
	}
	for index, frame := range g.frames {
		if replaySequence(frame["sequence"]) != int64(index+1) || frame["firstSequence"] != frame["sequence"] {
			t.Fatal("replay sequence coverage is not contiguous and monotonic")
		}
	}
}

func TestReplayKeepsLifecycleBarriersAndMetadata(t *testing.T) {
	s, _ := testServer(t)
	g := &generation{topicID: newID(), executionID: "test::local", attempt: 1, row: object{"id": newID()}}
	for _, chunk := range []object{
		{"type": "text-start", "id": "a"},
		{"type": "text-delta", "id": "a", "delta": "one", "providerMetadata": object{"provider": object{"step": 1}}},
		{"type": "text-delta", "id": "a", "delta": "two", "providerMetadata": object{"provider": object{"step": 2}}},
		{"type": "text-end", "id": "a"},
		{"type": "start-step"},
		{"type": "text-start", "id": "a"},
		{"type": "text-delta", "id": "a", "delta": "three"},
	} {
		if err := s.chunk(g, chunk); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.frames) != 6 || obj(g.frames[1]["chunk"])["delta"] != "onetwo" || obj(g.frames[5]["chunk"])["delta"] != "three" {
		t.Fatalf("lifecycle boundary was merged: %#v", g.frames)
	}
	if obj(obj(obj(g.frames[1]["chunk"])["providerMetadata"])["provider"])["step"] != 2 {
		t.Fatal("last SDK metadata was lost")
	}
	if g.frames[1]["firstSequence"] != 2 || g.frames[1]["sequence"] != 3 {
		t.Fatal("coalesced delta lost its original coverage")
	}
}
