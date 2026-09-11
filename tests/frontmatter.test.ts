import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../src/frontmatter.ts';

test('解析标准 SKILL.md frontmatter', () => {
  const text = '---\nname: foo-skill\ndescription: 做某件事的技能\n---\n\n# 正文\n';
  const { attrs, body } = parseFrontmatter(text);
  assert.equal(attrs.name, 'foo-skill');
  assert.equal(attrs.description, '做某件事的技能');
  assert.match(body, /# 正文/);
});

test('解析带引号的 description（含冒号）', () => {
  const text = `---\nname: bar\ndescription: "支持: 冒号内容"\n---\nbody`;
  const { attrs } = parseFrontmatter(text);
  assert.equal(attrs.description, '支持: 冒号内容');
});

test('无 frontmatter 时返回原文', () => {
  const { attrs, body } = parseFrontmatter('# 纯标题\n');
  assert.deepEqual(attrs, {});
  assert.equal(body, '# 纯标题\n');
});

test('CRLF 换行兼容', () => {
  const text = '---\r\nname: win\r\ndescription: windows 风格\r\n---\r\nbody';
  const { attrs } = parseFrontmatter(text);
  assert.equal(attrs.name, 'win');
});

test('忽略嵌套结构', () => {
  const text = '---\nname: x\nmetadata:\n  a: 1\n---\n';
  const { attrs } = parseFrontmatter(text);
  assert.equal(attrs.name, 'x');
  assert.equal(attrs['metadata'], undefined);
});
