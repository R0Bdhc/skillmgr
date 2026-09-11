# skillmgr

**跨 Agent 统一 AI Skills 管理器（Windows / Linux / macOS）。**

磁盘上只保留一份 canonical Skill 库；每个编码 Agent（Claude Code、Codex、Cursor、GitHub Copilot、Cline、OpenCode、Gemini CLI、Windsurf……）通过链接指向它。修改一次，所有 Agent 立即同步——没有多副本，没有版本分叉。

[English](README.md)

```
┌──────────────────────────────────────────────┐
│              CLI  (skillmgr)                 │
├──────────────────────────────────────────────┤
│      Skill Registry（SQLite，内置零依赖）       │
│    Name / Source / Version / Type / Status   │
├──────────────────────────────────────────────┤
│             Deployment Engine                │
│   Claude / Codex / Cursor / Copilot / ...    │
├──────────────────────────────────────────────┤
│    Canonical Store   默认 ~/skills           │
└──────────────────────────────────────────────┘
                     │
                     ↓
              GitHub / GitLab / Local
```

核心原则：**Canonical Store ≠ Agent 部署**。每个 Skill 只维护一份；各 Agent 的 skills 目录只是部署目标（默认链接），全部由 registry 记录。

## 为什么

按 Agent 各自维护 Skill 意味着同样的文件存 N 份，一改就分叉。skillmgr 保持唯一可信源，并对每个 Skill 回答五个问题：

- 它来自哪里？
- 当前是什么版本？
- 上游有没有更新？
- 部署到了哪些 Agent？
- 哪些 Agent 还没部署？

……并把这些答案变成一键动作：deploy / undeploy / update（自动备份 + 可回滚）/ doctor（自修复）。

## 环境要求

- Node.js **≥ 24**（使用内置 `node:sqlite` 与原生 TypeScript 运行——**零 npm 依赖**）
- git（用于从 GitHub/GitLab 安装/更新 Skill）

## 快速开始

```bash
git clone https://github.com/R0Bdhc/skillmgr.git
cd skillmgr
npm link          # 注册全局命令 skillmgr
skillmgr init     # 创建 canonical store（默认 ~/skills）
```

把 Skill 放进库（任何包含 `SKILL.md` 的目录）：

```
~/skills/
├── my-skill/
│   ├── SKILL.md
│   └── scripts/
└── another-skill/
    └── SKILL.md
```

然后：

```bash
skillmgr scan                     # 建立索引
skillmgr status                   # 部署矩阵
skillmgr deploy my-skill --all    # 一键部署到所有已检测 Agent
```

从 GitHub 安装：

```bash
skillmgr add anthropics/skills --skill theme-factory
skillmgr check --all
skillmgr update theme-factory     # Diff → Backup → Replace，可回滚
```

## 命令

```
skillmgr init [path]               创建 canonical store（默认 ~/skills）
skillmgr scan                      扫描库并同步 registry
skillmgr list [--type ...]         列出 skill
skillmgr status                    部署矩阵（skill × agent）
skillmgr agents                    agent 列表与检测结果
skillmgr info <skill>              来源 / 版本 / 部署 / 备份
skillmgr deploy <skill> [agents..] 部署；--all；--mode junction|symlink|copy
skillmgr undeploy <skill> [agents..]
skillmgr add <owner/repo|url>      从 GitHub/GitLab 安装
skillmgr check [skill|--all]       检查上游更新
skillmgr update <skill|--all>      更新 canonical（自动备份）
skillmgr rollback <skill> [ver]    回滚到备份
skillmgr doctor [--fix]            磁盘 ↔ registry 对账与修复
skillmgr history | root | help
```

所有命令支持 `--json`（机器可读输出）与 `--root <path>`（临时指定另一个 store）。

### 部署矩阵

```
skill              type  claude   codex    cursor   zcode    update
--------------------------------------------------------------------
code-debugger      local  Y(jun)  Y(jun)  .       .       =
theme-factory(#)   upstream Y(jun) .       .       .       *

Legend: Y 已部署  ! 漂移  x 缺失  ? 非受管  . 未部署
        = 最新  * 有更新  E 检查出错  名字后的 (#) = 有可用更新
```

标记刻意使用 ASCII 字符：✓ 这类符号在中文环境终端按宽字符渲染而按 1 列计算，会造成列错位；ASCII 保证任何终端/语言环境下都对齐。

## 交互式控制台（TUI）

在终端里裸敲 `skillmgr`（或 `skillmgr tui`）。主菜单把**管理**与**监视**分成两条路径：

