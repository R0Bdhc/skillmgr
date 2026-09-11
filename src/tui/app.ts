import { emitKeypressEvents } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSpec, Ctx } from '../config.ts';
import { shortAgentId } from '../agents.ts';
import { buildMatrix, cellSymbol, type MatrixRow } from '../status.ts';
import { deployOne, undeployOne } from '../deploy.ts';
import { syncStoreToRegistry } from '../store.ts';
import { addFromRepo, updateSkill } from '../sources.ts';
import { fixIssues } from '../doctor.ts';
import * as ansi from './ansi.ts';

// ---- 状态 ----

export interface TuiState {
  ctx: Ctx;
  root: string;
  version: string;
  rows: MatrixRow[];
  cursor: { r: number; c: number };
  filter: { active: boolean; text: string };
  status: { text: string; ok: boolean };
  mode: 'matrix' | 'help';
  input: { step: 'repo' | 'skill'; repo: string; prompt: string; buffer: string } | null;
}

// ---- 纯函数（可单测） ----

export function filteredRows(state: TuiState): MatrixRow[] {
  const text = state.filter.text.trim().toLowerCase();
  if (!text) return state.rows;
  return state.rows.filter((row) => row.skill.name.toLowerCase().includes(text));
}

/** 显示宽度：CJK/全角按 2 列计。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const STATE_COLOR = {
  ok: ansi.FG.green,
  drift: ansi.FG.yellow,
  missing: ansi.FG.red,
  foreign: ansi.FG.cyan,
  'not-deployed': ansi.FG.gray,
} as const;

const UPDATE_MARK: Record<MatrixRow['updateStatus'], string> = {
  up_to_date: '=',
  update_available: '↑',
  error: 'E',
  unchecked: ' ',
};

/** 当前光标指向的 {skill, agent}；矩阵为空时返回 null。 */
export function cellAt(state: TuiState): { row: MatrixRow; agent: AgentSpec } | null {
  const rows = filteredRows(state);
  if (rows.length === 0) return null;
  const r = Math.min(state.cursor.r, rows.length - 1);
  const c = Math.min(state.cursor.c, state.ctx.agents.length - 1);
  return { row: rows[r], agent: state.ctx.agents[c] };
}

/** 把整个 TUI 状态渲染为一帧字符串（HOME 起始、逐行清行、结尾清屏剩余）。 */
export function buildFrame(state: TuiState): string {
  const rows = filteredRows(state);
  const agents = state.ctx.agents;
  const colW = Math.max(8, ...agents.map((a) => shortAgentId(a.id).length + 2));
  const nameW = Math.max(12, ...rows.map((r) => displayWidth(r.skill.name))) + 2;
  const lines: string[] = [];

  lines.push(ansi.style(` skillmgr — ${state.root}`, ansi.BOLD) + ansi.paint('gray', `  ${state.rows.length} skills · v${state.version}`));

  let header = pad('skill', nameW);
  for (const agent of agents) header += pad(shortAgentId(agent.id), colW);
  header += ansi.paint('gray', 'up');
  lines.push(header);
  lines.push(ansi.paint('gray', '─'.repeat(nameW + agents.length * colW + 3)));

  rows.forEach((row, ri) => {
    const rowSelected = ri === Math.min(state.cursor.r, rows.length - 1);
    let line = rowSelected ? ansi.style(pad(row.skill.name, nameW), ansi.BOLD) : pad(row.skill.name, nameW);
    agents.forEach((agent, ci) => {
      const cell = row.cells[agent.id];
      const mark = `${cellSymbol(cell.state)}${cell.mode ? cell.mode[0] : ''}`;
      const text = pad(mark, colW);
      const isSelected = rowSelected && ci === state.cursor.c;
      if (isSelected) {
        line += ansi.style(text, ansi.INVERSE);
      } else {
        line += ansi.paint(STATE_COLOR[cell.state], text);
      }
    });
    const updateMark = UPDATE_MARK[row.updateStatus];
    line += updateMark === '↑' ? ansi.paint('yellow', '↑') : updateMark === 'E' ? ansi.paint('red', 'E') : ansi.paint('gray', updateMark);
    lines.push(line);
  });
  if (rows.length === 0) lines.push(ansi.paint('gray', state.filter.text ? `no skills match "${state.filter.text}"` : 'store is empty — run skillmgr scan'));

  lines.push('');
  if (state.input) {
    lines.push(ansi.style(` ${state.input.prompt} `, ansi.INVERSE) + state.input.buffer + ansi.paint('gray', '  (enter submit · esc cancel)'));
  } else if (state.filter.active) {
    lines.push(ansi.style(' / filter › ', ansi.INVERSE) + state.filter.text + ansi.paint('gray', '  (enter apply · esc clear)'));
  } else {
    lines.push(ansi.paint('gray', ' ↑↓←→ move · enter/space toggle · u update · a add · D doctor · R rescan · / filter · ? help · q quit'));
  }
  if (state.status.text) {
    lines.push(state.status.ok ? ansi.paint('green', ` ${state.status.text}`) : ansi.paint('red', ` ${state.status.text}`));
  }

  return ansi.HOME + lines.map((l) => l + ansi.ERASE_LINE).join('\n') + '\n' + ansi.CLEAR_TO_END;
}

