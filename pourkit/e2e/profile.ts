import type { VerificationCommand } from "../shared/config";

export type E2EVerificationProfile = "fast" | "full-check" | "failure";

export function getVerificationCommands(
  baseCommands: VerificationCommand[],
  profile: E2EVerificationProfile
): VerificationCommand[] {
  if (profile === "failure") {
    return [{ command: "exit 1", label: "fail-e2e" }];
  }
  if (profile === "full-check") {
    return [
      { command: "npm run prettier:check", label: "prettier:check" },
      { command: "npm run typecheck", label: "typecheck" },
      { command: "npm run test", label: "tests" },
      { command: "npm run build", label: "build" },
    ];
  }
  return baseCommands;
}

export function composeFailureWithProfile(
  baseCommands: VerificationCommand[],
  profile: E2EVerificationProfile
): VerificationCommand[] {
  const commands = getVerificationCommands(baseCommands, profile);
  return [{ command: "exit 1", label: "fail-e2e" }, ...commands];
}
