package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func paintingTestServer(t *testing.T) *server {
	t.Helper()
	s, _ := testServer(t)
	t.Cleanup(func() {
		s.mu.Lock()
		tasks := []*paintingTask{}
		for _, task := range s.painting.jobs {
			task.cancel()
			tasks = append(tasks, task)
		}
		s.mu.Unlock()
		for _, task := range tasks {
			select {
			case <-task.done:
			case <-time.After(5 * time.Second):
				t.Error("painting worker did not stop")
			}
		}
	})
	return s
}

func paintingPNG(t *testing.T, large bool) []byte {
	t.Helper()
	bitmap := image.NewNRGBA(image.Rect(0, 0, 4, 3))
	if large {
		bitmap = image.NewNRGBA(image.Rect(0, 0, 1050, 1050))
		_, _ = rand.New(rand.NewSource(7)).Read(bitmap.Pix)
	} else {
		bitmap.Set(0, 0, color.NRGBA{R: 240, G: 70, B: 110, A: 255})
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, bitmap); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func seedPaintingModel(t *testing.T, s *server, base, preset, modelID string) string {
	t.Helper()
	endpoint := "openai-chat-completions"
	if preset == "gemini" {
		endpoint = "google-generate-content"
	}
	provider := object{"id": "paint", "presetProviderId": preset, "name": "Painting provider", "isEnabled": true, "authOptional": true, "apiKeys": []any{}, "settings": object{}, "endpointConfigs": object{endpoint: object{"baseUrl": base, "adapterFamily": "openai-compatible"}}}
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	model := newModel(object{"providerId": "paint", "modelId": modelID, "capabilities": []any{"image-generation"}})
	if err := s.store.put("models", model); err != nil {
		t.Fatal(err)
	}
	return text(model["id"])
}

func paintingIPC(t *testing.T, s *server, route string, input object) any {
	t.Helper()
	result, err, after := s.invoke("ipc-api:request", []any{route, input})
	if err != nil || after != nil || obj(result)["ok"] != true {
		t.Fatalf("%s: %v %#v", route, err, result)
	}
	return obj(result)["data"]
}

func paintingAPI(t *testing.T, s *server, method, path string, query, body object) any {
	t.Helper()
	result, err, _ := s.invoke("data-api:request", []any{object{"id": "painting-test", "method": method, "path": path, "params": query, "body": body}})
	if err != nil || obj(result)["error"] != nil {
		t.Fatalf("%s %s: %v %#v", method, path, err, result)
	}
	return obj(result)["data"]
}

func awaitPainting(t *testing.T, s *server, id string) object {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		s.mu.Lock()
		job, err := s.store.get("painting-jobs", id)
		s.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if job["status"] != "running" {
			s.mu.Lock()
			task := s.painting.jobs[id]
			s.mu.Unlock()
			if task != nil {
				select {
				case <-task.done:
				case <-deadline:
					t.Fatal("painting worker did not finalize")
				}
			}
			return job
		}
		select {
		case <-deadline:
			t.Fatal("painting job did not finish")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestPaintingLargeOutputRoundTripsAsBoundedChunksAndSurvivesRestart(t *testing.T) {
	data := paintingPNG(t, true)
	if len(base64.StdEncoding.EncodeToString(data)) <= maxFrame {
		t.Fatal("fixture must exceed a bridge frame")
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/images/generations" {
			t.Error("wrong image path", r.URL.Path)
		}
		var body object
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "gpt-image-1" || body["prompt"] != "a cherry" {
			t.Error("wrong image request", body)
		}
		if body["response_format"] != nil {
			t.Error("gpt-image models reject response_format")
		}
		_ = json.NewEncoder(w).Encode(object{"data": []any{object{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
	}))
	defer provider.Close()
	s := paintingTestServer(t)
	model := seedPaintingModel(t, s, provider.URL, "openai", "gpt-image-1")
	id := newID()
	input := object{"requestId": id, "uniqueModelId": model, "prompt": "a cherry", "inputFileIds": []any{}, "params": object{"n": 1}}
	paintingIPC(t, s, "painting.generate.start", input)
	paintingIPC(t, s, "painting.generate.start", input)
	job := awaitPainting(t, s, id)
	if job["status"] != "succeeded" {
		t.Fatal(job)
	}
	paintingIPC(t, s, "painting.generate.start", input)
	if calls.Load() != 1 {
		t.Fatal("idempotent start resubmitted a billable request", calls.Load())
	}
	painting := obj(paintingAPI(t, s, "GET", "/paintings/"+text(job["paintingId"]), nil, nil))
	files := array(obj(painting["files"])["output"])
	if len(files) != 1 {
		t.Fatal(painting)
	}
	fileID := text(files[0])
	var joined bytes.Buffer
	offset := 0
	for {
		chunk := obj(paintingIPC(t, s, "painting.file.read", object{"fileId": fileID, "offset": offset}))
		encoded, _ := json.Marshal(chunk)
		if len(encoded) >= maxFrame {
			t.Fatal("file chunk exceeded the bridge frame")
		}
		decoded, err := base64.StdEncoding.DecodeString(text(chunk["data"]))
		if err != nil || len(decoded) > paintingChunkSize {
			t.Fatal("bad image chunk", err)
		}
		joined.Write(decoded)
		offset += len(decoded)
		if chunk["done"] == true {
			break
		}
	}
	if !bytes.Equal(joined.Bytes(), data) {
		t.Fatal("image changed during chunk transfer")
	}
	preview := obj(paintingIPC(t, s, "painting.file.read", object{"fileId": fileID, "offset": 0, "thumbnail": true}))
	previewData, _ := base64.StdEncoding.DecodeString(text(preview["data"]))
	config, _, err := image.DecodeConfig(bytes.NewReader(previewData))
	if err != nil || config.Width > 384 || config.Height > 384 {
		t.Fatal("thumbnail was not resized", config, err)
	}
	reopened, err := openStore(s.store.directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if _, err := reopened.get("paintings", text(job["paintingId"])); err != nil {
		t.Fatal("history did not persist", err)
	}
	if _, _, err := reopened.paintingFile(fileID); err != nil {
		t.Fatal("image did not persist", err)
	}
}

func TestPaintingCancellationDoesNotBlockCRUDOrSaveLateImages(t *testing.T) {
	started := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer provider.Close()
	s := paintingTestServer(t)
	model := seedPaintingModel(t, s, provider.URL, "openai", "gpt-image-1")
	id := newID()
	input := object{"requestId": id, "uniqueModelId": model, "prompt": "slow generation", "params": object{"n": 1}}
	paintingIPC(t, s, "painting.generate.start", input)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("provider request did not start")
	}
	startedAt := time.Now()
	paintingAPI(t, s, "GET", "/paintings", nil, nil)
	if time.Since(startedAt) > time.Second {
		t.Fatal("generation held the repository lock")
	}
	paintingIPC(t, s, "painting.generate.abort", object{"requestId": id})
	job := awaitPainting(t, s, id)
	if job["status"] != "cancelled" {
		t.Fatal(job)
	}
	rows, _ := s.store.list("paintings")
	files, _ := s.store.list("painting-files")
	if len(rows) != 0 || len(files) != 0 {
		t.Fatal("cancelled generation committed a receipt")
	}
	paintingIPC(t, s, "painting.generate.start", input)
	input["prompt"] = "a different request"
	result, _, _ := s.invoke("ipc-api:request", []any{"painting.generate.start", input})
	if obj(result)["ok"] == true {
		t.Fatal("reused a request ID for a different prompt")
	}
}

func uploadPaintingFixture(t *testing.T, s *server, data []byte) object {
	t.Helper()
	begin := obj(paintingIPC(t, s, "painting.file.upload.begin", object{"name": "reference.png", "size": len(data)}))
	id := begin["uploadId"]
	for offset := 0; offset < len(data); offset += paintingChunkSize {
		paintingIPC(t, s, "painting.file.upload.chunk", object{"uploadId": id, "offset": offset, "data": base64.StdEncoding.EncodeToString(data[offset:min(offset+paintingChunkSize, len(data))])})
	}
	return obj(paintingIPC(t, s, "painting.file.upload.finish", object{"uploadId": id}))
}

func TestPaintingProtocolSpecificBodiesAndReferenceImages(t *testing.T) {
	for _, variant := range []struct {
		preset, model, path string
		refs                int
		params              object
	}{
		{"openai", "gpt-image-1", "/v1/images/edits", 1, object{"n": 1, "quality": "high", "outputFormat": "webp"}},
		{"gemini", "gemini-2.5-flash-image", "/v1beta/models/gemini-2.5-flash-image:generateContent", 1, object{"n": 1, "aspectRatio": "16:9"}},
		{"zhipu", "cogview-4", "/api/paas/v4/images/generations", 0, object{"n": 1, "quality": "hd", "size": "768x1344"}},
		{"silicon", "Qwen/Qwen-Image-Edit-2509", "/v1/images/generations", 2, object{"n": 1, "size": "1024x1024"}},
	} {
		t.Run(variant.preset, func(t *testing.T) {
			data := paintingPNG(t, false)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != variant.path {
					t.Error("wrong endpoint", r.URL.Path)
				}
				body := object{}
				if variant.preset == "openai" {
					if err := r.ParseMultipartForm(2 * 1024 * 1024); err != nil {
						t.Error(err)
					}
					defer r.MultipartForm.RemoveAll()
					if r.FormValue("quality") != "high" || r.FormValue("output_format") != "webp" || len(r.MultipartForm.File["image"]) != 1 {
						t.Error("bad OpenAI multipart edit")
					}
					file, _, err := r.FormFile("image")
					if err != nil {
						t.Error(err)
					} else {
						uploaded, _ := io.ReadAll(file)
						file.Close()
						if !bytes.Equal(uploaded, data) {
							t.Error("reference image changed")
						}
					}
				} else if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				switch variant.preset {
				case "gemini":
					if r.Header.Get("Authorization") != "" || !paintingContains(obj(body["generationConfig"])["responseModalities"], "IMAGE") {
						t.Error("wrong Gemini auth/body", body)
					}
					parts := array(obj(array(body["contents"])[0])["parts"])
					if len(parts) != 2 || text(obj(obj(parts[1])["inlineData"])["data"]) != base64.StdEncoding.EncodeToString(data) {
						t.Error("Gemini input was not inlined")
					}
					_ = json.NewEncoder(w).Encode(object{"candidates": []any{object{"content": object{"parts": []any{object{"inlineData": object{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(data)}}}}}}})
					return
				case "silicon":
					if body["image_size"] != "1024x1024" || body["size"] != nil || body["n"] != nil || !strings.HasPrefix(text(body["image2"]), "data:image/png;base64,") {
						t.Error("wrong SiliconFlow body", body)
					}
					_ = json.NewEncoder(w).Encode(object{"images": []any{object{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
					return
				case "zhipu":
					if body["quality"] != "hd" || body["size"] != "768x1344" || body["response_format"] != nil || body["n"] != nil {
						t.Error("wrong Zhipu body", body)
					}
				}
				_ = json.NewEncoder(w).Encode(object{"data": []any{object{"b64_json": base64.StdEncoding.EncodeToString(data)}}})
			}))
			defer provider.Close()
			s := paintingTestServer(t)
			base := provider.URL
			if variant.preset == "gemini" {
				base += "/v1beta"
			}
			if variant.preset == "zhipu" {
				base += "/api/paas/v4/"
			}
			model := seedPaintingModel(t, s, base, variant.preset, variant.model)
			inputs := []any{}
			for i := 0; i < variant.refs; i++ {
				inputs = append(inputs, uploadPaintingFixture(t, s, data)["id"])
			}
			id := newID()
			paintingIPC(t, s, "painting.generate.start", object{"requestId": id, "uniqueModelId": model, "prompt": "test image", "inputFileIds": inputs, "params": variant.params})
			if job := awaitPainting(t, s, id); job["status"] != "succeeded" {
				t.Fatal(job)
			}
		})
	}
}

func TestPaintingDownloadsNeverForwardProviderCredentials(t *testing.T) {
	data := paintingPNG(t, false)
	var serverURL string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/output.png" {
			if r.Header.Get("Authorization") != "" || r.Header.Get("X-Provider-Key") != "" {
				t.Error("provider credentials reached the image download")
			}
			_, _ = w.Write(data)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("provider header missing")
		}
		_ = json.NewEncoder(w).Encode(object{"data": []any{object{"url": serverURL + "/output.png"}}})
	}))
	defer provider.Close()
	serverURL = provider.URL
	s := paintingTestServer(t)
	model := seedPaintingModel(t, s, provider.URL, "openai", "gpt-image-1")
	row, _ := s.store.get("providers", "paint")
	row["settings"] = object{"extraHeaders": object{"Authorization": "Bearer test-key", "X-Provider-Key": "secret"}}
	if err := s.store.put("providers", row); err != nil {
		t.Fatal(err)
	}
	id := newID()
	paintingIPC(t, s, "painting.generate.start", object{"requestId": id, "uniqueModelId": model, "prompt": "download fixture", "params": object{"n": 1}})
	if job := awaitPainting(t, s, id); job["status"] != "succeeded" {
		t.Fatal(job)
	}
}

func TestPaintingTrashRestoreAndSharedFileCleanup(t *testing.T) {
	s := paintingTestServer(t)
	entry := uploadPaintingFixture(t, s, paintingPNG(t, false))
	fileID := text(entry["id"])
	create := func() object {
		return obj(paintingAPI(t, s, "POST", "/paintings", nil, object{"providerId": "historical", "modelId": "old-model", "prompt": "shared file", "files": object{"input": []any{}, "output": []any{fileID}}}))
	}
	first, second := create(), create()
	paintingAPI(t, s, "DELETE", "/paintings/"+text(first["id"]), nil, nil)
	active := obj(paintingAPI(t, s, "GET", "/paintings", nil, nil))
	trash := obj(paintingAPI(t, s, "GET", "/paintings", object{"inTrash": true}, nil))
	if active["total"] != 1 || trash["total"] != 1 {
		t.Fatal("wrong trash membership", active, trash)
	}
	paintingAPI(t, s, "POST", "/paintings/"+text(first["id"])+"/restore", nil, nil)
	paintingAPI(t, s, "DELETE", "/paintings/"+text(first["id"]), nil, nil)
	paintingAPI(t, s, "DELETE", "/paintings/"+text(first["id"]), object{"permanent": true}, nil)
	if _, _, err := s.store.paintingFile(fileID); err != nil {
		t.Fatal("shared file was deleted", err)
	}
	_, path, _ := s.store.paintingFile(fileID)
	paintingAPI(t, s, "DELETE", "/paintings/"+text(second["id"]), nil, nil)
	paintingAPI(t, s, "DELETE", "/paintings/"+text(second["id"]), object{"permanent": true}, nil)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("unreferenced image was not deleted", err)
	}
	if _, err := os.Stat(paintingThumbnailPath(path)); !os.IsNotExist(err) {
		t.Fatal("unreferenced thumbnail was not deleted", err)
	}
}

