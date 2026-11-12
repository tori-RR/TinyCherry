---
description: Availability of built-in models and handling of legacy local model preferences in TinyCherry
sources:
  - src/main/ai/provider/config.ts
  - src/main/features/fileProcessing/config/resolveProcessorConfig.ts
  - src/main/features/fileProcessing/processors/registry.ts
  - src/renderer/routes/settings/local-models.tsx
---

# Built-in Local Models

TinyCherry no longer installs the bundled Qwen3 embedding or PaddleOCR models.
Existing model files and database records are kept for data compatibility.

The old Local Models and OCR settings routes open Model Provider settings.
Image attachments require a vision-capable model.

Existing knowledge bases with a supported external embedding provider can still
serve chat or Agent requests. A legacy knowledge base configured for the retired
built-in embedding provider cannot run new embedding requests with that provider.
