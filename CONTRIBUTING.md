# Contributing

Thanks for your interest in improving skillmgr!

## Development setup

Requirements: Node.js >= 24 (uses the built-in `node:sqlite` and native TypeScript execution), git.

```bash
git clone https://github.com/R0Bdhc/skillmgr.git
cd skillmgr
npm link     # registers the `skillmgr` command
npm test     # 23 tests, no network or global state touched
```

## Principles

- **Zero runtime dependencies.** Everything is built on Node stdlib (`node:sqlite`, `node:test`, `fs`, `child_process` with argument arrays — no shell interpolation).
- **Canonical store ≠ agent deployments.** The store holds the only copy; agent directories only ever hold links or clearly marked copies (`.skillmgr-managed.json`).
- **Never touch unmanaged content.** If a deployment target exists but was not created by skillmgr, refuse.
- **Adding an agent is a config change, not a code change** (`.registry/config.json`).
- **Cross-platform by construction:** junction on Windows (no privileges needed), symlink on POSIX, copy as last resort. CI runs the suite on ubuntu/windows/macos.

## Pull requests

1. Create a feature branch.
2. Add or update tests in `tests/` — bug fixes need a regression test.
3. Run `npm test` and make sure it passes on your platform.
4. Keep user-facing strings in English; code comments may be English or Chinese.