func TestPaintingUploadAndFileReadRejectInvalidInputs(t *testing.T) {
	s := paintingTestServer(t)
	data := paintingPNG(t, false)
	begin := obj(paintingIPC(t, s, "painting.file.upload.begin", object{"name": "test.png", "size": len(data)}))
	for _, input := range []object{
		{"uploadId": begin["uploadId"], "offset": 1, "data": base64.StdEncoding.EncodeToString(data)},
		{"uploadId": begin["uploadId"], "offset": 0, "data": strings.Repeat("A", paintingChunkSize*4/3+1)},
		{"uploadId": begin["uploadId"], "offset": 0, "data": "not-base64"},
	} {
		result, _, _ := s.invoke("ipc-api:request", []any{"painting.file.upload.chunk", input})
		if obj(result)["ok"] == true {
			t.Fatal("accepted malformed image chunk")
		}
	}
	paintingIPC(t, s, "painting.file.upload.abort", object{"uploadId": begin["uploadId"]})
	for _, id := range []string{"../../secret", newID()} {
		result, _, _ := s.invoke("ipc-api:request", []any{"painting.file.path", object{"fileId": id}})
		if obj(result)["ok"] == true {
			t.Fatal("exposed an unregistered image")
		}
	}
	entries, _ := os.ReadDir(filepath.Join(s.store.directory, "paintings"))
	if len(entries) != 0 {
		t.Fatal("upload abort left temporary files")
	}
}

