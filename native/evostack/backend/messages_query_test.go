package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestTopicAndKnowledgeQueriesUseScopedIndexes(t *testing.T) {
	s, _ := testServer(t)
	queries := []struct{ resource, field, index string }{
		{"messages", "topicId", "entity_topic"},
		{"knowledge-items", "baseId", "entity_knowledge_base"},
		{"knowledge-chunks", "itemId", "entity_knowledge_item"},
	}
	for _, query := range queries {
		rows, err := s.store.db.Query("EXPLAIN QUERY PLAN SELECT body FROM entity WHERE resource='"+query.resource+"' AND json_extract(body,'$."+query.field+"')=? ORDER BY rowid", "fixture")
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			found = found || strings.Contains(detail, query.index)
		}
		err = rows.Err()
		rows.Close()
		if err != nil || !found {
			t.Fatalf("%s was not used: %v", query.index, err)
		}
	}
}

func BenchmarkTopicRowsIndexedVsScan(b *testing.B) {
	for _, count := range []int{1000, 10000, 100000} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			repository, err := openStore(b.TempDir())
			if err != nil {
				b.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			s := newServer(repository, &wireWriter{output: io.Discard}, ctx, cancel)
			b.Cleanup(func() { cancel(); s.closeNetworkTransports(); repository.db.Close() })
			err = repository.transaction(func(view *store) error {
				statement, err := view.tx.Prepare("INSERT INTO entity(resource,id,body) VALUES('messages',?,?)")
				if err != nil {
					return err
				}
				defer statement.Close()
				for index := 0; index < count; index++ {
					topic := "other"
					if index < 50 {
						topic = "target"
					}
					id := fmt.Sprintf("fixture-%d", index)
					body := fmt.Sprintf(`{"id":%q,"topicId":%q,"role":"user","data":{"parts":[{"type":"text","text":%q}]}}`, id, topic, strings.Repeat("fixture ", 16))
					if _, err := statement.Exec(id, body); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				b.Fatal(err)
			}
			b.Run("indexed", func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					rows, err := s.topicRows("target")
					if err != nil || len(rows) != 50 {
						b.Fatalf("%d rows: %v", len(rows), err)
					}
				}
			})
			b.Run("previous-full-scan", func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					rows, err := s.store.list("messages")
					if err != nil {
						b.Fatal(err)
					}
					found := 0
					for _, row := range rows {
						if row["topicId"] == "target" {
							found++
						}
					}
					if found != 50 {
						b.Fatal(found)
					}
				}
			})
		})
	}
}
