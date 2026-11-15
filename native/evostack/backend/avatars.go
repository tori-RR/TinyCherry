package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
)

const maxAvatarBytes = 1024 * 1024

func avatarNumber(value any) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		result, err := n.Float64()
		if err == nil {
			return result
		}
	}
	return math.NaN()
}

func avatarBytes(value any) ([]byte, error) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 || len(values) > maxAvatarBytes {
		return nil, errors.New("avatar must contain 1 to 1048576 image bytes")
	}
	result := make([]byte, len(values))
	for i, value := range values {
		n := avatarNumber(value)
		if math.IsNaN(n) || math.Trunc(n) != n || n < 0 || n > 255 {
			return nil, errors.New("invalid avatar byte")
		}
		result[i] = byte(n)
	}
	return result, nil
}

func avatarImage(data []byte) (string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 4096 || config.Height > 4096 || config.Width*config.Height > 16*1024*1024 {
		return "", errors.New("invalid avatar image")
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return "", errors.New("invalid avatar image")
	}
	switch format {
	case "webp", "png", "gif":
		return "image/" + format, nil
	case "jpeg":
		return "image/jpeg", nil
	}
	return "", errors.New("unsupported avatar image")
}

// The renderer already normalizes uploads. Keep validated bytes so the same
// immutable file id can continue to serve historical message author snapshots.
func (s *server) setAssistantAvatar(input object) error {
	if len(input) != 2 || text(input["assistantId"]) == "" {
		return errors.New("assistantId and avatar required")
	}
	id := text(input["assistantId"])
	avatar := obj(input["avatar"])
	kind := text(avatar["kind"])
	var data []byte
	var mime string
	var err error
	switch kind {
	case "image":
		if len(avatar) != 2 {
			return errors.New("invalid image avatar input")
		}
		data, err = avatarBytes(avatar["data"])
		if err != nil {
			return err
		}
		mime, err = avatarImage(data)
		if err != nil {
			return err
		}
	case "emoji":
		emoji, ok := avatar["emoji"].(string)
		if len(avatar) != 2 || !ok || !utf8.ValidString(emoji) || !validAvatarEmoji(emoji) {
			return errors.New("invalid emoji avatar")
		}
	case "default":
		if len(avatar) != 1 {
			return errors.New("invalid default avatar input")
		}
	default:
		return errors.New("invalid avatar kind")
	}
	return s.transaction(func(tx *server) error {
		assistant, err := tx.store.get("assistants", id)
		if err != nil {
			return err
		}
		if assistant["deletedAt"] != nil {
			return sql.ErrNoRows
		}
		delete(assistant, "avatarFileId")
		delete(assistant, "avatarSrc")
		if kind == "image" {
			fileID := newID()
			encoded := base64.StdEncoding.EncodeToString(data)
			if err := tx.store.put("avatar-images", object{"id": fileID, "mime": mime, "data": encoded, "createdAt": time.Now().UnixMilli()}); err != nil {
				return err
			}
			assistant["avatarFileId"], assistant["avatarSrc"] = fileID, "data:"+mime+";base64,"+encoded
		} else if kind == "emoji" {
			assistant["emoji"] = avatar["emoji"]
		}
		assistant["updatedAt"] = timestamp()
		if err := tx.store.put("assistants", assistant); err != nil {
			return err
		}
		tx.store.onCommit(func() { s.changed("/assistants", "/assistants/:id") })
		return nil
	})
}

func (s *server) avatarFileCommand(route string, input object) (any, error, bool) {
	if route != "file.read" || obj(input["handle"])["kind"] != "entry" {
		return nil, nil, false
	}
	handle, options := obj(input["handle"]), obj(input["options"])
	if len(input) != 2 || len(handle) != 2 || text(handle["entryId"]) == "" {
		return nil, errors.New("invalid avatar file handle"), true
	}
	row, err := s.store.get("avatar-images", text(handle["entryId"]))
	if err != nil {
		return nil, err, true
	}
	data, err := base64.StdEncoding.DecodeString(text(row["data"]))
	if err != nil {
		return nil, errors.New("avatar file is corrupt"), true
	}
	version := object{"mtime": row["createdAt"], "size": len(data)}
	switch options["mode"] {
	case "full":
		if len(options) != 2 || options["encoding"] != "binary" {
			return nil, errors.New("invalid avatar read options"), true
		}
	case "range":
		offset, length := avatarNumber(options["offset"]), avatarNumber(options["length"])
		if len(options) != 3 || math.IsNaN(offset) || math.IsNaN(length) || math.Trunc(offset) != offset || math.Trunc(length) != length || offset < 0 || length <= 0 || length > 4*1024*1024 || offset > float64(len(data)) || offset+length > float64(len(data)) {
			return nil, errors.New("invalid avatar read range"), true
		}
		data = data[int(offset):int(offset+length)]
	default:
		return nil, errors.New("invalid avatar read mode"), true
	}
	return object{"content": skillBytes(data), "mime": row["mime"], "version": version}, nil, true
}
