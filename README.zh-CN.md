# opencode-okf-context

[English](./README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/opencode-okf-context)](https://www.npmjs.com/package/opencode-okf-context) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

一个 [OpenCode](https://opencode.ai) 插件，为 [OKF（开放知识格式，Open Knowledge Format）](https://github.com/GoogleCloudPlatform/knowledge-catalog) 知识包提供**渐进式披露**与**用完即卸**能力——让 AI agent 能读取整座知识库，却不会把上下文窗口撑爆。

设计借鉴了 [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)：和 DCP 一样，它只在消息发往 LLM 的途中重写，**永不修改真实会话历史**。但 DCP 用 LLM 摘要剪枝通用内容，本插件利用 OKF 原生结构（YAML `description`、`index.md`）做**确定性、零额外 token** 的披露与卸载。

> **它不是记忆插件。** 本插件是**知识访问**插件：读取*人工维护*的 OKF 知识包，低成本查询大型知识库且不长期占用上下文。它**不**记录对话、不自动生成记忆——需要记忆能力请改用记忆类插件（如 `echoes-vault-opencode`）。

## 它如何工作

```
L0 清单（始终在系统提示里，约几百字符）
   bundle 列表 + 根索引（标题 + 描述）+ 使用说明
        │ okf_list 下钻
L1 索引（按需，体积小）──────────────────────────┐
   某个 bundle 或子目录的索引（标题 + 描述，无全文）
        │ okf_read 加载  /  okf_search 定位
L2 全文（按需，体积大，有生命周期）
   concept 的完整 markdown 进入上下文
        │ 经过 N 轮用户消息（默认 2）  ·  或  okf_unload
卸载：全文 → 占位符
   "[OKF] concept tables/customers 已卸载 — 释放约 3.2k 字符。
    保留摘要：customers [BigQuery Table] — 客户主表…
    用 okf_read(id: \"tables/customers\") 重新加载。"
```

三套机制：

| 机制 | 发生了什么 |
|---|---|
| **确定性卸载** | 已加载 concept 的 `okf_read` 输出，在足够轮次后或显式 `okf_unload` 时，被替换为紧凑占位符（标题 + 类型 + 描述）。无需调用 LLM。 |
| **去重（deduplication）** | 同一个 concept 被读取两次时，只保留最新一次的全文；较早的读取折叠为"已去重"占位符。 |
| **软提醒（soft nudge）** | 当留存的 OKF 内容超过阈值，会在最后一条用户消息上锚定一行提醒（绝不新增消息）。 |

保护机制：最近的 `keepRecent` 次读取和 `protectedConcepts` glob 永不自动卸载；显式 `okf_unload` 优先级最高。所有重写只发生在出站消息——真实历史永不改变。

## 工具一览

| 工具 | 参数 | 返回 |
|---|---|---|
| `okf_list` | `bundle?`、`path?` | 某个 bundle 或子目录的索引（仅标题 + 描述） |
| `okf_read` | `id` 或 `ids: [...]`、`bundle?` | concept 的完整 markdown（单个，或批量整体加载）+ 出/入边引用元数据 + 末尾一行"用完请 okf_unload"引导 |
| `okf_search` | `query`、`bundle?`、`maxResults?` | 先搜元数据（title/description/tags），仅当无匹配时回退搜正文；返回精简引用 + 一行片段，绝不返回全文 |
| `okf_write` | `id`、`type?`、`title?`、`description?`、`tags?`、`body?`、`bundle?`、`mode?` | 新建 / 更新 / 删除 concept。`update`（默认）只改传入字段；`delete` 删除文件、移除其 `index.md` 条目并记入 `log.md` |
| `okf_validate` | `id?` 或 `all: true`、`bundle?` | 只读校验报告（概念级；`all:true` 还含 bundle 级）；每个问题附带一条可直接运行的 `okf_write(...)` 修复命令 |
| `okf_unload` | `id?` 或 `all: true`、`bundle?` | 标记 concept 立即卸载 |
| `okf_refs` | `id`、`bundle?` | 查询某个 concept 的引用图谱（谁引用了它 + 它引用了谁），仅元数据、不加载正文。用于影响分析（"改这个表会影响谁？"） |

`okf_validate` 按规则检查每个 concept 并对每个问题给出修复命令——它本身绝不写文件，运行它建议的 `okf_write` 命令即可：

```
✓ Validated 3 concept(s) in bundle "demo": 1 valid, 2 with issues (1 error, 3 warnings).

▶ tables/bad_type  (bundle: demo, 2 issues)
  ✗ [error] type: `type` is missing or empty. The OKF spec requires `type` …
    → fix: okf_write(id: "tables/bad_type", bundle: "demo", mode: "update", type: "<your type, …>")
```

检查范围：frontmatter 的 `type`/`title`/`description`/`tags` + 正文（概念级）；`okf_version`、`log.md`、断裂的交叉链接（bundle 级，用 `all:true`）。concept 的 YAML 损坏不再拖垮整个 bundle——它会以空 frontmatter 加载并报 `yaml-error`。

## 安装

已发布到 [npm](https://www.npmjs.com/package/opencode-okf-context)，包名 `opencode-okf-context`：

```bash
opencode plugin opencode-okf-context@latest --global
```

或手动加到 `~/.config/opencode/opencode.json`：

```json
{ "plugin": ["opencode-okf-context@latest"] }
```

验证 7 个工具已注册：

```bash
opencode debug agent build | grep okf   # -> okf_list/read/search/write/validate/unload/refs: true
```

> **关于包名：** 社区有一个独立的 `opencode-okf` 包，专注于 OKF bundle 的*创作与校验*。本插件（`opencode-okf-context`）与之互补——管*读取与上下文管理*。两者可同时安装、互不冲突。

## 配置

分层加载（深度合并，后者覆盖前者）：`~/.config/opencode/okf.jsonc` → `$OPENCODE_CONFIG_DIR/okf.jsonc` → `<项目>/.opencode/okf.jsonc` → `opencode.json` 里的插件选项。完整 schema 见 [`okf.schema.json`](./okf.schema.json)。

```jsonc
// .opencode/okf.jsonc
{
  "enabled": true,
  "scan":   { "enabled": true, "maxDepth": 4, "ignore": [] },
  "bundles": [{ "path": "docs/knowledge", "name": "project-kb" }],
  "disclosure": { "injectManifest": true, "maxManifestChars": 2000 },
  "unload": {
    "afterTurns": 2,          // 加载后经过 2 轮用户消息即卸载
    "keepRecent": 1,          // 最近 1 次读取永不自动卸载
    "placeholder": "description"
  },
  "nudge":   { "threshold": 6000, "frequency": 3, "force": "soft" },
  "write":   { "enabled": true, "updateIndex": true, "appendLog": true },
  "protectedConcepts": ["tables/*"],
  "debug": false
}
```

## 开发

```bash
bun install
bun test            # 106 个测试
bunx tsc --noEmit   # 类型检查
```

本仓库通过 `.opencode/plugin/okf.ts`（重导出 `src/index.ts`）dogfood 自己——在仓库根目录运行 `opencode` 即从源码加载插件，并自动发现 `fixtures/sample-bundle`。完整架构说明见 [AGENTS.md](./AGENTS.md)。

## 打包与发布

```bash
bun run build       # tsup 打包 JS（yaml 已 bundle）+ tsc 生成 d.ts
npm publish         # 需先 npm login
```

`@opencode-ai/plugin` 作为 peerDependency 由 opencode 运行时提供，包本身运行时零外部依赖。

## 范围 / 不做的事（v1）

- 不做 LLM 生成的摘要（OKF 的 `description` 就是确定性摘要）；提醒分层仅 soft。
- 校验覆盖概念级与 bundle 级检查；交叉链接的*完整性修复*不在范围内（属于 `opencode-okf`）。

## 许可证

MIT
