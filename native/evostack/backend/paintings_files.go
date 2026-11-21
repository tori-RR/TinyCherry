package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const paintingImageLimit = 20 * 1024 * 1024
const paintingChunkSize = 192 * 1024

type paintingUpload struct {
	path    string
	name    string
	size    int64
	offset  int64
	created time.Time
}

func paintingUUID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed.String() == id
}

func paintingDirectory(directory string) (string, error) {
	path := filepath.Join(directory, "paintings")
	if err := os.MkdirAll(path, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("painting storage is unavailable")
	}
	return path, nil
}

func paintingImageType(data []byte) (string, string, error) {
	if len(data) == 0 || len(data) > paintingImageLimit {
		return "", "", errors.New("image must be between 1 byte and 20 MiB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 16384 || config.Height > 16384 || int64(config.Width)*int64(config.Height) > 32*1024*1024 {
		return "", "", errors.New("invalid image or image exceeds 32 megapixels")
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return "", "", errors.New("only PNG, JPEG and WebP images are supported")
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return "", "", errors.New("image content is incomplete or invalid")
	}
	return format, "image/" + format, nil
}

func paintingFileDTO(row object) object {
	entry := clone(row)
	delete(entry, "mime")
	delete(entry, "releaseRequested")
	return entry
}

func paintingSafeName(name string) string {
	name = strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-", "\x00", "", "\r", "", "\n", "").Replace(name))
	name = strings.TrimSuffix(name, filepath.Ext(name))
	if name == "" || name == "." || name == ".." {
		name = "painting"
	}
	for len(name) > 120 {
		name = string([]rune(name)[:len([]rune(name))-1])
	}
	return name
}

func paintingThumbnailPath(path string) string {
	return strings.TrimSuffix(path, filepath.Ext(path)) + ".thumb.png"
}

func removePaintingFile(path string) {
	os.Remove(path)
	os.Remove(paintingThumbnailPath(path))
}

func writePaintingThumbnail(path string, data []byte) error {
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return errors.New("image content is invalid")
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width > 384 || height > 384 {
		if width >= height {
			height = max(1, height*384/width)
			width = 384
		} else {
			width = max(1, width*384/height)
			height = 384
		}
	}
	thumbnail := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(thumbnail, thumbnail.Bounds(), source, bounds, draw.Src, nil)
	file, err := os.OpenFile(paintingThumbnailPath(path), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	return errors.Join(png.Encode(file, thumbnail), file.Close())
}

// New UUIDs and exclusive creation keep generated files immutable and app-owned.
// The caller removes the file if its metadata transaction cannot commit.
func writePaintingFile(directory string, data []byte, name string) (object, string, error) {
	ext, mime, err := paintingImageType(data)
	if err != nil {
		return nil, "", err
	}
	dir, err := paintingDirectory(directory)
	if err != nil {
		return nil, "", err
	}
	id := newID()
	path := filepath.Join(dir, id+"."+ext)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, "", errors.New("could not create painting image")
	}
	_, writeErr := file.Write(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	err = errors.Join(writeErr, file.Close())
	if err != nil {
		os.Remove(path)
		return nil, "", errors.New("could not save painting image")
	}
	if err := writePaintingThumbnail(path, data); err != nil {
		removePaintingFile(path)
		return nil, "", errors.New("could not save painting preview")
	}
	now := time.Now().UnixMilli()
	hash := sha256.Sum256(data)
	row := object{"id": id, "origin": "internal", "name": paintingSafeName(name), "ext": ext,
		"size": len(data), "mime": mime, "contentHash": fmt.Sprintf("sha256:%x", hash),
		"cleanupPolicy": "delete_when_unreferenced", "createdAt": now, "updatedAt": now}
	return row, path, nil
}

func (s *store) paintingFile(id string) (object, string, error) {
	if !paintingUUID(id) {
		return nil, "", errors.New("invalid painting file ID")
	}
	row, err := s.get("painting-files", id)
	if err != nil {
		return nil, "", err
	}
	ext := text(row["ext"])
	if row["origin"] != "internal" || (ext != "png" && ext != "jpeg" && ext != "webp") {
		return nil, "", errors.New("invalid painting file record")
	}
	dir, err := paintingDirectory(s.directory)
	if err != nil {
		return nil, "", err
	}
	path := filepath.Join(dir, id+"."+ext)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, "", errors.New("painting image is missing")
	}
	size, sizeErr := paintingInteger(row["size"], 1, paintingImageLimit, -1)
	if sizeErr != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > paintingImageLimit || info.Size() != int64(size) {
		return nil, "", errors.New("painting image no longer matches its registered file")
	}
	return row, path, nil
}

func (s *server) paintingRead(input object, pathOnly bool) (any, error) {
	row, path, err := s.store.paintingFile(text(input["fileId"]))
	if err != nil {
		return nil, err
	}
	name := text(row["name"]) + "." + text(row["ext"])
	size, _ := paintingInteger(row["size"], 1, paintingImageLimit, -1)
	if pathOnly {
		return object{"path": path, "name": name, "mime": row["mime"], "size": size}, nil
	}
	if input["thumbnail"] == true {
		path = paintingThumbnailPath(path)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
			return nil, errors.New("painting preview is unavailable")
		}
		size = int(info.Size())
		row = clone(row)
		row["mime"] = "image/png"
	}
	offset, err := paintingInteger(input["offset"], 0, size, 0)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("could not read painting image")
	}
	defer file.Close()
	buffer := make([]byte, min(paintingChunkSize, size-offset))
	_, err = file.ReadAt(buffer, int64(offset))
	if err != nil && err != io.EOF {
		return nil, errors.New("could not read painting image")
	}
	return object{"data": base64.StdEncoding.EncodeToString(buffer), "mime": row["mime"], "name": name,
		"size": size, "nextOffset": offset + len(buffer), "done": offset+len(buffer) == size}, nil
}

