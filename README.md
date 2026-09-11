# skillmgr

**Cross-agent unified AI skills manager for Windows, Linux and macOS.**

One canonical skill store on your disk; every coding agent (Claude Code, Codex, Cursor, GitHub Copilot, Cline, OpenCode, Gemini CLI, Windsurf, ...) gets a link into it. Edit a skill once — all agents see the change instantly. No per-agent copies, no version drift.

[中文文档](README.zh-CN.md)

```
┌──────────────────────────────────────────────┐
│              CLI  (skillmgr)                 │
├──────────────────────────────────────────────┤
│        Skill Registry  (SQLite, built-in)    │
│    Name / Source / Version / Type / Status   │
├──────────────────────────────────────────────┤
│             Deployment Engine                │
│   Claude / Codex / Cursor / Copilot / ...    │
├──────────────────────────────────────────────┤
│     Canonical Store   ~/skills (default)     │
└──────────────────────────────────────────────┘
                     │
                     ↓
              GitHub / GitLab / Local
```

The core principle: **canonical store ≠ agent deployments**. You maintain one copy of each skill; agent skill directories are only deployment targets (links by default), fully recorded in the registry.

## Why

Managing skills per agent means N copies of the same files that drift apart the moment you edit one. skillmgr keeps a single source of truth and answers five questions for every skill:

- Where did it come from?
- Which version is installed?
- Is there an upstream update?
- Which agents is it deployed to?
- Which agents is it *not* deployed to?

...and turns the answers into one-key actions: deploy, undeploy, update (with automatic backup + rollback), doctor (self-repair).

## Requirements

- Node.js **>= 24** (uses the built-in `node:sqlite` and native TypeScript execution — **zero npm dependencies**)
- git (for installing/updating skills from GitHub/GitLab)

## Quick start

```bash
git clone https://github.com/R0Bdhc/skillmgr.git
cd skillmgr
npm link          # registers the global `skillmgr` command
skillmgr init     # creates the canonical store (default: ~/skills)
```

Put a skill in the store (any directory containing `SKILL.md`):

```
~/skills/
├── my-skill/
│   ├── SKILL.md
│   └── scripts/
└── another-skill/
    └── SKILL.md
```

Then:

```bash
skillmgr scan                     # index the store
skillmgr status                   # deployment matrix
skillmgr deploy my-skill --all    # deploy to every detected agent
```

Install from GitHub:

```bash
skillmgr add anthropics/skills --skill theme-factory
skillmgr check --all
skillmgr update theme-factory     # Diff -> Backup -> Replace, rollback-able
```

## Commands

```
skillmgr init [path]               create a canonical store (default ~/skills)
skillmgr scan                      scan the store and sync the registry
skillmgr list [--type ...]         list skills
skillmgr status                    deployment matrix (skill x agent)
skillmgr agents                    agents + detection results
skillmgr info <skill>              source / version / deployments / backups
skillmgr deploy <skill> [agents..] deploy; --all; --mode junction|symlink|copy
skillmgr undeploy <skill> [agents..]
skillmgr add <owner/repo|url>      install from GitHub/GitLab
skillmgr check [skill|--all]       check upstream for updates
skillmgr update <skill|--all>      update canonical copy (auto backup)
skillmgr rollback <skill> [ver]    restore a backup
skillmgr doctor [--fix]            reconcile disk vs registry, repair drift
skillmgr history | root | help
```

Every command accepts `--json` for machine-readable output and `--root <path>` to point at a different store.

### The deployment matrix

```
skill                        type  claude   codex    cursor   zcode    update
------------------------------------------------------------------------------
code-debugger                local  ✓(jun)  ✓(jun)  ·       ·       =
theme-factory                upstream ✓(jun) ·       ·       ·       =

Legend: ✓ deployed  ! drift  x missing  ? unmanaged  · not deployed  |  = up-to-date  ↑ update available  E check error
```

## Interactive console (TUI)

Run bare `skillmgr` (or `skillmgr tui`) in a terminal. A main menu separates **managing** skills from **watching** them:

```
 main menu ──► Skills Management ──► pick an agent ──► that agent's skills, one per row:
                                              yes   code-debugger
                                              no    theme-factory
                                              ...
       ──────────► Skills Status Monitor ──► the skill × agent matrix, connected agents only (read-only)
       └──────────► Add Agent ────────────► type the agent's skills dir (absolute path)
```

