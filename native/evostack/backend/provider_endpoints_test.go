package main

import (
	"bytes"
	"context"
	"net/http"
	"testing"
)

// Literal expectations follow the retained Electron version-path contract;
// new supported presets must receive an explicit reviewed golden entry.
func TestAllChatCompletionsPresetEndpoints(t *testing.T) {
	s, _ := testServer(t)
	wanted := map[string]string{
		"cherryin":        "https://open.cherryin.net/v1/chat/completions",
		"silicon":         "https://api.siliconflow.cn/v1/chat/completions",
		"zhipu":           "https://open.bigmodel.cn/api/paas/v4/chat/completions",
		"deepseek":        "https://api.deepseek.com/v1/chat/completions",
		"openrouter":      "https://openrouter.ai/api/v1/chat/completions",
		"radeon-cloud":    "https://developer.amd.com.cn/radeon/v1/chat/completions",
		"lmstudio":        "http://localhost:1234/v1/chat/completions",
		"litellm":         "http://localhost:4000/v1/chat/completions",
		"opencode":        "https://opencode.ai/zen/go/v1/chat/completions",
		"azure-openai":    "",
		"copilot":         "https://api.githubcopilot.com/chat/completions",
		"moonshot":        "https://api.moonshot.cn/v1/chat/completions",
		"moonshot-global": "https://api.moonshot.ai/v1/chat/completions",
		"dashscope":       "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions",
		"qwencloud":       "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
		"stepfun":         "https://api.stepfun.com/v1/chat/completions",
		"doubao":          "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
		"minimax":         "https://api.minimaxi.com/v1/chat/completions",
		"nvidia":          "https://integrate.api.nvidia.com/v1/chat/completions",
		"mistral":         "https://api.mistral.ai/v1/chat/completions",
		"jina":            "https://api.jina.ai/v1/chat/completions",
		"perplexity":      "https://api.perplexity.ai/chat/completions",
		"modelscope":      "https://api-inference.modelscope.cn/v1/chat/completions",
		"tokenhub":        "https://tokenhub.tencentmaas.com/v1/chat/completions",
		"baidu-cloud":     "https://qianfan.baidubce.com/v2/chat/completions",
		"mimo":            "https://api.xiaomimimo.com/v1/chat/completions",
		"zai":             "https://api.z.ai/api/paas/v4/chat/completions",
		"minimax-global":  "https://api.minimax.io/v1/chat/completions",
	}
	count := 0
	for _, provider := range s.store.defaults.Providers {
		if provider["defaultChatEndpoint"] != "openai-chat-completions" {
			continue
		}
		count++
		expected, known := wanted[text(provider["id"])]
		if !known {
			t.Fatalf("new chat-completions preset needs a reviewed endpoint golden: %v", provider["id"])
		}
		base := text(obj(obj(provider["endpointConfigs"])["openai-chat-completions"])["baseUrl"])
		actual, err := providerEndpoint(provider, base, "chat/completions")
		if expected == "" {
			if err == nil {
				t.Fatalf("empty configurable preset base accepted: %v", provider["id"])
			}
			continue
		}
		if err != nil || actual != expected {
			t.Fatalf("preset %v: %s, want %s (%v)", provider["id"], actual, expected, err)
		}
	}
	if count != len(wanted) {
		t.Fatalf("endpoint golden coverage drifted: presets=%d goldens=%d", count, len(wanted))
	}
}

func TestProviderPOSTCannotBeReplayedByPooledTransport(t *testing.T) {
	settings, _ := parseNetworkSettings("none", "", "")
	config := providerRequestConfig{address: "http://127.0.0.1:12345/v1/chat/completions", headers: http.Header{}, network: settings}
	request, err := config.request(context.Background(), http.MethodPost, bytes.NewReader([]byte(`{"model":"synthetic"}`)), false)
	if err != nil {
		t.Fatal(err)
	}
	if request.GetBody != nil {
		t.Fatal("a billable POST exposes a transport replay body")
	}
}
