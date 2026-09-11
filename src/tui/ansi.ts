// 极小 ANSI 工具集：零依赖 TUI 的全部终端控制能力都从这里出。

export const ALT_ENTER = '\x1b[?1049h';
export const ALT_EXIT = '\x1b[?1049l';
export const HIDE = '\x1b[?25l';
export const SHOW = '\x1b[?25h';
export const HOME = '\x1b[H';
export const CLEAR_TO_END = '\x1b[J';
export const ERASE_LINE = '\x1b[K';
export const RESET = '\x1b[0m';
export const INVERSE = '\x1b[7m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';

export const FG = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export type FgColor = keyof typeof FG;

export function paint(color: FgColor, text: string): string {
  return FG[color] + text + RESET;
}

export function style(text: string, ...codes: string[]): string {
  return codes.join('') + text + RESET;
}