// Removing a draft reference never removes another painting's file, and active
// jobs retain their inputs until they commit or reach a terminal state.
func (s *server) releasePaintingFile(id string) error {
	if !paintingUUID(id) {
		return errors.New("invalid painting file ID")
	}
	row, err := s.store.get("painting-files", id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	row["releaseRequested"] = true
	if s.paintingFileReferenced(id) {
		return s.store.put("painting-files", row)
	}
	_, path, err := s.store.paintingFile(id)
	if err != nil {
		return err
	}
	if err := s.store.delete("painting-files", id); err != nil {
		return err
	}
	removePaintingFile(path)
	return nil
}

// Upload chunks never exceed 256 KiB encoded, far below the private RPC frame.
func (s *server) paintingUploadCommand(route string, input object) (any, error) {
	for id, upload := range s.painting.uploads {
		if time.Since(upload.created) > 30*time.Minute {
			os.Remove(upload.path)
			delete(s.painting.uploads, id)
		}
	}
	if route == "painting.file.upload.begin" {
		if len(s.painting.uploads) >= 8 {
			return nil, errors.New("too many pending image uploads")
		}
		size, err := paintingInteger(input["size"], 1, paintingImageLimit, 0)
		if err != nil {
			return nil, errors.New("image must be between 1 byte and 20 MiB")
		}
		name := text(input["name"])
		if len(name) == 0 || len(name) > 800 {
			return nil, errors.New("invalid image name")
		}
		dir, err := paintingDirectory(s.store.directory)
		if err != nil {
			return nil, err
		}
		id := newID()
		path := filepath.Join(dir, id+".upload")
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, errors.New("could not start image upload")
		}
		if err := file.Close(); err != nil {
			removePaintingFile(path)
			return nil, err
		}
		s.painting.uploads[id] = &paintingUpload{path: path, name: name, size: int64(size), created: time.Now()}
		return object{"uploadId": id}, nil
	}
	id := text(input["uploadId"])
	upload := s.painting.uploads[id]
	if upload == nil {
		return nil, sql.ErrNoRows
	}
	switch route {
	case "painting.file.upload.abort":
		err := os.Remove(upload.path)
		delete(s.painting.uploads, id)
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		return nil, err
	case "painting.file.upload.chunk":
		offset, err := paintingInteger(input["offset"], 0, int(upload.size), -1)
		if err != nil || int64(offset) != upload.offset {
			return nil, errors.New("image upload offset mismatch")
		}
		encoded := text(input["data"])
		if len(encoded) == 0 || len(encoded) > paintingChunkSize*4/3 {
			return nil, errors.New("invalid image chunk size")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || upload.offset+int64(len(data)) > upload.size {
			return nil, errors.New("invalid image upload chunk")
		}
		info, err := os.Lstat(upload.path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != upload.offset {
			return nil, errors.New("image upload file changed")
		}
		file, err := os.OpenFile(upload.path, os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return nil, errors.New("could not append image upload")
		}
		n, writeErr := file.Write(data)
		closeErr := file.Close()
		upload.offset += int64(n)
		if err := errors.Join(writeErr, closeErr); err != nil {
			return nil, errors.New("could not write image upload")
		}
		return object{"offset": upload.offset}, nil
	case "painting.file.upload.finish":
		if upload.offset != upload.size {
			return nil, errors.New("image upload is incomplete")
		}
		info, err := os.Lstat(upload.path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != upload.size {
			return nil, errors.New("image upload file changed")
		}
		data, err := os.ReadFile(upload.path)
		if err != nil {
			return nil, errors.New("could not read uploaded image")
		}
		row, path, err := writePaintingFile(s.store.directory, data, upload.name)
		if err != nil {
			return nil, err
		}
		if err := s.store.put("painting-files", row); err != nil {
			os.Remove(path)
			return nil, err
		}
		os.Remove(upload.path)
		delete(s.painting.uploads, id)
		return paintingFileDTO(row), nil
	}
	return nil, notMigrated(route)
}

// Startup repair records interrupted requests without ever resubmitting them.
// Only orphaned files with this feature's generated UUID names are reclaimed.
func recoverPaintingFiles(s *store) error {
	if err := s.transaction(func(s *store) error {
		jobs, err := s.list("painting-jobs")
		if err != nil {
			return err
		}
		for _, job := range jobs {
			if job["status"] == "running" {
				job["status"], job["updatedAt"], job["error"] = "interrupted", timestamp(), "Application closed before generation completed. Check the provider before starting again."
				if err := s.put("painting-jobs", job); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		return err
	}
	// A crash can leave an unmounted draft with no opportunity to release it.
	// Keep recent drafts for recovery, but reclaim abandoned inputs after a day.
	paintings, err := s.list("paintings")
	if err != nil {
		return err
	}
	referenced := map[string]bool{}
	for _, painting := range paintings {
		for _, kind := range []string{"input", "output"} {
			for _, id := range array(obj(painting["files"])[kind]) {
				referenced[text(id)] = true
			}
		}
	}
	files, err := s.list("painting-files")
	if err != nil {
		return err
	}
	for _, row := range files {
		id := text(row["id"])
		created, _ := paintingInteger(row["createdAt"], 0, 1<<53-1, 0)
		if referenced[id] || (row["releaseRequested"] != true && time.Since(time.UnixMilli(int64(created))) < 24*time.Hour) {
			continue
		}
		if err := s.delete("painting-files", id); err != nil {
			return err
		}
	}
	dir, err := paintingDirectory(s.directory)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		ext := filepath.Ext(entry.Name())
		id := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ext), ".thumb")
		if !paintingUUID(id) {
			continue
		}
		if ext != ".upload" && ext != ".png" && ext != ".jpeg" && ext != ".webp" {
			continue
		}
		_, lookup := s.get("painting-files", id)
		if ext == ".upload" || errors.Is(lookup, sql.ErrNoRows) {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		} else if lookup != nil {
			return lookup
		}
	}
	return nil
}
