import { FormEvent, useEffect, useMemo, useState } from "react";

type ProviderKind = "ollama";

type ProviderConfig = {
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
};

type TranscriptTurn = {
  role: "writer" | "critic" | "operator" | "system";
  round: number;
  summary: string;
  code?: string;
  verdict?: "revise" | "approved";
};

type OperatorAction = {
  kind: "git" | "shell" | "test" | "file";
  title: string;
  detail: string;
  command?: string;
};

type SessionResponse = {
  transcript: TranscriptTurn[];
  finalCode: string;
  status: "approved" | "max_rounds";
  operatorPlan?: {
    summary: string;
    actions: OperatorAction[];
  };
};

const curatedCloudModels = [
  "gpt-oss:20b-cloud",
  "gpt-oss:120b-cloud",
  "deepseek-v3.1:671b-cloud",
  "qwen3-coder:480b-cloud",
  "kimi-k2:1t-cloud",
  "glm-4.6:cloud"
];

const defaultWriterModel = "gpt-oss:20b-cloud";
const defaultCriticModel = "qwen3-coder:480b-cloud";
const defaultOperatorModel = "gpt-oss:20b-cloud";

const defaultPrompt = `Build a small TypeScript CLI that reads a markdown task list and outputs completed items in JSON.`;

export function App() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [maxRounds, setMaxRounds] = useState(4);
  const [writer, setWriter] = useState<ProviderConfig>({
    provider: "ollama",
    model: defaultWriterModel,
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [critic, setCritic] = useState<ProviderConfig>({
    provider: "ollama",
    model: defaultCriticModel,
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [enableOperator, setEnableOperator] = useState(true);
  const [operator, setOperator] = useState<ProviderConfig>({
    provider: "ollama",
    model: defaultOperatorModel,
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [result, setResult] = useState<SessionResponse | null>(null);
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then(async (response) => {
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { models?: string[] };
        if (!cancelled && Array.isArray(data.models)) {
          setLocalModels(data.models);
        }
      })
      .catch(() => {
        // Daemon unreachable — silent fallback to curated list.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const availableModels = useMemo(() => {
    return Array.from(new Set([...curatedCloudModels, ...localModels])).sort();
  }, [localModels]);

  const statusLabel = useMemo(() => {
    if (!result) {
      return "Idle";
    }
    return result.status === "approved" ? "Approved" : "Needs more rounds";
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsRunning(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt,
          maxRounds,
          writer: normalizeProvider(writer),
          critic: normalizeProvider(critic),
          ...(enableOperator ? { operator: normalizeProvider(operator) } : {})
        })
      });

      const data = (await response.json()) as SessionResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in data ? data.error || "Request failed" : "Request failed");
      }

      setResult(data as SessionResponse);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unknown error");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Dual Agent Coding</p>
          <h1>Writer and critic in one loop.</h1>
          <p className="lede">
            Run both agents through Ollama using cloud-tagged models and stop when the
            critic approves or the round cap hits.
          </p>
        </div>

        <form className="config-form" onSubmit={handleSubmit}>
          <label>
            Task
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={8}
            />
          </label>

          <div className="stack">
            <ProviderEditor title="Writer" value={writer} onChange={setWriter} models={availableModels} />
            <ProviderEditor title="Critic" value={critic} onChange={setCritic} models={availableModels} />
            <section className="provider-block">
              <div className="provider-header">
                <h2>Operator</h2>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={enableOperator}
                  onChange={(event) => setEnableOperator(event.target.checked)}
                />
                <span>Enable third model for repo and terminal actions</span>
              </label>
              {enableOperator ? (
                <ProviderEditor title="Operator model" value={operator} onChange={setOperator} models={availableModels} />
              ) : (
                <p className="provider-meta">Disabled. The run stops after writer and critic.</p>
              )}
            </section>
          </div>

          <label>
            Max rounds
            <input
              type="number"
              min={1}
              max={8}
              value={maxRounds}
              onChange={(event) => setMaxRounds(Number(event.target.value))}
            />
          </label>

          <button type="submit" disabled={isRunning}>
            {isRunning ? "Running..." : "Run Session"}
          </button>
        </form>
      </aside>

      <main className="workspace">
        <section className="status-bar">
          <div>
            <span className="muted">Session status</span>
            <strong>{statusLabel}</strong>
          </div>
          <div>
            <span className="muted">Models</span>
            <strong>
              {writer.model}
              {" -> "}
              {critic.model}
              {enableOperator ? ` -> ${operator.model}` : ""}
            </strong>
          </div>
        </section>

        {error ? <p className="error">{error}</p> : null}

        <section className="panel">
          <div className="panel-header">
            <h2>Transcript</h2>
          </div>
          <div className="transcript">
            {result ? (
              result.transcript.map((turn, index) => (
                <article key={`${turn.role}-${turn.round}-${index}`} className={`turn ${turn.role}`}>
                  <div className="turn-meta">
                    <span>{turn.role}</span>
                    <span>Round {turn.round}</span>
                    {turn.verdict ? <span>{turn.verdict}</span> : null}
                  </div>
                  <p>{turn.summary}</p>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <p>Run a session to see the writer draft code and the critic respond.</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel code-panel">
          <div className="panel-header">
            <h2>Final code</h2>
          </div>
          <pre>{result?.finalCode || "// Final code will appear here"}</pre>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Operator plan</h2>
          </div>
          {result?.operatorPlan ? (
            <div className="operator-list">
              <p>{result.operatorPlan.summary}</p>
              {result.operatorPlan.actions.map((action, index) => (
                <article key={`${action.kind}-${index}`} className="turn operator">
                  <div className="turn-meta">
                    <span>{action.kind}</span>
                    <span>{action.title}</span>
                  </div>
                  <p>{action.detail}</p>
                  {action.command ? <pre>{action.command}</pre> : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p>Enable the operator to get repo and terminal follow-up actions.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function ProviderEditor({
  title,
  value,
  onChange,
  models
}: {
  title: string;
  value: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
  models: string[];
}) {
  const datalistId = `models-${title.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <section className="provider-block">
      <div className="provider-header">
        <h2>{title}</h2>
      </div>

      <label>
        Runtime
        <input type="text" value="ollama" readOnly />
      </label>

      <label>
        Model
        <input
          type="text"
          list={datalistId}
          value={value.model}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
          placeholder="e.g. gpt-oss:20b-cloud"
        />
        <datalist id={datalistId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>

      <p className="provider-meta">
        Invoked as <code>{`ollama run ${value.model || "<model>"}`}</code>.
      </p>

      <label>
        Base URL
        <input
          type="text"
          value={value.baseUrl}
          onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
          placeholder="http://127.0.0.1:11434"
        />
      </label>

      <label>
        API key
        <input
          type="password"
          value={value.apiKey}
          onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
          placeholder="Optional if your Ollama setup needs it"
        />
      </label>
    </section>
  );
}

function normalizeProvider(provider: ProviderConfig) {
  return {
    provider: provider.provider,
    model: provider.model.trim(),
    ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {})
  };
}
