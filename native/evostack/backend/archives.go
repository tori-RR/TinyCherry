package main

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
)

func archiveNumber(value any) (float64, bool) {
	var number float64
	switch value := value.(type) {
	case int:
		number = float64(value)
	case float64:
		number = value
	case string:
		value = strings.TrimSpace(value)
		if value == "" {
			return 0, true
		}
		var err error
		number, err = strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, false
		}
	case bool:
		if value {
			number = 1
		}
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
}

func (s *server) listArchives(query object) (object, error) {
	for key := range query {
		if key != "domain" && key != "cursor" && key != "limit" {
			return nil, errors.New("unknown archive query field")
		}
	}
	domain := ""
	if value, present := query["domain"]; present {
		var ok bool
		domain, ok = value.(string)
		if !ok || !contains([]any{"topics", "assistants", "agents", "sessions", "paintings", "files"}, domain) {
			return nil, errors.New("invalid archive domain")
		}
	}
	limit := 20
	if value, present := query["limit"]; present {
		number, valid := archiveNumber(value)
		if !valid || math.Trunc(number) != number || number < 1 || number > 200 {
			return nil, errors.New("archive page limit must be between 1 and 200")
		}
		limit = int(number)
	}
	var hasCursor bool
	var cursorTime float64
	var cursorID string
	if value, present := query["cursor"]; present {
		raw, ok := value.(string)
		if !ok {
			return nil, errors.New("archive cursor must be a string")
		}
		key, id, separated := strings.Cut(raw, ":")
		if decoded, err := url.PathUnescape(key); err == nil && separated && key != "" && id != "" {
			cursorTime, hasCursor = archiveNumber(decoded)
			cursorID = id
		}
	}
	// Native timestamps are UTC RFC3339Nano strings. Truncate the fraction to
	// milliseconds before ordering, matching the retained numeric archive DTO.
	rows, err := s.store.entities(`WITH archived AS (
  SELECT resource,id,body,json_extract(body,'$.deletedAt') AS archived_at
  FROM entity WHERE resource IN ('topics','assistants') AND json_extract(body,'$.deletedAt') IS NOT NULL
), entries AS (
  SELECT resource || ':' || id AS archive_id,id AS entity_id,resource AS domain,
    json_extract(body,'$.name') AS name,
    CASE WHEN resource='topics' THEN (
      SELECT json_extract(owner.body,'$.name') FROM entity owner
      WHERE owner.resource='assistants' AND owner.id=json_extract(archived.body,'$.assistantId')
    ) END AS parent_name,
    CASE WHEN typeof(archived_at) IN ('integer','real') THEN archived_at ELSE
      CAST(strftime('%s',substr(archived_at,1,19) || 'Z') AS INTEGER)*1000 +
      CASE WHEN substr(archived_at,20,1)='.' THEN
        CAST(substr(rtrim(substr(archived_at,21),'Z') || '000',1,3) AS INTEGER)
      ELSE 0 END
    END AS deleted_at
  FROM archived
)
SELECT json_object('id',archive_id,'entityId',entity_id,'domain',domain,'name',name,'parentName',parent_name,'deletedAt',deleted_at)
FROM entries WHERE (?='' OR domain=?) AND (NOT ? OR deleted_at<? OR (deleted_at=? AND archive_id>?))
ORDER BY deleted_at DESC,archive_id ASC LIMIT ?`, domain, domain, hasCursor, cursorTime, cursorTime, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	result := object{"items": rows}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		result["items"] = rows
		result["nextCursor"] = strconv.FormatFloat(last["deletedAt"].(float64), 'f', -1, 64) + ":" + text(last["id"])
	}
	return result, nil
}