function buildHelpFrame(state: TuiState): string {
  const lines = [
    ansi.style(' skillmgr — keys', ansi.BOLD),
    '',
    '  ↑↓←→          move the cursor across the deployment matrix',
    '  enter / space toggle the highlighted cell: · → ✓ deploy, ✓ → × undeploy',
    '                   x/! cells are redeployed (repairs); ? cells are never touched',
    '  u             update the highlighted skill (upstream only, auto backup)',
    '  a             add a skill from GitHub/GitLab',
    '  D             doctor: reconcile disk vs registry and repair',
    '  R             rescan the canonical store',
    '  /             filter skills by name',
    '  q             quit',
    '',
    ansi.paint('gray', '  press any key to return'),
  ];
  return ansi.HOME + lines.map((l) => l + ansi.ERASE_LINE).join('\n') + '\n' + ansi.CLEAR_TO_END;
}

export function ensureTTY(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('skillmgr tui requires an interactive terminal (TTY). Use "skillmgr status" for non-interactive output.');
  }
}

// ---- 交互循环 ----

function setStatus(state: TuiState, text: string, ok = true): void {
  state.status = { text, ok };
}

function reload(ctx: Ctx, db: DatabaseSync, state: TuiState): void {
  state.rows = buildMatrix(ctx, db);
}

