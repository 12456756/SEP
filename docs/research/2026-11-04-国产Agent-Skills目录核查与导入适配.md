# 国产 Agent Skills 目录核查与导入适配

核查日期：2026-11-04。实现涉及 SEP Web 与独立仓库 `sep-client`；本文不表示安装包已发布。

## 本机确认的目录

以下为本次在 macOS 上实际存在的目录。`~` 指当前操作系统用户主目录，扫描器运行在 SEP 客户端主进程内，不是服务器上。

| 来源 | 目录 | 本次试扫候选数 |
|---|---|---:|
| WorkBuddy 用户技能 | `~/.workbuddy/skills` | 1 |
| WorkBuddy 本地插件 | `~/.workbuddy/plugins/cache` | 29 |
| WorkBuddy 内置技能 | `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/skills` | 18 |
| 豆包办公用户技能 | `~/DoubaoWork/skills` | 0 |
| 豆包办公内置技能 | `~/Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.skills` | 106 |
| Qoder 用户技能 | `~/.qoder/skills` | 1 |

这是当前机器的观测值，不是产品内置技能数量承诺。WorkBuddy 插件目录出现 3 条深度上限警告，因此上述数量是已发现候选数，不能据此认定已经扫描所有深层目录。技能包内的 `sub-skills`、`references` 等资源不拆成独立候选，随外层技能预览和打包；同一真实目录合并，不同路径副本保留。

豆包办公（本机应用 `DoubaoWork.app`）与普通豆包聊天应用不是同一个产品目录。本次只验证豆包办公的 macOS 默认配置，未把该路径推断为 Windows、Linux 或其他浏览器配置的通用约定。已存在的用户技能文件夹为空，不代表该软件没有内置技能。

WorkBuddy 的 `plugins/marketplaces` 还有大量目录和连接器清单。本次自动扫描只新增已确认的内置技能子目录和本地插件缓存，不将整个市场目录、会话、数据库、配置或整个应用数据目录设为授权根。存在缓存副本不代表插件当前已经启用。

## 其他已核实的默认约定

| Agent | 用户级目录 | 项目级目录 | 证据 |
|---|---|---|---|
| CodeBuddy | `~/.codebuddy/skills` | `.codebuddy/skills` | 官方 CLI Skills 文档 |
| Qwen Code | `~/.qwen/skills` | `.qwen/skills` | 官方仓库 Skills 文档 |
| Kimi Code | `~/.kimi/skills` | `.kimi/skills` | 官方仓库 Skills 文档 |

官方资料：

- CodeBuddy：https://www.codebuddy.cn/docs/cli/skills
- Qwen Code：https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/skills.md
- Kimi Code：https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/skills.md

Kimi 的技能目录不能根据本机 `~/.kimi-code` 配置目录猜测。其文档还列出通用目录 `~/.config/agents/skills`、`~/.agents/skills`，以及兼容的 Claude/Codex 目录。SEP 对目录来源单独分类，不把读取兼容性直接转换为多个品牌标签。自定义路径仍通过客户端已有目录选择入口授权，本次不解析各产品的任意配置路径。

TRAE、QoderWork 等产品未在本次完成默认目录核验，未加入预设列表；其技能可以通过客户端手动选择所在目录扫描。

## 已实现的适配

- 客户端为 WorkBuddy、豆包办公、CodeBuddy、Qoder、Qwen Code、Kimi Code 新增用户级根目录和来源标识；新增目录仅在实际存在且通过 realpath 边界校验时展示。
- 豆包办公的两条自动发现路径限定 macOS，不猜测其他系统的应用数据路径。
- 项目扫描补充 `.workbuddy/skills`、`.codebuddy/skills`、`.qoder/skills`、`.qwen/skills`、`.kimi/skills`，来源按实际目录归类。
- XDG `agents/skills` 作为共享来源；保留原有 `.agents/skills`。
- Web 的“Agent 来源”筛选增加上述工具，复用服务端已有精确 `source` 筛选接口，无需增加导入会话字段。
- 文件权限、符号链接、文件预算、预览快照、打包和上传规则继续由现有扫描器执行。发现路径和预览不会自动上传技能，仍由用户选择并执行导入。

本机试扫只读取候选信息，没有创建云端导入会话或上传文件。识别到 `SKILL.md` 仅说明可进入导入流程，不保证技能调用的客户端私有工具、MCP、账号及资源在 SEP 上可用；这类依赖仍须平台审核和适配。

## 验证与发布

回归测试覆盖新增目录发现、来源归类、插件嵌套目录、缺失目录隐藏，以及越界符号链接拒绝。Web 回归验证 WorkBuddy、豆包办公、OpenCode 的来源查询和切换筛选后的分页重置。

代码完成后，Web 需要发布才会显示新选项，客户端需要重新构建、打包并安装才能自动扫描新增来源。旧客户端不会因为 Web 新增下拉选项而获得本机扫描能力。首次发现的新目录仍须用户在客户端批准；既有授权不自动扩大。
