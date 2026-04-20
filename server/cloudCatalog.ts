import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type CatalogEntry = {
  tag: string;
  country: string;
  maker: string;
  abliterated?: boolean;
};

const CURATED: CatalogEntry[] = [
  { tag: "gpt-oss:20b-cloud", country: "US", maker: "OpenAI" },
  { tag: "gpt-oss:120b-cloud", country: "US", maker: "OpenAI" },
  { tag: "deepseek-v3.1:671b-cloud", country: "China", maker: "DeepSeek" },
  { tag: "qwen3-coder:480b-cloud", country: "China", maker: "Alibaba Qwen" },
  { tag: "kimi-k2:1t-cloud", country: "China", maker: "Moonshot" },
  { tag: "glm-4.6:cloud", country: "China", maker: "Zhipu AI" }
];

let cachedOverrides: CatalogEntry[] | null = null;
let cachedOverrideSource: string | null = null;

export async function loadCatalogOverrides(): Promise<CatalogEntry[]> {
  const path = process.env.CLOUD_CATALOG_PATH;
  if (!path) {
    cachedOverrides = [];
    cachedOverrideSource = null;
    return [];
  }
  const absolute = resolve(path);
  if (cachedOverrides && cachedOverrideSource === absolute) {
    return cachedOverrides;
  }
  try {
    const raw = await readFile(absolute, "utf8");
    const parsed = JSON.parse(raw);
    const entries: CatalogEntry[] = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof item.tag === "string" &&
          typeof item.country === "string" &&
          typeof item.maker === "string"
        ) {
          entries.push({
            tag: item.tag,
            country: item.country,
            maker: item.maker,
            ...(item.abliterated ? { abliterated: true } : {})
          });
        }
      }
    }
    cachedOverrides = entries;
    cachedOverrideSource = absolute;
    return entries;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to load CLOUD_CATALOG_PATH (${absolute}): ${message}`);
  }
}

export async function mergedCatalog(): Promise<CatalogEntry[]> {
  const overrides = await loadCatalogOverrides();
  const byTag = new Map<string, CatalogEntry>();
  for (const entry of CURATED) byTag.set(entry.tag, entry);
  for (const entry of overrides) byTag.set(entry.tag, entry);
  return Array.from(byTag.values());
}

export function getCurated(): CatalogEntry[] {
  return CURATED.slice();
}
