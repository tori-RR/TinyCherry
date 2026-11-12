package main

import (
	"errors"
	"strings"
)

// The header drawer sends JSON Merge Patch tombstones. Keep untouched headers
// and remove tombstones from persistence, rather than only hiding them on send.
func mergeProviderSettings(current, patch object) (object, error) {
	for key, value := range patch {
		if key != "extraHeaders" {
			current[key] = value
			continue
		}
		if value == nil {
			delete(current, key)
			continue
		}
		entries, ok := value.(map[string]any)
		if !ok {
			return nil, errors.New("provider custom headers must be an object or null")
		}
		headers := clone(obj(current[key]))
		for name, entry := range headers {
			if entry == nil {
				delete(headers, name)
			}
		}
		for name, entry := range entries {
			if entry == nil {
				delete(headers, name)
			} else {
				content, ok := entry.(string)
				if !ok || !validHeaderName(name) || strings.ContainsAny(content, "\r\n\x00") {
					return nil, errors.New("invalid provider custom header")
				}
				headers[name] = entry
			}
		}
		current[key] = headers
	}
	return current, nil
}
