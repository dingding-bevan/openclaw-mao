import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

interface CliCheck {
  name: string;
  binary: string;
  versionFlag: string;
  ok: boolean;
  version?: string;
  error?: string;
}

interface TmuxCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

interface SetupResult {
  ok: boolean;
  cli_checks: CliCheck[];
  tmux: TmuxCheck;
}

const PATH_OVERRIDE = `/home/admin/.local/bin:/home/admin/.npm-global/bin:${process.env.PATH ?? ""}`;

function checkBinary(name: string, binary: string, versionFlag: string): CliCheck {
  const r = spawnSync(binary, [versionFlag], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, PATH: PATH_OVERRIDE },
  });
  if (r.status !== 0) {
    return {
      name,
      binary,
      versionFlag,
      ok: false,
      error: r.stderr?.trim() || r.error?.message || `exit ${r.status}`,
    };
  }
  // Take first non-empty stdout line as the version string
  const ver = (r.stdout ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return { name, binary, versionFlag, ok: true, version: ver };
}

function checkTmuxAvailable(): TmuxCheck {
  const r = spawnSync("tmux", ["-V"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, PATH: PATH_OVERRIDE },
  });
  if (r.status !== 0) {
    return { ok: false, error: r.stderr?.trim() || r.error?.message || `exit ${r.status}` };
  }
  const ver = (r.stdout ?? "").trim();
  return { ok: true, version: ver };
}

/**
 * v0.2.0: setup verifies the external CLIs mao dispatches to (kimi + opencode)
 * are reachable on PATH and respond to --version. We no longer register internal
 * OpenClaw agents (the previous implementation was a misread of the SDK — those
 * "agents" were OpenClaw-internal namespaces, not our actual coding agents).
 */
export function runSetup(_api: OpenClawPluginApi, _workspaceRoot: string): SetupResult {
  const checks = [
    checkBinary("kimi", "kimi", "--version"),
    checkBinary("opencode", "opencode", "--version"),
  ];
  const tmuxCheck = checkTmuxAvailable();
  return { ok: checks.every((c) => c.ok) && tmuxCheck.ok, cli_checks: checks, tmux: tmuxCheck };
}
