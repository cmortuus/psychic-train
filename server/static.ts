import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ServerResponse } from "node:http";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

type StaticResult = "served" | "not_found" | "skipped";

export async function serveStatic(
  urlPath: string,
  root: string,
  res: ServerResponse
): Promise<StaticResult> {
  const decoded = safeDecode(urlPath);
  if (decoded === null) {
    return "skipped";
  }

  const rootResolved = resolve(root);
  const requested = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const joined = resolve(join(rootResolved, normalize(requested)));
  if (joined !== rootResolved && !joined.startsWith(rootResolved + sep)) {
    return "skipped";
  }

  const fileStat = await statSafe(joined);
  const finalPath = fileStat && fileStat.isFile() ? joined : await spaFallback(rootResolved);
  if (!finalPath) {
    return "not_found";
  }

  const type = contentTypes[extname(finalPath).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.writeHead(200);
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(finalPath);
    stream.on("error", fail);
    stream.on("end", () => done());
    stream.pipe(res);
  });
  return "served";
}

async function spaFallback(root: string): Promise<string | null> {
  const indexPath = join(root, "index.html");
  const info = await statSafe(indexPath);
  return info && info.isFile() ? indexPath : null;
}

async function statSafe(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function safeDecode(value: string): string | null {
  try {
    const withoutQuery = value.split("?")[0] || "";
    return decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
}
