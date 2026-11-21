package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
)

type paintingProvider struct {
	config     providerRequestConfig
	modelID    string
	protocol   string
	descriptor object
	inputs     []paintingInput
}

type paintingInput struct{ path, mime, name string }

func paintingContains(value any, wanted string) bool {
	for _, item := range array(value) {
		if item == wanted {
			return true
		}
	}
	return false
}

// Match only protocols implemented below. Custom vendor jobs, Imagen predict,
// Vertex IAM and ChatGPT subscription transport are not silently treated as OpenAI.
func paintingModelDescriptor(provider, model object) (object, string) {
	if provider["isEnabled"] != true || model["isEnabled"] != true || isNativeChatGPTProvider(provider) || isNativeNousOAuthProvider(provider) {
		return nil, ""
	}
	auth := text(obj(provider["authConfig"])["type"])
	if auth != "" && auth != "api-key" {
		return nil, ""
	}
	modelID := text(model["apiModelId"])
	if modelID == "" {
		modelID = strings.TrimPrefix(text(model["id"]), text(provider["id"])+"::")
	}
	if modelID == "" {
		return nil, ""
	}
	lower := strings.ToLower(modelID)
	preset := text(provider["presetProviderId"])
	if preset == "" {
		preset = text(provider["id"])
	}
	configs := obj(provider["endpointConfigs"])
	imageModel := paintingContains(model["capabilities"], "image-generation") || paintingContains(model["endpointTypes"], "openai-image-generation") || len(obj(model["imageGeneration"])) > 0
	protocol, endpoint := "", ""
	maxImages, maxInputs := 4, 0
	sizes := []string{"1024x1024", "1536x1024", "1024x1536"}
	qualities, formats, ratios := []string{}, []string{}, []string{}
	switch {
	case preset == "silicon" || preset == "siliconflow":
		if !imageModel && !strings.Contains(lower, "kolors") && !strings.Contains(lower, "qwen-image") && !strings.Contains(lower, "flux") && !strings.Contains(lower, "stable-diffusion") && !strings.Contains(lower, "z-image") && !strings.Contains(lower, "moss-image") {
			return nil, ""
		}
		protocol, endpoint, maxImages = "silicon", "openai-chat-completions", 1
		if strings.Contains(lower, "kolors") {
			maxImages = 4
		}
		if strings.Contains(lower, "edit") {
			maxInputs = 3
		}
		sizes = []string{"1024x1024", "960x1280", "1280x960", "768x1024", "1024x768"}
	case preset == "zhipu" || preset == "zai":
		if !strings.HasPrefix(lower, "cogview") {
			return nil, ""
		}
		protocol, endpoint, maxImages = "zhipu", "openai-chat-completions", 1
		sizes = []string{"1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"}
		if lower == "cogview-4" {
			qualities = []string{"standard", "hd"}
		}
	case len(obj(configs["google-generate-content"])) > 0 && (strings.Contains(lower, "gemini") || strings.Contains(lower, "nano-banana")) && (imageModel || strings.Contains(lower, "image") || strings.Contains(lower, "nano-banana")):
		protocol, endpoint, maxImages, maxInputs = "gemini", "google-generate-content", 1, 4
		sizes = []string{}
		ratios = []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
	default:
		if !imageModel && !strings.Contains(lower, "gpt-image") && !strings.HasPrefix(lower, "dall-e-") {
			return nil, ""
		}
		endpoint = "openai-image-generation"
		if len(obj(configs[endpoint])) == 0 {
			endpoint = "openai-chat-completions"
		}
		family := text(obj(configs[endpoint])["adapterFamily"])
		if family != "openai" && family != "openai-compatible" && family != "" {
			return nil, ""
		}
		protocol = "openai"
		if strings.Contains(lower, "gpt-image") {
			maxInputs = 4
			qualities = []string{"auto", "low", "medium", "high"}
			formats = []string{"png", "jpeg", "webp"}
		} else if strings.HasPrefix(lower, "dall-e-3") {
			maxImages = 1
			sizes = []string{"1024x1024", "1792x1024", "1024x1792"}
			qualities = []string{"standard", "hd"}
		} else if strings.HasPrefix(lower, "dall-e-2") {
			maxInputs = 1
			sizes = []string{"256x256", "512x512", "1024x1024"}
		} else if paintingContains(model["endpointTypes"], "openai-image-edit") {
			maxInputs = 4
		}
	}
	if text(obj(configs[endpoint])["baseUrl"]) == "" {
		return nil, ""
	}
	providerName := text(provider["name"])
	if providerName == "" {
		providerName = text(provider["id"])
	}
	name := text(model["name"])
	if name == "" {
		name = modelID
	}
	return object{"id": model["id"], "name": name, "providerId": provider["id"], "providerName": providerName,
		"protocol": protocol, "canEdit": maxInputs > 0, "maxInputs": maxInputs, "maxImages": maxImages,
		"sizes": sizes, "qualities": qualities, "formats": formats, "aspectRatios": ratios}, endpoint
}

