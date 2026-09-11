import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFrame, cellAt, ensureTTY, filteredRows, type TuiState } from '../src/tui/app.ts';
import type { MatrixRow } from '../src/status.ts';
import type { AgentSpec, Ctx } from '../src/config.ts';

const AGENTS: AgentSpec[] = [
  { id: 'fake-agent', label: 'Fake', skillsDir: '/x/fake', detectPaths: [] },
  { id: 'other-agent', label: 'Other', skillsDir: '/x/other', detectPaths: [] },
];

function mkRow(name: string): MatrixRow {
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
    cells: {
      'fake-agent': { state: 'ok', mode: 'junction', detail: '' },
      'other-agent': { state: 'not-deployed', detail: 'not deployed' },
    },
  };
}

function fakeState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    ctx: { root: '/fake/store', agents: AGENTS } as unknown as Ctx,
    root: '/fake/store',
    version: 'test',
    rows: [mkRow('alpha'), mkRow('Beta-skill')],
    cursor: { r: 0, c: 0 },
    filter: { active: false, text: '' },
    status: { text: '', ok: true },
    mode: 'matrix',
    input: null,
    ...overrides,
  };
}

test('buildFrame renders title, rows, selected cell inverse and key hints', () => {
  const frame = buildFrame(fakeState());
  assert.match(frame, /skillmgr — \/fake\/store/);
  assert.match(frame, /alpha/);
  assert.match(frame, /Beta-skill/);
  assert.match(frame, /fake-agent/);
  assert.match(frame, /enter\/space toggle/);
  // 光标 (0,0)：第一行第一格应为反色高亮
  assert.match(frame, /\x1b\[7m/);
});

test('buildFrame shows empty-store hint and input mode prompt', () => {
  const empty = buildFrame(fakeState({ rows: [] }));
  assert.match(empty, /store is empty/);

  const input = buildFrame(fakeState({ input: { step: 'repo', repo: '', prompt: 'repo (owner/repo):', buffer: 'anthropics' } }));
  assert.match(input, /repo \(owner\/repo\):/);
  assert.match(input, /anthropics/);
});

test('filteredRows matches skill names case-insensitively', () => {
  const state = fakeState({ filter: { active: true, text: 'ALP' } });
  const rows = filteredRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skill.name, 'alpha');

  assert.equal(filteredRows(fakeState({ filter: { active: true, text: 'nope' } })).length, 0);
  assert.equal(filteredRows(fakeState()).length, 2);
});

test('cellAt clamps the cursor to the visible matrix', () => {
  const at = cellAt(fakeState({ cursor: { r: 0, c: 1 } }));
  assert.equal(at?.agent.id, 'other-agent');
  const clamped = cellAt(fakeState({ cursor: { r: 99, c: 99 } }));
  assert.equal(clamped?.row.skill.name, 'Beta-skill');
  assert.equal(clamped?.agent.id, 'other-agent');
  assert.equal(cellAt(fakeState({ rows: [] })), null);
});

test('ensureTTY rejects non-interactive streams', () => {
  assert.throws(() => ensureTTY({ isTTY: false }, { isTTY: true }), /TTY/);
  assert.throws(() => ensureTTY({ isTTY: true }, { isTTY: false }), /TTY/);
  assert.doesNotThrow(() => ensureTTY({ isTTY: true }, { isTTY: true }));
});
