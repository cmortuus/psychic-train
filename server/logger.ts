type LogLevel = "info" | "error" | "debug";

type LogFields = Record<string, string | number | boolean | null | undefined>;

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
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeFields(fields)
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
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
