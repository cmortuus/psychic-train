export type ProviderKind = "ollama";

export type ProviderConfig = {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Optional list of model tags (same provider) to escalate to when the
   * primary model refuses. Non-refusal failures never trigger fallbacks.
   */
  fallbacks?: string[];
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

export type SessionMode = "writer_critic" | "consensus";

export type SessionRequest = {
  prompt: string;
  writer: ProviderConfig;
  critic: ProviderConfig;
  operator?: ProviderConfig;
  maxRounds: number;
  minRounds?: number;
  anonymize?: boolean;
  usOnly?: boolean;
  mode?: SessionMode;
  workspaceRoot?: string;
};

export type SessionFile = { path: string; content: string };

export type SessionResult = {
  transcript: AgentTurn[];
  finalCode: string;
  finalFiles: SessionFile[];
  status: "approved" | "max_rounds" | "cancelled";
  operatorPlan?: {
    summary: string;
    actions: OperatorAction[];
  };
};

export type MaterializedFiles = {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  workspaceRoot: string;
};

export type SessionHooks = {
  onTurn?: (turn: AgentTurn) => void;
  onFilesMaterialized?: (details: MaterializedFiles) => void;
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
  onRefusalFallback?: (details: {
    agent: "writer" | "critic" | "operator";
    round: number;
    from: string;
    to: string;
    reason: string;
  }) => void;
};