```
 主菜单 ──► Skills Management ──► 选一个 agent ──► 该 agent 的 skill 列表（m×1）：
                                              yes   code-debugger
                                              no    theme-factory
                                              ...
       ──────────► Skills Status Monitor ──► skill × agent 矩阵，仅显示已连接 agent（只读）
       └──────────► Add Agent ────────────► 输入该 agent 的 skills 目录绝对路径
```

- **Skills Management**——每个 agent 一屏，m×1 列表里每个 skill 只有 **yes**（已激活/已部署）或 **no**（未激活）两个值。`enter`/`space` 对该 agent 切换；重新激活 drift 行即修复；非受管内容绝不触碰。
- **Skills Status Monitor**——只读部署矩阵，**只显示已连接的 agent**（检测到已安装的那批）；目录尚不存在的 agent 在首次部署创建目录前不会出现。
- **Add Agent**——发现遗漏的 agent？输入它的 skills 目录（绝对路径，也支持 `~/`），确认建议的 id 即刻接入——持久化到 `<store>/.registry/config.json`（`extraAgents` 段），与手改配置完全等效。

```
 menu      ↑↓ 移动 · enter 选择
 agents    ↑↓ 移动 · enter 进入管理 · a 从 GitHub 添加 · D doctor · R 重扫 · ← 返回
 manage    ↑↓ 移动 · enter/space yes↔no · u 更新 · / 过滤 · ← 返回
 monitor   ↑↓←→ 巡检 · r 刷新 · / 过滤 · ← 返回
 anywhere  ? 帮助 · q 退出
```

长操作（add/update/doctor/rescan）会挂起全屏、流式输出正常日志、按任意键返回。非 TTY 环境自动回退到子命令接口。

## 平台支持

| | Windows | Linux | macOS |
|---|---|---|---|
| 链接策略 | junction（无需特权）→ symlink → copy | symlink → copy | symlink → copy |
| 默认库根目录 | `%USERPROFILE%\skills` | `~/skills` | `~/skills` |
| CI | ✅ GitHub Actions | ✅ GitHub Actions | ✅ GitHub Actions |

symlink 的平台差异已内置处理：Windows 优先使用目录 junction（无需管理员、无需开发者模式、支持跨盘），真 symlink 与 copy 作为降级。CI 在三平台运行完整测试。

**根目录解析顺序**：`SKILLMGR_ROOT` 环境变量 > `~/.skillmgr/config.json` 的 `canonicalRoot` > 平台默认。

## 配置

两个配置文件，均可选：

**`~/.skillmgr/config.json`** — 用户级，先于任何 store 存在：

```json
{ "canonicalRoot": "D:/Projects/skills" }
```

**`<store>/.registry/config.json`** — 每个 store 一份。**新增 Agent 只是改配置，不需要改代码**：

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

内置注册表（路径约定改编自 [vercel-labs/skills](https://github.com/vercel-labs/skills)，MIT——见 [NOTICE](NOTICE)）：claude-code、codex、cursor、github-copilot、cline、opencode、gemini-cli、windsurf。

## Skill 类型与更新策略

| 类型 | 来源 | check / update |
|------|------|----------------|
| `local` | 自己维护（默认） | 跳过 |
| `upstream` | 通过 `skillmgr add` 安装 | `git ls-remote` 对比 pinned commit |
| `forked` | 你的 fork（source.url 指向 fork） | 与 fork 对比 |

更新绝不静默覆盖：**Check → Diff → Backup → Replace**。备份在 `.registry/backups/<skill>/<commit>/`；`rollback` 可恢复（且回滚前自动再备份当前状态，回滚本身可逆）。链接模式部署即时生效；copy 模式部署自动重拷。

## 安全模型

- 来源 URL：仅 http/https，host 白名单，拒绝 URL 内嵌凭据，拒绝 localhost/环回/私有/保留地址（IPv4 + IPv6）。
- git 全部以参数数组调用——不经 shell。
- SQL 全部参数绑定（内置 `node:sqlite` prepared statements）。
- 非 skillmgr 创建的部署目标内容绝不覆盖、绝不删除（copy 模式写入 `.skillmgr-managed.json` 标记；链接必须能解析回 canonical store）。

## 开发

```bash
npm test    # 23 个测试：临时目录 + 假 agent，不触碰全局状态
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)。Agent 路径约定改编自 vercel-labs/skills（MIT）——见 [NOTICE](NOTICE)。
