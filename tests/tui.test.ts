import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFrame, cellAt, ensureTTY, filteredRows, manageEntries, MENU_ITEMS, type TuiState } from '../src/tui/app.ts';
import type { MatrixRow, CellState } from '../src/status.ts';
import type { AgentSpec, Ctx } from '../src/config.ts';

const AGENTS: AgentSpec[] = [
  { id: 'fake-agent', label: 'Fake', skillsDir: '/x/fake', detectPaths: [] },
  { id: 'other-agent', label: 'Other', skillsDir: '/x/other', detectPaths: [] },
];

function mkRow(name: string, cells: Record<string, CellState>): MatrixRow {
  const full: Record<string, { state: CellState; mode?: string; detail: string }> = {};
  for (const agent of AGENTS) {
    const state = cells[agent.id] ?? 'not-deployed';
    full[agent.id] = { state, mode: state === 'ok' ? 'junction' : undefined, detail: '' };
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
    updateStatus: 'unchecked',
    cells: full,
  };
}

function fakeState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    ctx: { root: '/fake/store', agents: AGENTS } as unknown as Ctx,
    root: '/fake/store',
    version: 'test',
    rows: [mkRow('alpha', { 'fake-agent': 'ok' }), mkRow('Beta-skill', {})],
    mode: 'menu',
    helpReturn: 'menu',
    menuCursor: 0,
    agentCursor: 0,
    manageCursor: 0,
    monitorCursor: { r: 0, c: 0 },
    currentAgent: null,
    filter: { active: false, text: '' },
    status: { text: '', ok: true },
    input: null,
    ...overrides,
  };
}

test('menu frame lists the two entries with the selected one highlighted', () => {
  const frame = buildFrame(fakeState());
  assert.match(frame, /skillmgr · main menu/);
  assert.match(frame, /Skills Management/);
  assert.match(frame, /Skills Status Monitor/);
  assert.match(frame, /\x1b\[7m/);
  // 默认选中第一项：Skills Management 应出现在反色片段内
  const inverseChunk = frame.split('\x1b[7m')[1]?.split('\x1b[0m')[0] ?? '';
  assert.match(inverseChunk, /Skills Management/);
});

test('agents frame lists every agent of the store config', () => {
  const frame = buildFrame(fakeState({ mode: 'agents' }));
  assert.match(frame, /skills management — pick an agent/);
  assert.match(frame, /fake-agent/);
  assert.match(frame, /other-agent/);
});

test('manageEntries reduces cell states to binary yes/no with notes', () => {
  const state = fakeState({
    mode: 'manage',
    currentAgent: AGENTS[0],
    rows: [
      mkRow('ok-skill', { 'fake-agent': 'ok' }),
      mkRow('drift-skill', { 'fake-agent': 'drift' }),
      mkRow('missing-skill', { 'fake-agent': 'missing' }),
      mkRow('gone-skill', {}),
      mkRow('locked-skill', { 'fake-agent': 'foreign' }),
    ],
  });
  const entries = manageEntries(state);
  assert.deepEqual(entries.map((e) => e.active), [true, true, false, false, false]);
  assert.match(entries[1].note, /drift/);
  assert.match(entries[2].note, /missing/);
  assert.match(entries[4].note, /unmanaged/);
  assert.equal(entries[3].note, '');
});

test('manage frame renders the m×1 yes/no list for the chosen agent', () => {
  const frame = buildFrame(fakeState({
    mode: 'manage',
    currentAgent: AGENTS[0],
    rows: [mkRow('alpha', { 'fake-agent': 'ok' }), mkRow('Beta-skill', {})],
  }));
  assert.match(frame, /skills management — Fake/);
  assert.match(frame, /\byes\b/);
  assert.match(frame, /\bno\b/);
  assert.match(frame, /\x1b\[7m/);
  // manage 视图不显示其他 agent 的列名
  assert.doesNotMatch(frame, /other-agent/);
});

test('monitor frame stays read-only with the full matrix', () => {
  const frame = buildFrame(fakeState({
    mode: 'monitor',
    monitorCursor: { r: 0, c: 0 },
    rows: [mkRow('alpha', { 'fake-agent': 'ok' }), mkRow('Beta-skill', {})],
  }));
  assert.match(frame, /status monitor \(read-only\)/);
  assert.match(frame, /alpha/);
  assert.match(frame, /fake-agent/);
  assert.match(frame, /other-agent/);
  assert.match(frame, /\x1b\[7m/);
  assert.doesNotMatch(frame, /enter\/space toggle/, 'monitor 不应出现管理键位');
});

test('filteredRows matches skill names case-insensitively', () => {
  const state = fakeState({ filter: { active: true, text: 'ALP' } });
  assert.equal(filteredRows(state).length, 1);
  assert.equal(filteredRows(state)[0].skill.name, 'alpha');
  assert.equal(filteredRows(fakeState({ filter: { active: true, text: 'nope' } })).length, 0);
  assert.equal(filteredRows(fakeState()).length, 2);
});

test('cellAt clamps the monitor cursor to the visible matrix', () => {
  const at = cellAt(fakeState({ mode: 'monitor', monitorCursor: { r: 0, c: 1 } }));
  assert.equal(at?.agent.id, 'other-agent');
  const clamped = cellAt(fakeState({ mode: 'monitor', monitorCursor: { r: 99, c: 99 } }));
  assert.equal(clamped?.row.skill.name, 'Beta-skill');
  assert.equal(clamped?.agent.id, 'other-agent');
  assert.equal(cellAt(fakeState({ mode: 'monitor', rows: [] })), null);
});

test('ensureTTY rejects non-interactive streams', () => {
  assert.throws(() => ensureTTY({ isTTY: false }, { isTTY: true }), /TTY/);
  assert.throws(() => ensureTTY({ isTTY: true }, { isTTY: false }), /TTY/);
  assert.doesNotThrow(() => ensureTTY({ isTTY: true }, { isTTY: true }));
});

test('menu items are exactly management and monitor', () => {
  assert.deepEqual([...MENU_ITEMS], ['Skills Management', 'Skills Status Monitor']);
});
