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

Available model options:

- `gpt-oss` -> `gpt-oss:20b-cloud` — OpenAI
- `gemma3` -> `gemma3:12b-cloud` — Google
- `gemma4` -> `gemma4:31b-cloud` — Google DeepMind / Google
- `gemini-3-flash-preview` -> `gemini-3-flash-preview:cloud` — Google
- `nemotron-3-nano` -> `nemotron-3-nano:30b-cloud` — NVIDIA
- `rnj-1` -> `rnj-1:8b-cloud` — Essential AI

## Suggested setup

- Writer: `gpt-oss` on `ollama`
- Critic: `gemini-3-flash-preview` on `ollama`
- Operator: `rnj-1` on `ollama` for repo and terminal follow-up actions

## Production build

```bash
npm run build
npm run start
```
