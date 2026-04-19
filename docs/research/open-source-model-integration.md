---
title: 'Open-Source Model Integration Opportunities'
description: 'Comprehensive inventory of state-of-the-art open-source LLMs and inference providers for LangChain/LangGraph integration as of March 2026'
status: draft
created: '2026-03-18'
updated: '2026-03-18'
category: comparison
related:
  - apps/api/app/api/models/model.constants.ts
  - apps/api/app/api/providers/provider.service.ts
  - apps/api/app/api/providers/provider.schema.ts
---

# Open-Source Model Integration Opportunities

Inventory and evaluation of state-of-the-art open-source models and inference providers missing from Tau's model catalog, with integration recommendations for LangChain/LangGraph.

## Executive Summary

Tau currently offers 8 models from 3 closed-source providers (Anthropic, OpenAI, Google) plus dynamic Ollama discovery. As of March 2026, the open-source model landscape has reached parity with frontier closed models on multiple benchmarks. This research identifies **15+ high-impact models** across **6 new providers** that would dramatically expand Tau's model catalog, reduce per-token costs by 80-97%, and enable self-hosting for users who need it. The highest-priority additions are DeepSeek V3.2, GLM-5, and Qwen 3.5 via cloud inference providers (Together AI, Fireworks AI, Groq), followed by Mistral Large 3 and Llama 4 Maverick.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Current State](#current-state)
- [Methodology](#methodology)
- [Finding 1: Frontier Open-Source Models](#finding-1-frontier-open-source-models)
- [Finding 2: Specialized Models](#finding-2-specialized-models)
- [Finding 3: Small / Edge Models](#finding-3-small--edge-models)
- [Finding 4: Cloud Inference Providers](#finding-4-cloud-inference-providers)
- [Finding 5: Provider Integration Effort](#finding-5-provider-integration-effort)
- [Recommendations](#recommendations)
- [Integration Architecture](#integration-architecture)
- [References](#references)

## Problem Statement

Tau's model catalog (`model.constants.ts`) only includes closed-source models from Anthropic, OpenAI, and Google. Users cannot select open-source alternatives for:

1. **Cost reduction** — open-source models via cloud inference are 80-97% cheaper per token
2. **Self-hosting** — enterprises requiring data sovereignty or air-gapped deployments
3. **Specialization** — coding-optimized, reasoning-focused, or vision models that outperform general-purpose closed models in specific domains
4. **Vendor diversification** — reducing dependency on 3 closed-source providers

The existing `ProviderService` already supports Ollama (local) and SambaNova (cloud, OpenAI-compatible), but neither is exposed in the static model catalog. The architecture is ready for expansion.

## Current State

### Models in Catalog

| Provider  | Models                                 | Count |
| --------- | -------------------------------------- | ----- |
| Anthropic | Claude 4.6 Opus, Sonnet 4.6, Haiku 4.5 | 3     |
| OpenAI    | GPT-5.4, GPT-5.3 Codex, GPT-4.1        | 3     |
| Google    | Gemini 3.1 Pro, Gemini 3 Flash         | 2     |
| **Total** |                                        | **8** |

### Providers in Code (but no static models)

| Provider  | Status                              | LangChain Class |
| --------- | ----------------------------------- | --------------- |
| Ollama    | Dynamic discovery, no static models | `ChatOllama`    |
| SambaNova | Configured, no models in catalog    | `ChatOpenAI`    |
| Cerebras  | Configured, no models in catalog    | `ChatCerebras`  |

### Architecture Constraints

- `CloudProviderId` = `Exclude<ProviderId, 'ollama'>` — static models use cloud providers only
- `modelFamilySchema` = `'gpt' | 'claude' | 'gemini'` — needs extension for new families
- `modelList: Record<CloudProviderId, Record<string, Model>>` — keyed by provider ID
- Provider integration requires: LangChain adapter class, API key config, token accounting flags

## Methodology

- Web research of current model leaderboards (LMSYS Arena, MMLU-Pro, SWE-Bench, HumanEval) as of March 2026
- Review of LangChain JS/TS package ecosystem for provider adapters
- Analysis of existing provider patterns in `provider.service.ts` and `model.schema.ts`
- Cross-reference of model capabilities against Tau's requirements (tool calling, streaming, code generation)

## Finding 1: Frontier Open-Source Models

These models compete directly with GPT-5.4, Claude 4.6 Opus, and Gemini 3.1 Pro on general benchmarks.

| Model                | Org      | Params (Total/Active) | Context       | Tool Calling   | License      | LMSYS Elo | SWE-Bench        | MMLU-Pro    |
| -------------------- | -------- | --------------------- | ------------- | -------------- | ------------ | --------- | ---------------- | ----------- |
| **DeepSeek V3.2**    | DeepSeek | 685B / 37B MoE        | 128K          | Yes (native)   | MIT          | ~1369     | 77.8% (Speciale) | 85.9%       |
| **GLM-5**            | Zhipu AI | 744B / 40B MoE        | 200K+         | Yes (parallel) | MIT          | 1447      | 77.8%            | —           |
| **Qwen 3.5-397B**    | Alibaba  | 397B / 17B MoE        | 262K (1M ext) | Yes            | Apache 2.0   | 1387      | —                | 84.6%       |
| **Llama 4 Maverick** | Meta     | 400B / 17B MoE        | 1M+           | Yes            | Llama 4      | —         | —                | 83.2%       |
| **Mistral Large 3**  | Mistral  | 675B / 41B MoE        | 256K          | Yes (parallel) | Apache 2.0   | 1418      | —                | 85.5% MMMLU |
| **DeepSeek R2**      | DeepSeek | 1.2T / 78B MoE        | 128K+         | TBD            | Expected MIT | —         | —                | —           |

### Key Observations

- **DeepSeek V3.2** leads on SWE-Bench (code) and has breakthrough "Thinking in Tool-Use" — chain-of-thought integrated with tool calling. OpenAI-compatible API makes integration trivial.
- **GLM-5** tops the LMSYS coding arena at 1447 Elo. Available via OpenAI-compatible APIs (Z.AI, OpenRouter). MIT license.
- **Qwen 3.5** introduces Gated DeltaNet hybrid attention (near-linear complexity) and native multimodality. 262K native context extends to 1M.
- **Llama 4 Maverick** has 128 MoE experts and fits on a single H100 host. Massive ecosystem support.
- **Mistral Large 3** ships with native vision (2.5B encoder), Apache 2.0 license, and $0.50/$1.50 per M token pricing.
- **DeepSeek R2** (expected mid-2026) will be 1.2T parameters, 40x faster inference than R1, with multimodal capabilities.

## Finding 2: Specialized Models

### Reasoning / Thinking Models

| Model                  | Org       | Params         | Strength                                    | License      |
| ---------------------- | --------- | -------------- | ------------------------------------------- | ------------ |
| **DeepSeek R1**        | DeepSeek  | 671B / 37B MoE | Chain-of-thought reasoning, 79.8% AIME 2024 | MIT          |
| **QwQ-32B**            | Alibaba   | 32B            | Reasoning specialist, competes with o1-mini | Apache 2.0   |
| **Phi-4-reasoning**    | Microsoft | 14B            | Math/STEM reasoning, beats GPT-4o on MATH   | MIT          |
| **Kimi K2.5-Thinking** | Moonshot  | —              | 1433 Elo on coding arena                    | Modified MIT |

### Coding Models

| Model                 | Org      | Params         | Context | HumanEval | License         |
| --------------------- | -------- | -------------- | ------- | --------- | --------------- |
| **Codestral 25.08**   | Mistral  | 22B            | 256K    | 86.6%     | MNPL (non-prod) |
| **DeepSeek-Coder-V2** | DeepSeek | 236B / 21B MoE | 128K    | 90.2%     | MIT             |

### Multimodal / Vision Models

| Model                      | Org       | Params         | Capabilities                                   | License     |
| -------------------------- | --------- | -------------- | ---------------------------------------------- | ----------- |
| **InternVL 3.5**           | OpenGVLab | 241B / 28B MoE | Vision, video, reasoning — comparable to GPT-5 | Apache 2.0  |
| **Phi-4-reasoning-vision** | Microsoft | 15B            | Vision + reasoning from images                 | MIT         |
| **Qwen 3.5** (all sizes)   | Alibaba   | 0.8B–397B      | Native text + image + video fusion             | Apache 2.0  |
| **Llama 4 Scout**          | Meta      | 109B / 17B MoE | 10M token context, multimodal                  | Llama 4     |
| **Gemma 3 27B**            | Google    | 27B            | Vision + text, 128K context, 140+ languages    | Apache-like |

### RAG-Optimized

| Model          | Org    | Params | Strength                                               | License  |
| -------------- | ------ | ------ | ------------------------------------------------------ | -------- |
| **Command R+** | Cohere | 104B   | RAG-native, reduced hallucination, multi-step tool use | CC-BY-NC |

## Finding 3: Small / Edge Models

Models runnable on consumer hardware or edge deployments, suitable for Ollama self-hosting:

| Model                      | Org           | Params         | Context | Strength                                    | License     |
| -------------------------- | ------------- | -------------- | ------- | ------------------------------------------- | ----------- |
| **Qwen 3.5-9B**            | Alibaba       | 9B             | 262K    | "9B beats 120B" — native multimodal         | Apache 2.0  |
| **Qwen 3.5-27B**           | Alibaba       | 27B (dense)    | 262K    | Strong general purpose                      | Apache 2.0  |
| **Gemma 3 27B**            | Google        | 27B            | 128K    | Multimodal, function calling                | Apache-like |
| **Phi-4**                  | Microsoft     | 14B            | 16K     | Math/reasoning specialist                   | MIT         |
| **Phi-4-reasoning-vision** | Microsoft     | 15B            | 16K     | Multimodal reasoning                        | MIT         |
| **Llama 4 Scout**          | Meta          | 109B / 17B MoE | 10M     | Fits on single GPU (quantized)              | Llama 4     |
| **Hermes 3**               | Nous Research | 8B–405B        | 128K    | Enhanced tool calling, fine-tuned Llama 3.1 | Llama 3.1   |

## Finding 4: Cloud Inference Providers

These providers host open-source models with OpenAI-compatible APIs, making integration via `ChatOpenAI` or dedicated LangChain adapters straightforward.

| Provider         | LangChain JS Package                          | Models Hosted                                     | Pricing (per M tokens) | Key Advantage                                         |
| ---------------- | --------------------------------------------- | ------------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| **Together AI**  | `@langchain/community` (`ChatTogetherAI`)     | 100+ (Llama 4, Qwen 3.5, DeepSeek, Mistral, etc.) | $0.05–$0.90            | Broadest model selection, fine-tuning API             |
| **Fireworks AI** | `@langchain/community` (`ChatFireworks`)      | Curated top models                                | $0.05–$0.90            | Production-grade SLAs, optimized function calling     |
| **Groq**         | `@langchain/groq` (`ChatGroq`)                | Llama 3/4, Mistral, Mixtral                       | $0.05–$0.90            | Fastest inference (400-800 tok/s), generous free tier |
| **DeepInfra**    | `@langchain/community` (`ChatDeepInfra`)      | Llama, Mistral, DeepSeek                          | $0.05–$0.50            | Low-cost serverless                                   |
| **Mistral AI**   | `@langchain/mistralai` (`ChatMistralAI`)      | Mistral Large 3, Codestral, Ministral             | $0.04–$1.50            | First-party, vision-native models                     |
| **NVIDIA NIM**   | `langchain-nvidia-ai-endpoints` (Python only) | Nemotron, Llama, Mistral                          | Varies                 | GPU-optimized, on-prem deployment                     |
| **AWS Bedrock**  | `@langchain/aws` (`ChatBedrockConverse`)      | Llama 4, Mistral, Command R+                      | Varies                 | Enterprise compliance, existing AWS customers         |
| **SambaNova**    | Already configured (`ChatOpenAI`)             | DeepSeek, Llama, Qwen                             | $0.10–$1.00            | Already in provider code, just needs models           |
| **Cerebras**     | Already configured (`ChatCerebras`)           | Llama 3.x                                         | Fast inference         | Already in provider code, just needs models           |

### LangChain JS Feature Support

| Provider     | Tool Calling | Streaming | Structured Output | Multimodal        | Token Usage |
| ------------ | ------------ | --------- | ----------------- | ----------------- | ----------- |
| Together AI  | Yes          | Yes       | Yes               | Yes (audio/video) | Yes         |
| Fireworks AI | Yes          | Yes       | Yes               | No                | Yes         |
| Groq         | Yes          | Yes       | Yes               | No                | Yes         |
| DeepInfra    | Yes          | Yes       | Yes               | No                | Yes         |
| Mistral AI   | Yes          | Yes       | Yes               | No                | Yes         |
| AWS Bedrock  | Yes          | Yes       | Yes               | Yes               | Yes         |

## Finding 5: Provider Integration Effort

### Effort Tiers

**Tier 1 — Zero effort (already configured, just add models to catalog):**

| Provider  | Work Required                              |
| --------- | ------------------------------------------ |
| SambaNova | Add model entries to `modelList.sambanova` |
| Cerebras  | Add model entries to `modelList.cerebras`  |

**Tier 2 — Low effort (OpenAI-compatible API, reuse `ChatOpenAI`):**

Any provider with an OpenAI-compatible API can follow the SambaNova pattern: add a new provider ID, configure `ChatOpenAI` with `baseURL` and `apiKey`, and add model entries.

| Provider     | LangChain Class                               | Integration Pattern                                          |
| ------------ | --------------------------------------------- | ------------------------------------------------------------ |
| Together AI  | `ChatOpenAI` (compatible) or `ChatTogetherAI` | Same as SambaNova                                            |
| Fireworks AI | `ChatOpenAI` (compatible) or `ChatFireworks`  | Same as SambaNova                                            |
| Groq         | `ChatOpenAI` (compatible) or `ChatGroq`       | Same as SambaNova                                            |
| DeepInfra    | `ChatOpenAI` (compatible) or `ChatDeepInfra`  | Same as SambaNova                                            |
| DeepSeek     | `ChatOpenAI` (compatible)                     | Same as SambaNova (`baseURL: 'https://api.deepseek.com/v1'`) |

**Tier 3 — Medium effort (dedicated LangChain adapter):**

| Provider    | Package                | Work Required                                            |
| ----------- | ---------------------- | -------------------------------------------------------- |
| Mistral AI  | `@langchain/mistralai` | Install package, add provider, configure API key         |
| AWS Bedrock | `@langchain/aws`       | Install package, add provider, configure AWS credentials |

### Schema Changes Required

1. **`providerIdSchema`** — extend enum with new provider IDs: `'together'`, `'fireworks'`, `'groq'`, `'deepinfra'`, `'mistral'`, `'deepseek'`
2. **`modelFamilySchema`** — extend enum with: `'deepseek'`, `'qwen'`, `'llama'`, `'mistral'`, `'glm'`, `'phi'`, `'gemma'`, `'command'`
3. **`ProviderOptionsMap`** — add type entries for new providers
4. **`CloudProviderId`** — automatically includes new providers (excludes only `'ollama'`)
5. **Environment config** — add API key env vars: `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`, etc.

## Recommendations

| #   | Action                                                  | Priority | Effort  | Impact                                                   |
| --- | ------------------------------------------------------- | -------- | ------- | -------------------------------------------------------- |
| R1  | Add models to existing SambaNova/Cerebras providers     | P0       | Minimal | Quick wins — immediate model expansion                   |
| R2  | Add Together AI provider (broadest open-source catalog) | P0       | Low     | Access to 100+ models via one provider                   |
| R3  | Add Groq provider (fastest inference)                   | P1       | Low     | 400-800 tok/s, great free tier for dev                   |
| R4  | Add Fireworks AI provider (production SLAs)             | P1       | Low     | Production-grade open-source model serving               |
| R5  | Add DeepSeek direct API provider                        | P1       | Low     | Direct access to V3.2 and R1 at lowest cost              |
| R6  | Add Mistral AI provider (`@langchain/mistralai`)        | P2       | Medium  | First-party Mistral Large 3, Codestral access            |
| R7  | Extend `modelFamilySchema` for open-source families     | P0       | Minimal | Required for any new model family                        |
| R8  | Add initial model catalog entries for top models        | P0       | Low     | DeepSeek V3.2, GLM-5, Qwen 3.5, Llama 4, Mistral Large 3 |
| R9  | Add AWS Bedrock provider for enterprise users           | P3       | Medium  | Enterprise compliance path                               |
| R10 | Design models UI for user-managed providers/models      | P2       | High    | Enable self-hosting configuration                        |

### Recommended Initial Model Catalog

Top-priority models to add first, via cloud inference providers:

| Model            | Via Provider                | Rationale                                        |
| ---------------- | --------------------------- | ------------------------------------------------ |
| DeepSeek V3.2    | Together / DeepSeek API     | Best open-source coder, native tool-use thinking |
| GLM-5            | Together / OpenRouter       | #1 LMSYS coding Elo, MIT license                 |
| Qwen 3.5-397B    | Together / Fireworks        | Near-linear attention, 262K context, multimodal  |
| Llama 4 Maverick | Together / Groq / Fireworks | Meta ecosystem, massive community                |
| Mistral Large 3  | Mistral API / Together      | Apache 2.0, vision-native, cheap                 |
| DeepSeek R1      | Together / DeepSeek API     | Best open-source reasoning model                 |
| Qwen 3.5-27B     | Together / Groq             | Strong dense model, practical to self-host       |
| Llama 4 Scout    | Together / Groq             | 10M context, single-GPU deployable               |

### Cost Comparison

| Model              | Input ($/M tok) | Output ($/M tok) | vs GPT-5.4 Savings |
| ------------------ | --------------- | ---------------- | ------------------ |
| GPT-5.4 (baseline) | $2.50           | $15.00           | —                  |
| DeepSeek V3.2      | $0.14           | $0.28            | 94-98%             |
| GLM-5              | $0.71           | $3.57            | 72-76%             |
| Qwen 3.5-397B      | ~$0.50          | ~$2.00           | 80-87%             |
| Llama 4 Maverick   | ~$0.30          | ~$1.00           | 88-93%             |
| Mistral Large 3    | $0.50           | $1.50            | 80-90%             |

## Integration Architecture

### Adding an OpenAI-Compatible Provider

The existing SambaNova pattern provides the template. For a new provider like Together AI:

```typescript
// 1. Extend providerIdSchema
const providerIdSchema = z.enum([
  'openai', 'anthropic', 'sambanova', 'ollama',
  'vertexai', 'cerebras',
  'together', 'fireworks', 'groq', 'deepinfra', 'deepseek',
]);

// 2. Add to ProviderService.getProviders()
together: {
  provider: 'together',
  configuration: {
    apiKey: configService.get('TOGETHER_API_KEY', { infer: true }),
    baseURL: 'https://api.together.xyz/v1',
  },
  inputTokensIncludesCacheReadTokens: false,
  inputTokensIncludesCacheWriteTokens: false,
  streamingDoublesCacheTokens: false,
  createClass: (options) => new ChatOpenAI(options),
},

// 3. Add model entries to modelList
together: {
  'deepseek-v3.2': {
    id: 'together-deepseek-v3.2',
    name: 'DeepSeek V3.2',
    slug: 'deepseek-v3.2',
    model: 'deepseek-ai/DeepSeek-V3.2',
    // ...
  },
},
```

### For Dedicated LangChain Adapters

```typescript
// Mistral AI example
import { ChatMistralAI } from '@langchain/mistralai';

mistral: {
  provider: 'mistral',
  configuration: {
    apiKey: configService.get('MISTRAL_API_KEY', { infer: true }),
  },
  createClass: (options) => new ChatMistralAI(options),
},
```

## Diagrams

### Provider Architecture (Current vs Proposed)

```
Current:
┌─────────────┐
│ ModelService │
└──────┬──────┘
       │ buildModel()
       ▼
┌────────────────┐     ┌──────────────────────┐
│ProviderService │────▶│ Anthropic (3 models)  │
│                │────▶│ OpenAI   (3 models)   │
│                │────▶│ VertexAI (2 models)   │
│                │────▶│ Ollama   (dynamic)     │
│                │────▶│ SambaNova (0 models)   │
│                │────▶│ Cerebras  (0 models)   │
└────────────────┘     └──────────────────────┘

Proposed:
┌─────────────┐
│ ModelService │
└──────┬──────┘
       │ buildModel()
       ▼
┌────────────────┐     ┌──────────────────────────┐
│ProviderService │────▶│ Anthropic   (3 models)    │
│                │────▶│ OpenAI      (3 models)    │
│                │────▶│ VertexAI    (2 models)    │
│                │────▶│ Ollama      (dynamic)      │
│                │────▶│ Together AI (8+ models) ★  │
│                │────▶│ Groq        (4+ models) ★  │
│                │────▶│ Fireworks   (4+ models) ★  │
│                │────▶│ DeepSeek    (3+ models) ★  │
│                │────▶│ Mistral AI  (3+ models) ★  │
│                │────▶│ SambaNova   (3+ models) ★  │
│                │────▶│ Cerebras    (2+ models) ★  │
│                │────▶│ DeepInfra   (4+ models) ★  │
└────────────────┘     └──────────────────────────┘
                        ★ = new or newly populated
```

## References

- [LMSYS Chatbot Arena — Coding Leaderboard (March 2026)](https://arena.ai/leaderboard/code?license=open-source)
- [Awesome Agents — Open-Source LLM Leaderboard (Feb 2026)](https://awesomeagents.ai/leaderboards/open-source-llm-leaderboard/)
- [GLM-5 announcement (Neurohive)](https://neurohive.io/en/news/glm-5-top-1-open-weight-model-for-code-and-text-generation-competing-with-claude-and-gpt-on-agentic-tasks/)
- [DeepSeek V3.2 Tool-Use Guide](https://aize.dev/728/deepseek-v3-2-guide-mastering-its-new-tool-use-reasoning-engine/)
- [Qwen 3.5 GitHub](https://github.com/QwenLM/Qwen3.5)
- [Meta Llama 4 Blog](https://ai.meta.com/blog/llama-4-multimodal-intelligence)
- [Mistral Large 3 Docs](https://docs.mistral.ai/models/mistral-large-3-25-12)
- [LangChain JS — ChatTogetherAI](https://docs.langchain.com/oss/javascript/integrations/chat/togetherai)
- [LangChain JS — ChatGroq](https://docs.langchain.com/oss/javascript/integrations/chat/groq)
- [LangChain JS — ChatFireworks](https://docs.langchain.com/oss/javascript/integrations/chat/fireworks)
- [LangChain JS — @langchain/mistralai](https://www.npmjs.com/package/@langchain/mistralai)
- [LangChain JS — ChatBedrockConverse](https://docs.langchain.com/oss/javascript/integrations/chat/bedrock)

## Appendix

### Full Model Capability Matrix

| Model                  | Tool Calling     | Streaming | Thinking/CoT     | Vision              | Code      | Context | Self-Hostable               |
| ---------------------- | ---------------- | --------- | ---------------- | ------------------- | --------- | ------- | --------------------------- |
| DeepSeek V3.2          | Yes (native)     | Yes       | Yes (integrated) | No                  | Excellent | 128K    | Yes (8×H100)                |
| DeepSeek V3.2-Speciale | No               | Yes       | Yes (deep)       | No                  | Excellent | 128K    | Yes (8×H100)                |
| DeepSeek R1            | Limited          | Yes       | Yes (RL-trained) | No                  | Strong    | 128K    | Yes (distills: 1.5B–70B)    |
| GLM-5                  | Yes (parallel)   | Yes       | Yes (toggle)     | No                  | Excellent | 200K+   | Yes (8×H100/H200)           |
| Qwen 3.5-397B          | Yes              | Yes       | TBD              | Yes (native)        | Strong    | 262K–1M | Yes (multi-GPU)             |
| Qwen 3.5-27B           | Yes              | Yes       | TBD              | Yes (native)        | Strong    | 262K–1M | Yes (single GPU)            |
| Qwen 3.5-9B            | Yes              | Yes       | TBD              | Yes (native)        | Good      | 262K–1M | Yes (consumer)              |
| Llama 4 Maverick       | Yes              | Yes       | No               | Yes (native)        | Strong    | 1M+     | Yes (single H100)           |
| Llama 4 Scout          | Yes              | Yes       | No               | Yes (native)        | Good      | 10M     | Yes (single GPU, quantized) |
| Mistral Large 3        | Yes (parallel)   | Yes       | No               | Yes (native, 8 img) | Strong    | 256K    | Yes (multi-GPU)             |
| Codestral 25.08        | Yes              | Yes       | No               | No                  | Excellent | 256K    | Yes (single GPU)            |
| Phi-4-reasoning        | TBD              | Yes       | Yes (CoT)        | No                  | Good      | 16K     | Yes (consumer)              |
| Phi-4-reasoning-vision | TBD              | Yes       | Yes (CoT)        | Yes                 | Good      | 16K     | Yes (consumer)              |
| Gemma 3 27B            | Yes              | Yes       | No               | Yes                 | Good      | 128K    | Yes (single GPU)            |
| Command R+             | Yes (multi-step) | Yes       | No               | No                  | Moderate  | 128K    | Yes (multi-GPU)             |
| QwQ-32B                | Limited          | Yes       | Yes (deep)       | No                  | Good      | 32K     | Yes (single GPU)            |
| InternVL 3.5           | TBD              | Yes       | Yes              | Yes (state-of-art)  | Moderate  | —       | Yes (multi-GPU)             |
