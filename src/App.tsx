import { FormEvent, useEffect, useMemo, useState } from "react";
import { ChatView } from "./ChatView";
import { streamSession } from "./sseSession";

type AppView = "session" | "split" | "chat";

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

type ModelInfo = { tag: string; country: string; maker: string; abliterated?: boolean };

const curatedModels: ModelInfo[] = [
  { tag: "gpt-oss:20b-cloud", country: "US", maker: "OpenAI" },
  { tag: "gpt-oss:120b-cloud", country: "US", maker: "OpenAI" },
  { tag: "deepseek-v3.1:671b-cloud", country: "China", maker: "DeepSeek" },
  { tag: "qwen3-coder:480b-cloud", country: "China", maker: "Alibaba Qwen" },
  { tag: "kimi-k2:1t-cloud", country: "China", maker: "Moonshot" },
  { tag: "glm-4.6:cloud", country: "China", maker: "Zhipu AI" }
];

const ABLITERATED_ENV_TAGS: string[] = (() => {
  try {
    const raw = (import.meta as { env?: Record<string, string> }).env?.VITE_ABLITERATED_MODELS;
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
})();

function isAbliterated(tag: string, info?: ModelInfo): boolean {
  if (info?.abliterated) return true;
  return ABLITERATED_ENV_TAGS.includes(tag);
}

const COUNTRY_ORDER: Record<string, number> = {
  US: 0,
  China: 1,
  France: 2,
  UK: 3,
  Canada: 4,
  Germany: 5,
  Israel: 6,
  Local: 99
};

function countryRank(country: string): number {
  return COUNTRY_ORDER[country] ?? 50;
}

const defaultWriterModel = "gpt-oss:20b-cloud";
const defaultCriticModel = "gpt-oss:120b-cloud";
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
  const [liveTranscript, setLiveTranscript] = useState<TranscriptTurn[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [view, setView] = useState<AppView>("session");
  const [anonymize, setAnonymize] = useState(true);
  const [usOnly, setUsOnly] = useState(false);

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

  const groupedModels = useMemo(() => {
    const seen = new Map<string, ModelInfo>();
    for (const entry of curatedModels) {
      seen.set(entry.tag, entry);
    }
    for (const tag of localModels) {
      if (!seen.has(tag)) {
        seen.set(tag, { tag, country: "Local", maker: "ollama" });
      }
    }
    const groups = new Map<string, ModelInfo[]>();
    for (const info of seen.values()) {
      const list = groups.get(info.country) || [];
      list.push(info);
      groups.set(info.country, list);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        const rank = countryRank(a) - countryRank(b);
        return rank !== 0 ? rank : a.localeCompare(b);
      })
      .map(([country, entries]) => ({
        country,
        entries: entries.sort((x, y) => x.tag.localeCompare(y.tag))
      }));
  }, [localModels]);

  const statusLabel = useMemo(() => {
    if (!result) {
      return "Idle";
    }
    if (result.status === "approved") return "Approved";
    if (result.status === "cancelled") return "Cancelled";
    return "Needs more rounds";
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsRunning(true);
    setError("");
    setResult(null);
    setLiveTranscript([]);
    setActiveAgent(null);

    const controller = new AbortController();
    setAbortController(controller);

    const body = {
      prompt,
      maxRounds,
      anonymize,
      usOnly,
      writer: normalizeProvider(writer),
      critic: normalizeProvider(critic),
      ...(enableOperator ? { operator: normalizeProvider(operator) } : {})
    };

    let streamError: string | null = null;

    try {
      await streamSession(
        body,
        (event, data) => {
          if (event === "turn") {
            setLiveTranscript((prior) => [...prior, data as TranscriptTurn]);
            return;
          }
          if (event === "round_start") {
            const details = data as { agent: string; round: number };
            setActiveAgent(`${details.agent} · round ${details.round}`);
            return;
          }
          if (event === "round_complete") {
            setActiveAgent(null);
            return;
          }
          if (event === "done") {
            setResult(data as SessionResponse);
            setActiveAgent(null);
            return;
          }
          if (event === "cancelled") {
            streamError = "Session cancelled.";
            setActiveAgent(null);
            return;
          }
          if (event === "error") {
            const payload = data as { message?: string };
            streamError = payload.message || "Session failed";
            setActiveAgent(null);
          }
        },
        controller.signal
      );

      if (streamError) {
        setError(streamError);
      }
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === "AbortError") {
        setError("Session cancelled.");
      } else {
        setError(requestError instanceof Error ? requestError.message : "Unknown error");
      }
    } finally {
      setIsRunning(false);
      setActiveAgent(null);
      setAbortController(null);
    }
  }

  function handleStop() {
    abortController?.abort();
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
            <ProviderEditor title="Writer" value={writer} onChange={setWriter} groups={groupedModels} usOnly={usOnly} />
            <ProviderEditor title="Critic" value={critic} onChange={setCritic} groups={groupedModels} usOnly={usOnly} />
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
                <ProviderEditor title="Operator model" value={operator} onChange={setOperator} groups={groupedModels} usOnly={false} />
              ) : (
                <p className="provider-meta">Disabled. The run stops after writer and critic.</p>
              )}
            </section>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={anonymize}
              onChange={(event) => setAnonymize(event.target.checked)}
            />
            <span>Anonymize paths, emails, git remotes, and secrets in outbound prompts</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={usOnly}
              onChange={(event) => setUsOnly(event.target.checked)}
            />
            <span>Keep code on US models only (disables non-US writer/critic)</span>
          </label>

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

          <div className="button-row">
            <button type="submit" disabled={isRunning}>
              {isRunning ? "Running..." : "Run Session"}
            </button>
            {isRunning ? (
              <button type="button" className="stop-button" onClick={handleStop}>
                Stop
              </button>
            ) : null}
          </div>
        </form>
      </aside>

      <main className="workspace">
        <nav className="view-tabs" role="tablist">
          {(["session", "split", "chat"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={view === mode}
              className={view === mode ? "active" : ""}
              onClick={() => setView(mode)}
            >
              {mode === "session" ? "Session" : mode === "chat" ? "Chat" : "Split"}
            </button>
          ))}
        </nav>

        <div className={`workspace-body view-${view}`}>
        {view !== "chat" ? (
        <div className="pane session-pane">
        <section className="status-bar">
          <div>
            <span className="muted">Session status</span>
            <strong>{isRunning ? activeAgent || "Running..." : statusLabel}</strong>
          </div>
          <div>
            <span className="muted">Models</span>
            <div className="model-badges">
              <ModelBadge label="Writer" tag={writer.model} groups={groupedModels} />
              <ModelBadge label="Critic" tag={critic.model} groups={groupedModels} />
              {enableOperator ? (
                <ModelBadge label="Operator" tag={operator.model} groups={groupedModels} />
              ) : null}
            </div>
          </div>
        </section>

        {error ? <p className="error">{error}</p> : null}

        <section className="panel">
          <div className="panel-header">
            <h2>Transcript</h2>
          </div>
          <div className="transcript">
            {(() => {
              const turns = result?.transcript || liveTranscript;
              if (turns.length === 0) {
                return (
                  <div className="empty-state">
                    <p>Run a session to see the writer draft code and the critic respond.</p>
                  </div>
                );
              }
              return turns.map((turn, index) => (
                <article key={`${turn.role}-${turn.round}-${index}`} className={`turn ${turn.role}`}>
                  <div className="turn-meta">
                    <span>{turn.role}</span>
                    <span>Round {turn.round}</span>
                    {turn.verdict ? <span>{turn.verdict}</span> : null}
                  </div>
                  <p>{turn.summary}</p>
                  {turn.role === "writer" && turn.code ? (
                    <details className="turn-code-toggle">
                      <summary />
                      <pre>{turn.code}</pre>
                    </details>
                  ) : null}
                </article>
              ));
            })()}
          </div>
        </section>

        <section className="panel code-panel">
          <div className="panel-header">
            <h2>Final code</h2>
          </div>
          <pre>{result?.finalCode || latestCodeFrom(liveTranscript) || "// Final code will appear here"}</pre>
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
        </div>
        ) : null}
        {view !== "session" ? (
          <div className="pane chat-pane">
            <ChatView operator={operator} writer={writer} critic={critic} />
          </div>
        ) : null}
        </div>
      </main>
    </div>
  );
}

