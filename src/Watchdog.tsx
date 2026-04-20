import { useEffect, useState } from "react";

export type WatchdogItem = {
  id: string;
  event: string;
  message: string;
  code?: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
};

const POLL_MS = 10_000;

export function WatchdogIndicator() {
  const [items, setItems] = useState<WatchdogItem[]>([]);
  const [open, setOpen] = useState(false);

  async function refresh() {
    try {
      const response = await fetch("/api/watchdog/report");
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: WatchdogItem[] };
      setItems(Array.isArray(payload.items) ? payload.items : []);
    } catch {
      // ignore — server may be down
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function dismiss(id: string) {
    try {
      await fetch("/api/watchdog/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
    } catch {
      // ignore
    }
    setItems((prior) => prior.filter((item) => item.id !== id));
  }

  if (items.length === 0) {
    return (
      <button
        type="button"
        className="watchdog-indicator ok"
        onClick={refresh}
        title="Watchdog: no open issues"
      >
        ● ok
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="watchdog-indicator alert"
        onClick={() => setOpen((v) => !v)}
        title={`${items.length} open watchdog item(s)`}
      >
        ● {items.length}
      </button>
      {open ? (
        <div className="watchdog-drawer" role="dialog">
          <header>
            <h3>Watchdog ({items.length})</h3>
            <button type="button" onClick={() => setOpen(false)} className="watchdog-close">×</button>
          </header>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <div className="watchdog-item-head">
                  <strong>{item.event}</strong>
                  <span className="watchdog-count">×{item.count}</span>
                </div>
                <p>{item.message}</p>
                {item.code ? <code>{item.code}</code> : null}
                <div className="watchdog-item-meta">
                  <span className="provider-meta">last {new Date(item.lastSeen).toLocaleTimeString()}</span>
                  <button type="button" onClick={() => dismiss(item.id)}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
