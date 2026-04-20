import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LogEntry, subscribeLogs } from "./logger.js";

export type WatchdogItem = {
  id: string;
  event: string;
  message: string;
  code?: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
};

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ITEMS = 100;
const open = new Map<string, WatchdogItem>();
const dismissed = new Set<string>();
let started = false;

function signature(entry: LogEntry): string {
  const message = (entry.fields.message as string | undefined) ?? "";
  const code = (entry.fields.code as string | undefined) ?? "";
  const digest = createHash("sha256");
  digest.update(entry.event);
  digest.update("|");
  digest.update(message.slice(0, 200));
  digest.update("|");
  digest.update(code);
  return digest.digest("hex").slice(0, 16);
}

function shouldTrack(entry: LogEntry): boolean {
  if (entry.level !== "error") return false;
  const event = entry.event;
  if (!event || event === "http.request.invalid") return false;
  return true;
}

function sinkLine(line: string): void {
  const target = process.env.WATCHDOG_SINK;
  if (!target || target === "stdout") return;
  if (target.startsWith("file:")) {
    const path = target.slice("file:".length);
    appendFile(path, line + "\n").catch(() => undefined);
  }
}

function prune(now: number): void {
  for (const [id, item] of open) {
    if (now - Date.parse(item.lastSeen) > WINDOW_MS) {
      open.delete(id);
    }
  }
}

function ingest(entry: LogEntry): void {
  if (!shouldTrack(entry)) return;
  const id = signature(entry);
  if (dismissed.has(id)) return;
  const now = Date.now();
  prune(now);
  const existing = open.get(id);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = entry.ts;
  } else {
    if (open.size >= MAX_ITEMS) {
      const first = open.keys().next().value;
      if (first) open.delete(first);
    }
    const item: WatchdogItem = {
      id,
      event: entry.event,
      message: String(entry.fields.message ?? "(no message)"),
      ...(entry.fields.code ? { code: String(entry.fields.code) } : {}),
      firstSeen: entry.ts,
      lastSeen: entry.ts,
      count: 1
    };
    open.set(id, item);
    sinkLine(JSON.stringify({ watchdog: "new", ...item }));
  }
}

export function startWatchdog(): void {
  if (started) return;
  started = true;
  subscribeLogs(ingest);
}

export function watchdogReport(): WatchdogItem[] {
  const now = Date.now();
  prune(now);
  return Array.from(open.values()).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

export function dismissWatchdogItem(id: string): boolean {
  dismissed.add(id);
  return open.delete(id);
}

export function resetWatchdogForTests(): void {
  open.clear();
  dismissed.clear();
  started = false;
}
