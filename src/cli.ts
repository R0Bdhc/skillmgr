import { readFileSync } from 'node:fs';
import { loadCtx, type Ctx } from './config.ts';
import { openDb, listSkills, listHistory } from './registry.ts';
import { syncStoreToRegistry } from './store.ts';
import { listDetectedAgents, resolveAgent } from './agents.ts';
import { deployOne, ensureSkill, undeployOne } from './deploy.ts';
import { buildMatrix, matrixToJson, renderMatrix } from './status.ts';
import { collectIssues, fixIssues } from './doctor.ts';
import { addFromRepo, checkAll, rollbackSkill, skillDetail, updateSkill } from './sources.ts';
import { initStore } from './init.ts';
import { addHistory } from './registry.ts';

// ---- minimal argument parsing (zero dependencies, no commander) ----

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(['--mode', '--branch', '--as', '--type', '--skill', '--root', '--limit']);
const BOOLEAN_FLAGS = new Set(['--all', '--json', '--fix', '-y', '--yes']);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Flag ${arg} requires a value`);
      flags[arg] = arg === '--skill'
        ? [...String(flags[arg] ?? '').split(','), value].filter(Boolean).join(',')
        : value;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      flags[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const HELP = `skillmgr — cross-agent unified AI skills manager (Windows / Linux / macOS)

One canonical skill store, deployed to every coding agent via junctions/symlinks.
Edit once, all agents see the change — no per-agent copies, no version drift.

Usage: skillmgr <command> [args]

  init [path]                       create a canonical store (default ~/skills)
  scan                              scan the canonical store and sync the registry
  list [--type local|upstream|forked]
  status                            deployment matrix (skill x agent)
  agents                            list agents and detection results
  info <skill>                      detail: source / version / deployments / backups
  deploy <skill> [agent...]         deploy; --all = all detected agents; --mode junction|symlink|copy
  undeploy <skill> [agent...]       undeploy; --all
  add <owner/repo|url>              install from GitHub/GitLab; --skill <name> --branch <b> --as <new-name>
  check [skill|--all]               check upstream for updates
  update <skill|--all>              update the canonical copy (Diff -> Backup -> Replace)
  rollback <skill> [version]        restore a backup (default: latest)
  doctor [--fix]                    reconcile disk vs registry and repair
  history                           recent operations
  root                              print the canonical store location

