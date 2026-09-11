import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, sep } from 'node:path';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function fileHash(path: string): string {
  return sha256Bytes(readFileSync(path));
}

const IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv']);
const IGNORED_SUFFIXES = new Set(['.pyc', '.pyo']);

/** 递归列出 root 下所有文件的 POSIX 风格相对路径（排序稳定）。 */
export function listFiles(root: string, extraIgnore: string[] = []): string[] {
  const ignore = new Set(extraIgnore);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignore.has(rel)) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (IGNORED_SUFFIXES.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) continue;
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

/** 目录内容指纹：与 skill_lifecycle.py 的 tree_hash 同思路，用于漂移检测。 */
export function treeHash(root: string, extraIgnore: string[] = []): string {
  const digest = createHash('sha256');
  for (const rel of listFiles(root, extraIgnore)) {
    digest.update(Buffer.from(rel, 'utf8'));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(fileHash(join(root, rel)), 'ascii'));
    digest.update(Buffer.from([0x0a]));
  }
  return digest.digest('hex');
}

/** 仅统计文件总字节数，用于展示。 */
export function treeSize(root: string): number {
  let total = 0;
  for (const rel of listFiles(root)) {
    total += statSync(join(root, rel)).size;
  }
  return total;
}

export function pathEq(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, sep).replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function isSubpath(parent: string, child: string): boolean {
  const rel = child.toLowerCase().replace(/\//g, sep);
  const par = parent.toLowerCase().replace(/\//g, sep);
  return rel.startsWith(par.endsWith(sep) ? par : par + sep);
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** 两个目录的内容差异（按相对路径与内容 hash 比较），用于 update 前的 diff 摘要。 */
export function diffTrees(aRoot: string, bRoot: string): {
  added: string[]; removed: string[]; changed: string[];
} {
  const a = new Map(listFiles(aRoot).map((rel) => [rel, fileHash(join(aRoot, rel))]));
  const b = new Map(listFiles(bRoot).map((rel) => [rel, fileHash(join(bRoot, rel))]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [rel, hash] of b) {
    if (!a.has(rel)) added.push(rel);
    else if (a.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of a.keys()) if (!b.has(rel)) removed.push(rel);
  return { added, removed, changed };
}
