import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffTrees, isSubpath, pathEq, treeHash } from '../src/util.ts';
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'skillmgr-test-'));
}

test('treeHash：内容变化则指纹变化', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'world');
    const h1 = treeHash(dir);
    writeFileSync(join(dir, 'a.txt'), 'changed');
    const h2 = treeHash(dir);
    assert.notEqual(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('treeHash：extraIgnore 排除标记文件', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, '.skillmgr-managed.json'), '{}');
    const h1 = treeHash(dir, ['.skillmgr-managed.json']);
    const h2 = treeHash(join(dir));
    writeFileSync(join(dir, '.skillmgr-managed.json'), '{"x":1}');
    const h3 = treeHash(dir, ['.skillmgr-managed.json']);
    assert.equal(h1, h3);
    assert.notEqual(h1, h2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diffTrees：识别新增/删除/修改', () => {
  const a = tmp();
  const b = tmp();
  try {
    writeFileSync(join(a, 'same.txt'), 'x');
    writeFileSync(join(a, 'old.txt'), 'y');
    writeFileSync(join(b, 'same.txt'), 'x');
    writeFileSync(join(b, 'new.txt'), 'z');
    writeFileSync(join(b, 'old.txt'), 'changed');
    const d = diffTrees(a, b);
    assert.deepEqual(d.added.sort(), ['new.txt']);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.changed.sort(), ['old.txt']);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('pathEq 大小写不敏感', () => {
  assert.ok(pathEq(join('a', 'B', 'c'), join('A', 'b', 'C')));
  assert.ok(!pathEq(join('a', 'b'), join('a', 'c')));
  if (process.platform === 'win32') {
    // Windows 专属语义：正斜杠与反斜杠等价
    assert.ok(pathEq('D:\\Projects\\skills', 'd:/projects/skills'));
  }
  assert.ok(!pathEq(join('store'), join('other')));
});

test('isSubpath 防目录逃逸', () => {
  const parent = join('store');
  assert.ok(isSubpath(parent, join('store', 'foo')));
  assert.ok(!isSubpath(parent, join('store-other', 'foo')));
  assert.ok(!isSubpath(parent, join('elsewhere', 'evil')));
});
