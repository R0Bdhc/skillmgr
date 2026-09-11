import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadCtx } from '../src/config.ts';
import { openDb, listSkills, getSource } from '../src/registry.ts';
import { syncStoreToRegistry, scanStore } from '../src/store.ts';
import { deployOne, undeployOne, cellState, MANAGED_MARKER } from '../src/deploy.ts';
import { collectIssues, fixIssues } from '../src/doctor.ts';
import { applyUpdateFromDir, backupSkill, listBackups, rollbackSkill, updateSkill, checkSkill } from '../src/sources.ts';

/** 搭一个临时但结构完整的 Ctx：canonical store + 假 agent home。 */
function makeEnv(): { base: string; clean: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'skillmgr-e2e-'));
  const store = join(base, 'store');
  const agentHome = join(base, 'agent-home');
  mkdirSync(join(store, 'demo-skill'), { recursive: true });
  writeFileSync(join(store, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 测试技能\n---\n# demo\n');
  writeFileSync(join(store, 'demo-skill', 'notes.md'), 'v1');
  mkdirSync(agentHome, { recursive: true });
  process.env.SKILLMGR_ROOT = store;
  return { base, clean: () => { delete process.env.SKILLMGR_ROOT; rmSync(base, { recursive: true, force: true }); } };
}

function ctxOf(base: string) {
  // loadCtx 依赖 SKILLMGR_ROOT 环境变量指向临时目录，这里再注入自定义 agent
  const ctx = loadCtx();
  ctx.agents = [{
    id: 'fake-agent',
    label: 'Fake Agent',
    skillsDir: join(base, 'agent-home', 'skills'),
    detectPaths: [join(base, 'agent-home')],
  }];
  return ctx;
}

/** 统一的测试骨架：确保数据库句柄在清理目录前关闭（Windows 文件锁）。 */
function withEnv(fn: (env: { base: string; ctx: ReturnType<typeof loadCtx>; db: DatabaseSync }) => void): void {
  const env = makeEnv();
  const ctx = ctxOf(env.base);
  const db = openDb(ctx.dbPath);
  try {
    fn({ base: env.base, ctx, db });
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
    env.clean();
  }
}

test('e2e: scan -> deploy (junction) -> drift -> doctor -> undeploy', () => {
  withEnv(({ base, ctx, db }) => {
    // 扫描入库
    const scan = syncStoreToRegistry(ctx, db);
    assert.equal(scan.added, 1);
    const skill = listSkills(db)[0];
    assert.equal(skill.name, 'demo-skill');
    assert.equal(skill.type, 'local');
    assert.equal(scanStore(ctx).length, 1);

    // 自动模式部署（Windows 建 junction，POSIX 建 symlink，均为链接）
    const outcome = deployOne(ctx, db, skill, ctx.agents[0], 'auto');
    assert.ok(outcome.ok, `部署应成功: ${outcome.message}`);
    assert.ok(outcome.mode === 'junction' || outcome.mode === 'symlink', `应为链接模式，实际 ${outcome.mode}`);
    const target = join(base, 'agent-home', 'skills', 'demo-skill');
    assert.ok(lstatSync(target).isSymbolicLink(), '目标应为链接');
    assert.ok(existsSync(join(target, 'SKILL.md')), '链接应可透传读取 SKILL.md');

    // 状态：ok
    let cell = cellState(db, skill, ctx.agents[0]);
    assert.equal(cell.state, 'ok');

    // 链接模式：canonical 变更自动生效，不算漂移
    writeFileSync(join(ctx.root, 'demo-skill', 'notes.md'), 'v2');
    cell = cellState(db, skill, ctx.agents[0]);
    assert.equal(cell.state, 'ok');

    // 手动删除链接 → missing → doctor 修复
    rmSync(target, { recursive: true, force: true });
    cell = cellState(db, skill, ctx.agents[0]);
    assert.equal(cell.state, 'missing');
    const issues = collectIssues(ctx, db);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'missing');
    const { fixed } = fixIssues(ctx, db);
    assert.equal(fixed.length, 1);
    assert.equal(cellState(db, skill, ctx.agents[0]).state, 'ok');

    // 强制 copy 模式重部署 → 修改 canonical → copy 漂移
    const outcome2 = deployOne(ctx, db, skill, ctx.agents[0], 'copy');
    assert.ok(outcome2.ok, `copy 重部署失败: ${outcome2.message ?? '未知原因'}`);
    assert.equal(outcome2.mode, 'copy');
    assert.ok(existsSync(join(target, MANAGED_MARKER)));
    assert.ok(!lstatSync(target).isSymbolicLink(), 'copy 模式不应是链接');
    writeFileSync(join(ctx.root, 'demo-skill', 'notes.md'), 'v3');
    cell = cellState(db, skill, ctx.agents[0]);
    assert.equal(cell.state, 'drift');

    // foreign 保护：非受管目录不可覆盖、不可删除
    const removed = undeployOne(ctx, db, skill, ctx.agents[0]);
    assert.ok(removed.ok);
    assert.ok(!existsSync(target), '取消部署后目标应消失');
    mkdirSync(join(target, 'scripts'), { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'user content');
    const refused = deployOne(ctx, db, skill, ctx.agents[0], 'copy');
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? '', /refusing to overwrite/);
    const refusedRemove = undeployOne(ctx, db, skill, ctx.agents[0]);
    assert.equal(refusedRemove.ok, false);
    assert.match(refusedRemove.message ?? '', /refusing to delete/);
    assert.ok(existsSync(join(target, 'SKILL.md')), 'foreign 内容必须原样保留');
    rmSync(target, { recursive: true, force: true });
  });
});

