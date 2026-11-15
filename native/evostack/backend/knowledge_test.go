package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
)

func knowledgeReply(t *testing.T, s *server, route string, input object) object {
	t.Helper()
	result, err, after := s.invoke("ipc-api:request", []any{route, input})
	if err != nil || after != nil {
		t.Fatal("unexpected knowledge transport result", err)
	}
	return obj(result)
}

func knowledgeOK(t *testing.T, s *server, route string, input object) any {
	t.Helper()
	response := knowledgeReply(t, s, route, input)
	if response["ok"] != true {
		t.Fatalf("%s failed: %v", route, response["error"])
	}
	return response["data"]
}

func knowledgeBase(t *testing.T, s *server, config object) object {
	t.Helper()
	input := object{"name": "Knowledge test"}
	merge(input, config)
	return obj(knowledgeOK(t, s, "knowledge.create_base", object{"base": input}))
}

func knowledgeNote(t *testing.T, s *server, base object, source, content string) object {
	t.Helper()
	knowledgeOK(t, s, "knowledge.add_items", object{"baseId": base["id"], "items": []any{object{"type": "note", "data": object{"source": source, "content": content}}}})
	items, err := s.knowledgeItems(text(base["id"]))
	if err != nil || len(items) == 0 {
		t.Fatal("knowledge item missing", err)
	}
	return items[len(items)-1]
}