func TestPaintingStartupMarksInterruptedJobsWithoutRetry(t *testing.T) {
	s := paintingTestServer(t)
	job := object{"id": newID(), "status": "running", "uniqueModelId": "paint::gpt-image-1", "prompt": "interrupted", "createdAt": timestamp(), "updatedAt": timestamp()}
	if err := s.store.put("painting-jobs", job); err != nil {
		t.Fatal(err)
	}
	if err := recoverPaintingFiles(s.store); err != nil {
		t.Fatal(err)
	}
	recovered, err := s.store.get("painting-jobs", text(job["id"]))
	if err != nil || recovered["status"] != "interrupted" {
		t.Fatal("interrupted request was not recorded", recovered, err)
	}
	if len(s.painting.jobs) != 0 {
		t.Fatal("startup retried a billable request")
	}
}

func TestPaintingRejectsUnsupportedModelsAndParameterCounts(t *testing.T) {
	s := paintingTestServer(t)
	model := seedPaintingModel(t, s, "https://example.invalid/v1", "zhipu", "cogview-4")
	for _, params := range []object{{"n": 2}, {"n": 1.2}, {"n": 1, "quality": "high"}, {"n": 1, "unexpected": true}} {
		result, _, _ := s.invoke("ipc-api:request", []any{"painting.generate.start", object{"requestId": newID(), "uniqueModelId": model, "prompt": "invalid params", "params": params}})
		if obj(result)["ok"] == true {
			t.Fatal("accepted unsupported image parameters", params)
		}
	}
	provider, _ := s.store.get("providers", "paint")
	row := newModel(object{"providerId": "paint", "modelId": "glm-5", "capabilities": []any{"text-generation"}})
	if descriptor, _ := paintingModelDescriptor(provider, row); descriptor != nil {
		t.Fatal("ordinary chat model offered for painting")
	}
	provider["presetProviderId"] = "vertexai"
	provider["authConfig"] = object{"type": "iam-gcp"}
	if descriptor, _ := paintingModelDescriptor(provider, row); descriptor != nil {
		t.Fatal("unsupported IAM protocol offered for painting")
	}
	_, err := s.downloadPaintingImage(context.Background(), paintingProvider{config: providerRequestConfig{address: "https://provider.invalid/v1"}}, "http://169.254.169.254/latest/meta-data/")
	if err == nil {
		t.Fatal("accepted a private metadata image URL")
	}
}

