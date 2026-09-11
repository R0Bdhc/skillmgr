import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveExtraAgent } from '../src/config.ts';
import { renderMatrix, type MatrixRow } from '../src/status.ts';
import { buildFrame, ensureTTY, filteredRows, manageEntries, monitorAgents, monitorRowAt, suggestAgentId, MENU_ITEMS, type TuiState } from '../src/tui/app.ts';
import type { CellState } from '../src/status.ts';
import type { AgentSpec, Ctx } from '../src/config.ts';

/** 真实临时目录：connected 目录存在（检测通过），ghost 不存在（未连接）。 */
function makeDetectionFixture(): { connected: AgentSpec; ghost: AgentSpec; clean: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'skillmgr-tui-'));
  const connectedDir = join(base, 'connected');
  mkdirSync(connectedDir, { recursive: true });
  return {
    connected: { id: 'connected', label: 'Connected', skillsDir: connectedDir, detectPaths: [connectedDir] },
    ghost: { id: 'ghost', label: 'Ghost', skillsDir: join(base, 'ghost'), detectPaths: [join(base, 'ghost')] },
    clean: () => rmSync(base, { recursive: true, force: true }),
  };
}

const FIX = makeDetectionFixture();
const AGENTS: AgentSpec[] = [FIX.connected, FIX.ghost];

function mkRow(name: string, cells: Record<string, CellState> = {}, updateStatus: MatrixRow['updateStatus'] = 'unchecked'): MatrixRow {
  const full: Record<string, { state: CellState; mode?: string; detail: string }> = {};
  for (const agent of AGENTS) {
    const state = cells[agent.id] ?? 'not-deployed';
    full[agent.id] = { state, mode: state === 'ok' || state === 'drift' ? 'junction' : undefined, detail: '' };
  }
  return {
    skill: {
      id: name.length,
      name,
      local_path: `/store/${name}`,
      description: 'test',
      type: 'local',
      content_hash: 'deadbeef',
      updated_at: '2026-01-01',
    },
    updateStatus,
    cells: full,
  };
}

function fakeState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    ctx: { root: '/fake/store', agents: AGENTS } as unknown as Ctx,
    root: '/fake/store',
    version: 'test',
    rows: [mkRow('alpha', { connected: 'ok' }), mkRow('Beta-skill', {})],
    mode: 'menu',
    helpReturn: 'menu',
    menuCursor: 0,
    agentCursor: 0,
    manageCursor: 0,
    monitorCursor: { r: 0 },
    currentAgent: null,
    filter: { active: false, text: '' },
    status: { text: '', ok: true },
    input: null,
    ...overrides,
  };
}

test('menu items: management, monitor, add agent', () => {
  assert.deepEqual([...MENU_ITEMS], ['Skills Management', 'Skills Status Monitor', 'Add Agent']);
  const frame = buildFrame(fakeState());
  assert.match(frame, /Skills Management/);
  assert.match(frame, /Skills Status Monitor/);
  assert.match(frame, /Add Agent/);
});

test('monitorAgents only returns connected (detected) agents', () => {
  const ids = monitorAgents(fakeState({ mode: 'monitor' })).map((a) => a.id);
  assert.deepEqual(ids, ['connected']);
});