func knowledgeFiles(t *testing.T, s *server) []string {
	t.Helper()
	files := []string{}
	err := filepath.WalkDir(filepath.Join(s.store.directory, "knowledge"), func(path string, entry os.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func knowledgeHits(t *testing.T, s *server, base object, query string) []object {
	t.Helper()
	result, ok := knowledgeOK(t, s, "knowledge.search", object{"baseId": base["id"], "query": query}).([]object)
	if !ok {
		t.Fatal("knowledge search is not an array")
	}
	return result
}

func TestKnowledgeFTSQueriesAreMultilingualAndBaseIsolated(t *testing.T) {
	s, _ := testServer(t)
	alpha, beta := knowledgeBase(t, s, nil), knowledgeBase(t, s, nil)
	first := knowledgeNote(t, s, alpha, "Chinese", "樱桃知识库通过 Rust IPC 进行通信。")
	knowledgeNote(t, s, alpha, "Partial match", "Rust without the other required keyword.")
	knowledgeNote(t, s, alpha, "Short words", "go ai tools work together")
	foreign := knowledgeNote(t, s, beta, "Foreign", "樱桃知识库 Rust IPC foreign-only material")
	for _, query := range []string{"Rust IPC", "樱桃 知识库", "樱桃知识库如何通信", "樱桃", "go ai"} {
		hits := knowledgeHits(t, s, alpha, query)
		if len(hits) == 0 || hits[0]["itemId"] == foreign["id"] || hits[0]["scoreKind"] != "ranking" || (query == "Rust IPC" && hits[0]["itemId"] != first["id"]) {
			t.Fatalf("wrong result for %q: %#v", query, hits)
		}
	}
	knowledgeNote(t, s, alpha, "Code", "我的暗号是蓝莓。The secret code is blueberry.")
	for _, query := range []string{"暗号是什么", "what is the secret code"} {
		if got := knowledgeHits(t, s, alpha, query); len(got) != 1 || !strings.Contains(text(got[0]["pageContent"]), "蓝莓") {
			t.Fatalf("natural question missed indexed evidence: %s", query)
		}
	}
	var count int
	if err := s.store.db.QueryRow(`SELECT count(*) FROM knowledge_fts WHERE knowledge_fts MATCH '"知识库"'`).Scan(&count); err != nil || count != 2 {
		t.Fatal("trigram FTS5 query was not available", err, count)
	}
}

func TestKnowledgeUTF8ChunkOverlapReindexAndDelimiter(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, object{"chunkSize": 4, "chunkOverlap": 1})
	item := knowledgeNote(t, s, base, "Unicode", "甲乙丙丁戊己庚辛壬癸")
	chunks := knowledgeOK(t, s, "knowledge.list_item_chunks", object{"baseId": base["id"], "itemId": item["id"]}).([]object)
	for i, expected := range []string{"甲乙丙丁", "丁戊己庚", "庚辛壬癸"} {
		if len(chunks) != 3 || chunks[i]["content"] != expected || !utf8.ValidString(text(chunks[i]["content"])) || knowledgeNumber(obj(chunks[i]["metadata"])["chunkIndex"]) != i {
			t.Fatalf("wrong UTF-8 chunk %d: %#v", i, chunks)
		}
	}
	dataOK(t, s, "PATCH", "/knowledge-bases/"+text(base["id"]), object{"chunkSize": 6, "chunkOverlap": 0})
	knowledgeOK(t, s, "knowledge.reindex_items", object{"baseId": base["id"], "itemIds": []any{item["id"]}})
	if got := knowledgeOK(t, s, "knowledge.list_item_chunks", object{"baseId": base["id"], "itemId": item["id"]}).([]object); len(got) != 2 {
		t.Fatal("reindex retained stale chunks")
	}
	delimiter := knowledgeBase(t, s, object{"chunkStrategy": "delimiter", "chunkSeparator": `\n\n`, "chunkSize": 20, "chunkOverlap": 0})
	doc := knowledgeNote(t, s, delimiter, "Paragraphs", "first section\n\nsecond section")
	parts := knowledgeOK(t, s, "knowledge.list_item_chunks", object{"baseId": delimiter["id"], "itemId": doc["id"]}).([]object)
	if len(parts) != 2 || parts[0]["content"] != "first section" || parts[1]["content"] != "second section" {
		t.Fatal("delimiter was ignored")
	}
}

func TestKnowledgeSnapshotAndIndexRollbackTogether(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, nil)
	old := knowledgeNote(t, s, base, "Source", "original knowledge snapshot")
	oldPath := s.knowledgePath(old)
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_knowledge_item BEFORE INSERT ON entity WHEN NEW.resource='knowledge-items' BEGIN SELECT RAISE(ABORT,'injected item failure'); END`); err != nil {
		t.Fatal(err)
	}
	response := knowledgeReply(t, s, "knowledge.add_items", object{"baseId": base["id"], "conflictStrategy": "replace", "items": []any{object{"type": "note", "data": object{"source": "Source", "content": "replacement must roll back"}}}})
	if response["ok"] != false {
		t.Fatal("injected failure was ignored")
	}
	if raw, err := os.ReadFile(oldPath); err != nil || string(raw) != "original knowledge snapshot" {
		t.Fatal("rollback lost old snapshot", err)
	}
	if len(knowledgeFiles(t, s)) != 1 || len(knowledgeHits(t, s, base, "original")) != 1 || len(knowledgeHits(t, s, base, "replacement")) != 0 {
		t.Fatal("failed replacement left new state")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_knowledge_item"); err != nil {
		t.Fatal(err)
	}
	knowledgeOK(t, s, "knowledge.add_items", object{"baseId": base["id"], "conflictStrategy": "replace", "items": []any{object{"type": "note", "data": object{"source": "Source", "content": "committed replacement"}}}})
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) || len(knowledgeFiles(t, s)) != 1 {
		t.Fatal("successful replacement left the old snapshot", err)
	}
}

func TestKnowledgeFailedBatchDoesNotLeaveSnapshots(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, nil)
	response := knowledgeReply(t, s, "knowledge.add_items", object{"baseId": base["id"], "items": []any{
		object{"type": "note", "data": object{"source": "First", "content": "first must roll back"}},
		object{"type": "note", "data": object{"source": "Second", "content": " "}},
	}})
	items, err := s.knowledgeItems(text(base["id"]))
	if response["ok"] != false || err != nil || len(items) != 0 || len(knowledgeFiles(t, s)) != 0 {
		t.Fatal("failed batch left material state", err)
	}
}

func TestKnowledgeDeletionIsAtomicAndNeverCrossesBases(t *testing.T) {
	s, _ := testServer(t)
	alpha, beta := knowledgeBase(t, s, nil), knowledgeBase(t, s, nil)
	first := knowledgeNote(t, s, alpha, "Alpha", "alpha material")
	foreign := knowledgeNote(t, s, beta, "Beta", "beta material")
	bad := knowledgeReply(t, s, "knowledge.delete_items", object{"baseId": alpha["id"], "itemIds": []any{first["id"], foreign["id"]}})
	if bad["ok"] != false || len(knowledgeFiles(t, s)) != 2 || len(knowledgeHits(t, s, alpha, "alpha")) != 1 {
		t.Fatal("cross-base batch deleted earlier material")
	}
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_knowledge_delete BEFORE DELETE ON entity WHEN OLD.resource='knowledge-items' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END`); err != nil {
		t.Fatal(err)
	}
	bad = knowledgeReply(t, s, "knowledge.delete_items", object{"baseId": alpha["id"], "itemIds": []any{first["id"]}})
	if bad["ok"] != false || len(knowledgeFiles(t, s)) != 2 {
		t.Fatal("failed delete lost snapshot")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_knowledge_delete"); err != nil {
		t.Fatal(err)
	}
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Knowledge assistant", "knowledgeBaseIds": []any{alpha["id"], beta["id"]}}))
	knowledgeOK(t, s, "knowledge.delete_base", object{"baseId": alpha["id"]})
	if _, err := os.Stat(s.knowledgePath(first)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("base deletion retained raw file")
	}
	saved, err := s.store.get("assistants", text(assistant["id"]))
	if err != nil || len(array(saved["knowledgeBaseIds"])) != 1 || array(saved["knowledgeBaseIds"])[0] != beta["id"] {
		t.Fatal("base deletion did not detach only the deleted base", err)
	}
	knowledgeOK(t, s, "knowledge.delete_items", object{"baseId": beta["id"], "itemIds": []any{foreign["id"]}})
	if len(knowledgeFiles(t, s)) != 0 {
		t.Fatal("successful delete left raw snapshot files")
	}
}

