import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './config.ts';
import type { AgentSpec, Ctx } from './config.ts';

/** agent 是否安装：任一 detectPaths 存在即认为已安装。 */
export function detectAgent(agent: AgentSpec): boolean {
  return agent.detectPaths.some((p) => {
    const resolved = expandHome(p);
    try {
      return existsSync(resolved) && statSync(resolved).isDirectory();
    } catch {
      return false;
    }
  });
}

export function listDetectedAgents(ctx: Ctx): Array<AgentSpec & { detected: boolean }> {
  return ctx.agents.map((agent) => ({ ...agent, detected: detectAgent(agent) }));
}

export function resolveAgent(ctx: Ctx, idOrLabel: string): AgentSpec | undefined {
  const needle = idOrLabel.toLowerCase();
  return ctx.agents.find(
    (a) =>
      a.id.toLowerCase() === needle ||
      a.label.toLowerCase() === needle ||
      a.id.toLowerCase().replace(/[^a-z]/g, '') === needle.replace(/[^a-z]/g, ''),
  );
}

export function agentSkillsDir(agent: AgentSpec): string {
  return expandHome(agent.skillsDir);
}

/** 矩阵列头用的短名：claude-code → claude，github-copilot → copilot。 */
export function shortAgentId(id: string): string {
  const map: Record<string, string> = {
    'claude-code': 'claude',
    'github-copilot': 'copilot',
    'gemini-cli': 'gemini',
    'opencode': 'ocode',
  };
  return map[id] ?? id;
}

export function agentTargetPath(agent: AgentSpec, skillName: string): string {
  return join(agentSkillsDir(agent), skillName);
}
