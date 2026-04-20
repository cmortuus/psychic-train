import "dotenv/config";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runDualAgentSession } from "./runSession.js";
import { ProviderConfig, SessionRequest } from "./types.js";

const defaultWriter: ProviderConfig = {
  provider: "ollama",
  model: process.env.WRITER_MODEL || "gpt-oss:20b-cloud",
  baseUrl: process.env.WRITER_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  apiKey: process.env.WRITER_API_KEY || ""
};

const defaultCritic: ProviderConfig = {
  provider: "ollama",
  model: process.env.CRITIC_MODEL || "gemini-3-flash-preview:cloud",
  baseUrl: process.env.CRITIC_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  apiKey: process.env.CRITIC_API_KEY || ""
};

const defaultOperator: ProviderConfig = {
  provider: "ollama",
  model: process.env.OPERATOR_MODEL || "rnj-1:8b-cloud",
  baseUrl: process.env.OPERATOR_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  apiKey: process.env.OPERATOR_API_KEY || ""
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const prompt = await resolvePrompt(args);
  if (!prompt.trim()) {
    throw new Error("Missing prompt. Pass one as arguments or use stdin.");
  }

  const request: SessionRequest = {
    prompt,
    maxRounds: Number(process.env.MAX_ROUNDS || 4),
    writer: {
      ...defaultWriter
    },
    critic: {
      ...defaultCritic
    },
    ...(process.env.ENABLE_OPERATOR === "true"
      ? {
          operator: {
            ...defaultOperator
          }
        }
      : {})
  };

  printHeader(request);

  const result = await runDualAgentSession(request, {
    onTurn(turn) {
      if (turn.role === "writer") {
        output.write(`\n[writer][round ${turn.round}]\n${turn.summary}\n`);
        if (turn.code) {
          output.write(`${formatCodeBlock(turn.code)}\n`);
        }
        return;
      }

      if (turn.role === "critic") {
        output.write(
          `\n[critic][round ${turn.round}][${turn.verdict}]\n${turn.summary}\n`
        );
        return;
      }

      if (turn.role === "operator") {
        output.write(`\n[operator][round ${turn.round}]\n${turn.summary}\n`);
        return;
      }

      output.write(`\n[system]\n${turn.summary}\n`);
    }
  });

  if (result.operatorPlan) {
    output.write(`\nOperator plan: ${result.operatorPlan.summary}\n`);
    for (const action of result.operatorPlan.actions) {
      output.write(`- [${action.kind}] ${action.title}: ${action.detail}\n`);
      if (action.command) {
        output.write(`  command: ${action.command}\n`);
      }
    }
  }

  output.write(`\nFinal status: ${result.status}\n`);
}

async function resolvePrompt(args: string[]): Promise<string> {
  if (args.length > 0) {
    return args.join(" ").trim();
  }

  if (!input.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of input) {
      chunks.push(String(chunk));
    }
    return chunks.join("").trim();
  }

  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question("Task: ")).trim();
  } finally {
    rl.close();
  }
}

function printHeader(request: SessionRequest) {
  output.write("Dual Agent Terminal\n");
  output.write(`Writer: ${request.writer.provider} / ${request.writer.model}\n`);
  output.write(`Critic: ${request.critic.provider} / ${request.critic.model}\n`);
  output.write(`Max rounds: ${request.maxRounds}\n`);
}

function formatCodeBlock(code: string): string {
  const divider = "-".repeat(72);
  return `${divider}\n${code}\n${divider}`;
}

function printHelp() {
  output.write(`Usage: npm run terminal -- "build a todo cli"\n`);
  output.write(`\n`);
  output.write(`Environment variables:\n`);
  output.write(`  WRITER_MODEL=gpt-oss:20b-cloud|gemma3:12b-cloud|gemma4:31b-cloud|gemini-3-flash-preview:cloud|nemotron-3-nano:30b-cloud|rnj-1:8b-cloud\n`);
  output.write(`  WRITER_BASE_URL=...\n`);
  output.write(`  WRITER_API_KEY=...\n`);
  output.write(`  CRITIC_MODEL=gpt-oss:20b-cloud|gemma3:12b-cloud|gemma4:31b-cloud|gemini-3-flash-preview:cloud|nemotron-3-nano:30b-cloud|rnj-1:8b-cloud\n`);
  output.write(`  CRITIC_BASE_URL=...\n`);
  output.write(`  CRITIC_API_KEY=...\n`);
  output.write(`  ENABLE_OPERATOR=true|false\n`);
  output.write(`  OPERATOR_MODEL=gpt-oss:20b-cloud|gemma3:12b-cloud|gemma4:31b-cloud|gemini-3-flash-preview:cloud|nemotron-3-nano:30b-cloud|rnj-1:8b-cloud\n`);
  output.write(`  OPERATOR_BASE_URL=...\n`);
  output.write(`  OPERATOR_API_KEY=...\n`);
  output.write(`  MAX_ROUNDS=4\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Error: ${message}`);
  process.exit(1);
});
