# Dual Agent Code Studio

A small full-stack app for running a writer model and a critic model against the same coding task until the critic approves or the round limit is reached.

## What it does

- Uses one model as the writer and one as the critic.
- Optionally uses a third operator model to propose repo and terminal actions.
- Runs both agents through `ollama`.
- Maps the UI labels to valid Ollama cloud model tags.
- Shows the review transcript and final code in the UI.

## Run it

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and fill in anything you want to use:

```bash
cp .env.example .env
```

3. Start the app:

```bash
npm run dev
```

Client: [http://localhost:5173](http://localhost:5173)  
API: [http://localhost:8787/api/health](http://localhost:8787/api/health)

## Run it in the terminal

```bash
npm run terminal -- "Build a TypeScript CLI that parses a CSV file"
```

You can also pipe a prompt:

```bash
echo "Build a Node script that validates JSON files in a folder" | npm run terminal
```

The terminal runner uses environment variables for model setup:

```bash
WRITER_MODEL=gpt-oss:20b-cloud
WRITER_BASE_URL=http://127.0.0.1:11434

CRITIC_MODEL=gemini-3-flash-preview:cloud
CRITIC_BASE_URL=http://127.0.0.1:11434

ENABLE_OPERATOR=true
OPERATOR_MODEL=rnj-1:8b-cloud
OPERATOR_BASE_URL=http://127.0.0.1:11434
```

## Logging

The server writes structured JSON logs to stdout.

Default:

```bash
LOG_LEVEL=info
```

At `info`, the server logs:

- request start/result summaries
- session start/completion
- writer and critic round timing
- parse failures and request errors

At `debug`, it also logs redacted Ollama command previews and output previews.

Curated cloud model options (grouped by country of origin; US on top):

- **US**
  - `gpt-oss:20b-cloud` — OpenAI
  - `gpt-oss:120b-cloud` — OpenAI
- **China**
  - `deepseek-v3.1:671b-cloud` — DeepSeek
  - `qwen3-coder:480b-cloud` — Alibaba Qwen
  - `kimi-k2:1t-cloud` — Moonshot
  - `glm-4.6:cloud` — Zhipu AI

Anything Ollama reports on `GET /api/tags` also appears in the dropdown under `Local`.

## Suggested setup

- Writer: `gpt-oss:20b-cloud`
- Critic: `gpt-oss:120b-cloud` (default; picks up on failures the writer misses)
- Operator: a local model (keep it off-device and on the trust boundary)

## Privacy controls

The sidebar exposes two defensive toggles:

- **Anonymize outbound prompts** (default on) — paths, emails, git remotes, and common secret formats are replaced with stable tokens (`<PATH_1>`, `<REMOTE_1>`, …) before prompts leave the box, and rehydrated on the response. Env override: `ANONYMIZE_OUTBOUND=true|false`, plus `ANONYMIZE_PATTERNS=literal1,literal2` for extra strings.
- **Keep code on US models only** — disables non-US entries in the model dropdown; the server rejects sessions whose writer/critic would route to a non-US cloud.

Set `ENFORCE_LOCAL_OPERATOR=true` to reject any operator model whose tag contains `:cloud`.

## Abliteration (Heretic) for cloud models

Safety tuning in modern open-weight LLMs sometimes surfaces as refusals on benign coding topics. [Heretic](https://github.com/p-e-w/heretic) strips the refusal direction out of a model's activations and emits a new copy of the weights.

> **What abliteration does not do.** It does not remove inference-host telemetry or logging — those live outside the weights. For data-leakage concerns route to trusted hosts or stay local.

### Runbook

1. Install Heretic (requires a GPU):

   ```bash
   pip install heretic-llm
   ```

2. Run it against the model you want to abliterate (example with Qwen3 Coder):

   ```bash
   heretic ./qwen3-coder-480b
   ```

   This produces a new directory like `qwen3-coder-480b-abliterated/`.

3. Build an Ollama model from the abliterated weights (Modelfile-based import; see [Ollama docs](https://github.com/ollama/ollama/blob/main/docs/import.md)). You'll end up with a local tag like `qwen3-coder-abliterated:480b`.

4. Expose it to the app via env so the status bar badges the model:

   ```bash
   VITE_ABLITERATED_MODELS=qwen3-coder-abliterated:480b
   npm run dev
   ```

   (Comma-separated list.) Pick the tag from the **Local** group in the dropdown — it will show an `abliterated` badge in the status bar.

## Production build

```bash
npm run build
npm run start
```
