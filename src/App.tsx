import { FormEvent, useEffect, useMemo, useState } from "react";
import { ChatView } from "./ChatView";
import { FolderPicker } from "./FolderPicker";
import { streamSession } from "./sseSession";
import { WatchdogIndicator } from "./Watchdog";

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

type SessionFile = { path: string; content: string };

type SessionResponse = {
  transcript: TranscriptTurn[];
  finalCode: string;
  finalFiles?: SessionFile[];
  status: "approved" | "max_rounds" | "cancelled";
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

const SETTINGS_KEY = "psychic-train:settings:v1";

type PersistedSettings = {
  prompt: string;
  maxRounds: number;
  minRounds: number;
  writer: ProviderConfig;
  critic: ProviderConfig;
  operator: ProviderConfig;
  enableOperator: boolean;
  anonymize: boolean;
  usOnly: boolean;
  mode: "writer_critic" | "consensus";
};

const defaultProviderFor = (model: string): ProviderConfig => ({
  provider: "ollama",
  model,
  baseUrl: "http://127.0.0.1:11434",
  apiKey: ""
});

const defaultSettings = (): PersistedSettings => ({
  prompt: defaultPrompt,
  maxRounds: 0,
  minRounds: 1,
  writer: defaultProviderFor(defaultWriterModel),
  critic: defaultProviderFor(defaultCriticModel),
  operator: defaultProviderFor(defaultOperatorModel),
  enableOperator: true,
  anonymize: true,
  usOnly: false,
  mode: "writer_critic"
});

function loadSettings(): PersistedSettings {
  if (typeof window === "undefined") return defaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return { ...defaultSettings(), ...parsed };
  } catch {
    return defaultSettings();
  }
}

