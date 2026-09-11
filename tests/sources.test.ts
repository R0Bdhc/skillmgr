import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isForbiddenHost, parseRepoRef } from '../src/sources.ts';
import type { Ctx } from '../src/config.ts';

const ctx = { allowedHosts: ['github.com', 'gitlab.com'] } as unknown as Ctx;

test('owner/repo shorthand expands to github.com', () => {
  const ref = parseRepoRef('anthropics/skills', ctx);
  assert.equal(ref.url, 'https://github.com/anthropics/skills');
  assert.equal(ref.owner, 'anthropics');
});

test('full https URL passes', () => {
  const ref = parseRepoRef('https://github.com/vercel-labs/agent-skills/tree/main/skills/foo', ctx);
  assert.equal(ref.url, 'https://github.com/vercel-labs/agent-skills');
  assert.equal(ref.repo, 'agent-skills');
});

test('rejects non-http(s) protocols', () => {
  assert.throws(() => parseRepoRef('ftp://github.com/a/b', ctx), /http\/https/);
  assert.throws(() => parseRepoRef('file:///etc/passwd', ctx), /http\/https/);
});

test('rejects hosts outside the allowlist', () => {
  assert.throws(() => parseRepoRef('https://evil.example.com/a/b', ctx), /allowlist/);
});

test('rejects local/loopback/private addresses (even if allowlisted)', () => {
  assert.throws(() => parseRepoRef('http://localhost/a/b', ctx), /forbidden host/);
  assert.throws(() => parseRepoRef('http://127.0.0.1/a/b', ctx), /forbidden host/);
  assert.throws(() => parseRepoRef('http://192.168.1.10/a/b', ctx), /forbidden host/);
  assert.throws(() => parseRepoRef('http://10.0.0.5/a/b', ctx), /forbidden host/);
  assert.throws(() => parseRepoRef('http://[::1]/a/b', ctx), /forbidden host/);
  assert.throws(() => parseRepoRef('http://169.254.169.254/latest', ctx), /forbidden host/);
});

test('rejects credentials embedded in the URL', () => {
  assert.throws(() => parseRepoRef('https://user:token@github.com/a/b', ctx), /credentials/);
});

test('isForbiddenHost details', () => {
  assert.equal(isForbiddenHost('LOCALHOST'), true);
  assert.equal(isForbiddenHost('172.16.0.1'), true);
  assert.equal(isForbiddenHost('172.32.0.1'), false);
  assert.equal(isForbiddenHost('224.0.0.1'), true);
  assert.equal(isForbiddenHost('fd00::1'), true);
  assert.equal(isForbiddenHost('github.com'), false);
});