test('backup and rollback', () => {
  withEnv(({ base, ctx, db }) => {
    syncStoreToRegistry(ctx, db);
    const skill = listSkills(db)[0];

    const backup1 = backupSkill(ctx, skill, 'v1');
    assert.ok(existsSync(join(backup1, 'SKILL.md')));
    assert.deepEqual(listBackups(ctx, 'demo-skill'), ['v1']);

    // 修改 canonical 后回滚
    writeFileSync(join(ctx.root, 'demo-skill', 'notes.md'), 'changed');
    const result = rollbackSkill(ctx, db, 'demo-skill', 'v1');
    assert.equal(result.restoredFrom, 'v1');
    assert.equal(readFileSync(join(ctx.root, 'demo-skill', 'notes.md'), 'utf8'), 'v1');

    // 回滚前会自动再备份当前状态
    assert.equal(listBackups(ctx, 'demo-skill').length, 2);

    assert.throws(() => rollbackSkill(ctx, db, 'demo-skill', 'nope'), /backup not found/);
    void base;
  });
});

test('local skill without upstream: check skips, update reports', () => {
  withEnv(({ ctx, db }) => {
    syncStoreToRegistry(ctx, db);
    const skill = listSkills(db)[0];
    const check = checkSkill(ctx, db, skill);
    assert.equal(check.status, 'skipped');
    const update = updateSkill(ctx, db, 'demo-skill');
    assert.equal(update.updated, false);
    assert.match(update.message ?? '', /local/);
    assert.equal(getSource(db, skill.id), undefined);
  });
});

test('copy-mode deployment is re-copied after applyUpdateFromDir', () => {
  withEnv(({ base, ctx, db }) => {
    syncStoreToRegistry(ctx, db);
    const skill = listSkills(db)[0];

    // copy 模式部署到假 agent
    const outcome = deployOne(ctx, db, skill, ctx.agents[0], 'copy');
    assert.ok(outcome.ok, `copy 部署失败: ${outcome.message ?? '未知原因'}`);

    // 构造"上游 v2"目录并应用更新
    const upstream = join(base, 'upstream-v2');
    mkdirSync(upstream, { recursive: true });
    writeFileSync(join(upstream, 'SKILL.md'), '---\nname: demo-skill\ndescription: 测试技能 v2\n---\n# demo\n');
    writeFileSync(join(upstream, 'notes.md'), 'upstream-v2');
    writeFileSync(join(upstream, 'new-file.md'), 'brand new');

    const result = applyUpdateFromDir(ctx, db, skill, upstream, 'a'.repeat(40), '测试技能 v2');
    assert.ok(result.updated);
    assert.deepEqual(result.diff?.added, ['new-file.md']);
    assert.ok(result.redeployed?.includes('fake-agent'), 'copy 部署应被重拷');

    // canonical 与部署目标都已是 v2，且目标是 copy（非链接）
    const target = join(base, 'agent-home', 'skills', 'demo-skill');
    assert.equal(readFileSync(join(target, 'notes.md'), 'utf8'), 'upstream-v2');
    assert.ok(existsSync(join(target, MANAGED_MARKER)));
    assert.ok(!lstatSync(target).isSymbolicLink());
    assert.equal(cellState(db, listSkills(db)[0], ctx.agents[0]).state, 'ok');

    // 备份里应有更新前的版本
    assert.ok(listBackups(ctx, 'demo-skill').length >= 1);
  });
});