func TestKnowledgeTextImportURLAndUnsupportedSources(t *testing.T) {
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/text":
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, "URL reference contains 樱桃 Rust")
		case "/pdf":
			w.Header().Set("Content-Type", "application/pdf")
			fmt.Fprint(w, "%PDF-1.7")
		default:
			http.Redirect(w, r, "/text", http.StatusFound)
		}
	}))
	defer web.Close()
	s, dir := testServer(t)
	base := knowledgeBase(t, s, nil)
	knowledgeOK(t, s, "knowledge.import_text", object{"baseId": base["id"], "name": "upload.txt", "content": "uploaded UTF-8 樱桃"})
	source := filepath.Join(dir, "source.md")
	if err := os.WriteFile(source, []byte("local file reference"), 0600); err != nil {
		t.Fatal(err)
	}
	knowledgeOK(t, s, "knowledge.add_items", object{"baseId": base["id"], "items": []any{
		object{"type": "file", "data": object{"source": "source.md", "path": source}},
		object{"type": "url", "data": object{"source": "Web", "url": web.URL + "/text"}},
	}})
	for _, source := range []object{
		{"type": "directory", "data": object{"source": dir}},
		{"type": "file", "data": object{"source": "PDF", "path": filepath.Join(dir, "file.pdf")}},
		{"type": "file", "data": object{"source": "relative", "path": "file.txt"}},
		{"type": "url", "data": object{"source": "PDF URL", "url": web.URL + "/pdf"}},
		{"type": "url", "data": object{"source": "Redirect URL", "url": web.URL + "/redirect"}},
		{"type": "note", "data": object{"source": "oversize", "content": strings.Repeat("a", knowledgeTextLimit+1)}},
		{"type": "note", "data": object{"source": "binary", "content": "hello\x00world"}},
	} {
		if response := knowledgeReply(t, s, "knowledge.add_items", object{"baseId": base["id"], "items": []any{source}}); response["ok"] != false {
			t.Fatalf("unsupported material accepted: %v", source["type"])
		}
	}
	if response := knowledgeReply(t, s, "knowledge.import_text", object{"baseId": base["id"], "name": "upload.pdf", "content": "%PDF-1.7"}); response["ok"] != false {
		t.Fatal("PDF upload accepted as text")
	}
	if len(knowledgeFiles(t, s)) != 3 {
		t.Fatal("failed sources left files")
	}
}

