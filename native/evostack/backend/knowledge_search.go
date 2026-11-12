package main

import (
	"sort"
	"strings"
	"unicode"
)

type knowledgeHit struct {
	id, content string
	score       float64
}

// Retrieval has its own bounded query; it never truncates the user's message.
func knowledgeRetrievalQuery(content string) string {
	words := strings.FieldsFunc(content, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	selected := []string{}
	seen := map[string]bool{}
	length := 0
	for _, word := range words {
		word = strings.ToLower(word)
		if knowledgeStopWord(word) || seen[word] {
			continue
		}
		seen[word] = true
		runes := []rune(word)
		if len(runes) > 128 {
			runes = runes[:128]
		}
		if len(selected) == 100 || length+len(runes)+len(selected) > 1000 {
			break
		}
		selected = append(selected, string(runes))
		length += len(runes)
	}
	return strings.Join(selected, " ")
}

func (s *server) knowledgeCandidates(baseID, query string, words []string, limit int) ([]knowledgeHit, error) {
	candidates := map[string]*knowledgeHit{}
	collect := func(where, order string, args []any) error {
		args = append(args, min(200, max(20, limit*4)))
		rows, err := s.store.connection().Query("SELECT chunk_id,content FROM knowledge_fts WHERE "+where+" ORDER BY "+order+" LIMIT ?", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		rank := 0
		for rows.Next() {
			var id, content string
			if err := rows.Scan(&id, &content); err != nil {
				return err
			}
			rank++
			hit := candidates[id]
			if hit == nil {
				hit = &knowledgeHit{id: id, content: content}
				candidates[id] = hit
			}
			// Reciprocal-rank fusion combines two candidate channels, not probabilities.
			hit.score += 1.0 / float64(60+rank)
		}
		return rows.Err()
	}
	if term := knowledgeMatchQuery(query); term != "" {
		if err := collect("base_id=? AND knowledge_fts MATCH ?", "bm25(knowledge_fts),chunk_id", []any{baseID, term}); err != nil {
			return nil, err
		}
	}
	short, predicates, relevance := []string{}, []string{}, []string{}
	seen := map[string]bool{}
	for _, word := range words {
		word = strings.ToLower(word)
		if len([]rune(word)) >= 3 || knowledgeStopWord(word) || seen[word] {
			continue
		}
		seen[word] = true
		short = append(short, word)
		predicates = append(predicates, "instr(lower(content),lower(?))>0")
		relevance = append(relevance, "CASE WHEN instr(lower(content),lower(?))>0 THEN 1 ELSE 0 END")
	}
	if len(short) > 0 {
		args := []any{baseID}
		for _, word := range short {
			args = append(args, word)
		}
		for _, word := range short {
			args = append(args, word)
		}
		if err := collect("base_id=? AND ("+strings.Join(predicates, " OR ")+")", "("+strings.Join(relevance, "+")+") DESC,length(content),chunk_id", args); err != nil {
			return nil, err
		}
	}
	hits := make([]knowledgeHit, 0, len(candidates))
	for _, hit := range candidates {
		hits = append(hits, *hit)
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].id < hits[j].id
	})
	return hits[:min(limit, len(hits))], nil
}
