import { FormEvent, useMemo, useState } from "react";

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

type ModelOption = {
  value: string;
  label: string;
  maker: string;
  runtimeModel: string;
};

const modelOptions: ModelOption[] = [
  { value: "gpt-oss", label: "gpt-oss", maker: "OpenAI", runtimeModel: "gpt-oss:20b-cloud" },
  { value: "gemma3", label: "gemma3", maker: "Google", runtimeModel: "gemma3:12b-cloud" },
  { value: "gemma4", label: "gemma4", maker: "Google DeepMind / Google", runtimeModel: "gemma4:31b-cloud" },
  { value: "gemini-3-flash-preview", label: "gemini-3-flash-preview", maker: "Google", runtimeModel: "gemini-3-flash-preview:cloud" },
  { value: "nemotron-3-nano", label: "nemotron-3-nano", maker: "NVIDIA", runtimeModel: "nemotron-3-nano:30b-cloud" },
  { value: "rnj-1", label: "rnj-1", maker: "Essential AI", runtimeModel: "rnj-1:8b-cloud" }
];

const defaultPrompt = `Build a small TypeScript CLI that reads a markdown task list and outputs completed items in JSON.`;

export function App() {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [maxRounds, setMaxRounds] = useState(4);
  const [writer, setWriter] = useState<ProviderConfig>({
    provider: "ollama",
    model: "gpt-oss",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [critic, setCritic] = useState<ProviderConfig>({
    provider: "ollama",
    model: "gemini-3-flash-preview",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [enableOperator, setEnableOperator] = useState(true);
  const [operator, setOperator] = useState<ProviderConfig>({
    provider: "ollama",
    model: "rnj-1",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: ""
  });
  const [result, setResult] = useState<SessionResponse | null>(null);
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);

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
            <ProviderEditor title="Writer" value={writer} onChange={setWriter} />
            <ProviderEditor title="Critic" value={critic} onChange={setCritic} />
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
                <ProviderEditor title="Operator model" value={operator} onChange={setOperator} />
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
              {getRuntimeModel(writer.model)}
              {" -> "}
              {getRuntimeModel(critic.model)}
              {enableOperator ? ` -> ${getRuntimeModel(operator.model)}` : ""}
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
  onChange
}: {
  title: string;
  value: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
}) {
  const selectedModel = modelOptions.find((option) => option.value === value.model);

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
        <select
          value={value.model}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
        >
          {modelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} - {option.maker}
            </option>
          ))}
        </select>
      </label>

      <p className="provider-meta">
        Maker: {selectedModel?.maker || "Unknown"}.
        {" "}
        Invoked as <code>{`ollama run ${selectedModel?.runtimeModel || value.model}`}</code>.
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
  const runtimeModel = getRuntimeModel(provider.model);

  return {
    provider: provider.provider,
    model: runtimeModel,
    ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {})
  };
}

function getRuntimeModel(label: string) {
  return modelOptions.find((option) => option.value === label)?.runtimeModel || label.trim();
}