func TestKnowledgePaginationValidationAndBoundedChunkOutput(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, nil)
	for i := 0; i < 3; i++ {
		knowledgeNote(t, s, base, fmt.Sprintf("Note %d", i), "pagination content")
	}
	page, err, _ := s.knowledgeData("GET", "/knowledge-bases/"+text(base["id"])+"/items", object{"limit": 2}, nil)
	if err != nil || len(obj(page)["items"].([]object)) != 2 || obj(page)["hasMore"] != true {
		t.Fatal("bad first page", err)
	}
	next, err, _ := s.knowledgeData("GET", "/knowledge-bases/"+text(base["id"])+"/items", object{"limit": 2, "cursor": obj(page)["nextCursor"]}, nil)
	if err != nil || len(obj(next)["items"].([]object)) != 1 || obj(next)["hasMore"] != false {
		t.Fatal("bad second page", err)
	}
	for _, q := range []object{{"cursor": "missing"}, {"limit": 0}, {"limit": 101}, {"limit": 1.5}} {
		if _, err, _ := s.knowledgeData("GET", "/knowledge-bases", q, nil); err == nil {
			t.Fatal("bad pagination accepted")
		}
	}
	for _, config := range []object{{"chunkSize": 4, "chunkOverlap": 4}, {"chunkSize": 1.5}, {"chunkStrategy": "unknown"}, {"embeddingModelId": "fake", "dimensions": 3}} {
		if response := knowledgeReply(t, s, "knowledge.create_base", object{"base": merge(object{"name": "invalid"}, config)}); response["ok"] != false {
			t.Fatal("invalid knowledge config accepted")
		}
	}
	tiny := knowledgeBase(t, s, object{"chunkSize": 1, "chunkOverlap": 0})
	if response := knowledgeReply(t, s, "knowledge.import_text", object{"baseId": tiny["id"], "name": "tiny.txt", "content": strings.Repeat("a", 5000)}); response["ok"] != false {
		t.Fatal("unbounded chunk output accepted")
	}
	if len(knowledgeFiles(t, s)) != 3 {
		t.Fatal("rejected chunk budget left snapshot")
	}
	if _, err := s.checkedKnowledgePath(object{"baseId": base["id"], "id": "../../outside"}); err == nil {
		t.Fatal("unsafe snapshot identity accepted")
	}
}

