import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { parseFrontmatter } from './frontmatter.ts';
import type { Ctx } from './config.ts';
import {
  addHistory,
  getSkillByName,
  getUpdateCheck,
  getSource,
  listDeployments,
  listSkills,
  recordUpdateCheck,
  setPinnedCommit,
  setSource,
  upsertSkill,
  type SkillRow,
} from './registry.ts';
import { ensureSkill, deployOne, classifyTarget } from './deploy.ts';
import { diffTrees, nowIso, treeHash } from './util.ts';

// ---- URL / 仓库引用解析与校验 ----

export interface RepoRef {
  url: string;
  host: string;
  owner: string;
  repo: string;
}

/** 仅允许 http(s) + host 白名单 + 拒绝本机/环回/私有/保留地址。 */
export function isForbiddenHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0') return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(h) === 6) {
    const low = h.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('::ffff:')) return isForbiddenHost(low.slice(7));
    return false;
  }
  return false;
}

export function parseRepoRef(ref: string, ctx: Ctx): RepoRef {
  let url: string;
  if (ref.match(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/)) {
    url = `https://github.com/${ref}`;
  } else {
    url = ref;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`cannot parse repo reference: ${ref}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only http/https protocols are allowed, got: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('credentials embedded in the URL are not allowed');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (isForbiddenHost(host)) {
    throw new Error(`forbidden host (local/private/reserved): ${host}`);
  }
  if (!ctx.allowedHosts.some((allowed) => host === allowed.toLowerCase())) {
    throw new Error(`host not in allowlist: ${host} (extend allowedHosts in .registry/config.json)`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error(`URL path must contain owner/repo: ${url}`);
  return { url: `${parsed.protocol}//${parsed.host}/${segments[0]}/${segments[1]}`, host, owner: segments[0], repo: segments[1] };
}

// ---- git 调用（参数数组，不经 shell） ----

function git(args: string[], opts: { timeoutMs?: number } = {}): string {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args[0]} failed: ${stderr.slice(0, 800)}`);
  }
  return (result.stdout || '').trim();
}

export interface DiscoveredSkill {
  dir: string;
  name: string;
  /** Path relative to the repository root, e.g. skills/foo */
  subpath: string;
  description: string;
}

/** 在克隆目录中查找所有含 SKILL.md 的目录。 */
export function discoverSkillDirs(repoDir: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = join(dir, entry.name);
      const skillMd = join(child, 'SKILL.md');
      if (existsSync(skillMd)) {
        let description = '';
        try {
          description = parseFrontmatter(readFileSync(skillMd, 'utf8')).attrs.description ?? '';
        } catch {
          // 同 store 扫描：解析失败不阻塞
        }
        found.push({ dir: child, name: entry.name, subpath: relative(repoDir, child).split(sep).join('/'), description });
      }
      walk(child);
    }
  };
  walk(repoDir);
  return found;
}

function cloneToTemp(ctx: Ctx, ref: RepoRef, branch?: string): { dir: string; commit: string; resolvedBranch: string } {
  const dir = join(tmpdir(), `skillmgr-clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none', '--single-branch'];
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push(ref.url, dir);
  git(cloneArgs);
  const commit = git(['-C', dir, 'rev-parse', 'HEAD']);
  const resolvedBranch = git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return { dir, commit, resolvedBranch };
}

function cleanupTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---- add ----

export interface AddOptions {
  skills?: string[];
  branch?: string;
  as?: string;
}

export interface AddResult {
  added: Array<{ name: string; commit: string; branch: string }>;
  available: string[];
}

