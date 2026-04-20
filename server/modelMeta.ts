type ModelMetadata = { country: string; maker: string };

const METADATA: Record<string, ModelMetadata> = {
  "gpt-oss:20b-cloud": { country: "US", maker: "OpenAI" },
  "gpt-oss:120b-cloud": { country: "US", maker: "OpenAI" },
  "deepseek-v3.1:671b-cloud": { country: "China", maker: "DeepSeek" },
  "qwen3-coder:480b-cloud": { country: "China", maker: "Alibaba Qwen" },
  "kimi-k2:1t-cloud": { country: "China", maker: "Moonshot" },
  "glm-4.6:cloud": { country: "China", maker: "Zhipu AI" }
};

export function countryOf(modelTag: string): string {
  const entry = METADATA[modelTag];
  if (entry) return entry.country;
  return modelTag.includes(":cloud") ? "Unknown" : "Local";
}

export function isUs(modelTag: string): boolean {
  return countryOf(modelTag) === "US";
}

export function isNonUsCloud(modelTag: string): boolean {
  const c = countryOf(modelTag);
  return c !== "US" && c !== "Local";
}