func TestPaintingReleasedDraftWaitsForActiveTaskThenCleansFailedJob(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-finish:
			http.Error(w, "fixture failure", http.StatusBadRequest)
		case <-r.Context().Done():
		}
	}))
	defer provider.Close()
	s := paintingTestServer(t)
	model := seedPaintingModel(t, s, provider.URL, "openai", "gpt-image-1")
	entry := uploadPaintingFixture(t, s, paintingPNG(t, false))
	fileID := text(entry["id"])
	id := newID()
	paintingIPC(t, s, "painting.generate.start", object{"requestId": id, "uniqueModelId": model, "prompt": "reference then leave", "inputFileIds": []any{fileID}, "params": object{"n": 1}})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("provider did not start")
	}
	paintingIPC(t, s, "painting.file.release", object{"fileId": fileID})
	s.mu.Lock()
	_, _, err := s.store.paintingFile(fileID)
	s.mu.Unlock()
	if err != nil {
		t.Fatal("released an active job's reference", err)
	}
	close(finish)
	if job := awaitPainting(t, s, id); job["status"] != "failed" {
		t.Fatal(job)
	}
	s.mu.Lock()
	files, _ := s.store.list("painting-files")
	s.mu.Unlock()
	if len(files) != 0 {
		t.Fatal("failed job retained its released draft")
	}
	entries, _ := os.ReadDir(filepath.Join(s.store.directory, "paintings"))
	if len(entries) != 0 {
		t.Fatal("released draft left image or thumbnail files")
	}
}

func TestPaintingStartupReclaimsOnlyAbandonedUnreferencedFiles(t *testing.T) {
	s := paintingTestServer(t)
	old := uploadPaintingFixture(t, s, paintingPNG(t, false))
	recent := uploadPaintingFixture(t, s, paintingPNG(t, false))
	row, _ := s.store.get("painting-files", text(old["id"]))
	row["createdAt"] = time.Now().Add(-25 * time.Hour).UnixMilli()
	if err := s.store.put("painting-files", row); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(s.store.directory, "paintings", "user-file.txt")
	if err := os.WriteFile(unknown, []byte("do not touch"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := recoverPaintingFiles(s.store); err != nil {
		t.Fatal(err)
	}
	files, _ := s.store.list("painting-files")
	if len(files) != 1 || files[0]["id"] != recent["id"] {
		t.Fatal("wrong abandoned file cleanup", files)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatal("cleanup touched an unrelated file", err)
	}
}
