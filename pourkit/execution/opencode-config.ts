export interface SerenaExecutionContext {
  available: boolean;
  sandboxMcpUrl: string;
}

export interface SerenaOpenCodeConfig {
  mcp: {
    serena: {
      type: "remote";
      url: string;
      enabled: true;
    };
  };
}

export function isSerenaEligibleStage(stage: string): boolean {
  return stage === "builder" || stage === "refactor";
}

export function buildSerenaOpenCodeConfig(
  stage: string,
  serena?: SerenaExecutionContext
): SerenaOpenCodeConfig | undefined {
  if (!serena?.available || !isSerenaEligibleStage(stage)) {
    return undefined;
  }

  return {
    mcp: {
      serena: {
        type: "remote",
        url: serena.sandboxMcpUrl,
        enabled: true,
      },
    },
  };
}
