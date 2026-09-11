import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface AgentSpec {
  id: string;
  label: string;
  /** Global skills directory (supports a leading ~). */
  skillsDir: string;
  /** Paths (supports ~) whose existence marks the agent as installed. */
  detectPaths: string[];
}

export interface Ctx {
  /** Canonical store root, e.g. D:\Projects\skills or ~/skills */
  root: string;
  registryDir: string;
  dbPath: string;
  backupDir: string;
  agents: AgentSpec[];
  allowedHosts: string[];
}

/**
 * Built-in agent registry (global scope). Path conventions adapted from
 * vercel-labs/skills (MIT License); see NOTICE. Override or extend via the
 * `agents` / `extraAgents` / `disabledAgents` sections of
 * <store>/.registry/config.json — adding an agent is a config change,
 * never a code change.
 */
export const BUILTIN_AGENTS: AgentSpec[] = [
  { id: 'claude-code', label: 'Claude Code', skillsDir: '~/.claude/skills', detectPaths: ['~/.claude'] },
  { id: 'codex', label: 'Codex', skillsDir: '~/.codex/skills', detectPaths: ['~/.codex'] },
  { id: 'cursor', label: 'Cursor', skillsDir: '~/.cursor/skills', detectPaths: ['~/.cursor'] },
  { id: 'github-copilot', label: 'GitHub Copilot', skillsDir: '~/.copilot/skills', detectPaths: ['~/.copilot'] },
  { id: 'cline', label: 'Cline', skillsDir: '~/.cline/skills', detectPaths: ['~/.cline'] },
  { id: 'opencode', label: 'OpenCode', skillsDir: '~/.config/opencode/skills', detectPaths: ['~/.config/opencode'] },
  { id: 'gemini-cli', label: 'Gemini CLI', skillsDir: '~/.gemini/skills', detectPaths: ['~/.gemini'] },
  { id: 'windsurf', label: 'Windsurf', skillsDir: '~/.codeium/windsurf/skills', detectPaths: ['~/.codeium'] },
];

const DEFAULT_ALLOWED_HOSTS = ['github.com', 'gitlab.com', 'raw.githubusercontent.com', 'codeload.github.com'];

/** User-level config that lives outside the store (resolves the chicken-and-egg
 * problem: the store's own config.json cannot name the store's location). */
export function userConfigPath(): string {
  return join(homedir(), '.skillmgr', 'config.json');
}

interface UserConfig {
  canonicalRoot?: string;
}

function loadUserConfig(): UserConfig {
  const path = userConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
  } catch (error) {
    throw new Error(`Failed to parse user config (${path}): ${(error as Error).message}`);
  }
}

interface ConfigFile {
  canonicalRoot?: string;
  agents?: Record<string, Partial<AgentSpec>>;
  disabledAgents?: string[];
  extraAgents?: AgentSpec[];
  allowedHosts?: string[];
}

function loadConfigFile(registryDir: string): ConfigFile {
  const path = join(registryDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
  } catch (error) {
    throw new Error(`Failed to parse config (${path}): ${(error as Error).message}`);
  }
}

/**
 * Canonical store root resolution order:
 *   1. SKILLMGR_ROOT environment variable
 *   2. canonicalRoot in ~/.skillmgr/config.json
 *   3. platform default: ~/skills
 */
export function resolveDefaultRoot(envRoot: string | undefined, userCanonicalRoot: string | undefined): string {
  if (envRoot) return resolve(envRoot);
  if (userCanonicalRoot) return resolve(expandHome(userCanonicalRoot));
  return join(homedir(), 'skills');
}

export function defaultRoot(): string {
  const user = loadUserConfig();
  return resolveDefaultRoot(process.env.SKILLMGR_ROOT, user.canonicalRoot);
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

export function loadCtx(rootOverride?: string): Ctx {
  const root = resolve(rootOverride ?? defaultRoot());
  if (!existsSync(root)) {
    throw new Error(
      `Canonical store not found: ${root}\n` +
      'Run "skillmgr init" to create it, or point SKILLMGR_ROOT / --root <path> at an existing store.',
    );
  }
  const registryDir = join(root, '.registry');
  const cfg = loadConfigFile(registryDir);

  const agents: AgentSpec[] = [];
  const disabled = new Set(cfg.disabledAgents ?? []);
  for (const spec of BUILTIN_AGENTS) {
    if (disabled.has(spec.id)) continue;
    const override = cfg.agents?.[spec.id];
    agents.push(override ? { ...spec, ...override, id: spec.id } : spec);
  }
  for (const extra of cfg.extraAgents ?? []) {
    if (!disabled.has(extra.id) && !agents.some((a) => a.id === extra.id)) agents.push(extra);
  }

  return {
    root,
    registryDir,
    dbPath: join(registryDir, 'registry.db'),
    backupDir: join(registryDir, 'backups'),
    agents,
    allowedHosts: cfg.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
  };
}

/**
 * 把一个 agent 持久化到 <store>/.registry/config.json 的 extraAgents 段
 * （与手改配置等效）。id 或 skillsDir 冲突时抛错，不产生半写状态。
 */
export function saveExtraAgent(ctx: Ctx, agent: AgentSpec): void {
  const path = join(ctx.registryDir, 'config.json');
  const cfg: ConfigFile = existsSync(path) ? loadConfigFile(ctx.registryDir) : {};
  cfg.extraAgents ??= [];
  if (cfg.extraAgents.some((a) => a.id === agent.id)) {
    throw new Error(`agent id already exists: ${agent.id}`);
  }
  const normalize = (p: string) => expandHome(p).replace(/\//g, '\\').toLowerCase();
  if (
    cfg.extraAgents.some((a) => normalize(a.skillsDir) === normalize(agent.skillsDir)) ||
    Object.values(cfg.agents ?? {}).some((override) => override.skillsDir && normalize(override.skillsDir) === normalize(agent.skillsDir)) ||
    BUILTIN_AGENTS.some((a) => normalize(a.skillsDir) === normalize(agent.skillsDir))
  ) {
    throw new Error(`another agent already uses this skills directory: ${agent.skillsDir}`);
  }
  cfg.extraAgents.push(agent);
  mkdirSync(ctx.registryDir, { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}
