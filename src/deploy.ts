import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSpec, Ctx } from './config.ts';
import { agentTargetPath } from './agents.ts';
import {
  addHistory,
  deleteDeployment,
  getDeployment,
  getSkillByName,
  upsertDeployment,
  type SkillRow,
} from './registry.ts';
import { syncStoreToRegistry } from './store.ts';
import { nowIso, pathEq, treeHash } from './util.ts';

export const MANAGED_MARKER = '.skillmgr-managed.json';

export type DeployMode = 'auto' | 'junction' | 'symlink' | 'copy';
export type TargetKind = 'link' | 'copy' | null;

export interface TargetClass {
  kind: TargetKind;
  /** Whether this deployment was created by skillmgr (link resolves to the canonical copy, or managed marker present). */
  managed: boolean;
  /** Whether the link resolves / copy content matches the canonical copy. */
  healthy: boolean;
  detail: string;
}

/**
 * 判定 agent 目录下 target 的归属与健康状态。
 * - link：realpath 解析回 canonical 即受管；解析失败（悬空）但链接目标字符串指向 canonical，仍算受管但 unhealthy。
 * - copy：存在 MANAGED_MARKER 且 skill 名匹配即受管；内容指纹（排除标记文件）一致才 healthy。
 * - 其他任何内容一律 foreign，绝不触碰。
 */
export function classifyTarget(target: string, canonicalPath: string, skillName: string): TargetClass {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return { kind: null, managed: false, healthy: false, detail: 'missing' };
  }
  if (st.isSymbolicLink()) {
    let linkTarget = '';
    try {
      linkTarget = readlinkSync(target);
    } catch {
      return { kind: 'link', managed: false, healthy: false, detail: 'link unreadable' };
    }
    const pointsToOurs = pathEq(resolve(linkTarget), resolve(canonicalPath));
    if (!pointsToOurs) return { kind: 'link', managed: false, healthy: false, detail: `link points elsewhere: ${linkTarget}` };
    let real = '';
    try {
      real = realpathSync(target);
    } catch {
      return { kind: 'link', managed: true, healthy: false, detail: 'dangling link (canonical missing)' };
    }
    return {
      kind: 'link',
      managed: true,
      healthy: pathEq(real, resolve(canonicalPath)),
      detail: `link → ${real}`,
    };
  }
  if (st.isDirectory()) {
    const markerPath = join(target, MANAGED_MARKER);
    if (!existsSync(markerPath)) {
      return { kind: 'copy', managed: false, healthy: false, detail: 'directory exists without managed marker' };
    }
    let marker: { skill?: string };
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    } catch {
      return { kind: 'copy', managed: false, healthy: false, detail: 'corrupted managed marker' };
    }
    if (marker.skill !== skillName) {
      return { kind: 'copy', managed: false, healthy: false, detail: `marker belongs to another skill: ${marker.skill}` };
    }
    const same = treeHash(target, [MANAGED_MARKER]) === treeHash(canonicalPath);
    return { kind: 'copy', managed: true, healthy: same, detail: same ? 'copy in sync' : 'copy content drifted' };
  }
  return { kind: null, managed: false, healthy: false, detail: 'a non-directory file with the same name exists' };
}

export interface DeployOutcome {
  agentId: string;
  ok: boolean;
  mode?: string;
  message?: string;
}

