export interface Frontmatter {
  attrs: Record<string, string>;
  body: string;
}

/**
 * SKILL.md 的 YAML frontmatter 极简解析：只取顶层 `key: value` 标量，
 * 支持单/双引号包裹。嵌套结构对 skillmgr 无意义，直接忽略。
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { attrs: {}, body: text };
  const attrs: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value) attrs[kv[1]] = value;
  }
  return { attrs, body: text.slice(match[0].length) };
}
