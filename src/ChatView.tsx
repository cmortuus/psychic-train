import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FolderPicker } from "./FolderPicker";
import { streamChat } from "./sseChat";

type ProviderConfig = {
  provider: "ollama";
  model: string;
  baseUrl: string;
  apiKey: string;
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
  | { kind: "delegate"; event: string; summary: string };

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
  onDelegateTurn?: (turn: DelegateTurn) => void;
  onDelegateStart?: () => void;
};

export function ChatView({ operator, writer, critic, onDelegateTurn, onDelegateStart }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef<boolean>(true);

  const activeWorkspace = useMemo(() => workspaceRoot || "(default: server cwd)", [workspaceRoot]);

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
          operator: normalize(operator),
          writer: normalize(writer),
          critic: normalize(critic)
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

  function handleWorkspaceChange(next: string) {
    setWorkspaceRoot(next);
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
        <label className="workspace-input">
          <span>Workspace</span>
          <div className="workspace-input-row">
            <input
              type="text"
              placeholder="/absolute/path (blank = server cwd)"
              value={workspaceRoot}
              onChange={(event) => handleWorkspaceChange(event.target.value)}
            />
            <button type="button" onClick={() => setPickerOpen(true)}>Browse…</button>
          </div>
        </label>
        <p className="provider-meta">Active: <code>{activeWorkspace}</code></p>
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
      </header>

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
  return null;
}

function normalize(provider: ProviderConfig) {
  return {
    provider: provider.provider,
    model: provider.model.trim(),
    ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    ...(provider.apiKey.trim() ? { apiKey: provider.apiKey.trim() } : {})
  };
}
