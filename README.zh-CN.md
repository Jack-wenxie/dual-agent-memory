# dual-agent-memory

在一台 Windows 电脑上，供 Claude Code 和 Codex 两个编程智能体共用的本地长期记忆。

- 一个小型 MCP 服务器（`lancedb-memory-host/`）：先写加密预写日志，再存入 LanceDB，并通过持久队列分发变更。
- 一个查询引擎（`mqe/`）：从只读的 SQLite 投影中返回有界、经来源核验的证据。
- 一个 Python 伴随程序（`bti/`）：维护可读的 Markdown 记忆卡、单行索引和链接登记库。

工作围绕五个可测量的维度展开：构建成本、检索成本、生成成本、刷新延迟和查询规模，见 [docs/FIVE_DIMENSIONS.md](docs/FIVE_DIMENSIONS.md)（英文）。

> **状态：v0.2 公开候选版。** 这里的一切都只用合成数据验证过。与 v0.1 相同，投影生产者、在线投影消费者和应用钩子安装只作为源码供审阅，默认不启用。因此，新记忆会被保存，但一直处于 `pending_projection`；召回只返回现有投影已映射的记录。全新安装没有投影，所以在建好投影之前召回不会返回任何记录。详见[包含与不包含的内容](#包含与不包含的内容)。

## 整套系统的文档

v0.2 新增了一组方法文档（均为英文），介绍本仓库所属的整套知识与记忆系统，而不只是上面这三个组件。这些文档只讲结构、理念和方法，示例和模板都是合成的，不含任何真实数据。建议先读[文档索引](docs/README.md)和[系统总览](docs/SYSTEM_OVERVIEW.md)；总览列出了每一层、各层如何配合，以及每个版本公开了哪些内容。之后可以从下面三篇入手：

- [指令内核](docs/INSTRUCTION_KERNEL.md)：每个智能体只常驻加载一套简短规则，再用一张表把各类工作指向按需读取的指令模块。
- [记忆治理](docs/MEMORY_GOVERNANCE.md)：哪些内容值得记住，记忆如何写入、核对、更正和淘汰，新对话又如何把它读回来。
- [智能体协作](docs/AGENT_COLLABORATION.md)：两个智能体如何把工作拆成互不重叠的切片并互相审查产出，以及哪些决定必须由人来做。

## 目录

| 路径 | 内容 |
|---|---|
| `lancedb-memory-host/` | MCP 服务器（Node 上的 TypeScript）。工具：`ping`、`memory_recall`、`memory_store`、`memory_save_tx`、`memory_update`、`memory_forget`、`memory_stats`、`memory_list`。 |
| `mqe/` | 查询引擎：投影契约、引擎、证据包、按需展开（hydration）、合成夹具和评估工具，见 [mqe/README.md](mqe/README.md)。 |
| `bti/` | Python 伴随程序：记忆卡、索引和链接登记库，见 [bti/README.md](bti/README.md)。 |
| `graph-memory/` | 记忆图谱的发布、解析与简报内核（Python 标准库），附固定种子的合成 notebook，见 [graph-memory/README.md](graph-memory/README.md)（英文）。 |
| `screen-context/` | 已完成屏幕上下文缓存的离线校验器（Node），附固定种子的合成检查；它不是 Screenpipe 客户端，见 [screen-context/README.md](screen-context/README.md)（英文）。 |
| `third_party/` | 本项目所修改的上游文件、补丁、来源记录和校验脚本，见 [third_party/memory-lancedb-pro-1.0.32/README.md](third_party/memory-lancedb-pro-1.0.32/README.md)。 |
| `docs/` | 整套系统的[文档索引](docs/README.md)、[系统总览](docs/SYSTEM_OVERVIEW.md)、各篇方法文档和[模板](docs/README.md#templates)，以及[架构](docs/ARCHITECTURE.md)、[五个维度](docs/FIVE_DIMENSIONS.md)、[评估](docs/EVALUATION.md)、[维护](docs/MAINTENANCE.md)和[设计决策](docs/DECISIONS.md)，均为英文。 |

`lancedb-memory-host/` 和 `mqe/` 必须并列放置：主机从 `../mqe` 加载查询引擎模块，投影消费者从 `../lancedb-memory-host` 导入主机的队列模块。

## 环境要求

- Windows x64。在 Windows 11 上测试过；托管工作流使用 GitHub 的 `windows-latest` 运行器。其它平台未测试。
- Node.js 24.15.0（测试基准）和 npm。
- Python 3.12。`bti/` 只需要标准库；主机用它运行 BTI 伴随程序，另有三个主机测试需要它。用 `PY312_EXE` 指定解释器，否则主机使用 `python`。记忆图谱 notebook 和屏幕上下文检查也用 Python 3.12 运行，其中屏幕上下文检查还需要 Node。
- 实际使用时，需要一个兼容 Ollama HTTP API 的向量嵌入服务（默认 `http://localhost:11434`，模型 `qwen3-embedding:0.6b`）。测试使用本地的合成替身。

## 运行测试

两个 Node 包各自按锁文件安装，不需要运行依赖的生命周期脚本。

```powershell
cd lancedb-memory-host
npm ci --ignore-scripts
npm test
cd ../mqe
npm ci --ignore-scripts
npm test
cd ../bti
python -m unittest discover -p "test_*.py"
```

在 Windows 上请把 `TEMP` 设得短一些（远低于 70 个字符）。原生的 SQLite 和 LanceDB 库在路径超过 260 个字符时会失败，而部分测试会建立多层临时目录。记忆图谱内核和屏幕上下文校验器各有合成检查，见 [graph-memory/README.md](graph-memory/README.md#run-the-synthetic-checks) 和 [screen-context/README.md](screen-context/README.md#run-the-checks)。`.github/workflows/` 中的工作流用短临时目录运行这三套测试和这两项检查。

## 运行主机

主机只监听 `127.0.0.1`。它需要一个由你创建、至少 16 个字符的密钥文件；没有就拒绝启动，也从不替你创建。先按上文安装依赖，并先启动向量嵌入服务：存储无法初始化时，主机尝试三次后退出。

```powershell
cd lancedb-memory-host
New-Item -ItemType Directory -Force memory-data | Out-Null
node -e "require('fs').writeFileSync('memory-data/secret.txt', require('crypto').randomBytes(32).toString('hex'), { flag: 'wx' })"
$env:MEMORY_DATA = "$PWD/memory-data"
$env:LANCEDB_MEMORY_DB = "$PWD/memory-data/lancedb"
$env:SECRET_FILE = "$PWD/memory-data/secret.txt"
npm run dev
```

MCP 客户端通过 Streamable HTTP 连接 `http://127.0.0.1:<PORT>/mcp/<secret>`。请像对待密码一样对待这个地址。`GET /health` 不需要密钥，报告就绪状态、队列和投影消费者状态。没有在线消费者时（v0.1 即如此）它报告 `degraded`，各字段含义见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3000` | 回环端口。 |
| `MEMORY_DATA` | `./memory-data` | 数据根目录：审计日志和写入面。 |
| `LANCEDB_MEMORY_DB` | 无 | LanceDB 目录。记忆工具需要它。 |
| `SECRET_FILE` | `<MEMORY_DATA>/.lancedb-memory-secret` | 访问密钥，必须存在。 |
| `MEMORY_WAL_KEY_FILE` | `<MEMORY_DATA>/write-plane/.wal-key` | 加密预写日志的密钥。缺失时首次启动自动创建，与访问密钥相互独立。 |
| `OLLAMA_URL` | `http://localhost:11434` | 向量嵌入服务地址。 |
| `EMBED_MODEL` | `qwen3-embedding:0.6b` | 嵌入模型。 |
| `EMBED_VECTOR_DIM` | `qwen3-embedding` 为 1024，其它为 768 | 向量维度（64 到 4096）。 |
| `EMBED_QUERY_INSTRUCTION` | 随模型而定 | 加在召回查询前面的指令。 |
| `RATE_LIMIT` | `120` | 每个客户端地址每分钟的请求数。 |
| `MQE_CONSUMER_HEALTH_FILE` | `mqe/data/projection/mutation-consumer-health.v1.json` | `/health` 读取的投影消费者健康文件。 |
| `MQE_SOURCE_ROOTS_PATH` | `mqe/config/source_roots.v1.json` | 查询引擎的显式来源根目录配置。 |
| `PY312_EXE` | `python` | 运行 BTI 伴随程序的 Python。 |
| `BTI_DATA_HOME` | `./bti-data` | BTI 数据目录。 |

检索时限等调优变量见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。经审阅的安全摘要、记忆取代、有界的 BM25 诊断和一个只做观察的候选计数默认都关闭，各自由运维者在 `lancedb-memory-host/src/index.ts` 定义的环境开关显式开启。

## 保存和召回做了什么

1. `memory_save_tx` 需要一个幂等键。它先把请求写入加密预写日志，再把记录提交到 LanceDB，然后把变更事件发布到持久队列。默认情况下事件直接进入投影队列；如果设置 `companion_required: true`，先由 BTI 伴随程序写好 Markdown 卡片，事件随后才进入投影队列。工具返回 `stored`，同时 `record_ref: null`、`record_ref_status: pending_projection`。
2. `memory_recall` 在 LanceDB 中做向量和 BM25 检索，用倒数排名融合，再通过当前查询引擎投影把每条命中映射为不透明的 `rr1_…` 引用。没有映射的命中会被扣下，不安全的文本会被替换成脱敏标记。
3. 映射新记录的投影由生产者构建、由在线消费者激活，二者在本版本中仍只提供源码，与 v0.1 相同。预置测试 `lancedb-memory-host/test/seeded-projection-recall.test.mjs` 用生成的合成投影，端到端演示了已映射的路径。

两条路径的细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 包含与不包含的内容

| 能力 | 状态 |
|---|---|
| MCP 主机：保存、幂等重试、更新、遗忘、列出、召回、健康检查 | 已用合成数据验证 |
| 查询引擎、按需展开、输出安全、生成的投影 | 已用合成数据验证 |
| BTI 记忆卡、索引和链接登记库 | 已用合成数据验证 |
| 记忆图谱发布、解析与简报内核 | 已用固定种子的合成 notebook 验证；不含生产者、健康检查、Graphify 或图谱数据 |
| 屏幕上下文缓存校验器 | 已用固定种子的合成检查验证；不含采集客户端、Screenpipe 或录屏 |
| 投影生产者和在线投影消费者 | 仅源码供审阅；未启用；完整链路未验证 |
| 应用钩子和原生适配器 | 仅源码供审阅；未安装、未编译 |
| 其它操作系统 | 未测试 |

仓库不含任何真实记忆、标注、查询、密钥、数据库或录屏。

## 文档

- [架构](docs/ARCHITECTURE.md)：组件、写入与读取路径、队列和健康检查。
- [五个维度](docs/FIVE_DIMENSIONS.md)和[评估](docs/EVALUATION.md)：如何衡量改动。
- [维护](docs/MAINTENANCE.md)：健康检查、队列、备份、升级和定期检查。
- [设计决策](docs/DECISIONS.md)。
- [安全](SECURITY.md)和[贡献指南](CONTRIBUTING.md)。
- English: [README.md](README.md).

## 致谢

这个项目建立在许多人的工作之上，在此一并致谢。锁定的 npm 依赖版本及其声明的许可元数据见锁文件；收录和再分发说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。外部工具及模型保留各自条款。这里写的许可是各上游项目自己的声明，不是法律审查。

**收录或依赖的代码**

- [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)，作者 win4r：其记忆存储 `store.ts`（1.0.32 版）收录于本仓库并有修改，按其 package.json 声明的 MIT 许可使用。
- [LanceDB](https://github.com/lancedb/lancedb)（Apache-2.0）：记忆主机的向量与全文存储。
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)，Model Context Protocol 贡献者：主机和检索引擎的协议层。这里锁定的 1.x 版本为 MIT 许可（版权方 Anthropic, PBC）；该项目较新的 main/v2 分支对新贡献采用 Apache-2.0。
- [Express](https://github.com/expressjs/express)（MIT）与 Colin McDonnell 的 [Zod](https://github.com/colinhacks/zod)（MIT）：主机的 HTTP 层与输入校验。
- [SQLite](https://sqlite.org/)，Richard Hipp 与 SQLite 团队（公有领域）：检索引擎的投影库。
- [Apache Arrow](https://github.com/apache/arrow)（Apache-2.0），经由 LanceDB 使用。

**借鉴的方法**

- [Graphify](https://github.com/Graphify-Labs/graphify)：由 Safi Shamsi 与贡献者创建，现由 Graphify Labs 维护。参考安装用 Graphify 构建记忆图谱，[记忆图谱](docs/MEMORY_GRAPH.md) 里的方法就是从这种用法里发展出来的。参考安装所用的 0.3.11 版为 MIT 许可；当前 v8 分支为 Apache-2.0，其 NOTICE 对早期部分保留了原来的 MIT 条款。
- [Matt Pocock 的 skills](https://github.com/mattpocock/skills)（MIT）：[路由与门](docs/ROUTING_AND_GATES.md) 里的诊断循环改编自该仓库的 bug 诊断 skill。

**方法文档提到的外部工具（本仓库不包含）**

- [Screenpipe](https://github.com/screenpipe/screenpipe)：屏幕上下文方法所针对的屏幕记录器。它以 Screenpipe Commercial License 公开源码，不是开源许可；当前许可方为 Negentropy Labs, Inc.（dba Screenpipe），参考安装所用 0.4.37 版的许可写的是 Mediar, Inc.。本仓库只校验我们自己的完成缓存格式，不是 Screenpipe 客户端，也不含任何 Screenpipe 代码。
- [Ollama](https://github.com/ollama/ollama)（MIT）与 Qwen 团队的 [Qwen3-Embedding](https://github.com/QwenLM/Qwen3-Embedding)（0.6B 模型为 Apache-2.0）：默认配置里的本地嵌入运行时和模型。本仓库不含模型权重。
- 科研知识库所用的 [Obsidian](https://obsidian.md)，以及 Dmitry Paranyushkin 与 Nodus Labs 的 [InfraNodus](https://infranodus.com)（可选的文本网络分析视角）。两者都是有各自条款的产品，均未随附。

**语言、格式与工具**

- [Node.js](https://github.com/nodejs/node)、[TypeScript](https://github.com/microsoft/TypeScript)（借助 Hiroki Osame 的 [tsx](https://github.com/privatenumber/tsx) 运行）和 [Python](https://github.com/python/cpython)，以及 [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) 的类型定义。
- 离线演示用的 [Jupyter 笔记本格式](https://github.com/jupyter/nbformat)、方法文档里的 [Mermaid](https://github.com/mermaid-js/mermaid) 图，以及图文件采用的 [NetworkX](https://github.com/networkx/networkx) node-link 格式。可选的 LanceDB 导入会用到 [pandas](https://github.com/pandas-dev/pandas)。
- CI 用的 GitHub Actions [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 和 [setup-python](https://github.com/actions/setup-python)；许可元数据遵循 FSFE 的 [REUSE](https://reuse.software/) 规范与 [SPDX](https://spdx.dev/) 项目的许可元数据约定。
- 构建、安装、核验和发布前密钥扫描用到的 [Git](https://git-scm.com/)、[npm](https://github.com/npm/cli)、[PowerShell](https://github.com/PowerShell/PowerShell)，以及 Zachary Rice 的 [Gitleaks](https://github.com/gitleaks/gitleaks)。

## 许可

MIT，见 [LICENSE](LICENSE)。仓库中有一个上游文件按其声明的 MIT 许可使用，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
