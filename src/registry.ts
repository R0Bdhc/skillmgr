import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './util.ts';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    local_path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'local',
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    skill_id INTEGER PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    subpath TEXT NOT NULL DEFAULT '',
    pinned_commit TEXT NOT NULL DEFAULT '',
    upstream_url TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS deployments (
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    target_path TEXT NOT NULL,
    deployed_content_hash TEXT NOT NULL DEFAULT '',
    deployed_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS update_checks (
    skill_id INTEGER PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    remote_commit TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL
  )`,
];

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.prepare('PRAGMA foreign_keys = ON').run();
  for (const statement of SCHEMA_STATEMENTS) db.prepare(statement).run();
  return db;
}

export interface SkillRow {
  id: number;
  name: string;
  local_path: string;
  description: string;
  type: string;
  content_hash: string;
  updated_at: string;
}

export interface SourceRow {
  skill_id: number;
  kind: string;
  url: string;
  branch: string;
  subpath: string;
  pinned_commit: string;
  upstream_url: string | null;
}

export interface DeploymentRow {
  skill_id: number;
  agent_id: string;
  mode: string;
  target_path: string;
  deployed_content_hash: string;
  deployed_at: string;
}

export interface UpdateCheckRow {
  skill_id: number;
  checked_at: string;
  remote_commit: string;
  status: string;
  detail: string;
}

// ---- skills ----

export function upsertSkill(
  db: DatabaseSync,
  skill: Pick<SkillRow, 'name' | 'local_path' | 'description' | 'content_hash'>,
  type?: string,
): SkillRow {
  const existing = getSkillByName(db, skill.name);
  const now = nowIso();
  if (existing) {
    db.prepare(
      'UPDATE skills SET local_path = ?, description = ?, content_hash = ?, type = ?, updated_at = ? WHERE id = ?',
    ).run(skill.local_path, skill.description, skill.content_hash, type ?? existing.type, now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO skills (name, local_path, description, type, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(skill.name, skill.local_path, skill.description, type ?? 'local', skill.content_hash, now, now);
  }
  return getSkillByName(db, skill.name)!;
}

export function getSkillByName(db: DatabaseSync, name: string): SkillRow | undefined {
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as SkillRow | undefined;
}

export function listSkills(db: DatabaseSync): SkillRow[] {
  return db.prepare('SELECT * FROM skills ORDER BY name').all() as SkillRow[];
}

export function setSkillType(db: DatabaseSync, skillId: number, type: string): void {
  db.prepare('UPDATE skills SET type = ?, updated_at = ? WHERE id = ?').run(type, nowIso(), skillId);
}

export function deleteSkill(db: DatabaseSync, skillId: number): void {
  db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
}

// ---- sources ----

export function setSource(
  db: DatabaseSync,
  skillId: number,
  source: Omit<SourceRow, 'skill_id'>,
): void {
  db.prepare(
    `INSERT INTO sources (skill_id, kind, url, branch, subpath, pinned_commit, upstream_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       kind = excluded.kind, url = excluded.url, branch = excluded.branch,
       subpath = excluded.subpath, pinned_commit = excluded.pinned_commit,
       upstream_url = excluded.upstream_url`,
  ).run(skillId, source.kind, source.url, source.branch, source.subpath, source.pinned_commit, source.upstream_url);
}

export function getSource(db: DatabaseSync, skillId: number): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE skill_id = ?').get(skillId) as SourceRow | undefined;
}

export function setPinnedCommit(db: DatabaseSync, skillId: number, commit: string): void {
  db.prepare('UPDATE sources SET pinned_commit = ? WHERE skill_id = ?').run(commit, skillId);
}

// ---- deployments ----

export function upsertDeployment(
  db: DatabaseSync,
  skillId: number,
  agentId: string,
  mode: string,
  targetPath: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO deployments (skill_id, agent_id, mode, target_path, deployed_content_hash, deployed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_id, agent_id) DO UPDATE SET
       mode = excluded.mode, target_path = excluded.target_path,
       deployed_content_hash = excluded.deployed_content_hash,
       deployed_at = excluded.deployed_at`,
  ).run(skillId, agentId, mode, targetPath, contentHash, nowIso());
}

export function deleteDeployment(db: DatabaseSync, skillId: number, agentId: string): void {
  db.prepare('DELETE FROM deployments WHERE skill_id = ? AND agent_id = ?').run(skillId, agentId);
}

export function getDeployment(db: DatabaseSync, skillId: number, agentId: string): DeploymentRow | undefined {
  return db.prepare('SELECT * FROM deployments WHERE skill_id = ? AND agent_id = ?').get(skillId, agentId) as
    | DeploymentRow
    | undefined;
}

export function listDeployments(db: DatabaseSync, skillId?: number): DeploymentRow[] {
  if (skillId === undefined) {
    return db.prepare('SELECT * FROM deployments ORDER BY agent_id, skill_id').all() as DeploymentRow[];
  }
  return db.prepare('SELECT * FROM deployments WHERE skill_id = ?').all(skillId) as DeploymentRow[];
}

// ---- update checks ----

export function recordUpdateCheck(
  db: DatabaseSync,
  skillId: number,
  remoteCommit: string,
  status: string,
  detail = '',
): void {
  db.prepare(
    `INSERT INTO update_checks (skill_id, checked_at, remote_commit, status, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       checked_at = excluded.checked_at, remote_commit = excluded.remote_commit,
       status = excluded.status, detail = excluded.detail`,
  ).run(skillId, nowIso(), remoteCommit, status, detail);
}

export function getUpdateCheck(db: DatabaseSync, skillId: number): UpdateCheckRow | undefined {
  return db.prepare('SELECT * FROM update_checks WHERE skill_id = ?').get(skillId) as UpdateCheckRow | undefined;
}

// ---- history ----

export function addHistory(
  db: DatabaseSync,
  action: string,
  skillId: number | null,
  detail: Record<string, unknown> = {},
): void {
  db.prepare('INSERT INTO history (skill_id, action, detail, at) VALUES (?, ?, ?, ?)').run(
    skillId,
    action,
    JSON.stringify(detail),
    nowIso(),
  );
}

export function listHistory(db: DatabaseSync, limit = 30): Array<{
  id: number; action: string; skill_id: number | null; detail: string; at: string;
}> {
  return db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?').all(limit) as Array<{
    id: number; action: string; skill_id: number | null; detail: string; at: string;
  }>;
}
