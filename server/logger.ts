type LogLevel = "info" | "error" | "debug";

type LogFields = Record<string, string | number | boolean | null | undefined>;

type LogEntry = {
  ts: string;
  level: LogLevel;
  event: string;
  fields: LogFields;
};

type Subscriber = (entry: LogEntry) => void;

const subscribers: Set<Subscriber> = new Set();

export function subscribeLogs(listener: Subscriber): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function logInfo(event: string, fields: LogFields = {}) {
  writeLog("info", event, fields);
}

export function logError(event: string, fields: LogFields = {}) {
  writeLog("error", event, fields);
}

export function logDebug(event: string, fields: LogFields = {}) {
  if (!isDebugEnabled()) {
    return;
  }

  writeLog("debug", event, fields);
}

function writeLog(level: LogLevel, event: string, fields: LogFields) {
  const sanitized = sanitizeFields(fields);
  const ts = new Date().toISOString();
  const payload = {
    ts,
    level,
    event,
    ...sanitized
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  if (subscribers.size > 0) {
    const entry: LogEntry = { ts, level, event, fields: sanitized };
    for (const listener of subscribers) {
      try {
        listener(entry);
      } catch (err) {
        // Never let a bad subscriber break the logger, but don't silently
        // swallow either — surface a rate-limited stderr line so a
        // permanently-broken subscriber is diagnosable.
        reportSubscriberError(listener, err);
      }
    }
  }
}

// One warn per subscriber per minute, keyed by function identity.
const subscriberErrorLastWarn = new WeakMap<Subscriber, number>();
const SUBSCRIBER_WARN_INTERVAL_MS = 60_000;

function reportSubscriberError(listener: Subscriber, err: unknown): void {
  const now = Date.now();
  const prev = subscriberErrorLastWarn.get(listener) ?? 0;
  if (now - prev < SUBSCRIBER_WARN_INTERVAL_MS) return;
  subscriberErrorLastWarn.set(listener, now);
  const name = listener.name || "<anonymous>";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[logger.subscriber.error] ${name}: ${message}`);
}

function sanitizeFields(fields: LogFields) {
  const next: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      next[key] = redactSecrets(key, value);
      continue;
    }

    next[key] = value;
  }

  return next;
}

function redactSecrets(key: string, value: string) {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("key") || lowerKey.includes("token") || lowerKey.includes("secret")) {
    return redactValue(value);
  }

  return value;
}

export function redactValue(value: string) {
  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

function isDebugEnabled() {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  return value === "debug";
}

export type { LogEntry, LogLevel, LogFields };
