import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultRoot } from './config.ts';

const CONFIG_TEMPLATE = {
  _readme: [
    'skillmgr per-store configuration. Unknown keys are ignored.',
    'agents: override a built-in agent (label / skillsDir / detectPaths, ~ expands to home).',
    'extraAgents: add new agents — adding an agent is a config change, never a code change.',
    'disabledAgents: hide built-in agents from the matrix.',
    'allowedHosts: git hosts permitted for "skillmgr add" (http/https only).',
  ],
  agents: {},
  extraAgents: [],
  disabledAgents: [],
  allowedHosts: ['github.com', 'gitlab.com', 'raw.githubusercontent.com', 'codeload.github.com'],
} as const;

export interface InitResult {
  root: string;
  createdStore: boolean;
  createdConfig: boolean;
}

/** Create a canonical store skeleton: <root> + .registry/ + default config.json. */
export function initStore(target?: string): InitResult {
  const root = resolve(target ?? defaultRoot());
  const registryDir = join(root, '.registry');
  const createdStore = !existsSync(root);
  mkdirSync(registryDir, { recursive: true });
  const configPath = join(registryDir, 'config.json');
  let createdConfig = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
    createdConfig = true;
  }
  return { root, createdStore, createdConfig };
}
