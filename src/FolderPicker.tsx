import { useEffect, useState } from "react";

type BrowseEntry = { name: string; isDirectory: boolean; path: string };
type BrowseResult = {
  cwd: string;
  parent: string | null;
  entries: BrowseEntry[];
  totalEntries?: number;
  truncated?: boolean;
};

type Props = {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
};

export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [current, setCurrent] = useState<BrowseResult | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(initialPath || "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loadingPath === null) return;
    let cancelled = false;
    const query = loadingPath ? `?path=${encodeURIComponent(loadingPath)}` : "";
    fetch(`/api/browse${query}`)
      .then(async (response) => {
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError((payload as { error?: string }).error || "Browse failed");
          return;
        }
        setCurrent(payload as BrowseResult);
        setError(null);
      })
      .catch((browseError) => {
        if (!cancelled) setError(browseError instanceof Error ? browseError.message : "Browse failed");
      });
    return () => {
      cancelled = true;
    };
  }, [loadingPath]);

  function navigate(path: string) {
    setLoadingPath(path);
  }

  function handleSelect() {
    if (current) onSelect(current.cwd);
  }

  return (
    <div
      className="folder-picker-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="folder-picker">
        <header>
          <div>
            <h3>Pick a folder</h3>
            <code>{current?.cwd || loadingPath || "…"}</code>
          </div>
          <button type="button" className="folder-picker-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="folder-picker-nav">
          <button
            type="button"
            disabled={!current?.parent}
            onClick={() => current?.parent && navigate(current.parent)}
          >
            ↑ Up
          </button>
          <input
            type="text"
            placeholder="/absolute/path"
            value={loadingPath ?? ""}
            onChange={(event) => setLoadingPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setLoadingPath((prior) => (prior === null ? "" : prior));
              }
            }}
          />
        </div>

        {error ? <p className="error">{error}</p> : null}
        {current?.truncated ? (
          <p className="folder-picker-truncated">
            Showing first {current.entries.length} of {current.totalEntries} entries. Drill into a
            subfolder to narrow the view.
          </p>
        ) : null}

        <ul className="folder-picker-list">
          {(current?.entries || [])
            .filter((entry) => entry.isDirectory)
            .map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => navigate(entry.path)}>
                  📁 {entry.name}
                </button>
              </li>
            ))}
          {current && current.entries.filter((e) => e.isDirectory).length === 0 ? (
            <li className="folder-picker-empty">(no subdirectories)</li>
          ) : null}
        </ul>

        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={handleSelect} disabled={!current}>
            Use this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