function ProviderEditor({
  title,
  value,
  onChange,
  groups,
  usOnly
}: {
  title: string;
  value: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
  groups: Array<{ country: string; entries: ModelInfo[] }>;
  usOnly: boolean;
}) {
  const selected = groups
    .flatMap((group) => group.entries)
    .find((entry) => entry.tag === value.model);

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
          {groups.length === 0 ? <option value="">No models available</option> : null}
          {groups.map((group) => {
            const groupDisabled = usOnly && group.country !== "US" && group.country !== "Local";
            return (
              <optgroup key={group.country} label={groupDisabled ? `${group.country} (disabled)` : group.country}>
                {group.entries.map((entry) => {
                  const abliterated = isAbliterated(entry.tag, entry);
                  const suffix = abliterated ? " · abliterated" : "";
                  return (
                    <option key={entry.tag} value={entry.tag} disabled={groupDisabled}>
                      {entry.tag} — {entry.country} · {entry.maker}{suffix}
                    </option>
                  );
                })}
              </optgroup>
            );
          })}
        </select>
      </label>

      <p className="provider-meta">
        {selected ? `${selected.country} · ${selected.maker}. ` : ""}
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

function ModelBadge({
  label,
  tag,
  groups
}: {
  label: string;
  tag: string;
  groups: Array<{ country: string; entries: ModelInfo[] }>;
}) {
  const info = groups.flatMap((g) => g.entries).find((entry) => entry.tag === tag);
  const country = info?.country || (tag.includes(":cloud") ? "Unknown" : "Local");
  const nonUs = country !== "US" && country !== "Local" && country !== "Unknown";
  const abliterated = isAbliterated(tag, info);
  return (
    <span className={`model-badge ${nonUs ? "non-us" : ""}`}>
      <span className="model-badge-label">{label}</span>
      <span className="model-badge-country">{country}</span>
      <code>{tag}</code>
      {abliterated ? <span className="model-badge-abliterated" title="Refusal direction orthogonalized">abliterated</span> : null}
    </span>
  );
}

function latestCodeFrom(transcript: TranscriptTurn[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const turn = transcript[index];
    if (turn && turn.role === "writer" && turn.code) {
      return turn.code;
    }
  }
  return "";
}

function normalizeProvider(provider: ProviderConfig) {
  return {
    provider: provider.provider,
    model: provider.model.trim(),
    ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {})
  };
}