Global flags: --json (machine-readable output), --root <path>, --version
Docs: https://github.com/R0Bdhc/skillmgr
`;

function out(data: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(data, null, 2) : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
}

function resolveAgentList(ctx: Ctx, names: string[], all: boolean, { detectedOnly = false } = {}) {
  if (all) {
    const detected = listDetectedAgents(ctx).filter((a) => a.detected);
    if (detectedOnly && detected.length === 0) throw new Error('No installed agents detected; pass agent names explicitly');
    return (detectedOnly ? detected : ctx.agents);
  }
  if (names.length === 0) throw new Error('Specify at least one agent, or use --all');
  return names.map((name) => {
    const agent = resolveAgent(ctx, name);
    if (!agent) throw new Error(`Unknown agent: ${name}. Available: ${ctx.agents.map((a) => a.id).join(', ')}`);
    return agent;
  });
}

function printOutcomes(outcomes: Array<{ agentId: string; ok: boolean; mode?: string; message?: string }>): void {
  for (const outcome of outcomes) {
    const mark = outcome.ok ? '✓' : '✗';
    const detail = outcome.message ?? outcome.mode ?? '';
    console.log(`  ${mark} ${outcome.agentId}${detail ? ` — ${detail}` : ''}`);
  }
}

function dispatch(cmd: string, args: ParsedArgs, ctx: Ctx): number {
  const json = Boolean(args.flags['--json']);
  const db = openDb(ctx.dbPath);
  const [pos0] = args.positionals;

  switch (cmd) {
    case 'root':
      out(ctx.root, json);
      return 0;

    case 'init': {
      const result = initStore(args.positionals[0]);
      if (json) { out(result, true); return 0; }
      console.log(`✓ canonical store: ${result.root}`);
      if (result.createdConfig) console.log('  wrote .registry/config.json (agent overrides, allowed hosts)');
      else console.log('  kept existing .registry/config.json');
      console.log('Next steps:');
      console.log(`  1. put skills into ${result.root}<skill-name>/SKILL.md`);
      console.log('  2. skillmgr scan');
      console.log('  3. skillmgr status        # deployment matrix');
      console.log('  4. skillmgr deploy <skill> --all');
      return 0;
    }

    case 'scan': {
      const result = syncStoreToRegistry(ctx, db);
      addHistory(db, 'scan', null, result);
      if (json) out(result, true);
      else console.log(`Scanned ${ctx.root}: added ${result.added}, updated ${result.updated}, removed ${result.removed.length}${result.removed.length ? ` (${result.removed.join(', ')})` : ''}`);
      return 0;
    }

    case 'list': {
      syncStoreToRegistry(ctx, db);
      const type = args.flags['--type'] as string | undefined;
      let skills = listSkills(db);
      if (type) skills = skills.filter((s) => s.type === type);
      if (json) { out(skills, true); return 0; }
      for (const s of skills) {
        console.log(`${s.name.padEnd(30)} ${s.type.padEnd(9)} ${s.content_hash.slice(0, 12)}  ${s.description.slice(0, 60)}`);
      }
      console.log(`${skills.length} skill(s)`);
      return 0;
    }

    case 'status': {
      syncStoreToRegistry(ctx, db);
      const rows = buildMatrix(ctx, db);
      if (json) { out(matrixToJson(ctx, rows), true); return 0; }
      console.log(renderMatrix(ctx, rows));
      return 0;
    }

    case 'agents': {
      const agents = listDetectedAgents(ctx);
      if (json) { out(agents, true); return 0; }
      for (const a of agents) {
        console.log(`${a.detected ? '✓' : '×'} ${a.id.padEnd(16)} ${a.label.padEnd(16)} ${a.skillsDir}`);
      }
      return 0;
    }

    case 'info': {
      if (!pos0) throw new Error('Usage: skillmgr info <skill>');
      out(skillDetail(ctx, db, pos0), json);
      return 0;
    }

    case 'deploy':
    case 'undeploy': {
      if (!pos0) throw new Error(`Usage: skillmgr ${cmd} <skill> [agent...] [--all]`);
      const agents = resolveAgentList(ctx, args.positionals.slice(1), Boolean(args.flags['--all']), { detectedOnly: cmd === 'deploy' });
      const mode = (args.flags['--mode'] as 'auto' | 'junction' | 'symlink' | 'copy' | undefined) ?? 'auto';
      const skill = ensureSkill(ctx, db, pos0);
      const outcomes = agents.map((agent) =>
        cmd === 'deploy'
          ? deployOne(ctx, db, skill, agent, mode)
          : undeployOne(ctx, db, skill, agent));
      printOutcomes(outcomes);
      return outcomes.every((o) => o.ok) ? 0 : 1;
    }

    case 'add': {
      if (!pos0) throw new Error('Usage: skillmgr add <owner/repo|url> [--skill name] [--branch b] [--as new-name]');
      const result = addFromRepo(ctx, db, pos0, {
        skills: args.flags['--skill'] ? String(args.flags['--skill']).split(',') : undefined,
        branch: args.flags['--branch'] as string | undefined,
        as: args.flags['--as'] as string | undefined,
      });
      if (json) { out(result, true); return 0; }
      for (const item of result.added) console.log(`✓ added ${item.name} (${item.branch}@${item.commit.slice(0, 12)})`);
      if (result.added.length === 0) console.log(`Nothing added. Available: ${result.available.join(', ')}`);
      return 0;
    }

    case 'check': {
      const targets = args.flags['--all'] || !pos0 ? undefined : [pos0];
      const results = checkAll(ctx, db, targets);
      if (json) { out(results, true); return 0; }
      for (const r of results) {
        const mark = r.status === 'up_to_date' ? '=' : r.status === 'update_available' ? '↑' : r.status === 'error' ? 'E' : '·';
        console.log(`${mark} ${r.skill.padEnd(30)} ${r.status}${r.detail ? ` — ${r.detail}` : ''}${r.remoteCommit ? ` (${r.remoteCommit.slice(0, 12)})` : ''}`);
      }
      return results.some((r) => r.status === 'error') ? 1 : 0;
    }

    case 'update': {
      const all = Boolean(args.flags['--all']) || pos0 === '--all' || pos0 === undefined;
      const names = all
        ? listSkills(db).filter((s) => s.type !== 'local').map((s) => s.name)
        : [pos0];
      const results: unknown[] = [];
      for (const name of names) results.push(updateSkill(ctx, db, name));
      if (json) { out(results, true); return 0; }
      for (const r of results as Awaited<ReturnType<typeof updateSkill>>[]) {
        if (!r.updated) { console.log(`· ${r.skill} — ${r.message}`); continue; }
        const d = r.diff ?? { added: [], removed: [], changed: [] };
        console.log(`✓ ${r.skill} → ${r.commit?.slice(0, 12)}`);
        console.log(`  Changes: +${d.added.length} added / ~${d.changed.length} modified / -${d.removed.length} deleted`);
        console.log(`  Backup: ${r.backup}`);
        if (r.redeployed?.length) console.log(`  Re-copied (copy mode): ${r.redeployed.join(', ')}`);
      }
      return 0;
    }

    case 'rollback': {
      if (!pos0) throw new Error('Usage: skillmgr rollback <skill> [version]');
      const result = rollbackSkill(ctx, db, pos0, args.positionals[1]);
      console.log(`✓ ${result.skill} restored from backup ${result.restoredFrom}`);
      return 0;
    }

    case 'doctor': {
      const issues = collectIssues(ctx, db);
      if (args.flags['--fix']) {
        const { fixed, failed } = fixIssues(ctx, db);
        if (json) { out({ issues, fixed, failed }, true); return failed.length > 0 ? 1 : 0; }
        for (const line of fixed) console.log(`✓ fixed: ${line}`);
        for (const line of failed) console.log(`✗ fix failed: ${line}`);
      } else if (json) {
        out({ issues }, true);
      }
      if (!json) {
        const remaining = issues.filter((i) => !i.fixable || !args.flags['--fix']);
        for (const issue of remaining) {
          console.log(`! ${issue.skill}${issue.agent ? ` @ ${issue.agent}` : ''} [${issue.kind}] ${issue.detail}`);
        }
        console.log(remaining.length === 0 ? '✓ no issues found' : `${remaining.length} issue(s)${args.flags['--fix'] ? '' : ' (run skillmgr doctor --fix to repair fixable ones)'}`);
      }
      return issues.some((i) => !i.fixable) ? 1 : 0;
    }

    case 'history': {
      const limit = Number(args.flags['--limit'] ?? 30);
      out(listHistory(db, limit), json);
      return 0;
    }

    case 'help':
      out(HELP, false);
      return 0;

    default:
      throw new Error(`Unknown command: ${cmd} (run skillmgr help)`);
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return `skillmgr v${pkg.version}`;
  } catch {
    return 'skillmgr (version unknown)';
  }
}

export function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(version());
    return;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const [cmd] = args.positionals.splice(0, 1);
  if (!cmd || cmd === 'help') {
    out(HELP, false);
    return;
  }
  try {
    const ctx = loadCtx(args.flags['--root'] as string | undefined);
    process.exitCode = dispatch(cmd, args, ctx);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

main();
