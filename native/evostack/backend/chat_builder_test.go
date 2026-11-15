package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHighFrequencyStreamPreservesPartsPersistenceAndReplay(t *testing.T) {
	const deltas = 6000
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for index := 0; index < deltas; index++ {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"中\"}}]}\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	var wire bytes.Buffer
	s.writer = &wireWriter{output: &wire}
	g := launch(t, s, topic)
	waitDone(t, g)
	row, err := s.store.get("messages", text(g.row["id"]))
	expected := strings.Repeat("中", deltas)
	if err != nil || row["status"] != "success" || g.answer != expected || partsText(obj(row["data"])["parts"]) != expected {
		t.Fatal("high-frequency SSE changed persisted/visible text")
	}
	var replay strings.Builder
	for _, frame := range g.frames {
		chunk := obj(frame["chunk"])
		if chunk["type"] == "text-delta" {
			replay.WriteString(text(chunk["delta"]))
		}
	}
	if replay.String() != expected || len(g.frames) > 10 {
		t.Fatal("high-frequency SSE replay lost content or was not compacted")
	}
	streaming := 0
	for _, line := range bytes.Split(bytes.TrimSpace(wire.Bytes()), []byte{'\n'}) {
		var frame object
		if err := json.Unmarshal(line, &frame); err != nil {
			t.Fatal(err)
		}
		params := obj(frame["params"])
		if params["channel"] != "cache:sync" {
			continue
		}
		args := array(params["args"])
		if len(args) == 1 && obj(args[0])["key"] == "topic.stream.statuses."+text(topic["id"]) && obj(obj(args[0])["value"])["status"] == "streaming" {
			streaming++
		}
	}
	if streaming != 1 {
		t.Fatalf("unchanged streaming status was broadcast %d times", streaming)
	}
}

var benchmarkAnswerSink string

func BenchmarkAnswerAccumulation(b *testing.B) {
	const deltas = 4096
	const delta = "small Unicode 中 delta "
	b.Run("legacy-concatenation", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(deltas * int64(len(delta)))
		for index := 0; index < b.N; index++ {
			answer := ""
			for part := 0; part < deltas; part++ {
				answer += delta
			}
			benchmarkAnswerSink = answer
		}
	})
	b.Run("generation-builder", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(deltas * int64(len(delta)))
		for index := 0; index < b.N; index++ {
			generation := &generation{}
			for part := 0; part < deltas; part++ {
				generation.appendAnswer("text", delta)
			}
			benchmarkAnswerSink = generation.answer
		}
	})
}
