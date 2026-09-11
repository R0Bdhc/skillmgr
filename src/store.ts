import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import type { Ctx } from './config.ts';
import { treeHash } from './util.ts';
import type { DatabaseSync } from 'node:sqlite';
import { deleteSkill, listSkills, upsertSkill } from './registry.ts';

export interface SkillDirInfo {
  name: string;
  path: string;
  description: string;
  contentHash: string;
}

function readDescription(skillMd: string): string {
  try {
    return parseFrontmatter(readFileSync(skillMd, 'utf8')).attrs.description ?? '';
  } catch {
    return '';
  }
}

/**
 * 扫描 canonical store：每个含 SKILL.md 的一级子目录视为一个 skill。
 * INDEX.md、.registry 等非 skill 条目自动跳过。
 */
export function scanStore(ctx: Ctx): SkillDirInfo[] {
  const skills: SkillDirInfo[] = [];
  for (const entry of readdirSync(ctx.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const dir = join(ctx.root, entry.name);
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd) || !statSync(skillMd).isFile()) continue;
    skills.push({
      name: entry.name,
      path: dir,
      description: readDescription(skillMd),
      contentHash: treeHash(dir),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkillDir(ctx: Ctx, name: string): SkillDirInfo | undefined {
  const dir = join(ctx.root, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return undefined;
  return { name, path: dir, description: readDescription(skillMd), contentHash: treeHash(dir) };
}

/**
 * 把 store 中的 skill 同步进 registry：新增/更新本地信息，
 * 已有记录的 type/source/deployments 保持不变；store 中已消失的 skill 从 registry 移除。
 */
export function syncStoreToRegistry(
  ctx: Ctx,
  db: DatabaseSync,
): { added: number; updated: number; removed: string[] } {
  const before = new Map(listSkills(db).map((s) => [s.name, s.content_hash]));
  const onDisk = scanStore(ctx);
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  for (const skill of onDisk) {
    seen.add(skill.name);
    upsertSkill(db, {
      name: skill.name,
      local_path: skill.path,
      description: skill.description,
      content_hash: skill.contentHash,
    });
    const oldHash = before.get(skill.name);
    if (oldHash === undefined) added += 1;
    else if (oldHash !== skill.contentHash) updated += 1;
  }
  const removed: string[] = [];
  for (const row of listSkills(db)) {
    if (!seen.has(row.name)) {
      deleteSkill(db, row.id);
      removed.push(row.name);
    }
  }
  return { added, updated, removed };
}
