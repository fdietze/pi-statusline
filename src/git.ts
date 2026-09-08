export interface GitStatus {
  ahead: number;
  behind: number;
  dirty: number;
  branch?: string;
}

export type GitStatusState = GitStatus | "error";
export type GitTokenKind = "ahead" | "behind" | "dirty" | "clean" | "error";

export interface GitStatusToken {
  kind: GitTokenKind;
  text: string;
}

export const gitBranchSymbol = (nerdFont: boolean) => nerdFont ? "" : "";

export function parseGitStatus(output: string): GitStatus {
  const abMatch = /(?:^|\0)# branch\.ab \+(\d+) -(\d+)(?:\0|$)/.exec(output);
  const branchMatch = /(?:^|\0)# branch\.head ([^\0]+)(?:\0|$)/.exec(output);
  // Count working-tree changes: porcelain v2 records starting with a digit (changed files)
  // or "?" (untracked), excluding comment lines starting with "#".
  // With -z flag, records are separated by \0 (or start of string).
  const dirty = (output.match(/(?:^|\0)[\d?][^\0]*/g) || []).length;
  return {
    ahead: Number(abMatch?.[1] ?? 0),
    behind: Number(abMatch?.[2] ?? 0),
    dirty,
    ...(branchMatch && { branch: branchMatch[1] === "(detached)" ? "detached" : branchMatch[1] }),
  };
}

export function gitStatusTokens(status: GitStatusState): GitStatusToken[] {
  if (status === "error") return [{ kind: "error", text: "!" }];
  const tokens: GitStatusToken[] = [
    status.dirty && { kind: "dirty", text: `● ${status.dirty}` },
    status.behind && { kind: "behind", text: `↓${status.behind}` },
    status.ahead && { kind: "ahead", text: `↑${status.ahead}` },
  ].filter((token): token is GitStatusToken => Boolean(token));
  return tokens.length ? tokens : [{ kind: "clean", text: "✓" }];
}
