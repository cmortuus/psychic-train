import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logError, logInfo } from "./logger.js";
import {
  dismissWatchdogItem,
  resetWatchdogForTests,
  startWatchdog,
  watchdogReport
} from "./watchdog.js";

describe("watchdog", () => {
  beforeEach(() => {
    resetWatchdogForTests();
    startWatchdog();
  });

  afterEach(() => {
    resetWatchdogForTests();
  });

  it("ignores info logs", () => {
    logInfo("something", { message: "fine" });
    expect(watchdogReport()).toHaveLength(0);
  });

  it("tracks error logs and deduplicates by signature", () => {
    logError("chat.error", { message: "ollama 500", code: "upstream_error" });
    logError("chat.error", { message: "ollama 500", code: "upstream_error" });
    logError("chat.error", { message: "ollama 500", code: "upstream_error" });
    const report = watchdogReport();
    expect(report).toHaveLength(1);
    expect(report[0]?.count).toBe(3);
    expect(report[0]?.event).toBe("chat.error");
  });

  it("distinguishes different messages under the same event", () => {
    logError("chat.error", { message: "boom A" });
    logError("chat.error", { message: "boom B" });
    expect(watchdogReport()).toHaveLength(2);
  });

  it("dismissed items stay suppressed", () => {
    logError("tool.error", { message: "nope" });
    const [item] = watchdogReport();
    expect(item).toBeDefined();
    dismissWatchdogItem(item!.id);
    logError("tool.error", { message: "nope" });
    expect(watchdogReport()).toHaveLength(0);
  });
});
