import { emitKeypressEvents } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSpec, Ctx } from '../config.ts';
import { listDetectedAgents, shortAgentId } from '../agents.ts';
import { buildMatrix, cellSymbol, type MatrixRow } from '../status.ts';
import { deployOne, undeployOne } from '../deploy.ts';
import { syncStoreToRegistry } from '../store.ts';
import { addFromRepo, updateSkill } from '../sources.ts';
import { fixIssues } from '../doctor.ts';
import * as ansi from './ansi.ts';

// ---- 状态 ----

export type ViewMode = 'menu' | 'agents' | 'manage' | 'monitor' | 'help';

export const MENU_ITEMS = ['Skills Management', 'Skills Status Monitor'] as const;

export interface TuiState {
  ctx: Ctx;
  root: string;
  version: string;
  rows: MatrixRow[];
  mode: ViewMode;
  helpReturn: ViewMode;
  menuCursor: number;
  agentCursor: number;
  manageCursor: number;
  monitorCursor: { r: number; c: number };
  /** Skills Management 当前选中的 agent（manage 视图的 m×1 列表主体）。 */
  currentAgent: AgentSpec | null;
  filter: { active: boolean; text: string };
  status: { text: string; ok: boolean };
  input: { step: 'repo' | 'skill'; repo: string; prompt: string; buffer: string } | null;
}

/** 管理视图（m×1）的一行：yes = 已激活（部署在位），no = 未激活。 */
export interface ManageEntry {
  row: MatrixRow;
  active: boolean;
  note: string;
}

// ---- 纯函数（可单测） ----

export function filteredRows(state: TuiState): MatrixRow[] {
  const text = state.filter.text.trim().toLowerCase();
  if (!text) return state.rows;
  return state.rows.filter((row) => row.skill.name.toLowerCase().includes(text));
}

/**
 * 管理视图的 m×1 映射：单元格状态归约为二值 yes/no。
 * ok/drift → yes（已激活；drift 附注）；missing/not-deployed/foreign → no（附注）。
 */
export function manageEntries(state: TuiState): ManageEntry[] {
  const agent = state.currentAgent;
  if (!agent) return [];
  return filteredRows(state).map((row) => {
    const cell = row.cells[agent.id];
    switch (cell.state) {
      case 'ok': return { row, active: true, note: '' };
      case 'drift': return { row, active: true, note: 'drift — toggle to repair' };
      case 'missing': return { row, active: false, note: 'missing — toggle to activate' };
      case 'foreign': return { row, active: false, note: 'unmanaged content — not touched' };
      default: return { row, active: false, note: '' };
    }
  });
}

