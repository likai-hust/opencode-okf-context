# opencode-okf-context

[English](./README.md) | 简体中文

一个 [OpenCode](https://opencode.ai) 插件，为 [OKF（开放知识格式，Open Knowledge Format）](https://github.com/GoogleCloudPlatform/knowledge-catalog) 知识包提供**渐进式披露**与**用完即卸**能力——让 AI agent 能读取整座知识库，却不会把上下文窗口撑爆。

设计直接借鉴了 [opencode-dynamic-context-pruning (DCP)](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)：和 DCP 一样，它**永不修改真实会话历史**，只在消息发往 LLM 的途中重写。但 DCP 用 LLM 生成的摘要来剪枝通用内容，而本插件利用 OKF 原生的结构（YAML frontmatter 的 `description`、`index.md`）做**确定性、零额外 token** 的披露与卸载。

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

借鉴自 / 互补于 DCP 的三套机制：

| 机制 | 发生了什么 |
|---|---|
| **确定性卸载** | 已加载 concept 的 `okf_read` 输出，在足够轮次后或显式 `okf_unload` 时，被替换为紧凑占位符（标题 + 类型 + 描述）。无需调用 LLM 生成摘要。 |
| **去重（deduplication）** | 同一个 concept 被读取两次时，只保留最新一次的全文；较早的读取折叠为"已去重"占位符。 |
| **软提醒（soft nudge）** | 当留存的 OKF 内容超过阈值，会在最后一条用户消息上锚定一行提醒（绝不新增消息），并按消息数节流。 |

保护机制：最近的 `keepRecent` 次读取永不自动卸载；`protectedConcepts` glob 永不卸载；显式 `okf_unload` 优先级最高。

## 工具一览

| 工具 | 参数 | 返回 |
|---|---|---|
| `okf_list` | `bundle?`、`path?` | 某个 bundle 或子目录的索引（仅标题 + 描述） |
| `okf_read` | `id`、`bundle?` | concept 的完整 markdown + 末尾一行"用完请 okf_unload"引导 |
| `okf_search` | `query`、`bundle?`、`maxResults?` | 先搜元数据（title/description/tags）；仅当元数据无匹配时才回退搜正文。返回精简引用 + 一行片段，绝不返回全文 |
| `okf_write` | `id`、`type?`、`title?`、`description?`、`tags?`、`body?`、`bundle?`、`mode?` | 新建/更新 concept。`update` 模式（默认）下只改传入的字段，其余从磁盘保留——可只修一个字段而无需重述整篇文档。更新父级 `index.md`；按日期头前置写入 `log.md` |
| `okf_validate` | `id?` 或 `all: true`、`bundle?` | 只读校验报告（仅概念级规则）；每个问题附带一条可直接运行的 `okf_write(...)` 修复命令 |
| `okf_unload` | `id?` 或 `all: true`、`bundle?` | 标记 concept 立即卸载；返回操作结果 |

### 校验与修复

`okf_validate` 按概念级规则检查每个 concept，报告问题（含严重级别）及修复命令：

```
✓ Validated 3 concept(s) in bundle "demo": 1 valid, 2 with issues (1 error, 3 warnings).

▶ tables/bad_tags  (bundle: demo, 2 issues)
  ⚠ [warning] title: `title` is missing; defaulting to the concept id "bad_tags".
    → fix: okf_write(id: "tables/bad_tags", bundle: "demo", mode: "update", title: "bad_tags")
  ⚠ [warning] tags: `tags` is "core" (string); it should be an array of strings.
    → fix: okf_write(id: "tables/bad_tags", bundle: "demo", mode: "update", tags: ["core"])

▶ tables/bad_type  (bundle: demo, 2 issues)
  ✗ [error] type: `type` is missing or empty. The OKF spec requires `type` …
    → fix: okf_write(id: "tables/bad_type", bundle: "demo", mode: "update", type: "<your type, …>")
```

规则（仅概念级）：

| code | 严重级别 | 触发条件 | 可自动修复？ |
|---|---|---|---|
| `type-missing` | error | `type` 为空（spec 唯一硬性要求） | ❌ 需你输入 |
| `type-not-string` | warning | `type` 不是字符串 | ✅ 强转为 `String(type)` |
| `frontmatter-missing` | error | 完全没有 `---` 块 | ✅ 自动补齐骨架 |
| `title-missing` | warning | `title` 为空 | ✅ 默认取 id 末段 |
| `description-missing` | warning | `description` 为空（驱动渐进式披露） | ❌ 需你输入 |
| `tags-not-array` | warning | `tags` 不是字符串数组 | ✅ 规范化为 `string[]` |
| `body-empty` | warning | markdown 正文为空 | ❌ 需你输入 |

`okf_validate` 绝不写文件。修复时运行它给出的 `okf_write` 命令即可——每条都用 `mode: "update"`，只改列出的字段，其余原样保留。标 ❌ 的问题需要校验器无法编造的内容，因此以带 `<占位符>` 的模板形式给出，请你填入真实内容。

## 安装（本地开发）

opencode 会自动加载项目里的 `.opencode/plugin/*.ts`，所以本仓库可以直接 dogfood 自己：

```bash
cd opencode-okf-context
bun install
# fixtures/sample-bundle 里的示例知识包会被自动发现
opencode
```

`.opencode/plugin/okf.ts` 重新导出 `src/index.ts`。用下面的命令验证注册：

```bash
opencode debug agent build | grep okf   # -> okf_list/read/search/write/unload: true
```

## 安装

opencode 会自动加载其插件目录下的任意 `*.js` / `*.ts` 文件。提供三种安装方式：

### 方式一：离线 / 内网（单文件，零依赖，推荐用于受限网络）

一个完全打包、无运行时依赖的 `okf.js` 是内网环境最简单的分发形式。拿到离线包（`opencode-okf-context-0.1.0-offline.tar.gz`）或自行构建后，把文件放进 opencode 的插件目录即可：

```bash
mkdir -p ~/.config/opencode/plugin          # 全局（对所有项目生效）
tar -xzf opencode-okf-context-0.1.0-offline.tar.gz -C ~/.config/opencode/plugin okf.js
# 或按项目安装：放到对应项目的 .opencode/plugin/okf.js
opencode debug agent build | grep okf       # 验证 5 个工具已注册
```

自行从本仓库构建离线文件：

```bash
cd opencode-okf-context
bun install
bun run build        # 产出 dist/index.js（yaml、@opencode-ai/* 全部已打包进去）
cp dist/index.js ~/.config/opencode/plugin/okf.js
```

升级 = 覆盖 `okf.js` 后重启 opencode；卸载 = 删除该文件。

### 方式二：从 npm 安装

```bash
opencode plugin opencode-okf-context@latest --global
```

或手动加到 `~/.config/opencode/opencode.json`：

```json
{ "plugin": ["opencode-okf-context@latest"] }
```

### 方式三：从本地目录安装（开发调试用）

把 `plugin` 数组指向本仓库——opencode 用 Bun 运行 `.ts`，改代码后重启即生效：

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["/absolute/path/to/opencode-okf-context"] }
```

> 仓库根目录已内置 `.opencode/plugin/okf.ts` 重导出 `src/index.ts`——只要把 `plugin` 指向本仓库根目录，opencode 就会自动发现并加载它，无需额外配置。

### 关于包名

社区已有一个独立的 `opencode-okf` 包，专注于 OKF bundle 的**创作与校验**（`/okf-create`、`/okf-validate` 等）。本插件（`opencode-okf-context`）与之互补——本插件管**读取与上下文管理**。两者可同时安装、互不冲突。

## 配置

采用 DCP 风格的分层配置，后加载的层覆盖前层（深度合并）：

1. `~/.config/opencode/okf.jsonc`（全局）
2. `$OPENCODE_CONFIG_DIR/okf.jsonc`（若设置了该环境变量）
3. `<项目>/.opencode/okf.jsonc`（项目级）
4. `opencode.json` 里的插件选项（`["opencode-okf-context", {...}]`）——优先级最高

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

完整 schema 见 [`okf.schema.json`](./okf.schema.json)。

### 配置项说明

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `scan.enabled` | `true` | 是否自动扫描项目根目录发现 bundle |
| `scan.maxDepth` | `4` | 自动扫描的最大目录深度 |
| `bundles` | `[]` | 显式声明的 bundle，与自动扫描结果合并（冲突时以配置为准） |
| `disclosure.injectManifest` | `true` | 是否把 L0 清单注入系统提示 |
| `disclosure.maxManifestChars` | `2000` | 注入清单的字符上限 |
| `unload.afterTurns` | `2` | 加载多少轮用户消息后自动卸载 |
| `unload.keepRecent` | `1` | 永不自动卸载最近 N 次读取 |
| `unload.placeholder` | `"description"` | 占位符详略：`description`（带标题+描述）或 `minimal`（仅重载提示） |
| `nudge.threshold` | `6000` | 留存的 OKF 内容超过多少字符时触发软提醒 |
| `nudge.frequency` | `3` | 每 N 条用户消息最多注入一次提醒 |
| `write.enabled` | `true` | 是否启用 `okf_write` |
| `write.updateIndex` | `true` | 写 concept 时同步更新父级 `index.md` |
| `write.appendLog` | `true` | 写 concept 时按日期头前置写入 `log.md` |
| `protectedConcepts` | `[]` | 永不自动卸载的 concept id glob（如 `tables/*`） |
| `debug` | `false` | 向 stderr 输出卸载/去重/提醒日志 |

## 与 DCP 共存

opencode-okf 与 DCP 可以干净地共存——它们处理的是不同对象：

- DCP 剪枝的是通用的陈旧工具输出 / 消息段（用 LLM 摘要）。
- opencode-okf 只重写自己的 `okf_read` 输出，替换为极小的确定性占位符。
- 卸载后的占位符已经很小，DCP 在那里没有什么可再压缩的。

两者同时运行无需特殊配置。

## 开发

```bash
bun install
bun test            # 49 个测试：core / messages / write / validate / integration
bunx tsc --noEmit   # 类型检查
```

测试用例在 [`tests/`](./tests)，示例知识包在 [`fixtures/sample-bundle`](./fixtures/sample-bundle)。集成测试会加载真实的插件入口，在不启动 opencode 服务的情况下端到端验证 hooks 与工具。

## 打包与发布

```bash
bun run build       # tsup 打包 JS（yaml 已 bundle）+ tsc 生成 d.ts
npm pack            # 生成 opencode-okf-context-0.1.0.tgz
npm publish         # 发布到 npm（需先 npm login）
```

构建产物在 `dist/`，`@opencode-ai/plugin` 作为 peerDependency 由 opencode 运行时提供，包本身运行时零外部依赖。

## 项目结构

```
src/
  index.ts        插件入口：串联发现 + 工具 + transform hooks
  discovery.ts    bundle 扫描与 OKF concept 解析
  frontmatter.ts  YAML frontmatter 拆分 / 序列化
  config.ts       分层 okf.jsonc 加载（JSONC 注释剥离 + 深度合并）
  state.ts        内存 bundle 缓存 + 每会话卸载/提醒状态
  registry.ts     bundle/concept 解析、占位符、glob 匹配
  indexing.ts     L0 清单 + L1 索引渲染（缺失 index.md 时自动合成）
  tools.ts        6 个 okf_* 工具（含 okf_validate）
  validate.ts     概念级校验规则（纯函数，供 okf_validate 使用）
  messages.ts     出站变换：去重 + 自动/手动卸载 + 软提醒
tests/            core、messages（卸载/去重/提醒）、write、validate、integration
fixtures/sample-bundle/   一个含 3 个 concept 的 OKF 知识包，供 dogfood 与测试
.opencode/plugin/okf.ts   本地开发用的重导出，让插件在本仓库内加载
```

## 范围 / 不做的事（v1）

- 不做 LLM 生成的摘要（OKF 的 `description` 就是确定性的摘要）。
- 不做 "strong"/阻断式提醒分层（v1 仅 soft）。
- 不实现 Attested Computation（证明计算）执行。
- 校验**仅限概念级**（frontmatter 的 `type`/`title`/`description`/`tags` + 正文）。bundle 结构检查（根 `index.md` 的 `okf_version`、`log.md` 是否存在、交叉链接完整性）不在范围内——那些属于专注创作的 `opencode-okf` 包。
- 已具备发布结构，但尚未发布到 npm（运行 `bun run build` 后即可发布）。

## 许可证

MIT
