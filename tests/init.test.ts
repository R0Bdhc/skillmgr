import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDefaultRoot } from '../src/config.ts';
import { initStore } from '../src/init.ts';

test('default root resolution priority: env > user config > ~/skills', () => {
  // 1. env wins
  assert.equal(
    resolveDefaultRoot('/tmp/from-env', 'D:\\custom\\store'),
    resolve('/tmp/from-env'),
  );
  // 2. user config next (supports ~)
  assert.equal(
    resolveDefaultRoot(undefined, '~/mystore'),
    join(homedir(), 'mystore'),
  );
  // 3. platform default: ~/skills
  assert.equal(
    resolveDefaultRoot(undefined, undefined),
    join(homedir(), 'skills'),
  );
});

test('initStore creates store skeleton and a parseable default config, and never overwrites', () => {
  const base = mkdtempSync(join(tmpdir(), 'skillmgr-init-'));
  try {
    const target = join(base, 'new-store');
    const r1 = initStore(target);
    assert.equal(r1.createdStore, true);
    assert.equal(r1.createdConfig, true);
    assert.ok(existsSync(join(target, '.registry')));

    // 默认 config 必须能被 loadConfigFile 的 JSON.parse 接受
    const cfg = JSON.parse(readFileSync(join(target, '.registry', 'config.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.allowedHosts));
    assert.ok(cfg.allowedHosts.includes('github.com'));

    // 二次 init：不覆盖已有 config
    const sentinel = { _readme: ['sentinel'], agents: {}, extraAgents: [], disabledAgents: [], allowedHosts: ['example.com'] };
    writeFileSync(join(target, '.registry', 'config.json'), JSON.stringify(sentinel));
    const r2 = initStore(target);
    assert.equal(r2.createdConfig, false);
    assert.deepEqual(JSON.parse(readFileSync(join(target, '.registry', 'config.json'), 'utf8')), sentinel);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