func (s *server) paintingProviderLocked(uniqueID string, inputIDs []string) (paintingProvider, error) {
	model, err := s.store.get("models", uniqueID)
	if err != nil {
		return paintingProvider{}, err
	}
	provider, err := s.store.get("providers", text(model["providerId"]))
	if err != nil {
		return paintingProvider{}, err
	}
	descriptor, endpoint := paintingModelDescriptor(provider, model)
	if descriptor == nil {
		return paintingProvider{}, errors.New("this model's image protocol is not supported or is disabled")
	}
	maxInputs := descriptor["maxInputs"].(int)
	if len(inputIDs) > maxInputs {
		return paintingProvider{}, errors.New("this model does not accept this number of reference images")
	}
	protocol := text(descriptor["protocol"])
	resource := "images/generations"
	if len(inputIDs) > 0 && protocol == "openai" {
		resource = "images/edits"
		if text(obj(obj(provider["endpointConfigs"])["openai-image-edit"])["baseUrl"]) != "" {
			endpoint = "openai-image-edit"
		}
	}
	modelID := text(model["apiModelId"])
	if modelID == "" {
		modelID = text(model["modelId"])
	}
	if protocol == "gemini" {
		resource = "models/" + url.PathEscape(strings.TrimPrefix(modelID, "models/")) + ":generateContent"
	}
	base := text(obj(obj(provider["endpointConfigs"])[endpoint])["baseUrl"])
	key, err := s.providerKey(provider, "")
	if err != nil {
		return paintingProvider{}, err
	}
	config, err := s.resolveProviderRequest(provider, base, key, resource)
	if err != nil {
		return paintingProvider{}, err
	}
	if protocol == "gemini" {
		config.headers.Del("Authorization")
		if config.headers.Get("x-goog-api-key") == "" {
			config.headers.Set("x-goog-api-key", key)
		}
	}
	inputs := []paintingInput{}
	for _, id := range inputIDs {
		row, path, err := s.store.paintingFile(id)
		if err != nil {
			return paintingProvider{}, err
		}
		inputs = append(inputs, paintingInput{path: path, mime: text(row["mime"]), name: text(row["id"]) + "." + text(row["ext"])})
	}
	return paintingProvider{config: config, modelID: modelID, protocol: protocol, descriptor: descriptor, inputs: inputs}, nil
}