func TestChatProviderRequestContainsOnlySelectedKnowledge(t *testing.T) {
	requests := make(chan object, 2)
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request object
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		requests <- request
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Knowledge referenced\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer web.Close()
	s, _ := testServer(t)
	defer s.cancel()
	seedChat(t, s, web.URL)
	alpha, beta := knowledgeBase(t, s, nil), knowledgeBase(t, s, nil)
	knowledgeNote(t, s, alpha, "Alpha source", "The secret code is AlphaReference; 我的暗号是蓝莓")
	knowledgeNote(t, s, beta, "Beta source", "The secret code is BetaReference; 我的暗号是草莓")
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Knowledge", "knowledgeBaseIds": []any{alpha["id"]}}))
	for _, explicit := range []bool{false, true} {
		topic := obj(dataOK(t, s, "POST", "/topics", object{"assistantId": assistant["id"]}))
		parts := []any{object{"type": "text", "text": "what is the secret code"}}
		if explicit {
			prompt := fmt.Sprintf("The user attached knowledge base \"%s\" (id: %s). Include \"%s\" in kb_search baseIds before answering questions that may depend on this knowledge base, and cite relevant kb_search or kb_read results. Use kb_list only to browse its structure; kb_list output is not retrieved evidence.", beta["name"], beta["id"], beta["id"])
			parts = []any{object{"type": "text", "text": "请问🌸" + prompt + "\n暗号是什么", "providerMetadata": object{"cherry": object{"composer": object{"version": 1, "tokens": []any{object{"kind": "knowledge", "id": "knowledge:" + text(beta["id"]), "label": beta["name"], "promptText": prompt, "textOffset": 4, "index": 0}}}}}}, object{"type": "data-knowledge-scope", "data": object{"baseIds": []any{beta["id"]}}}}
		}
		s.mu.Lock()
		_, err, after := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": parts})
		g := s.active[text(topic["id"])]
		s.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		after()
		waitDone(t, g)
		request := <-requests
		var context strings.Builder
		for _, v := range array(request["messages"]) {
			m := obj(v)
			if strings.Contains(text(m["content"]), "kb_search") {
				t.Fatal("composer tool instruction leaked into model request")
			}
			if m["role"] == "system" {
				context.WriteString(text(m["content"]))
			}
		}
		if context.Len() == 0 || !strings.Contains(context.String(), "untrusted reference data") {
			t.Fatal("no knowledge instruction boundary in actual HTTP request")
		}
		wanted, unwanted := "AlphaReference", "BetaReference"
		if explicit {
			wanted, unwanted = unwanted, wanted
		}
		if !strings.Contains(context.String(), wanted) || strings.Contains(context.String(), unwanted) {
			t.Fatal("actual chat request mixed knowledge bases")
		}
	}
}

func TestKnowledgeComposerMarkerCleaningPreservesUserText(t *testing.T) {
	id := newID()
	prompt := knowledgeComposerPrompt("Docs", id)
	parts := []any{object{"type": "text", "text": "普通🌸" + prompt + "\n暗号是什么", "providerMetadata": object{"cherry": object{"composer": object{"version": 1, "tokens": []any{object{"kind": "knowledge", "id": "knowledge:" + id, "label": "Docs", "promptText": prompt, "textOffset": 4, "index": 0}}}}}}, object{"type": "data-knowledge-scope", "data": object{"baseIds": []any{id}}}}
	if got := knowledgeMessageText(parts); got != "普通🌸\n暗号是什么" {
		t.Fatalf("wrong marker-cleaned text: %q", got)
	}
	ordinary := []any{object{"type": "text", "text": prompt + " is a quoted example"}}
	if got := knowledgeMessageText(ordinary); got != prompt+" is a quoted example" {
		t.Fatal("ordinary prose was removed")
	}
	part := obj(parts[0])
	token := obj(array(obj(obj(obj(part["providerMetadata"])["cherry"])["composer"])["tokens"])[0])
	token["promptText"] = "ordinary text must not be erased"
	if got := knowledgeMessageText(parts); got != part["text"] {
		t.Fatal("unverified token erased text")
	}
	token["promptText"] = prompt
	token["textOffset"] = 3
	if got := knowledgeMessageText(parts); got != part["text"] {
		t.Fatal("half-surrogate offset erased text")
	}
}

func TestKnowledgeContextHasUTF8SafeSizeBound(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, object{"chunkSize": 32000, "chunkOverlap": 0})
	knowledgeNote(t, s, base, "Large source", "暗号"+strings.Repeat("蓝", 31000))
	context, err := s.knowledgeContext(object{"knowledgeBaseIds": []any{base["id"]}}, []any{object{"type": "text", "text": "暗号"}})
	if err != nil || len(context) > 64000 || !utf8.ValidString(context) || !strings.HasSuffix(context, "</reference>\n") || !strings.Contains(context, "蓝") {
		t.Fatal("knowledge context exceeded or corrupted its bound", err, len(context))
	}
}

