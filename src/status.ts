import type { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './config.ts';
import { shortAgentId } from './agents.ts';
import { getUpdateCheck, listSkills, type SkillRow } from './registry.ts';
import { cellState, type CellState } from './deploy.ts';

export interface MatrixCell {
  state: CellState;
  mode?: string;
  detail: string;
}

export interface MatrixRow {
  skill: SkillRow;
  updateStatus: 'up_to_date' | 'update_available' | 'error' | 'unchecked';
  checkedAt?: string;
  remoteCommit?: string;
  cells: Record<string, MatrixCell>;
}

export function buildMatrix(ctx: Ctx, db: DatabaseSync): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const skill of listSkills(db)) {
    const check = getUpdateCheck(db, skill.id);
    const cells: Record<string, MatrixCell> = {};
    for (const agent of ctx.agents) {
      cells[agent.id] = cellState(db, skill, agent);
    }
    rows.push({
      skill,
      updateStatus: (check?.status as MatrixRow['updateStatus']) ?? 'unchecked',
      checkedAt: check?.checked_at,
      remoteCommit: check?.remote_commit,
      cells,
    });
  }
  return rows;
}

// 对齐表格内一律使用宽度确定的 ASCII 符号：✓ · × ↑ 等属 Unicode Ambiguous Width，
// 中文环境终端按宽字符渲染而 pad 按 1 列计算，会导致后续列逐格错位。
const GLYPH: Record<CellState, string> = {
  ok: 'Y',
  drift: '!',
  missing: 'x',
  foreign: '?',
  'not-deployed': '.',
};

/** CLI 表格与 TUI 共用的单元格符号。 */
export function cellSymbol(state: CellState): string {
  return GLYPH[state];
}

/** 可更新 skill 的名字后缀标注（TUI 监视矩阵与 CLI 表格共用）。 */
export function updateMarker(row: MatrixRow): string {
  return row.updateStatus === 'update_available' ? '(#)' : '';
}

const UPDATE_GLYPH: Record<MatrixRow['updateStatus'], string> = {
  up_to_date: '=',
  update_available: '*',
  error: 'E',
  unchecked: ' ',
};

/** 显示宽度：CJK/全角按 2 列计；对齐区已保证不含 Ambiguous Width 符号。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  // CJK/全角按 2 列计；对齐区已保证不含 Ambiguous Width 符号（✓ · × ↑ 等）
  let width_ = 0;
  for (const ch of text) width_ += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - width_));
}

export function renderMatrix(ctx: Ctx, rows: MatrixRow[]): string {
  const headers = ctx.agents.map((a) => shortAgentId(a.id));
  const nameWidth = Math.max(10, ...rows.map((r) => displayWidth(r.skill.name + updateMarker(r)))) + 2;
  const typeWidth = Math.max(4, ...rows.map((r) => displayWidth(r.skill.type)));
  const colWidth = 9;
  const lines: string[] = [];
  lines.push(pad('skill', nameWidth) + pad('type', typeWidth) + '  ' + headers.map((h) => pad(h, colWidth)).join('') + 'update');
  lines.push('-'.repeat(nameWidth + typeWidth + 2 + headers.length * colWidth + 7));
  for (const row of rows) {
    let line = pad(row.skill.name + updateMarker(row), nameWidth) + pad(row.skill.type, typeWidth) + '  ';
    for (const agent of ctx.agents) {
      const cell = row.cells[agent.id];
      line += pad(cellSymbol(cell.state) + (cell.mode ? `(${cell.mode.slice(0, 3)})` : ''), colWidth);
    }
    line += UPDATE_GLYPH[row.updateStatus];
    lines.push(line);
  }
  lines.push('');
  lines.push('Legend: Y deployed  ! drift  x missing  ? unmanaged  . not deployed  |  = up-to-date  * update available  E check error  (#) after a name = update available');
  return lines.join('\n');
}

export function matrixToJson(ctx: Ctx, rows: MatrixRow[]) {
  return {
    root: ctx.root,
    agents: ctx.agents.map((a) => ({ id: a.id, label: a.label, skillsDir: a.skillsDir })),
    skills: rows.map((row) => ({
      name: row.skill.name,
      type: row.skill.type,
      description: row.skill.description,
      contentHash: row.skill.content_hash,
      update: { status: row.updateStatus, checkedAt: row.checkedAt, remoteCommit: row.remoteCommit },
      deployments: Object.fromEntries(
        Object.entries(row.cells).map(([agentId, cell]) => [agentId, { state: cell.state, mode: cell.mode }]),
      ),
    })),
  };
}