export function runTui(ctx: Ctx, db: DatabaseSync, version = '0'): void {
  ensureTTY();
  const stdin = process.stdin;
  const stdout = process.stdout;

  const state: TuiState = {
    ctx,
    root: ctx.root,
    version,
    rows: buildMatrix(ctx, db),
    cursor: { r: 0, c: 0 },
    filter: { active: false, text: '' },
    status: { text: '', ok: true },
    mode: 'matrix',
    input: null,
  };

  let busy = false;
  let keyWaiter: ((str: string, key: unknown) => void) | null = null;

  const redraw = (): void => {
    stdout.write(state.mode === 'help' ? buildHelpFrame(state) : buildFrame(state));
  };

  const waitKey = (): Promise<void> =>
    new Promise((resolveKey) => {
      keyWaiter = (str, key) => {
        if (key && (key as { ctrl?: boolean }).ctrl && (key as { name?: string }).name === 'c') {
          resolveKey();
          return;
        }
        keyWaiter = null;
        resolveKey();
      };
    });

  /** htop 式挂起：退出全屏 → 正常输出 → 按任意键返回 → 重绘。 */
  const suspend = async (fn: () => Promise<string> | string): Promise<void> => {
    stdout.write(ansi.ALT_EXIT + ansi.SHOW);
    let message = '';
    let ok = true;
    try {
      message = await fn() || 'done';
    } catch (error) {
      message = (error as Error).message;
      ok = false;
    }
    console.log(message);
    console.log(ansi.paint('gray', '(press any key to return)'));
    await waitKey();
    stdout.write(ansi.ALT_ENTER + ansi.HIDE);
    setStatus(state, message, ok);
    redraw();
  };

  const toggleCell = async (): Promise<void> => {
    const at = cellAt(state);
    if (!at) {
      setStatus(state, 'no skills to toggle', false);
      return;
    }
    const cell = at.row.cells[at.agent.id];
    const outcome = cell.state === 'ok'
      ? undeployOne(ctx, db, at.row.skill, at.agent)
      : deployOne(ctx, db, at.row.skill, at.agent, 'auto');
    reload(ctx, db, state);
    setStatus(state, `${outcome.agentId}: ${outcome.message ?? outcome.mode ?? 'ok'}`, outcome.ok);
  };

  const onKey = async (str: string, key: { name?: string; ctrl?: boolean }): Promise<void> => {
    if (busy) return;
    if (key && key.ctrl && key.name === 'c') {
      quit();
      return;
    }
    // 挂起等待态的按键由 waitKey 消费
    if (keyWaiter) return;

    if (state.mode === 'help') {
      state.mode = 'matrix';
      redraw();
      return;
    }

    if (state.input) {
      if (key && key.name === 'escape') {
        state.input = null;
      } else if (key && key.name === 'backspace') {
        state.input.buffer = state.input.buffer.slice(0, -1);
      } else if (key && key.name === 'return') {
        const value = state.input.buffer.trim();
        if (state.input.step === 'repo') {
          if (!value) { state.input = null; redraw(); return; }
          state.input = { step: 'skill', repo: value, prompt: 'skill name (empty = auto):', buffer: '' };
          redraw();
          return;
        }
        const repo = state.input.repo;
        const skillName = value || undefined;
        state.input = null;
        busy = true;
        redraw();
        await suspend(() => {
          const result = addFromRepo(ctx, db, repo, { skills: skillName ? [skillName] : undefined });
          reload(ctx, db, state);
          return result.added.length > 0
            ? `added: ${result.added.map((x) => x.name).join(', ')}`
            : `nothing added. available: ${result.available.join(', ')}`;
        });
        busy = false;
        redraw();
        return;
      } else if (str && str >= ' ' && !key?.ctrl && !key?.meta) {
        state.input.buffer += str;
      }
      redraw();
      return;
    }

    if (state.filter.active) {
      if (key && key.name === 'escape') {
        state.filter = { active: false, text: '' };
        state.cursor.r = 0;
      } else if (key && key.name === 'backspace') {
        state.filter.text = state.filter.text.slice(0, -1);
      } else if (key && key.name === 'return') {
        state.filter.active = false;
        state.cursor.r = 0;
      } else if (str && str >= ' ' && !key?.ctrl && !key?.meta) {
        state.filter.text += str;
      }
      redraw();
      return;
    }

    const rowCount = filteredRows(state).length;
    switch (key && key.name) {
      case 'up': state.cursor.r = Math.max(0, state.cursor.r - 1); break;
      case 'down': state.cursor.r = Math.min(Math.max(0, rowCount - 1), state.cursor.r + 1); break;
      case 'left': state.cursor.c = Math.max(0, state.cursor.c - 1); break;
      case 'right': state.cursor.c = Math.min(ctx.agents.length - 1, state.cursor.c + 1); break;
      case 'return':
      case 'space':
        busy = true;
        redraw();
        await toggleCell();
        busy = false;
        break;
      case 'q': quit(); return;
      case '?': state.mode = 'help'; break;
      case '/': state.filter = { active: true, text: state.filter.text }; break;
      default:
        break;
    }
    if (key && !key.ctrl && str === 'D') {
      busy = true;
      redraw();
      await suspend(() => {
        const { fixed, failed } = fixIssues(ctx, db);
        reload(ctx, db, state);
        return `fixed ${fixed.length}, failed ${failed.length}` +
          (fixed.length ? `\n  ${fixed.join('\n  ')}` : '') +
          (failed.length ? `\n  ✗ ${failed.join('\n  ✗ ')}` : '');
      });
      busy = false;
    } else if (key && !key.ctrl && str === 'R') {
      busy = true;
      redraw();
      await suspend(() => {
        const result = syncStoreToRegistry(ctx, db);
        reload(ctx, db, state);
        return `rescan ${ctx.root}: added ${result.added}, updated ${result.updated}, removed ${result.removed.length}`;
      });
      busy = false;
    } else if (key && !key.ctrl && str === 'u') {
      const at = cellAt(state);
      if (!at) { setStatus(state, 'no skills', false); redraw(); return; }
      if (at.row.skill.type === 'local') {
        setStatus(state, `${at.row.skill.name}: local skill — nothing to update`, false);
        redraw();
        return;
      }
      busy = true;
      redraw();
      await suspend(() => {
        const result = updateSkill(ctx, db, at.row.skill.name);
        reload(ctx, db, state);
        if (!result.updated) return `${result.skill}: ${result.message}`;
        const d = result.diff ?? { added: [], removed: [], changed: [] };
        return `updated ${result.skill} → ${result.commit?.slice(0, 12)}  (+${d.added.length}/~${d.changed.length}/-${d.removed.length})\n  backup: ${result.backup}`;
      });
      busy = false;
    }
    redraw();
  };

  let quitting = false;
  function quit(): void {
    if (quitting) return;
    quitting = true;
    stdin.setRawMode(false);
    stdin.pause();
    stdin.removeListener('keypress', onKeyWrapper);
    stdin.removeListener('data', dataBridge);
    stdout.removeListener('resize', redraw);
    stdout.write(ansi.ALT_EXIT + ansi.SHOW);
  }

  // keypress 事件携带 (str, key)；waitKey 复用同一监听。
  const onKeyWrapper = (str: string, key: { name?: string; ctrl?: boolean }): void => {
    if (keyWaiter) {
      const waiter = keyWaiter;
      keyWaiter = null;
      waiter(str, key);
      return;
    }
    void onKey(str, key);
  };

  // runTui 由 cli 以已 resume 的 stdin 进入；这里接管为 raw 模式。
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKeyWrapper);
  // raw 模式下 resize 事件依赖 keypress 流；data 桥接保证某些平台的事件泵运转。
  const dataBridge = (): void => {};
  stdin.on('data', dataBridge);
  stdout.on('resize', redraw);

  stdout.write(ansi.ALT_ENTER + ansi.HIDE);
  redraw();
}