/** 从 GitHub/GitLab 添加 skill 到 canonical store，并记录来源。 */
export function addFromRepo(ctx: Ctx, db: DatabaseSync, ref0: string, opts: AddOptions = {}): AddResult {
  const ref = parseRepoRef(ref0, ctx);
  const cloned = cloneToTemp(ctx, ref, opts.branch);
  try {
    const discovered = discoverSkillDirs(cloned.dir);
    if (discovered.length === 0) throw new Error('no directories containing SKILL.md found in the repository');
    let selected: DiscoveredSkill[];
    if (opts.skills && opts.skills.length > 0) {
      selected = opts.skills.map((want) => {
        const hit = discovered.find((d) => d.name === want);
        if (!hit) throw new Error(`skill "${want}" not found in the repository. Available: ${discovered.map((d) => d.name).join(', ')}`);
        return hit;
      });
    } else if (discovered.length === 1) {
      selected = discovered;
    } else {
      throw new Error(`found ${discovered.length} skills, specify one with --skill <name>. Available: ${discovered.map((d) => d.name).join(', ')}`);
    }
    const added: AddResult['added'] = [];
    for (const item of selected) {
      const name = opts.as && selected.length === 1 ? opts.as : item.name;
      const dest = join(ctx.root, name);
      if (existsSync(dest)) throw new Error(`"${name}" already exists in the canonical store (${dest}). Use "skillmgr update ${name}" to update it, or --as to install under another name`);
      cpSync(item.dir, dest, { recursive: true });
      const skill = upsertSkill(db, {
        name,
        local_path: dest,
        description: item.description,
        content_hash: treeHash(dest),
      }, 'upstream');
      const kind = ref.host.includes('gitlab') ? 'gitlab' : 'github';
      setSource(db, skill.id, {
        kind,
        url: ref.url,
        branch: cloned.resolvedBranch,
        subpath: item.subpath,
        pinned_commit: cloned.commit,
        upstream_url: null,
      });
      addHistory(db, 'add', skill.id, { url: ref.url, commit: cloned.commit, branch: cloned.resolvedBranch });
      added.push({ name, commit: cloned.commit, branch: cloned.resolvedBranch });
    }
    return { added, available: discovered.map((d) => d.name) };
  } finally {
    cleanupTemp(cloned.dir);
  }
}

// ---- check ----

function remoteHead(ctx: Ctx, ref: RepoRef, branch: string): string {
  const output = git(['ls-remote', ref.url, branch], { timeoutMs: 60_000 });
  const lines = output.split('\n').filter(Boolean);
  const hit = lines.find((line) => line.trim().endsWith(`refs/heads/${branch}`));
  const chosen = (hit ?? lines[0]) ?? '';
  const sha = chosen.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`unexpected ls-remote output: ${output.slice(0, 200)}`);
  return sha;
}

export interface CheckResult {
  skill: string;
  status: 'up_to_date' | 'update_available' | 'error' | 'skipped';
  remoteCommit?: string;
  detail?: string;
}

export function checkSkill(ctx: Ctx, db: DatabaseSync, skill: SkillRow): CheckResult {
  const source = getSource(db, skill.id);
  if (!source) return { skill: skill.name, status: 'skipped', detail: 'local skill, no upstream source' };
  try {
    const ref = parseRepoRef(source.url, ctx);
    const remote = remoteHead(ctx, ref, source.branch || 'HEAD');
    const status = remote === source.pinned_commit ? 'up_to_date' : 'update_available';
    recordUpdateCheck(db, skill.id, remote, status);
    return { skill: skill.name, status, remoteCommit: remote };
  } catch (error) {
    recordUpdateCheck(db, skill.id, '', 'error', (error as Error).message);
    return { skill: skill.name, status: 'error', detail: (error as Error).message };
  }
}

export function checkAll(ctx: Ctx, db: DatabaseSync, names?: string[]): CheckResult[] {
  const skills = names && names.length > 0
    ? names.map((n) => ensureSkill(ctx, db, n))
    : listSkills(db);
  return skills.map((skill) => checkSkill(ctx, db, skill));
}

// ---- backup / update / rollback ----

/** 把 canonical 中的 skill 当前内容备份到 .registry/backups/<skill>/<label>/。 */
export function backupSkill(ctx: Ctx, skill: SkillRow, label: string): string {
  const dest = join(ctx.backupDir, skill.name, label);
  if (existsSync(dest)) throw new Error(`backup already exists: ${dest}`);
  mkdirSync(dest, { recursive: true });
  cpSync(skill.local_path, dest, { recursive: true });
  return dest;
}

