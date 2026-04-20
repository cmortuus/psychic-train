import { FormEvent, useEffect, useRef, useState } from "react";
import { FolderPicker } from "./FolderPicker";
import { streamAutopilot } from "./sseAutopilot";
import { streamChat } from "./sseChat";

type ProviderConfig = {
  provider: "ollama";
  model: string;
  baseUrl: string;
  apiKey: string;
  fallbacks?: string[];
};

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "system"; content: string }
  | { role: "assistant"; content: string; toolCall?: ToolCall }
  | { role: "tool"; content: string; ok: boolean };

type ToolCall =
  | { type: "message"; content: string }
  | { type: "delegate_coding_task"; task: string; maxRounds?: number }
  | { type: "set_workspace"; path: string }
  | { type: "clone_repo"; repoUrl: string; destination: string; setAsWorkspace?: boolean }
  | { type: "run_git"; args: string[] }
  | { type: "read_file"; path: string }
  | { type: "write_file"; path: string; content: string }
  | { type: "list_dir"; path: string };

type TimelineEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "tool_result"; ok: boolean; summary: string; detail?: string }
  | { kind: "workspace"; root: string }
  | { kind: "delegate"; event: string; summary: string }
  | { kind: "autopilot"; event: string; summary: string };

type DelegateTurn = {
  role: "writer" | "critic" | "operator" | "system";
  round: number;
  summary: string;
  code?: string;
  verdict?: "revise" | "approved";
};

type Props = {
  operator: ProviderConfig;
  writer: ProviderConfig;
  critic: ProviderConfig;
  workspaceRoot: string;
  onWorkspaceChange: (next: string) => void;
  onDelegateTurn?: (turn: DelegateTurn) => void;
  onDelegateStart?: () => void;
  minRounds: number;
  maxRounds: number;
  mode: "writer_critic" | "consensus";
  anonymize: boolean;
  usOnly: boolean;
  fallbackPool: string[];
};

const STORAGE_KEY = "psychic-train:chat:v1";

type PersistedChat = {
  messages: ChatMessage[];
  timeline: TimelineEntry[];
};

