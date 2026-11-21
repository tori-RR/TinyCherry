package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"
)

type paintingTask struct {
	cancel context.CancelFunc
	inputs []string
	done   chan struct{}
}
type paintingRuntime struct {
	jobs    map[string]*paintingTask
	uploads map[string]*paintingUpload
}

func newPaintingRuntime() *paintingRuntime {
	return &paintingRuntime{jobs: map[string]*paintingTask{}, uploads: map[string]*paintingUpload{}}
}

func paintingInteger(value any, minimum, maximum, fallback int) (int, error) {
	if value == nil {
		if fallback < minimum || fallback > maximum {
			return 0, errors.New("integer value is required")
		}
		return fallback, nil
	}
	var number float64
	switch v := value.(type) {
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	case float64:
		number = v
	default:
		return 0, errors.New("expected an integer")
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < float64(minimum) || number > float64(maximum) {
		return 0, errors.New("integer is outside its allowed range")
	}
	return int(number), nil
}

func paintingIDs(value any, maximum int) ([]string, error) {
	if value == nil {
		return []string{}, nil
	}
	values, ok := value.([]any)
	if !ok || len(values) > maximum {
		return nil, errors.New("invalid painting image list")
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		id := text(value)
		if !paintingUUID(id) || seen[id] {
			return nil, errors.New("painting file IDs must be unique UUIDs")
		}
		ids = append(ids, id)
		seen[id] = true
	}
	return ids, nil
}

func paintingJobDTO(job object) object {
	result := object{}
	for _, key := range []string{"id", "status", "uniqueModelId", "prompt", "createdAt", "updatedAt", "paintingId", "error"} {
		if value, exists := job[key]; exists {
			result[key] = value
		}
	}
	return result
}

// These quick IPC commands acquire their own short state lock. Provider network
// calls and image decoding run in a worker, never under the shared repository lock.
func (s *server) paintingCommand(route string, input object) (any, error, bool) {
	if !strings.HasPrefix(route, "painting.") {
		return nil, nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.painting == nil {
		s.painting = newPaintingRuntime()
	}
	var result any
	var err error
	switch route {
	case "painting.models":
		models, e := s.store.list("models")
		err = e
		items := []object{}
		if err == nil {
			for _, model := range models {
				provider, e := s.store.get("providers", text(model["providerId"]))
				if e != nil {
					continue
				}
				if descriptor, _ := paintingModelDescriptor(provider, model); descriptor != nil {
					items = append(items, descriptor)
				}
			}
		}
		sort.SliceStable(items, func(i, j int) bool {
			return text(items[i]["providerName"])+text(items[i]["name"]) < text(items[j]["providerName"])+text(items[j]["name"])
		})
		result = items
	case "painting.generate.start":
		result, err = s.startPainting(input)
	case "painting.generate.list":
		jobs, e := s.store.list("painting-jobs")
		err = e
		sort.SliceStable(jobs, func(i, j int) bool { return text(jobs[i]["createdAt"]) > text(jobs[j]["createdAt"]) })
		items := []object{}
		for _, job := range jobs {
			if len(items) < 50 || job["status"] == "running" {
				items = append(items, paintingJobDTO(job))
			}
		}
		result = items
	case "painting.generate.abort":
		id := text(input["requestId"])
		job, e := s.store.get("painting-jobs", id)
		err = e
		if err == nil {
			if job["status"] == "running" {
				if task := s.painting.jobs[id]; task != nil {
					task.cancel()
				}
				job["status"], job["updatedAt"] = "cancelled", timestamp()
				err = s.store.put("painting-jobs", job)
			}
			result = paintingJobDTO(job)
		}
	case "painting.file.read":
		result, err = s.paintingRead(input, false)
	case "painting.file.path":
		result, err = s.paintingRead(input, true)
	case "painting.file.release":
		err = s.releasePaintingFile(text(input["fileId"]))
	default:
		if strings.HasPrefix(route, "painting.file.upload.") {
			result, err = s.paintingUploadCommand(route, input)
		} else {
			err = notMigrated(route)
		}
	}
	return result, err, true
}

func (s *server) startPainting(input object) (any, error) {
	requestID := text(input["requestId"])
	if !paintingUUID(requestID) {
		return nil, errors.New("painting request requires a UUID")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, errors.New("invalid painting request")
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(encoded))
	if previous, err := s.store.get("painting-jobs", requestID); err == nil {
		if previous["fingerprint"] != fingerprint {
			return nil, errors.New("painting request ID was already used for a different request")
		}
		return paintingJobDTO(previous), nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if s.context.Err() != nil {
		return nil, errors.New("application is closing")
	}
	if len(s.painting.jobs) >= 2 {
		return nil, errors.New("two paintings are already generating; wait or cancel one")
	}
	for key := range input {
		if key != "requestId" && key != "uniqueModelId" && key != "prompt" && key != "inputFileIds" && key != "params" {
			return nil, errors.New("unsupported painting request field")
		}
	}
	prompt := strings.TrimSpace(text(input["prompt"]))
	if prompt == "" || len([]rune(prompt)) > 32000 {
		return nil, errors.New("painting prompt must contain 1–32000 characters")
	}
	inputIDs, err := paintingIDs(input["inputFileIds"], 4)
	if err != nil {
		return nil, err
	}
	provider, err := s.paintingProviderLocked(text(input["uniqueModelId"]), inputIDs)
	if err != nil {
		return nil, err
	}
	params, err := paintingParameters(obj(input["params"]), provider.descriptor)
	if err != nil {
		return nil, err
	}
	now := timestamp()
	job := object{"id": requestID, "status": "running", "uniqueModelId": input["uniqueModelId"], "prompt": prompt,
		"createdAt": now, "updatedAt": now, "fingerprint": fingerprint}
	if err := s.store.put("painting-jobs", job); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(s.context, 30*time.Minute)
	task := &paintingTask{cancel: cancel, inputs: inputIDs, done: make(chan struct{})}
	s.painting.jobs[requestID] = task
	go s.runPainting(ctx, task, clone(job), provider, params)
	return paintingJobDTO(job), nil
}

func (s *server) runPainting(ctx context.Context, task *paintingTask, job object, provider paintingProvider, params object) {
	defer close(task.done)
	defer task.cancel()
	images, err := s.requestPaintingImages(ctx, provider, text(job["prompt"]), params)
	rows := []object{}
	paths := []string{}
	if err == nil {
		for i, image := range images {
			if err = ctx.Err(); err != nil {
				break
			}
			var row object
			var path string
			row, path, err = writePaintingFile(s.store.directory, image, fmt.Sprintf("Painting %s %d", time.Now().Format("2006-01-02"), i+1))
			if err != nil {
				break
			}
			rows, paths = append(rows, row), append(paths, path)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		delete(s.painting.jobs, text(job["id"]))
		for _, id := range task.inputs {
			row, lookup := s.store.get("painting-files", id)
			if lookup == nil && row["releaseRequested"] == true {
				_ = s.releasePaintingFile(id)
			}
		}
	}()
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	current, lookup := s.store.get("painting-jobs", text(job["id"]))
	if lookup != nil {
		err = lookup
	}
	if current != nil && current["status"] == "cancelled" {
		err = context.Canceled
	}
	job["updatedAt"] = timestamp()
	if err == nil {
		files := []any{}
		for _, row := range rows {
			files = append(files, row["id"])
		}
		inputFiles := []any{}
		for _, id := range task.inputs {
			inputFiles = append(inputFiles, id)
		}
		painting := object{"id": newID(), "providerId": provider.descriptor["providerId"], "modelId": provider.modelID,
			"prompt": job["prompt"], "files": object{"output": files, "input": inputFiles},
			"createdAt": timestamp(), "updatedAt": timestamp(), "orderKey": fmt.Sprintf("%020d", time.Now().UnixMilli())}
		job["status"], job["paintingId"] = "succeeded", painting["id"]
		err = s.transaction(func(s *server) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			for _, row := range rows {
				if err := s.store.put("painting-files", row); err != nil {
					return err
				}
			}
			if err := s.store.put("paintings", painting); err != nil {
				return err
			}
			return s.store.put("painting-jobs", job)
		})
	}
	if err != nil {
		for _, path := range paths {
			removePaintingFile(path)
		}
		delete(job, "paintingId")
		job["status"], job["error"] = "failed", err.Error()
		if errors.Is(err, context.Canceled) {
			job["status"], job["error"] = "cancelled", "Generation cancelled; the provider may still bill work already accepted."
		}
		if errors.Is(err, context.DeadlineExceeded) {
			job["error"] = "Image generation reached its 30-minute time limit. Check the provider before starting again."
		}
		if saveErr := s.store.put("painting-jobs", job); saveErr != nil {
			return
		}
	}
	s.changed("/paintings", "/paintings/:id")
}

func (s *server) paintingData(method, path string, query object, body any) (any, error, bool) {
	if path != "/paintings" && !strings.HasPrefix(path, "/paintings/") {
		return nil, nil, false
	}
	result, err := s.paintingDataOperation(method, path, query, obj(body))
	return result, err, true
}

func (s *server) paintingDataOperation(method, path string, query, input object) (any, error) {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	for i := 1; i < len(segments); i++ {
		value, err := url.PathUnescape(segments[i])
		if err != nil {
			return nil, err
		}
		segments[i] = value
	}
	if len(segments) == 1 {
		switch method {
		case "GET":
			rows, err := s.store.list("paintings")
			if err != nil {
				return nil, err
			}
			filtered := []object{}
			for _, row := range rows {
				if (row["deletedAt"] != nil) != (query["inTrash"] == true) {
					continue
				}
				if providerID := text(query["providerId"]); providerID != "" && row["providerId"] != providerID {
					continue
				}
				filtered = append(filtered, row)
			}
			sort.SliceStable(filtered, func(i, j int) bool {
				a, b := text(filtered[i]["orderKey"]), text(filtered[j]["orderKey"])
				if a == b {
					return text(filtered[i]["id"]) > text(filtered[j]["id"])
				}
				return a > b
			})
			limit, err := paintingInteger(query["limit"], 1, 100, 20)
			if err != nil {
				return nil, err
			}
			start := 0
			if cursor := text(query["cursor"]); cursor != "" {
				start = len(filtered)
				for i, row := range filtered {
					if row["id"] == cursor {
						start = i + 1
						break
					}
				}
			}
			end := min(start+limit, len(filtered))
			result := object{"items": filtered[start:end], "total": len(filtered)}
			if end < len(filtered) {
				result["nextCursor"] = filtered[end-1]["id"]
			}
			return result, nil
		case "POST":
			id := text(input["id"])
			if id == "" {
				id = newID()
			}
			if _, err := s.store.get("paintings", id); err == nil {
				return nil, errors.New("painting already exists")
			} else if !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			row := object{"id": id, "providerId": input["providerId"], "modelId": input["modelId"], "prompt": input["prompt"], "files": input["files"], "createdAt": timestamp(), "updatedAt": timestamp(), "orderKey": fmt.Sprintf("%020d", time.Now().UnixMilli())}
			if err := s.validatePainting(row); err != nil {
				return nil, err
			}
			return row, s.store.put("paintings", row)
		}
	}
	if method == "PATCH" && ((len(segments) == 2 && segments[1] == "order:batch") || (len(segments) == 3 && segments[2] == "order")) {
		rows, err := s.store.list("paintings")
		if err != nil {
			return nil, err
		}
		rows = filter(rows, object{"sortOrder": "desc"})
		if len(segments) == 3 {
			input = object{"moves": []any{object{"id": segments[1], "anchor": input}}}
		}
		rows, err = applyOrderMoves(rows, "id", input)
		if err != nil {
			return nil, err
		}
		for i, row := range rows {
			row["orderKey"] = orderKeyAt(len(rows) - i)
			if err := s.store.put("paintings", row); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	if len(segments) < 2 || len(segments) > 3 {
		return nil, notMigrated(path)
	}
	row, err := s.store.get("paintings", segments[1])
	if err != nil {
		return nil, err
	}
	if len(segments) == 3 {
		if segments[2] == "restore" && method == "POST" {
			delete(row, "deletedAt")
			row["updatedAt"] = timestamp()
			return row, s.store.put("paintings", row)
		}
		return nil, notMigrated(path)
	}
	switch method {
	case "GET":
		return row, nil
	case "PATCH":
		if row["deletedAt"] != nil {
			return nil, errors.New("restore a painting before editing it")
		}
		for key, value := range input {
			if key != "providerId" && key != "modelId" && key != "prompt" && key != "files" {
				return nil, errors.New("unsupported painting field")
			}
			row[key] = value
		}
		if err := s.validatePainting(row); err != nil {
			return nil, err
		}
		row["updatedAt"] = timestamp()
		return row, s.store.put("paintings", row)
	case "DELETE":
		if query["permanent"] != true {
			row["deletedAt"], row["updatedAt"] = timestamp(), timestamp()
			return nil, s.store.put("paintings", row)
		}
		if row["deletedAt"] == nil {
			return nil, errors.New("move the painting to the recycle bin before permanently deleting it")
		}
		if err := s.store.delete("paintings", text(row["id"])); err != nil {
			return nil, err
		}
		files := obj(row["files"])
		ids := append(append([]any{}, array(files["input"])...), array(files["output"])...)
		for _, value := range ids {
			id := text(value)
			if s.paintingFileReferenced(id) {
				continue
			}
			_, filePath, err := s.store.paintingFile(id)
			if err != nil {
				continue
			}
			if err := s.store.delete("painting-files", id); err != nil {
				return nil, err
			}
			s.store.onCommit(func() { removePaintingFile(filePath) })
		}
		return nil, nil
	}
	return nil, notMigrated(method + " " + path)
}

func (s *server) validatePainting(row object) error {
	if len(text(row["id"])) > 200 || strings.TrimSpace(text(row["providerId"])) == "" || len(text(row["providerId"])) > 200 {
		return errors.New("invalid painting identity")
	}
	if _, ok := row["prompt"].(string); !ok || len([]rune(text(row["prompt"]))) > 32000 {
		return errors.New("invalid painting prompt")
	}
	files := obj(row["files"])
	if len(files) != 2 {
		return errors.New("painting requires input and output file lists")
	}
	for _, key := range []string{"input", "output"} {
		if _, exists := files[key]; !exists {
			return errors.New("painting requires input and output file lists")
		}
		ids, err := paintingIDs(files[key], 4)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, _, err := s.store.paintingFile(id); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *server) paintingFileReferenced(id string) bool {
	rows, err := s.store.list("paintings")
	if err != nil {
		return true
	}
	for _, row := range rows {
		for _, key := range []string{"input", "output"} {
			if paintingContains(obj(row["files"])[key], id) {
				return true
			}
		}
	}
	if s.painting != nil {
		for _, task := range s.painting.jobs {
			for _, input := range task.inputs {
				if input == id {
					return true
				}
			}
		}
	}
	return false
}