export function listBackups(ctx: Ctx, skillName: string): string[] {
  const dir = join(ctx.backupDir, skillName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

export interface UpdateResult {
  skill: string;
  updated: boolean;
  commit?: string;
  diff?: { added: string[]; removed: string[]; changed: string[] };
  redeployed?: string[];
  backup?: string;
  message?: string;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12) || 'unknown';
}

/**
 * 用准备好的新版本目录替换 canonical（Diff → Backup → Replace → 重拷 copy 部署）。
 * junction/symlink 指向 canonical，自动生效，无需处理。
 */
export function applyUpdateFromDir(
  ctx: Ctx,
  db: DatabaseSync,
  skill: SkillRow,
  newDir: string,
  newCommit: string,
  newDescription?: string,
): UpdateResult {
  const diff = diffTrees(skill.local_path, newDir);
  const source = getSource(db, skill.id);
  const backupLabel = source?.pinned_commit ? shortSha(source.pinned_commit) : `local-${nowIso().replace(/[:.]/g, '-')}`;
  const backup = backupSkill(ctx, skill, backupLabel);
  rmSync(skill.local_path, { recursive: true, force: true });
  cpSync(newDir, skill.local_path, { recursive: true });
  const updated = upsertSkill(db, {
    name: skill.name,
    local_path: skill.local_path,
    description: newDescription ?? skill.description,
    content_hash: treeHash(skill.local_path),
  }, skill.type);
  if (source) setPinnedCommit(db, skill.id, newCommit);
  recordUpdateCheck(db, skill.id, newCommit, 'up_to_date');
  addHistory(db, 'update', skill.id, { commit: newCommit, backup, changed: diff.changed.length });

  const redeployed: string[] = [];
  for (const dep of listDeployments(db, skill.id)) {
    if (dep.mode !== 'copy') continue;
    const agent = ctx.agents.find((a) => a.id === dep.agent_id);
    if (!agent) continue;
    const cls = classifyTarget(dep.target_path, updated.local_path, skill.name);
    if (cls.managed && !cls.healthy) {
      const outcome = deployOne(ctx, db, updated, agent, 'copy');
      if (outcome.ok) redeployed.push(agent.id);
    }
  }
  return { skill: skill.name, updated: true, commit: newCommit, diff, redeployed, backup };
}

export function updateSkill(ctx: Ctx, db: DatabaseSync, name: string): UpdateResult {
  const skill = ensureSkill(ctx, db, name);
  const source = getSource(db, skill.id);
  if (!source) return { skill: name, updated: false, message: 'local skill, no upstream source to update' };
  const ref = parseRepoRef(source.url, ctx);
  const cloned = cloneToTemp(ctx, ref, source.branch || undefined);
  try {
    const found = discoverSkillDirs(cloned.dir).find((d) => d.name === name || d.subpath === source.subpath);
    if (!found) throw new Error(`not found in the upstream repository: ${name} (subpath=${source.subpath}) — it may have been renamed or removed upstream`);
    if (cloned.commit === source.pinned_commit) {
      recordUpdateCheck(db, skill.id, cloned.commit, 'up_to_date');
      return { skill: name, updated: false, message: 'already up to date', commit: cloned.commit };
    }
    return applyUpdateFromDir(ctx, db, skill, found.dir, cloned.commit, found.description);
  } finally {
    cleanupTemp(cloned.dir);
  }
}

export interface RollbackResult {
  skill: string;
  restoredFrom: string;
  message?: string;
}

export function rollbackSkill(ctx: Ctx, db: DatabaseSync, name: string, version?: string): RollbackResult {
  const skill = ensureSkill(ctx, db, name);
  const versions = listBackups(ctx, name);
  if (versions.length === 0) throw new Error(`no backups available: ${name}`);
  const chosen = version ?? versions[0];
  if (!versions.includes(chosen)) throw new Error(`backup not found: ${chosen}. Available: ${versions.join(', ')}`);
  const backupDir = join(ctx.backupDir, name, chosen);
  // 回滚前先备份当前状态，保证回滚本身可逆
  backupSkill(ctx, skill, `pre-rollback-${nowIso().replace(/[:.]/g, '-')}`);
  rmSync(skill.local_path, { recursive: true, force: true });
  cpSync(backupDir, skill.local_path, { recursive: true });
  const updated = upsertSkill(db, {
    name,
    local_path: skill.local_path,
    description: skill.description,
    content_hash: treeHash(skill.local_path),
  });
  if (chosen.match(/^[0-9a-f]{7,40}$/)) {
    const source = getSource(db, skill.id);
    if (source) setPinnedCommit(db, skill.id, chosen);
  }
  addHistory(db, 'rollback', updated.id, { restoredFrom: chosen });
  return { skill: name, restoredFrom: chosen };
}

/** skill 详情（registry 可回答的五个问题）。 */
export function skillDetail(ctx: Ctx, db: DatabaseSync, name: string) {
  const skill = getSkillByName(db, name) ?? ensureSkill(ctx, db, name);
  const source = getSource(db, skill.id);
  const check = getUpdateCheck(db, skill.id);
  const deps = listDeployments(db, skill.id);
  return {
    name: skill.name,
    type: skill.type,
    description: skill.description,
    localPath: skill.local_path,
    contentHash: skill.content_hash,
    updatedAt: skill.updated_at,
    source: source
      ? { kind: source.kind, url: source.url, branch: source.branch, subpath: source.subpath, commit: source.pinned_commit }
      : null,
    update: check ? { status: check.status, checkedAt: check.checked_at, remoteCommit: check.remote_commit, detail: check.detail } : null,
    deployments: deps.map((d) => ({ agent: d.agent_id, mode: d.mode, path: d.target_path, at: d.deployed_at })),
    backups: listBackups(ctx, skill.name),
  };
}