function tryLink(target: string, canonicalPath: string, kind: 'junction' | 'symlink'): boolean {
  try {
    // Node 的 type 参数只接受 'dir' | 'file' | 'junction'：目录 symlink 在 Windows 用 'dir'（需开发者模式/特权），POSIX 上参数被忽略。
    symlinkSync(resolve(canonicalPath), target, kind === 'junction' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

function tryCopy(target: string, skill: SkillRow): void {
  cpSync(skill.local_path, target, { recursive: true });
  writeFileSync(
    join(target, MANAGED_MARKER),
    JSON.stringify({ managedBy: 'skillmgr', skill: skill.name, hash: skill.content_hash, at: nowIso() }, null, 2),
  );
}

/** 把一个 skill 部署到一个 agent（幂等：受管目标会先清理再重建）。 */
export function deployOne(
  ctx: Ctx,
  db: DatabaseSync,
  skill: SkillRow,
  agent: AgentSpec,
  mode: DeployMode = 'auto',
): DeployOutcome {
  const target = agentTargetPath(agent, skill.name);
  const cls = classifyTarget(target, skill.local_path, skill.name);
  if (cls.kind !== null && !cls.managed) {
    return {
      agentId: agent.id,
      ok: false,
      message: `target already exists and is not managed by skillmgr, refusing to overwrite: ${target} (${cls.detail})`,
    };
  }
  if (
    cls.managed && cls.healthy && cls.kind === 'link' &&
    (mode === 'auto' || mode === 'junction' || mode === 'symlink')
  ) {
    // 链接已有效：无需重建。registry 缺记录（孤儿部署）时补记。
    const existing = getDeployment(db, skill.id, agent.id);
    if (existing) return { agentId: agent.id, ok: true, mode: existing.mode, message: 'already up to date (valid link)' };
    upsertDeployment(db, skill.id, agent.id, 'junction', target, skill.content_hash);
    addHistory(db, 'deploy', skill.id, { agent: agent.id, mode: 'junction' });
    return { agentId: agent.id, ok: true, mode: 'junction', message: 'registered pre-existing link deployment' };
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });

  // junction 是 NTFS 概念：Windows 上 junction → symlink → copy 逐级降级；
  // POSIX 上直接用 symlink（symlinkSync 的 type 参数在非 Windows 被忽略）。
  const attempts: DeployMode[] = mode === 'auto'
    ? (process.platform === 'win32' ? ['junction', 'symlink', 'copy'] : ['symlink', 'copy'])
    : [mode];
  let used: DeployMode | undefined;
  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt === 'junction') {
      if (tryLink(target, skill.local_path, 'junction')) { used = 'junction'; break; }
    } else if (attempt === 'symlink') {
      if (tryLink(target, skill.local_path, 'symlink')) { used = 'symlink'; break; }
    } else if (attempt === 'copy') {
      try {
        tryCopy(target, skill);
        used = 'copy';
        break;
      } catch (error) {
        lastError = error;
        break;
      }
    }
    if (mode !== 'auto') lastError ??= new Error(`${attempt} failed (insufficient privileges? on Windows enable Developer Mode for real symlinks)`);
  }
  if (!used) {
    const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
    return { agentId: agent.id, ok: false, message: `deploy failed (mode ${mode}): ${target}${reason}` };
  }
  upsertDeployment(db, skill.id, agent.id, used, target, skill.content_hash);
  addHistory(db, 'deploy', skill.id, { agent: agent.id, mode: used });
  return { agentId: agent.id, ok: true, mode: used };
}

export function undeployOne(
  ctx: Ctx,
  db: DatabaseSync,
  skill: SkillRow,
  agent: AgentSpec,
): DeployOutcome {
  const target = agentTargetPath(agent, skill.name);
  const cls = classifyTarget(target, skill.local_path, skill.name);
  if (cls.kind === null) {
    deleteDeployment(db, skill.id, agent.id);
    return { agentId: agent.id, ok: true, message: 'was not deployed (stale registry record removed)' };
  }
  if (!cls.managed) {
    return { agentId: agent.id, ok: false, message: `unmanaged content present, refusing to delete: ${target} (${cls.detail})` };
  }
  rmSync(target, { recursive: true, force: true });
  deleteDeployment(db, skill.id, agent.id);
  addHistory(db, 'undeploy', skill.id, { agent: agent.id });
  return { agentId: agent.id, ok: true, mode: cls.kind };
}

// ---- 状态查询（不修改任何东西） ----

export type CellState = 'ok' | 'drift' | 'missing' | 'foreign' | 'not-deployed';

export function cellState(
  db: DatabaseSync,
  skill: SkillRow,
  agent: AgentSpec,
): { state: CellState; mode?: string; detail: string } {
  const row = getDeployment(db, skill.id, agent.id);
  const target = agentTargetPath(agent, skill.name);
  if (!row) {
    const cls = classifyTarget(target, skill.local_path, skill.name);
    if (cls.managed) return { state: 'missing', detail: `managed deployment on disk but no registry record (${cls.detail})` };
    return { state: 'not-deployed', detail: 'not deployed' };
  }
  const cls = classifyTarget(target, skill.local_path, skill.name);
  if (cls.kind === null) return { state: 'missing', mode: row.mode, detail: 'no longer on disk (link or directory deleted)' };
  if (!cls.managed) return { state: 'foreign', mode: row.mode, detail: cls.detail };
  if (!cls.healthy) return { state: 'drift', mode: row.mode, detail: cls.detail };
  return { state: 'ok', mode: row.mode, detail: cls.detail };
}

export function ensureSkill(ctx: Ctx, db: DatabaseSync, name: string): SkillRow {
  syncStoreToRegistry(ctx, db);
  const skill = getSkillByName(db, name);
  if (!skill) throw new Error(`skill not found in canonical store: ${name} (${join(ctx.root, name)})`);
  return skill;
}