function loadPersisted(): PersistedChat | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedChat;
    if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.timeline)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function ChatView({
  operator,
  writer,
  critic,
  workspaceRoot,
  onWorkspaceChange,
  onDelegateTurn,
  onDelegateStart,
  minRounds,
  maxRounds,
  mode,
  anonymize,
  usOnly,
  fallbackPool
}: Props) {
  const initialRef = useRef<PersistedChat | null | undefined>(undefined);
  if (initialRef.current === undefined) {
    initialRef.current = loadPersisted();
  }
  const initial = initialRef.current;
  const [messages, setMessages] = useState<ChatMessage[]>(initial?.messages || []);
  const setWorkspaceRoot = onWorkspaceChange;
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>(initial?.timeline || []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef<boolean>(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      const payload: PersistedChat = { messages, timeline };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // quota or disabled storage — drop silently
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [messages, timeline]);

  function handleClear() {
    setMessages([]);
    setTimeline([]);
    setError(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance <= 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [timeline.length, isRunning]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;

    const nextUserMsg: ChatMessage = { role: "user", content: trimmed };
    const nextMessages = [...messages, nextUserMsg];
    setMessages(nextMessages);
    setTimeline((prior) => [...prior, { kind: "user", text: trimmed }]);
    setInput("");
    setError(null);
    setIsRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        {
          messages: nextMessages,
          workspaceRoot,
          operator: normalize(operator, fallbackPool),
          writer: normalize(writer, fallbackPool),
          critic: normalize(critic, fallbackPool)
        },
        (event, data) => {
          if (event === "assistant_message") {
            const content = (data as { content: string }).content;
            setTimeline((prior) => [...prior, { kind: "assistant", text: content }]);
            return;
          }
          if (event === "tool_call") {
            const call = data as ToolCall;
            if (call.type === "delegate_coding_task") {
              onDelegateStart?.();
              setTimeline((prior) => [
                ...prior,
                { kind: "delegate", event: "delegated", summary: call.task }
              ]);
              return;
            }
            setTimeline((prior) => [...prior, { kind: "tool_call", call }]);
            return;
          }
          if (event === "tool_result") {
            const r = data as { ok: boolean; summary: string; detail?: string };
            setTimeline((prior) => [...prior, { kind: "tool_result", ...r }]);
            return;
          }
          if (event === "workspace_changed") {
            const root = (data as { root: string }).root;
            setWorkspaceRoot(root);
            setTimeline((prior) => [...prior, { kind: "workspace", root }]);
            return;
          }
          if (event === "delegate_turn") {
            onDelegateTurn?.(data as DelegateTurn);
            return;
          }
          if (event === "done") {
            const payload = data as { messages: ChatMessage[]; workspaceRoot: string };
            setMessages(payload.messages);
            if (payload.workspaceRoot) setWorkspaceRoot(payload.workspaceRoot);
            return;
          }
          if (event === "cancelled") {
            setError("Cancelled.");
            return;
          }
          if (event === "error") {
            const message = (data as { message?: string }).message || "Chat failed";
            setError(message);
          }
        },
        controller.signal
      );
    } catch (streamError) {
      if (streamError instanceof Error && streamError.name === "AbortError") {
        setError("Cancelled.");
      } else {
        setError(streamError instanceof Error ? streamError.message : "Unknown error");
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleAutopilot() {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    if (!workspaceRoot) {
      setError("Autopilot needs a workspace — use the “Open folder…” button above.");
      return;
    }
    setInput("");
    setError(null);
    setIsRunning(true);
    setTimeline((prior) => [...prior, { kind: "user", text: `⚡ Autopilot: ${trimmed}` }]);
    onDelegateStart?.();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAutopilot(
        {
          prompt: trimmed,
          workspaceRoot,
          writer: normalize(writer, fallbackPool),
          critic: normalize(critic, fallbackPool),
          minRounds,
          maxRounds,
          mode,
          anonymize,
          usOnly,
          ...(operator.model ? { operator: normalize(operator, fallbackPool) } : {})
        },
        (event, data) => {
          if (event === "iteration_start") {
            const { iteration } = data as { iteration: number };
            setTimeline((prior) => [...prior, { kind: "autopilot", event: `iteration ${iteration}`, summary: `Starting iteration ${iteration}` }]);
            return;
          }
          if (event === "session_turn") {
            onDelegateTurn?.(data as DelegateTurn);
            return;
          }
          if (event === "test_result") {
            const r = data as { passed: boolean; summary: string };
            setTimeline((prior) => [
              ...prior,
              { kind: "tool_result", ok: r.passed, summary: r.summary, detail: (data as { rawOutput?: string }).rawOutput }
            ]);
            return;
          }
          if (event === "commit") {
            const c = data as { message: string; output: string };
            setTimeline((prior) => [...prior, { kind: "autopilot", event: "commit", summary: c.message }]);
            return;
          }
          if (event === "note") {
            const n = data as { message: string };
            setTimeline((prior) => [...prior, { kind: "autopilot", event: "note", summary: n.message }]);
            return;
          }
          if (event === "done") {
            const r = data as { status: string; iterations: number; committed?: boolean };
            setTimeline((prior) => [
              ...prior,
              {
                kind: "autopilot",
                event: `done · ${r.status}`,
                summary: `Autopilot finished after ${r.iterations} iteration(s)${r.committed ? " · committed" : ""}.`
              }
            ]);
            return;
          }
          if (event === "error") {
            const payload = data as { message?: string };
            setError(payload.message || "Autopilot failed");
          }
          if (event === "cancelled") {
            setError("Autopilot cancelled.");
          }
        },
        controller.signal
      );
    } catch (autoError) {
      if (autoError instanceof Error && autoError.name === "AbortError") {
        setError("Autopilot cancelled.");
      } else {
        setError(autoError instanceof Error ? autoError.message : "Unknown error");
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="chat-view">
      <header className="chat-header">
        <div>
          <p className="eyebrow">Operator chat</p>
          <h2>Talk to the operator</h2>
          <p className="lede">
            The operator coordinates writer/critic, reads/writes files in the workspace, runs
            allowlisted git commands, and can switch workspaces or clone repos on the fly.
          </p>
        </div>
        <div className="chat-header-actions">
          <p className="provider-meta">
            Workspace: <code>{workspaceRoot || "(default: server cwd)"}</code>{" "}
            <button
              type="button"
              className="chat-folder-pick"
              onClick={() => setPickerOpen(true)}
              disabled={isRunning}
              title="Open a folder on this machine"
            >
              {workspaceRoot ? "Change…" : "Open folder…"}
            </button>
          </p>
          <button
            type="button"
            onClick={handleClear}
            disabled={isRunning || (messages.length === 0 && timeline.length === 0)}
          >
            Clear chat
          </button>
        </div>
      </header>
      {pickerOpen ? (
        <FolderPicker
          initialPath={workspaceRoot}
          onSelect={(path) => {
            setWorkspaceRoot(path);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      <div className="chat-scroll" ref={scrollRef}>
        {timeline.length === 0 ? (
          <div className="empty-state">
            <p>Say hi, describe a task, or ask the operator to set a workspace.</p>
          </div>
        ) : (
          timeline.map((entry, index) => <TimelineItem key={index} entry={entry} />)
        )}
        {isRunning ? <p className="chat-running">Operator thinking…</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>

      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
            }
          }}
          rows={3}
          placeholder="Tell the operator what to do. ⌘/Ctrl+Enter to send."
          disabled={isRunning}
        />
        <div className="button-row">
          <button type="submit" disabled={isRunning || !input.trim()}>
            {isRunning ? "Sending..." : "Send"}
          </button>
          <button
            type="button"
            className="autopilot-button"
            onClick={handleAutopilot}
            disabled={isRunning || !input.trim() || !workspaceRoot}
            title={workspaceRoot ? "Fully autonomous: scaffold → generate → test → commit" : "Open a folder first"}
          >
            ⚡ Autopilot
          </button>
          {isRunning ? (
            <button type="button" className="stop-button" onClick={handleStop}>
              Stop
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "user") {
    return (
      <article className="chat-bubble user">
        <p>{entry.text}</p>
      </article>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <article className="chat-bubble assistant">
        <p>{entry.text}</p>
      </article>
    );
  }
  if (entry.kind === "system") {
    return <p className="chat-system">{entry.text}</p>;
  }
  if (entry.kind === "tool_call") {
    return (
      <article className="chat-tool-call">
        <header>tool · {entry.call.type}</header>
        <pre>{JSON.stringify(entry.call, null, 2)}</pre>
      </article>
    );
  }
  if (entry.kind === "tool_result") {
    return (
      <article className={`chat-tool-result ${entry.ok ? "ok" : "err"}`}>
        <header>{entry.ok ? "tool result · ok" : "tool result · error"}</header>
        <p>{entry.summary}</p>
        {entry.detail ? <pre>{entry.detail}</pre> : null}
      </article>
    );
  }
  if (entry.kind === "workspace") {
    return <p className="chat-system">Workspace → {entry.root}</p>;
  }
  if (entry.kind === "delegate") {
    return (
      <article className="chat-delegate">
        <header>delegate · {entry.event}</header>
        <p>{entry.summary}</p>
      </article>
    );
  }
  if (entry.kind === "autopilot") {
    return (
      <article className="chat-autopilot">
        <header>autopilot · {entry.event}</header>
        <p>{entry.summary}</p>
      </article>
    );
  }
  return null;
}

function normalize(provider: ProviderConfig, pool: string[] = []) {
  const explicit = (provider.fallbacks || []).map((tag) => tag.trim()).filter(Boolean);
  const taken = new Set([provider.model.trim(), ...explicit]);
  const merged = [...explicit, ...pool.map((t) => t.trim()).filter((t) => t && !taken.has(t))];
  return {
    provider: provider.provider,
    model: provider.model.trim(),
    ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {}),
    ...(merged.length > 0 ? { fallbacks: merged } : {})
  };
}