func TestKnowledgeSnapshotsRecoverAfterInterruptedMutation(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint("committed_", committed), func(t *testing.T) {
			s, dir := testServer(t)
			base := knowledgeBase(t, s, nil)
			item := knowledgeNote(t, s, base, "Recovery source", "snapshot survives SQLite rollback")
			path := s.knowledgePath(item)
			files := &knowledgeFileJournal{}
			if committed {
				if err := s.transaction(func(s *server) error { return s.removeKnowledgeItem(item, files) }); err != nil {
					t.Fatal(err)
				}
			} else if err := files.remove(path); err != nil {
				t.Fatal(err)
			}
			orphanID, err := uuid.NewV7()
			if err != nil {
				t.Fatal(err)
			}
			orphan := filepath.Join(filepath.Dir(path), orphanID.String()+".md")
			if err := os.WriteFile(orphan, []byte("uncommitted new snapshot"), 0600); err != nil {
				t.Fatal(err)
			}
			unmanaged := filepath.Join(filepath.Dir(path), "leave-user-file.txt")
			if err := os.WriteFile(unmanaged, []byte("untouched"), 0600); err != nil {
				t.Fatal(err)
			}
			s.store.db.Close()
			reopened, err := openStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.db.Close()
			if committed {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("committed delete restored its file")
				}
			} else if raw, err := os.ReadFile(path); err != nil || string(raw) != "snapshot survives SQLite rollback" {
				t.Fatal("interrupted rollback did not restore old snapshot", err)
			}
			if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("uncommitted snapshot survived recovery")
			}
			for _, pair := range files.removed {
				if _, err := os.Stat(pair[1]); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("recovery retained a staged deletion")
				}
			}
			if raw, err := os.ReadFile(unmanaged); err != nil || string(raw) != "untouched" {
				t.Fatal("recovery touched an unmanaged user file", err)
			}
		})
	}
}

func TestKnowledgeBaseOrderingUsesAnchorsAndPreservesGroup(t *testing.T) {
	s, _ := testServer(t)
	a, b, c := knowledgeBase(t, s, object{"name": "A"}), knowledgeBase(t, s, object{"name": "B"}), knowledgeBase(t, s, object{"name": "C"})
	order := func(group any) []string {
		t.Helper()
		page, err, _ := s.knowledgeData("GET", "/knowledge-bases", object{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, row := range obj(page)["items"].([]object) {
			if row["groupId"] == group {
				ids = append(ids, text(row["id"]))
			}
		}
		return ids
	}
	expect := func(group any, expected ...object) {
		t.Helper()
		want := []string{}
		for _, base := range expected {
			want = append(want, text(base["id"]))
		}
		if got := order(group); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatal("wrong persisted base order", got, want)
		}
	}
	move := func(base object, anchor object) {
		t.Helper()
		dataOK(t, s, "PATCH", "/knowledge-bases/"+text(base["id"])+"/order", object{"anchor": anchor})
	}
	expect(nil, a, b, c)
	move(c, object{"before": a["id"]})
	expect(nil, c, a, b)
	move(c, object{"after": b["id"]})
	expect(nil, a, b, c)
	move(b, object{"position": "first"})
	expect(nil, b, a, c)
	move(b, object{"position": "last"})
	expect(nil, a, c, b)
	group := obj(dataOK(t, s, "POST", "/groups", object{"entityType": "knowledge", "name": "Knowledge group"}))
	g1, g2 := knowledgeBase(t, s, object{"name": "G1", "groupId": group["id"]}), knowledgeBase(t, s, object{"name": "G2", "groupId": group["id"]})
	move(g1, object{"position": "last"})
	expect(group["id"], g2, g1)
	saved, _ := s.store.get("knowledge-bases", text(g1["id"]))
	if saved["groupId"] != group["id"] {
		t.Fatal("omitted groupId cleared group")
	}
	for _, anchor := range []object{{"before": "missing"}, {"after": g1["id"]}, {"position": "middle"}, {"before": a["id"], "after": b["id"]}} {
		if reply := dataResponse(t, s, "PATCH", "/knowledge-bases/"+text(c["id"])+"/order", object{"anchor": anchor}); reply["error"] == nil {
			t.Fatal("invalid order anchor accepted")
		}
	}
	expect(nil, a, c, b)
	dataOK(t, s, "PATCH", "/knowledge-bases/"+text(b["id"])+"/order", object{"anchor": object{"after": g1["id"]}, "groupId": group["id"]})
	expect(nil, a, c)
	expect(group["id"], g2, g1, b)
	appended := knowledgeBase(t, s, object{"name": "Appended after reordering"})
	expect(nil, a, c, appended)
}

func knowledgeChangeEffects(t *testing.T, wire *bytes.Buffer) []object {
	t.Helper()
	effects := []object{}
	for _, line := range strings.Split(strings.TrimSpace(wire.String()), "\n") {
		if line == "" {
			continue
		}
		var frame object
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatal(err)
		}
		if frame["jsonrpc"] != "2.0" || frame["method"] != "event" {
			t.Fatal("invalid notification frame")
		}
		params := obj(frame["params"])
		if params["channel"] != "data-api:data-changed" {
			continue
		}
		args := array(params["args"])
		if len(args) != 1 {
			t.Fatal("data change must carry one effect array")
		}
		for _, effect := range array(args[0]) {
			effects = append(effects, obj(effect))
		}
	}
	return effects
}