export function App() {
  const initialSettings = loadSettings();
  const [prompt, setPrompt] = useState(initialSettings.prompt);
  const [maxRounds, setMaxRounds] = useState(initialSettings.maxRounds);
  const [writer, setWriter] = useState<ProviderConfig>(initialSettings.writer);
  const [critic, setCritic] = useState<ProviderConfig>(initialSettings.critic);
  const [enableOperator, setEnableOperator] = useState(initialSettings.enableOperator);
  const [operator, setOperator] = useState<ProviderConfig>(initialSettings.operator);
  const [result, setResult] = useState<SessionResponse | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptTurn[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [serverCatalog, setServerCatalog] = useState<ModelInfo[] | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [userView, setUserView] = useState<AppView | null>(null);
  const [isWide, setIsWide] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1400px)").matches : true
  );
  const [anonymize, setAnonymize] = useState(initialSettings.anonymize);
  const [usOnly, setUsOnly] = useState(initialSettings.usOnly);
  const [mode, setMode] = useState<"writer_critic" | "consensus">(initialSettings.mode);
  const [minRounds, setMinRounds] = useState(initialSettings.minRounds);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("psychic-train:sidebar-collapsed") === "true";
  });
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("psychic-train:workspace") || "";
  });
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("psychic-train:sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      const payload: PersistedSettings = {
        prompt,
        maxRounds,
        minRounds,
        writer,
        critic,
        operator,
        enableOperator,
        anonymize,
        usOnly,
        mode
      };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
      } catch {
        // quota or disabled — drop silently
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [prompt, maxRounds, minRounds, writer, critic, operator, enableOperator, anonymize, usOnly, mode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (workspaceRoot) {
      window.localStorage.setItem("psychic-train:workspace", workspaceRoot);
    } else {
      window.localStorage.removeItem("psychic-train:workspace");
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 1400px)");
    const onChange = () => setIsWide(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const view: AppView = userView ?? (isWide ? "split" : "chat");
  const setView = (next: AppView) => setUserView(next);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { catalog?: ModelInfo[] };
        if (!cancelled && Array.isArray(payload.catalog)) {
          setServerCatalog(payload.catalog);
        }
      })
      .catch(() => {
        // Fall back to the bundled curated list.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    const catalog = serverCatalog && serverCatalog.length > 0 ? serverCatalog : curatedModels;
    for (const entry of catalog) {
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
      minRounds,
      anonymize,
      usOnly,
      mode,
      ...(workspaceRoot ? { workspaceRoot } : {}),
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
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-toggle-row">
          {!sidebarCollapsed ? (
            <div>
              <p className="eyebrow">Dual Agent Coding</p>
              <h1>Writer and critic in one loop.</h1>
            </div>
          ) : null}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>

        {sidebarCollapsed ? (
          <div className="sidebar-rail">
            <span className="model-badge" title={`Writer · ${writer.model}`}>W</span>
            <span className="model-badge" title={`Critic · ${critic.model}`}>C</span>
            {enableOperator ? (
              <span className="model-badge" title={`Operator · ${operator.model}`}>O</span>
            ) : null}
          </div>
        ) : (
          <form className="config-form" onSubmit={handleSubmit}>
            <p className="lede">
              Run both agents through Ollama using cloud-tagged models and stop when the
              critic approves or the round cap hits.
            </p>

            <label className="workspace-input">
              <span>Workspace</span>
              <div className="workspace-input-row">
                <input
                  type="text"
                  placeholder="/absolute/path (blank = server cwd)"
                  value={workspaceRoot}
                  onChange={(event) => setWorkspaceRoot(event.target.value)}
                />
                <button type="button" onClick={() => setWorkspacePickerOpen(true)}>Browse…</button>
              </div>
              <span className="provider-meta">
                Active: <code>{workspaceRoot || "(default: server cwd)"}</code>
              </span>
            </label>
            {workspacePickerOpen ? (
              <FolderPicker
                initialPath={workspaceRoot}
                onSelect={(path) => {
                  setWorkspaceRoot(path);
                  setWorkspacePickerOpen(false);
                }}
                onClose={() => setWorkspacePickerOpen(false)}
              />
            ) : null}

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
              Approval mode
              <select value={mode} onChange={(event) => setMode(event.target.value as "writer_critic" | "consensus")}>
                <option value="writer_critic">Writer + Critic (critic is the gate)</option>
                <option value="consensus" disabled={!enableOperator}>
                  Consensus (writer + critic + operator all must approve{!enableOperator ? " — requires operator" : ""})
                </option>
              </select>
            </label>

            <div className="round-range">
              <label>
                Min rounds per task
                <input
                  type="number"
                  min={1}
                  value={minRounds}
                  onChange={(event) => {
                    const next = Number(event.target.value) || 1;
                    setMinRounds(next);
                    if (mode !== "consensus" && maxRounds > 0 && next > maxRounds) setMaxRounds(next);
                  }}
                />
              </label>
              <label>
                Max rounds per task{" "}
                {mode === "consensus" ? (
                  <span className="provider-meta">(ignored in consensus)</span>
                ) : maxRounds === 0 ? (
                  <span className="provider-meta">(0 = unlimited)</span>
                ) : null}
                <input
                  type="number"
                  min={0}
                  value={maxRounds}
                  onChange={(event) => setMaxRounds(Math.max(0, Number(event.target.value) || 0))}
                  disabled={mode === "consensus"}
                />
              </label>
            </div>

            <label>
              Task <span className="provider-meta">(for the Session tab — operator drives the Chat tab)</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={6}
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
        )}
      </aside>

      <main className="workspace">
        <nav className="view-tabs" role="tablist">
          {(["session", "split", "chat"] as const)
            .filter((mode) => mode !== "split" || isWide)
            .map((mode) => (
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
          <div className="view-tabs-spacer" />
          <WatchdogIndicator />
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
            <h2>Final files</h2>
          </div>
          <FinalFilesView
            files={result?.finalFiles}
            fallbackCode={result?.finalCode || latestCodeFrom(liveTranscript)}
          />
        </section>

        {enableOperator ? (
          <section className="panel">
            <div className="panel-header">
              <h2>Operator plan</h2>
            </div>
            {result?.operatorPlan ? (
              <div className="operator-list">
                <p>{result.operatorPlan.summary}</p>
                {result.operatorPlan.actions.map((action, index) => (
                  <OperatorActionCard
                    key={`${action.kind}-${index}`}
                    action={action}
                    workspaceRoot={workspaceRoot}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <p>Run a session to get repo and terminal follow-up actions.</p>
              </div>
            )}
          </section>
        ) : null}
        </div>
        ) : null}
        {view !== "session" ? (
          <div className="pane chat-pane">
            <ChatView
            operator={operator}
            writer={writer}
            critic={critic}
            workspaceRoot={workspaceRoot}
            onWorkspaceChange={setWorkspaceRoot}
            minRounds={minRounds}
            maxRounds={maxRounds}
            mode={mode}
            anonymize={anonymize}
            usOnly={usOnly}
            onDelegateStart={() => {
              setLiveTranscript([]);
              setResult(null);
              setError("");
              setActiveAgent("writer · round 1");
            }}
            onDelegateTurn={(turn) => {
              setLiveTranscript((prior) => [...prior, turn]);
              setActiveAgent(`${turn.role} · round ${turn.round}`);
            }}
          />
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

function OperatorActionCard({
  action,
  workspaceRoot
}: {
  action: OperatorAction;
  workspaceRoot: string;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "running" } | { kind: "done"; ok: boolean; summary: string; detail?: string }
  >({ kind: "idle" });
  const toolCall = operatorActionToTool(action);
  const disabled = !workspaceRoot || toolCall === null || state.kind === "running";

  async function handleRun() {
    if (!toolCall) return;
    if (operatorActionIsDestructive(action) && !window.confirm(`Run this action?\n\n${action.title}\n${action.command ?? ""}`)) return;
    setState({ kind: "running" });
    try {
      const response = await fetch("/api/tool/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCall, workspaceRoot })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
      const ok = Boolean((payload as { ok?: boolean }).ok);
      const summary = String((payload as { summary?: string }).summary || "");
      const detail = typeof (payload as { detail?: string }).detail === "string"
        ? (payload as { detail?: string }).detail
        : undefined;
      setState({ kind: "done", ok, summary, detail });
    } catch (error) {
      setState({
        kind: "done",
        ok: false,
        summary: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return (
    <article className="turn operator operator-action">
      <div className="turn-meta">
        <span>{action.kind}</span>
        <span>{action.title}</span>
      </div>
      <p>{action.detail}</p>
      {action.command ? <pre>{action.command}</pre> : null}
      <div className="operator-action-row">
        <button
          type="button"
          onClick={handleRun}
          disabled={disabled}
          title={
            !workspaceRoot
              ? "Set a workspace in the sidebar first"
              : toolCall === null
                ? "This action type can't be executed automatically"
                : ""
          }
        >
          {state.kind === "running" ? "Running..." : "Run"}
        </button>
        {toolCall === null ? (
          <span className="provider-meta">No runnable tool for this action kind.</span>
        ) : null}
      </div>
      {state.kind === "done" ? (
        <article className={`chat-tool-result ${state.ok ? "ok" : "err"}`}>
          <header>{state.ok ? "tool result · ok" : "tool result · error"}</header>
          <p>{state.summary}</p>
          {state.detail ? <pre>{state.detail}</pre> : null}
        </article>
      ) : null}
    </article>
  );
}

type ToolCallPayload =
  | { type: "run_git"; args: string[] }
  | { type: "run_shell"; command: string; args: string[] }
  | { type: "run_tests" }
  | { type: "write_file"; path: string; content: string };

function operatorActionToTool(action: OperatorAction): ToolCallPayload | null {
  if (action.kind === "git") {
    const argv = tokenizeCommand(action.command);
    const args = argv[0] === "git" ? argv.slice(1) : argv;
    if (args.length === 0) return null;
    return { type: "run_git", args };
  }
  if (action.kind === "shell") {
    const argv = tokenizeCommand(action.command);
    if (argv.length === 0) return null;
    return { type: "run_shell", command: argv[0] as string, args: argv.slice(1) };
  }
  if (action.kind === "test") {
    return { type: "run_tests" };
  }
  return null;
}

function operatorActionIsDestructive(action: OperatorAction): boolean {
  const cmd = (action.command || "").toLowerCase();
  if (action.kind === "git") return /\b(push|reset|rebase|clean|checkout)\b/.test(cmd);
  if (action.kind === "shell") return /\brm\s+-r|rm\s+-f|sudo\b/.test(cmd);
  return false;
}

function tokenizeCommand(input?: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === " " || ch === "\t") {
      if (current) { out.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function FinalFilesView({
  files,
  fallbackCode
}: {
  files?: SessionFile[];
  fallbackCode?: string;
}) {
  const list = files && files.length > 0
    ? files
    : fallbackCode
      ? [{ path: "(writer output)", content: fallbackCode }]
      : [];
  const [selected, setSelected] = useState<string | null>(null);
  const active = list.find((f) => f.path === selected) || list[0];

  if (list.length === 0) {
    return <pre>{"// Final files will appear here"}</pre>;
  }

  return (
    <div className="final-files">
      <ul className="final-files-list">
        {list.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={active?.path === file.path ? "active" : ""}
              onClick={() => setSelected(file.path)}
            >
              {file.path}
            </button>
          </li>
        ))}
      </ul>
      <pre className="final-files-pane">{active?.content ?? ""}</pre>
    </div>
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