func paintingParameters(params object, descriptor object) (object, error) {
	for key := range params {
		if !slices.Contains([]string{"n", "size", "quality", "outputFormat", "aspectRatio"}, key) {
			return nil, errors.New("unsupported painting parameter")
		}
	}
	n, err := paintingInteger(params["n"], 1, descriptor["maxImages"].(int), 1)
	if err != nil {
		return nil, errors.New("invalid image count for the selected model")
	}
	result := object{"n": n}
	for _, pair := range [][2]string{{"size", "sizes"}, {"quality", "qualities"}, {"outputFormat", "formats"}, {"aspectRatio", "aspectRatios"}} {
		if value, exists := params[pair[0]]; exists && value != "" {
			options := descriptor[pair[1]].([]string)
			if !slices.Contains(options, text(value)) {
				return nil, fmt.Errorf("unsupported %s for the selected model", pair[0])
			}
			result[pair[0]] = value
		}
	}
	return result, nil
}

func (provider paintingProvider) requestBody(prompt string, params object) ([]byte, string, error) {
	body := object{"model": provider.modelID, "prompt": prompt}
	if provider.protocol == "gemini" {
		parts := []any{object{"text": prompt}}
		for _, input := range provider.inputs {
			data, err := os.ReadFile(input.path)
			if err != nil {
				return nil, "", errors.New("reference image is unavailable")
			}
			parts = append(parts, object{"inlineData": object{"mimeType": input.mime, "data": base64.StdEncoding.EncodeToString(data)}})
		}
		generation := object{"responseModalities": []string{"IMAGE"}}
		if ratio := text(params["aspectRatio"]); ratio != "" {
			generation["imageConfig"] = object{"aspectRatio": ratio}
		}
		body = object{"contents": []any{object{"role": "user", "parts": parts}}, "generationConfig": generation}
	} else if provider.protocol == "silicon" {
		// Cherry's SiliconImageModel uses image_size/batch_size, not size/n,
		// and references are JSON data URLs rather than OpenAI multipart.
		if params["size"] != nil {
			body["image_size"] = params["size"]
		}
		if params["n"].(int) > 1 {
			body["batch_size"] = params["n"]
		}
		for i, input := range provider.inputs {
			data, err := os.ReadFile(input.path)
			if err != nil {
				return nil, "", errors.New("reference image is unavailable")
			}
			key := []string{"image", "image2", "image3"}[i]
			body[key] = "data:" + input.mime + ";base64," + base64.StdEncoding.EncodeToString(data)
		}
	} else {
		body["n"] = params["n"]
		for _, key := range []string{"size", "quality"} {
			if params[key] != nil {
				body[key] = params[key]
			}
		}
		if params["outputFormat"] != nil {
			body["output_format"] = params["outputFormat"]
		}
		if provider.protocol == "zhipu" {
			delete(body, "n")
		}
		if provider.protocol == "openai" && strings.HasPrefix(strings.ToLower(provider.modelID), "dall-e-") {
			body["response_format"] = "b64_json"
		}
	}
	if provider.protocol == "openai" && len(provider.inputs) > 0 {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		for key, value := range body {
			if err := writer.WriteField(key, fmt.Sprint(value)); err != nil {
				return nil, "", err
			}
		}
		field := "image[]"
		if len(provider.inputs) == 1 {
			field = "image"
		}
		for _, input := range provider.inputs {
			part, err := writer.CreateFormFile(field, input.name)
			if err != nil {
				return nil, "", err
			}
			file, err := os.Open(input.path)
			if err != nil {
				return nil, "", errors.New("reference image is unavailable")
			}
			_, copyErr := io.Copy(part, io.LimitReader(file, paintingImageLimit+1))
			err = errors.Join(copyErr, file.Close())
			if err != nil {
				return nil, "", errors.New("could not read reference image")
			}
		}
		if err := writer.Close(); err != nil {
			return nil, "", err
		}
		return buffer.Bytes(), writer.FormDataContentType(), nil
	}
	encoded, err := json.Marshal(body)
	return encoded, "application/json", err
}