func TestKnowledgeCommittedChangesUseOriginalDataApiEventContract(t *testing.T) {
	s, _ := testServer(t)
	var wire bytes.Buffer
	s.writer.output = &wire
	base := knowledgeBase(t, s, nil)
	check := func() {
		t.Helper()
		found := map[string]bool{}
		for _, effect := range knowledgeChangeEffects(t, &wire) {
			endpoint := text(effect["endpoint"])
			found[endpoint] = true
			if _, present := effect["dimension"]; present {
				t.Fatal("membership was sent as a dimension instead of a kind")
			}
			switch endpoint {
			case "/knowledge-bases", "/knowledge-bases/:id/items", "/assistants":
				if effect["kind"] != "membership" {
					t.Fatalf("collection notification does not match original schema: %v", effect)
				}
				if endpoint == "/knowledge-bases/:id/items" && obj(effect["routeParams"])["id"] != base["id"] {
					t.Fatalf("item notification was not scoped to its committed base: %v", effect)
				}
			case "/knowledge-bases/:id", "/knowledge-items/:id":
				if _, present := effect["kind"]; present {
					t.Fatal("scalar notification has a collection kind")
				}
			}
		}
		for _, endpoint := range []string{"/knowledge-bases", "/knowledge-bases/:id/items", "/knowledge-bases/:id"} {
			if !found[endpoint] {
				t.Fatalf("missing original GET template %s", endpoint)
			}
		}
		wire.Reset()
	}
	check()
	knowledgeNote(t, s, base, "Note source", "Committed note content")
	check()
	knowledgeOK(t, s, "knowledge.import_text", object{"baseId": base["id"], "name": "uploaded.txt", "content": "Committed imported content"})
	check()
	items, err := s.knowledgeItems(text(base["id"]))
	if err != nil || len(items) != 2 {
		t.Fatal("notified items were not durably queryable", err)
	}
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_notified_item BEFORE INSERT ON entity WHEN NEW.resource='knowledge-items' BEGIN SELECT RAISE(ABORT,'injected item failure'); END`); err != nil {
		t.Fatal(err)
	}
	if response := knowledgeReply(t, s, "knowledge.import_text", object{"baseId": base["id"], "name": "failed.txt", "content": "Must roll back"}); response["ok"] != false {
		t.Fatal("injected failure ignored")
	}
	if len(knowledgeChangeEffects(t, &wire)) != 0 {
		t.Fatal("failed knowledge transaction broadcast a change")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_notified_item"); err != nil {
		t.Fatal(err)
	}
	response := knowledgeReply(t, s, "knowledge.add_items", object{"baseId": base["id"], "conflictStrategy": "detect", "items": []any{object{"type": "note", "data": object{"source": "Note source", "content": "conflicting note"}}}})
	if obj(response["data"])["status"] != "conflicts" || len(knowledgeChangeEffects(t, &wire)) != 0 {
		t.Fatal("non-mutating conflict detection broadcast a change")
	}
}
