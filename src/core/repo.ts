import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pExecFile = promisify(execFile);
const pExec = promisify(exec);

export async function git(repo: string, args: string[]) {
  const { stdout } = await pExecFile("git", args, { cwd: repo, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function runCommand(cwd: string, command: string, timeoutMs = 10 * 60_000) {
  try {
    const { stdout, stderr } = await pExec(command, { cwd, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
    return { command, exitCode: 0, excerpt: tail(stdout + stderr) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return { command, exitCode: typeof e.code === "number" ? e.code : 1, excerpt: tail((e.stdout ?? "") + (e.stderr ?? e.message)) };
  }
}

const tail = (s: string, n = 4000) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * R5: the reviewer works in a separate, throw-away worktree of the branch.
 * Files are made read-only before tests run, so the review cannot "fix" anything.
 */
export async function createReviewSandbox(repo: string, branch: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  await git(repo, ["worktree", "add", "--detach", dir, branch]);
  return {
    dir,
    async dispose() {
      await git(repo, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    },
  };
}

export function lineCounter(root: string) {
  const cache = new Map<string, number | null>();
  return (file: string) => {
    if (cache.has(file)) return cache.get(file)!;
    const abs = path.resolve(root, file);
    let n: number | null = null;
    if (abs.startsWith(path.resolve(root)) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      n = fs.readFileSync(abs, "utf8").split("\n").length;
    }
    cache.set(file, n);
    return n;
  };
}

/** Numbered excerpt of changed files so reviewers can cite exact lines. */
export function numberedFiles(root: string, files: string[], maxChars = 120_000) {
  let out = "";
  for (const f of files) {
    const abs = path.resolve(root, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const body = fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
      .join("\n");
    const block = `\n=== ${f} ===\n${body}\n`;
    if (out.length + block.length > maxChars) {
      out += `\n=== ${f} === (omitted: size limit)\n`;
      continue;
    }
    out += block;
  }
  return out;
}
