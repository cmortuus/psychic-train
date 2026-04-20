export type ProviderKind = "ollama";

export type ProviderConfig = {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
};

export type AgentTurn = {
  role: "writer" | "critic" | "operator" | "system";
  round: number;
  summary: string;
  code?: string;
  verdict?: "revise" | "approved";
};

export type OperatorAction = {
  kind: "git" | "shell" | "test" | "file";
  title: string;
  detail: string;
  command?: string;
};

export type SessionRequest = {
  prompt: string;
  writer: ProviderConfig;
  critic: ProviderConfig;
  operator?: ProviderConfig;
  maxRounds: number;
};

export type SessionResult = {
  transcript: AgentTurn[];
  finalCode: string;
  status: "approved" | "max_rounds" | "cancelled";
  operatorPlan?: {
    summary: string;
    actions: OperatorAction[];
  };
};

export type SessionHooks = {
  onTurn?: (turn: AgentTurn) => void;
  onRoundStart?: (details: {
    agent: "writer" | "critic" | "operator";
    round: number;
    model: string;
  }) => void;
  onRoundComplete?: (details: {
    agent: "writer" | "critic" | "operator";
    round: number;
    model: string;
    durationMs: number;
  }) => void;
  onParseFailure?: (details: {
    agent: "writer" | "critic" | "operator";
    round: number;
    excerpt: string;
  }) => void;
};