/** 剥离 ANSI 转义后断言纯文本内容（含 (#)、列对齐等）。 */
function plain(frame: string): string {
  return frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

test('monitor frame: connected-only, ASCII marks, (#) update marker, row navigation hints', () => {
  const text = plain(buildFrame(fakeState({
    mode: 'monitor',
    rows: [
      mkRow('fresh-skill', { connected: 'ok' }),
      mkRow('stale-skill', { connected: 'ok' }, 'update_available'),
    ],
  })));
  assert.match(text, /status monitor \(read-only\)/);
  assert.match(text, /fresh-skill/);
  assert.match(text, /stale-skill\(#\)/, '(#) 应紧跟名字');
  assert.match(text, /\*$/m); // 更新列的 update available 标记
  assert.match(text, /← menu/);
  // 对齐表格区（表头至数据行）禁用 Ambiguous Width 字符（bug 2 防回归）；
  // 页脚提示里的 · 分隔符与 ↑↓ 箭头是装饰，不参与对齐，不在守卫范围
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('skill'));
  const end = lines.findIndex((l) => l.trim() === '', start);
  const table = lines.slice(start, end === -1 ? undefined : end).join('\n');
  assert.doesNotMatch(table, /[✓·×↑]/);
  assert.doesNotMatch(table, /ghost/, '未连接 agent 不应出现在监视矩阵');
  assert.doesNotMatch(table, /undefined/, '配色查找不得产生 undefined');
});

test('monitor frame hints when no agents are connected', () => {
  const empty = buildFrame(fakeState({
    mode: 'monitor',
    ctx: { root: '/fake/store', agents: [FIX.ghost] } as unknown as Ctx,
  }));
  assert.match(empty, /no connected agents — use "Add Agent" in the main menu/);
});

test('suggestAgentId derives id from the parent directory name', () => {
  assert.equal(suggestAgentId('/home/u/.myagent/skills'), 'myagent');
  assert.equal(suggestAgentId('/opt/tools/my agent/skills/'), 'my-agent');
  assert.equal(suggestAgentId('/x'), 'agent');
});

test('manage frame renders the m×1 yes/no list for the chosen agent', () => {
  const frame = buildFrame(fakeState({
    mode: 'manage',
    currentAgent: AGENTS[0],
    rows: [mkRow('alpha', { connected: 'ok' }), mkRow('Beta-skill', {})],
  }));
  assert.match(frame, /skills management — Connected/);
  assert.match(frame, /\byes\b/);
  assert.match(frame, /\bno\b/);
  assert.match(frame, /\x1b\[7m/);
  assert.doesNotMatch(frame, /ghost/);
});

test('manageEntries reduces cell states to binary yes/no with notes', () => {
  const state = fakeState({
    mode: 'manage',
    currentAgent: AGENTS[0],
    rows: [
      mkRow('ok-skill', { connected: 'ok' }),
      mkRow('drift-skill', { connected: 'drift' }),
      mkRow('missing-skill', { connected: 'missing' }),
      mkRow('gone-skill', {}),
      mkRow('locked-skill', { connected: 'foreign' }),
    ],
  });
  const entries = manageEntries(state);
  assert.deepEqual(entries.map((e) => e.active), [true, true, false, false, false]);
  assert.match(entries[1].note, /drift/);
  assert.match(entries[2].note, /missing/);
  assert.match(entries[4].note, /unmanaged/);
  assert.equal(entries[3].note, '');
});

test('filteredRows matches skill names case-insensitively', () => {
  const state = fakeState({ filter: { active: true, text: 'ALP' } });
  assert.equal(filteredRows(state).length, 1);
  assert.equal(filteredRows(state)[0].skill.name, 'alpha');
  assert.equal(filteredRows(fakeState({ filter: { active: true, text: 'nope' } })).length, 0);
  assert.equal(filteredRows(fakeState()).length, 2);
});

test('monitorRowAt clamps to the visible rows', () => {
  const state = fakeState({ mode: 'monitor', monitorCursor: { r: 99 } });
  assert.equal(monitorRowAt(state)?.skill.name, 'Beta-skill');
  assert.equal(monitorRowAt(fakeState({ mode: 'monitor', rows: [] })), null);
});

test('CLI renderMatrix: ASCII marks, (#) marker, updated legend', () => {
  const ctx = { agents: AGENTS } as unknown as Ctx;
  const out = renderMatrix(ctx, [
    mkRow('fresh-skill', { connected: 'ok' }),
    mkRow('stale-skill', { connected: 'drift' }, 'update_available'),
  ]);
  assert.match(out, /fresh-skill/);
  assert.match(out, /stale-skill\(#\)/);
  assert.match(out, /Y\(jun\)/);
  assert.match(out, /!\(jun\)/); // drift 单元格仍带部署模式后缀
  assert.match(out, /Legend: Y deployed/);
  assert.match(out, /\*$/m); // update available 列标记
  assert.doesNotMatch(out, /[✓·×↑]/);
});

test('saveExtraAgent persists to store config and rejects duplicates', () => {
  const base = mkdtempSync(join(tmpdir(), 'skillmgr-saveagent-'));
  try {
    const ctx = { registryDir: join(base, '.registry'), agents: [] } as unknown as Ctx;
    saveExtraAgent(ctx, { id: 'hermes', label: 'Hermes', skillsDir: join(base, 'hermes', 'skills'), detectPaths: [join(base, 'hermes')] });
    const cfgPath = join(base, '.registry', 'config.json');
    assert.ok(existsSync(cfgPath));
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg.extraAgents[0].id, 'hermes');

    assert.throws(
      () => saveExtraAgent(ctx, { id: 'hermes', label: 'X', skillsDir: join(base, 'other'), detectPaths: [] }),
      /agent id already exists/,
    );
    assert.throws(
      () => saveExtraAgent(ctx, { id: 'other', label: 'X', skillsDir: join(base, 'hermes', 'skills'), detectPaths: [] }),
      /already uses this skills directory/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensureTTY rejects non-interactive streams', () => {
  assert.throws(() => ensureTTY({ isTTY: false }, { isTTY: true }), /TTY/);
  assert.throws(() => ensureTTY({ isTTY: true }, { isTTY: false }), /TTY/);
  assert.doesNotThrow(() => ensureTTY({ isTTY: true }, { isTTY: true }));
});