- **Skills Management** — one screen per agent, an m×1 list where every skill is just **yes** (activated/deployed) or **no** (not activated). `enter`/`space` toggles it for that agent; re-activating a drifted row repairs it. Unmanaged content is never touched.
- **Skills Status Monitor** — the read-only deployment matrix, showing **connected agents only** (agents detected as installed). Agents whose directories don't exist stay hidden until their first deployment creates them.
- **Add Agent** — missing an agent? Type its skills directory (absolute path, `~/` works too), confirm the suggested id, and it is connected instantly — persisted to `<store>/.registry/config.json` (`extraAgents`), same as editing the config by hand.

```
 menu      ↑↓ move · enter select · q quit
 agents    ↑↓ move · enter manage · a add from GitHub · D doctor · R rescan · ← back
 manage    ↑↓ move · enter/space yes↔no · u update · / filter · ← back
 monitor   ↑↓←→ inspect · r refresh · / filter · ← back
 anywhere  ? help · q quit
```

Long operations (add/update/doctor/rescan) suspend the full screen, stream normal output, and resume on any keypress. Non-TTY environments fall back to the subcommand interface.

## Platform support

| | Windows | Linux | macOS |
|---|---|---|---|
| Link strategy | junction (no privileges) → symlink → copy | symlink → copy | symlink → copy |
| Default store root | `%USERPROFILE%\skills` | `~/skills` | `~/skills` |
| CI | ✅ GitHub Actions | ✅ GitHub Actions | ✅ GitHub Actions |

Symlink type quirks are handled for you: on Windows skillmgr uses directory junctions first (no admin rights, no Developer Mode, works across drives); real symlinks and copy mode are fallbacks. CI runs the test suite on all three platforms.

**Root resolution order:** `SKILLMGR_ROOT` env var > `canonicalRoot` in `~/.skillmgr/config.json` > platform default.

## Configuration

Two config files, both optional:

**`~/.skillmgr/config.json`** — user-level, exists before any store:

```json
{ "canonicalRoot": "D:/Projects/skills" }
```

**`<store>/.registry/config.json`** — per-store. Adding an agent is a config change, never a code change:

```json
{
  "agents": {
    "cursor": { "skillsDir": "~/.cursor/skills", "detectPaths": ["~/.cursor"] }
  },
  "extraAgents": [
    { "id": "zcode", "label": "ZCode", "skillsDir": "~/.zcode/skills", "detectPaths": ["~/.zcode"] },
    { "id": "hermes", "label": "Hermes", "skillsDir": "~/.hermes/skills", "detectPaths": ["~/.hermes"] }
  ],
  "disabledAgents": ["windsurf"],
  "allowedHosts": ["github.com", "gitlab.com", "raw.githubusercontent.com", "codeload.github.com"]
}
```

Built-in agent registry (path conventions adapted from [vercel-labs/skills](https://github.com/vercel-labs/skills), MIT — see [NOTICE](NOTICE)): claude-code, codex, cursor, github-copilot, cline, opencode, gemini-cli, windsurf.

## Skill types & update strategy

| Type | Origin | check / update |
|------|--------|----------------|
| `local` | maintained by you (default) | skipped |
| `upstream` | installed via `skillmgr add` | `git ls-remote` vs pinned commit |
| `forked` | your fork (set `source.url` to the fork) | compares against the fork |

Updates never overwrite silently: **Check → Diff → Backup → Replace**. Backups live in `.registry/backups/<skill>/<commit>/`; `rollback` restores them (and backs up the current state first, so rollback itself is reversible). Link-mode deployments pick up updates instantly; copy-mode deployments are re-copied automatically.

## Safety model

- Source URLs: http/https only, host allowlist, embedded credentials rejected, localhost/loopback/private/reserved addresses rejected (IPv4 + IPv6).
- git is always invoked with argument arrays — no shell interpolation.
- All SQL is parameterized (built-in `node:sqlite` prepared statements).
- Deployment targets containing content not created by skillmgr are never overwritten or deleted (copy mode writes a `.skillmgr-managed.json` marker; links must resolve back to the canonical store).

## Development

```bash
npm test    # 23 tests, temp dirs + fake agent homes, no global state touched
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Agent path conventions adapted from vercel-labs/skills (MIT) — see [NOTICE](NOTICE).
