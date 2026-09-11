import type { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './config.ts';
import { agentTargetPath } from './agents.ts';
import {
  addHistory,
  getDeployment,
  listDeployments,
  listSkills,
} from './registry.ts';
import { classifyTarget, deployOne } from './deploy.ts';

export interface Issue {
  kind: 'missing' | 'drift' | 'orphan' | 'stale-skill' | 'foreign';
  skill: string;
  agent?: string;
  detail: string;
  fixable: boolean;
}

/** 磁盘 ↔ registry 全量对账，收集问题（不改任何东西）。 */
export function collectIssues(ctx: Ctx, db: DatabaseSync): Issue[] {
  const issues: Issue[] = [];
  for (const skill of listSkills(db)) {
    for (const dep of listDeployments(db, skill.id)) {
      const agent = ctx.agents.find((a) => a.id === dep.agent_id);
      if (!agent) {
        issues.push({ kind: 'stale-skill', skill: skill.name, agent: dep.agent_id, detail: 'registry references an agent not defined in the current config', fixable: false });
        continue;
      }
      const cls = classifyTarget(dep.target_path, skill.local_path, skill.name);
      if (cls.kind === null) {
        issues.push({ kind: 'missing', skill: skill.name, agent: agent.id, detail: 'deployment target missing, can be redeployed', fixable: true });
      } else if (!cls.managed) {
        issues.push({ kind: 'foreign', skill: skill.name, agent: agent.id, detail: `deployment target occupied by unmanaged content: ${cls.detail}`, fixable: false });
      } else if (!cls.healthy) {
        issues.push({ kind: 'drift', skill: skill.name, agent: agent.id, detail: cls.detail, fixable: true });
      }
    }
    // 磁盘上有受管部署但 registry 无记录（孤儿）
    for (const agent of ctx.agents) {
      if (getDeployment(db, skill.id, agent.id)) continue;
      const cls = classifyTarget(agentTargetPath(agent, skill.name), skill.local_path, skill.name);
      if (cls.managed) {
        issues.push({ kind: 'orphan', skill: skill.name, agent: agent.id, detail: `managed deployment on disk but no registry record (${cls.detail})`, fixable: true });
      }
    }
  }
  return issues;
}

export function fixIssues(ctx: Ctx, db: DatabaseSync): { fixed: string[]; failed: string[] } {
  const fixed: string[] = [];
  const failed: string[] = [];
  for (const issue of collectIssues(ctx, db)) {
    if (!issue.fixable) continue;
    try {
      const skill = listSkills(db).find((s) => s.name === issue.skill)!;
      const agent = ctx.agents.find((a) => a.id === issue.agent);
      if (!agent) continue;
      const outcome = deployOne(ctx, db, skill, agent, 'auto');
      if (outcome.ok) {
        fixed.push(`${issue.skill} @ ${agent.id}: ${issue.detail} → rebuilt as ${outcome.mode}`);
      } else {
        failed.push(`${issue.skill} @ ${agent.id}: ${outcome.message}`);
      }
    } catch (error) {
      failed.push(`${issue.skill} @ ${issue.agent}: ${(error as Error).message}`);
    }
  }
  if (fixed.length > 0) addHistory(db, 'doctor', null, { fixed: fixed.length });
  return { fixed, failed };
}
