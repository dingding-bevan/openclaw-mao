import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

interface AgentSpec {
  id: string;
  description: string;
  model: string;
}

const REQUIRED_AGENTS: AgentSpec[] = [
  { id: "opencode-dev",  description: "OpenCode 工程团队：新功能、重构、代码审查", model: "qwen/qwen3-coder-next" },
  { id: "kimi-bugfix",   description: "KimiCode 快修：紧急 bug 修复、hotfix",       model: "moonshot/kimi-k2.5"   },
  { id: "orchestrator",  description: "主编排器：分类、状态追踪、结果汇总",          model: "xiaomi/mimo-v2.5"     },
];

interface SetupResult {
  ok: boolean;
  registered: string[];
  alreadyExists: string[];
  failed: { id: string; error: string }[];
}

function listExistingAgentIds(): Set<string> {
  const out = spawnSync("openclaw", ["agents", "list", "--json"], { encoding: "utf8" });
  if (out.status !== 0) return new Set();
  try {
    const parsed = JSON.parse(out.stdout);
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.agents ?? [];
    return new Set(arr.map((a) => a.id ?? a.agent_id ?? a.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function runSetup(api: OpenClawPluginApi, workspaceRoot: string): SetupResult {
  const existing = listExistingAgentIds();
  const result: SetupResult = { ok: true, registered: [], alreadyExists: [], failed: [] };

  for (const spec of REQUIRED_AGENTS) {
    if (existing.has(spec.id)) {
      api.logger.debug(`openclaw-mao: agent already registered: ${spec.id}`);
      result.alreadyExists.push(spec.id);
      continue;
    }
    const workspaceDir = `${workspaceRoot}/agents/${spec.id}`;
    mkdirSync(workspaceDir, { recursive: true });

    api.logger.info(`openclaw-mao: registering agent ${spec.id} at ${workspaceDir}`);
    const out = spawnSync(
      "openclaw",
      [
        "agents",
        "add",
        spec.id,
        "--non-interactive",
        "--workspace",
        workspaceDir,
        "--model",
        spec.model,
      ],
      { encoding: "utf8" },
    );
    if (out.status !== 0) {
      result.ok = false;
      result.failed.push({ id: spec.id, error: out.stderr || `exit ${out.status}` });
      api.logger.warn(`openclaw-mao: failed to register agent ${spec.id}: ${out.stderr ?? `exit ${out.status}`}`);
      continue;
    }
    result.registered.push(spec.id);
  }
  return result;
}