/** 监视视图当前光标指向的 {skill, agent}。 */
export function cellAt(state: TuiState): { row: MatrixRow; agent: AgentSpec } | null {
  const rows = filteredRows(state);
  if (rows.length === 0) return null;
  const r = Math.min(state.monitorCursor.r, rows.length - 1);
  const c = Math.min(state.monitorCursor.c, state.ctx.agents.length - 1);
  return { row: rows[r], agent: state.ctx.agents[c] };
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

function wrap(lines: string[]): string {
  return ansi.HOME + lines.map((l) => l + ansi.ERASE_LINE).join('\n') + '\n' + ansi.CLEAR_TO_END;
}

function title(state: TuiState, section: string): string {
  return ansi.style(` skillmgr · ${section}`, ansi.BOLD) + ansi.paint('gray', ` — ${state.root}  ${state.rows.length} skills · v${state.version}`);
}

function statusLine(state: TuiState): string {
  if (!state.status.text) return '';
  return state.status.ok ? ansi.paint('green', ` ${state.status.text}`) : ansi.paint('red', ` ${state.status.text}`);
}

function footer(state: TuiState): string {
  if (state.input) {
    return ansi.style(` ${state.input.prompt} `, ansi.INVERSE) + state.input.buffer + ansi.paint('gray', '  (enter submit · esc cancel)');
  }
  if (state.filter.active) {
    return ansi.style(' / filter › ', ansi.INVERSE) + state.filter.text + ansi.paint('gray', '  (enter apply · esc clear)');
  }
  const hints: Partial<Record<ViewMode, string>> = {
    menu: ' ↑↓ move · enter select · q quit',
    agents: ' ↑↓ move · enter manage skills · a add · D doctor · R rescan · ← back · ? help · q quit',
    manage: ' ↑↓ move · enter/space yes↔no · u update · / filter · ← agents · ? help · q quit',
    monitor: ' ↑↓←→ inspect · r refresh · / filter · ← menu · ? help · q quit',
  };
  return ansi.paint('gray', hints[state.mode] ?? '');
}

/** 把整个 TUI 状态渲染为一帧字符串（HOME 起始、逐行清行、结尾清屏剩余）。 */
export function buildFrame(state: TuiState): string {
  switch (state.mode) {
    case 'help': return buildHelpFrame();
    case 'menu': return buildMenuFrame(state);
    case 'agents': return buildAgentsFrame(state);
    case 'manage': return buildManageFrame(state);
    default: return buildMonitorFrame(state);
  }
}

function buildMenuFrame(state: TuiState): string {
  const lines = [title(state, 'main menu'), ''];
  MENU_ITEMS.forEach((item, i) => {
    const selected = i === state.menuCursor;
    const marker = selected ? '› ' : '  ';
    lines.push(selected ? ansi.style(` ${marker}${item}`, ansi.INVERSE) : ` ${marker}${item}`);
  });
  lines.push('');
  lines.push(footer(state));
  const s = statusLine(state);
  if (s) lines.push(s);
  return wrap(lines);
}

function buildAgentsFrame(state: TuiState): string {
  const detected = listDetectedAgents(state.ctx);
  const idW = Math.max(10, ...detected.map((a) => a.id.length)) + 2;
  const lines = [title(state, 'skills management — pick an agent'), ''];
  detected.forEach((agent, i) => {
    const selected = i === state.agentCursor;
    const text = pad(`${agent.detected ? '✓' : '×'} ${agent.id}`, idW) + pad(agent.label, 16) + agent.skillsDir;
    lines.push(selected ? ansi.style(` ${text}`, ansi.INVERSE) : ` ${text}`);
  });
  lines.push('');
  lines.push(footer(state));
  const s = statusLine(state);
  if (s) lines.push(s);
  return wrap(lines);
}

function buildManageFrame(state: TuiState): string {
  const agent = state.currentAgent;
  if (!agent) return buildAgentsFrame(state);
  const entries = manageEntries(state);
  const nameW = Math.max(12, ...entries.map((e) => displayWidth(e.row.skill.name))) + 2;
  const lines = [
    title(state, `skills management — ${agent.label}`),
    ansi.paint('gray', ` ${agent.skillsDir}`),
    '',
    pad('skill', nameW) + ansi.paint('gray', 'active'),
    ansi.paint('gray', '─'.repeat(nameW + 12)),
  ];
  entries.forEach((entry, i) => {
    const selected = i === Math.min(state.manageCursor, entries.length - 1);
    const token = entry.active ? ansi.paint('green', 'yes') : ansi.paint('gray', 'no ');
    const name = pad(entry.row.skill.name, nameW);
    const note = entry.note ? ansi.paint('yellow', `  ${entry.note}`) : '';
    const body = `${name}${token}${note}`;
    lines.push(selected ? ansi.style(` ${body}`, ansi.INVERSE) : ` ${body}`);
  });
  if (entries.length === 0) lines.push(ansi.paint('gray', state.filter.text ? `no skills match "${state.filter.text}"` : 'store is empty — run skillmgr scan'));
  lines.push('');
  lines.push(footer(state));
  const s = statusLine(state);
  if (s) lines.push(s);
  return wrap(lines);
}

function buildMonitorFrame(state: TuiState): string {
  const rows = filteredRows(state);
  const agents = state.ctx.agents;
  const colW = Math.max(8, ...agents.map((a) => shortAgentId(a.id).length + 2));
  const nameW = Math.max(12, ...rows.map((r) => displayWidth(r.skill.name))) + 2;
  const lines = [title(state, 'status monitor (read-only)')];

  let header = pad('skill', nameW);
  for (const agent of agents) header += pad(shortAgentId(agent.id), colW);
  header += ansi.paint('gray', 'up');
  lines.push(header);
  lines.push(ansi.paint('gray', '─'.repeat(nameW + agents.length * colW + 3)));

  rows.forEach((row, ri) => {
    const rowSelected = ri === Math.min(state.monitorCursor.r, rows.length - 1);
    let line = rowSelected ? ansi.style(pad(row.skill.name, nameW), ansi.BOLD) : pad(row.skill.name, nameW);
    agents.forEach((agent, ci) => {
      const cell = row.cells[agent.id];
      const mark = `${cellSymbol(cell.state)}${cell.mode ? cell.mode[0] : ''}`;
      const text = pad(mark, colW);
      const isSelected = rowSelected && ci === state.monitorCursor.c;
      line += isSelected ? ansi.style(text, ansi.INVERSE) : ansi.paint(STATE_COLOR[cell.state], text);
    });
    const updateMark = UPDATE_MARK[row.updateStatus];
    line += updateMark === '↑' ? ansi.paint('yellow', '↑') : updateMark === 'E' ? ansi.paint('red', 'E') : ansi.paint('gray', updateMark);
    lines.push(line);
  });
  if (rows.length === 0) lines.push(ansi.paint('gray', state.filter.text ? `no skills match "${state.filter.text}"` : 'store is empty — run skillmgr scan'));

  lines.push('');
  lines.push(footer(state));
  const s = statusLine(state);
  if (s) lines.push(s);
  return wrap(lines);
}

function buildHelpFrame(): string {
  const lines = [
    ansi.style(' skillmgr — keys', ansi.BOLD),
    '',
    '  main menu       choose Skills Management or Skills Status Monitor',
    '',
    '  skills management (per agent, m×1 list):',
    '    ↑↓            move between skills',
    '    enter / space toggle yes ↔ no for the selected agent',
    '                    yes = activated (deployed), no = not activated',
    '                    drift rows repair themselves when re-activated',
    '    u             update the highlighted skill (upstream only, auto backup)',
    '    /             filter skills by name',
    '    ←             back to the agent list',
    '',
    '  agent list:      enter manage · a add from GitHub · D doctor · R rescan',
    '  status monitor:  read-only matrix · ↑↓←→ inspect · r refresh',
    '  anywhere:        ? help · q quit',
    '',
    ansi.paint('gray', '  press any key to return'),
  ];
  return wrap(lines);
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
  };

  let busy = false;
  let keyWaiter: ((str: string, key: unknown) => void) | null = null;

  const redraw = (): void => {
    stdout.write(buildFrame(state));
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

  /** 管理视图：yes ↔ no 切换（no→yes 部署/修复，yes→no 取消部署）。 */
  const toggleManage = async (): Promise<void> => {
    const entries = manageEntries(state);
    if (entries.length === 0 || !state.currentAgent) {
      setStatus(state, 'no skills to toggle', false);
      return;
    }
    const entry = entries[Math.min(state.manageCursor, entries.length - 1)];
    const outcome = entry.active
      ? undeployOne(ctx, db, entry.row.skill, state.currentAgent)
      : deployOne(ctx, db, entry.row.skill, state.currentAgent, 'auto');
    reload(ctx, db, state);
    const verb = entry.active ? 'no (undeployed)' : 'yes (deployed)';
    setStatus(state, `${entry.row.skill.name} @ ${state.currentAgent.id}: ${verb}${outcome.ok ? '' : ` — ${outcome.message}`}`, outcome.ok);
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
      state.mode = state.helpReturn;
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
        state.manageCursor = 0;
        state.monitorCursor.r = 0;
      } else if (key && key.name === 'backspace') {
        state.filter.text = state.filter.text.slice(0, -1);
      } else if (key && key.name === 'return') {
        state.filter.active = false;
        state.manageCursor = 0;
        state.monitorCursor.r = 0;
      } else if (str && str >= ' ' && !key?.ctrl && !key?.meta) {
        state.filter.text += str;
      }
      redraw();
      return;
    }

    const back = !!(key && (key.name === 'escape' || key.name === 'left'));
    const plainKey = key?.name ?? '';

    if (state.mode === 'menu') {
      if (plainKey === 'up') state.menuCursor = Math.max(0, state.menuCursor - 1);
      else if (plainKey === 'down') state.menuCursor = Math.min(MENU_ITEMS.length - 1, state.menuCursor + 1);
      else if (plainKey === 'return' || plainKey === 'space') {
        if (state.menuCursor === 0) state.mode = 'agents';
        else { state.mode = 'monitor'; state.monitorCursor = { r: 0, c: 0 }; }
      } else if (plainKey === 'q') { quit(); return; }
      redraw();
      return;
    }

    if (state.mode === 'agents') {
      const count = state.ctx.agents.length;
      if (plainKey === 'up') state.agentCursor = Math.max(0, state.agentCursor - 1);
      else if (plainKey === 'down') state.agentCursor = Math.min(count - 1, state.agentCursor + 1);
      else if (plainKey === 'return' || plainKey === 'space') {
        state.currentAgent = state.ctx.agents[state.agentCursor];
        state.mode = 'manage';
        state.manageCursor = 0;
      } else if (str === 'a') {
        state.input = { step: 'repo', repo: '', prompt: 'repo (owner/repo):', buffer: '' };
      } else if (str === 'D') {
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
      } else if (str === 'R') {
        busy = true;
        redraw();
        await suspend(() => {
          const result = syncStoreToRegistry(ctx, db);
          reload(ctx, db, state);
          return `rescan ${ctx.root}: added ${result.added}, updated ${result.updated}, removed ${result.removed.length}`;
        });
        busy = false;
      } else if (back) { state.mode = 'menu'; }
      else if (plainKey === 'q') { quit(); return; }
      else if (plainKey === '?') { state.helpReturn = 'agents'; state.mode = 'help'; }
      redraw();
      return;
    }

    if (state.mode === 'manage') {
      const count = manageEntries(state).length;
      if (plainKey === 'up') state.manageCursor = Math.max(0, state.manageCursor - 1);
      else if (plainKey === 'down') state.manageCursor = Math.min(Math.max(0, count - 1), state.manageCursor + 1);
      else if (plainKey === 'return' || plainKey === 'space') {
        busy = true;
        redraw();
        await toggleManage();
        busy = false;
      } else if (str === 'u') {
        const entries = manageEntries(state);
        if (entries.length === 0) { setStatus(state, 'no skills', false); redraw(); return; }
        const entry = entries[Math.min(state.manageCursor, entries.length - 1)];
        if (entry.row.skill.type === 'local') {
          setStatus(state, `${entry.row.skill.name}: local skill — nothing to update`, false);
          redraw();
          return;
        }
        busy = true;
        redraw();
        await suspend(() => {
          const result = updateSkill(ctx, db, entry.row.skill.name);
          reload(ctx, db, state);
          if (!result.updated) return `${result.skill}: ${result.message}`;
          const d = result.diff ?? { added: [], removed: [], changed: [] };
          return `updated ${result.skill} → ${result.commit?.slice(0, 12)}  (+${d.added.length}/~${d.changed.length}/-${d.removed.length})\n  backup: ${result.backup}`;
        });
        busy = false;
      } else if (plainKey === '/') {
        state.filter = { active: true, text: state.filter.text };
      } else if (back) { state.mode = 'agents'; }
      else if (plainKey === 'q') { quit(); return; }
      else if (plainKey === '?') { state.helpReturn = 'manage'; state.mode = 'help'; }
      redraw();
      return;
    }

    // monitor（只读）
    const rowCount = filteredRows(state).length;
    if (plainKey === 'up') state.monitorCursor.r = Math.max(0, state.monitorCursor.r - 1);
    else if (plainKey === 'down') state.monitorCursor.r = Math.min(Math.max(0, rowCount - 1), state.monitorCursor.r + 1);
    else if (plainKey === 'left') state.monitorCursor.c = Math.max(0, state.monitorCursor.c - 1);
    else if (plainKey === 'right') state.monitorCursor.c = Math.min(state.ctx.agents.length - 1, state.monitorCursor.c + 1);
    else if (plainKey === 'r') {
      reload(ctx, db, state);
      setStatus(state, 'refreshed');
    } else if (plainKey === '/') {
      state.filter = { active: true, text: state.filter.text };
    } else if (back) { state.mode = 'menu'; }
    else if (plainKey === 'q') { quit(); return; }
    else if (plainKey === '?') { state.helpReturn = 'monitor'; state.mode = 'help'; }
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

  // raw 模式下 resize 事件依赖 keypress 流；data 桥接保证某些平台的事件泵运转。
  const dataBridge = (): void => {};

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKeyWrapper);
  stdin.on('data', dataBridge);
  stdout.on('resize', redraw);

  stdout.write(ansi.ALT_ENTER + ansi.HIDE);
  redraw();
}