func (s *server) requestPaintingImages(ctx context.Context, provider paintingProvider, prompt string, params object) ([][]byte, error) {
	body, contentType, err := provider.requestBody(prompt, params)
	if err != nil {
		return nil, err
	}
	request, err := provider.config.request(ctx, http.MethodPost, bytes.NewReader(body), false)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "application/json")
	response, err := s.networkClient(provider.config.network).Do(request)
	if err != nil {
		return nil, errors.New("image request failed; check the provider and network before retrying")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("image provider returned HTTP %d; check model availability, parameters and account balance", response.StatusCode)
	}
	const responseLimit = 112 * 1024 * 1024 // Four 20 MiB images encoded as base64, plus JSON.
	data, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil || len(data) > responseLimit {
		return nil, errors.New("image response is incomplete or exceeds its size limit")
	}
	var payload object
	if json.Unmarshal(data, &payload) != nil {
		return nil, errors.New("image provider returned invalid JSON")
	}
	items := []object{}
	if provider.protocol == "gemini" {
		for _, candidate := range array(payload["candidates"]) {
			for _, part := range array(obj(obj(candidate)["content"])["parts"]) {
				inline := obj(obj(part)["inlineData"])
				if len(inline) == 0 {
					inline = obj(obj(part)["inline_data"])
				}
				if encoded := text(inline["data"]); encoded != "" {
					items = append(items, object{"b64_json": encoded})
				}
			}
		}
	} else {
		values := array(payload["data"])
		if provider.protocol == "silicon" && payload["images"] != nil {
			values = array(payload["images"])
		}
		for _, value := range values {
			items = append(items, obj(value))
		}
	}
	if len(items) == 0 {
		return nil, errors.New("the provider returned no images; the model may have rejected the prompt")
	}
	if len(items) > 4 {
		return nil, errors.New("the provider returned too many images")
	}
	images := make([][]byte, 0, len(items))
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var data []byte
		if encoded := text(item["b64_json"]); encoded != "" {
			if len(encoded) > (paintingImageLimit+2)/3*4 {
				return nil, errors.New("generated image exceeds 20 MiB")
			}
			data, err = base64.StdEncoding.Strict().DecodeString(encoded)
			if err != nil {
				return nil, errors.New("provider returned invalid image encoding")
			}
		} else if address := text(item["url"]); address != "" {
			data, err = s.downloadPaintingImage(ctx, provider, address)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, errors.New("provider returned an unsupported image result")
		}
		if _, _, err := paintingImageType(data); err != nil {
			return nil, err
		}
		images = append(images, data)
	}
	return images, nil
}

func (s *server) downloadPaintingImage(ctx context.Context, provider paintingProvider, address string) ([]byte, error) {
	parsed, err := url.Parse(address)
	origin, _ := url.Parse(provider.config.address)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("provider returned an invalid image URL")
	}
	sameOrigin := origin != nil && strings.EqualFold(parsed.Host, origin.Host) && parsed.Scheme == origin.Scheme
	if !sameOrigin {
		if parsed.Scheme != "https" {
			return nil, errors.New("remote image downloads require HTTPS")
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, parsed.Hostname())
		if err != nil || len(ips) == 0 {
			return nil, errors.New("image download host could not be resolved")
		}
		for _, ip := range ips {
			if !ip.IP.IsGlobalUnicast() || ip.IP.IsPrivate() || ip.IP.IsLoopback() || ip.IP.IsLinkLocalUnicast() {
				return nil, errors.New("provider image URL points to a private network")
			}
		}
	}
	// A fresh unauthenticated request prevents a CDN URL receiving provider keys.
	// Redirects stay disabled; signed CDN links must be the final image URL.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, errors.New("invalid image download URL")
	}
	response, err := s.networkClient(provider.config.network).Do(request)
	if err != nil {
		return nil, errors.New("generated image could not be downloaded")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("image download returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, paintingImageLimit+1))
	if err != nil || len(data) > paintingImageLimit {
		return nil, errors.New("downloaded image exceeds 20 MiB or is incomplete")
	}
	return data, nil
}
