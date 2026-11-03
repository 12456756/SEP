# 本地 Agent Skills 扫描上传可行性调研

> 同日后续复核：[Web 本机 Skills 扫描与开发者身份方案复核](./2026-11-03-Web本机Skills扫描与开发者身份方案复核.md)补充了更少操作的生产方案与实际账号证据。生产主路径建议更新为“Web + 免登录本机连接器 + 云端短期导入会话”，本文 localhost 桥接保留为较低开发成本的过渡选项。扫描核心问题、Agent 目录表和 ADMIN 首次创建边界继续适用。

> 日期：2026-11-03。代码基线：SEP `a375419`。范围：截图中的运营后台首次导入、用户电脑上的 Agent Skills 发现、部署后的连接方式与开发评估。本文是调研与开发建议，不代表功能已经开发或部署。

已确认的前端页面设计与详细开发任务见 [Skills 本机扫描导入前端开发方案 v1](../plans/2026-11-03-Skills本机扫描导入前端开发方案-v1.md)。助手 v1 的 roots、单项预览、会话撤销等接口在该文中进一步细化；均属于待实现契约。

## 结论摘要

- **可以现在开始开发，已有可复用基础。** 仓库已经有本地扫描器、打包器、CLI 和 localhost 桥接原型；当前截图页面尚未接入。主要工作是接通运营导入、补足本机授权与目录兼容、完成部署浏览器联调。
- **完整需求应采用“部署后的 SEP 网页 + 用户电脑上的扫描助手”。** 远端服务器不能直接扫描访问者电脑；本地助手安装、启动并配对后，网页可展示各 Agent 的候选 Skills，由用户选择上传。已有 SEP 桌面客户端也可承载扫描能力，但需要在该客户端单独开发。
- **不必取消 ZIP 协议。** 用户不再手工压缩；助手在本机把选中的完整技能目录生成 ZIP，复用现有上传、静态校验和审核流程。脚本、references、assets 一并保留，不能只上传 `SKILL.md`。
- **首期按当前权限仅开放运营 ADMIN 首次导入。** 当前贡献接口明确禁止创建 SKILL，旧 CLI 的“上传后创建投稿”路径已不适用。扫描功能不能顺带放开普通成员首次创建权限。
- **预估：单人 5–8 个工程日可完成运营后台自动发现与单项导入的内测版。** 正式三系统安装分发另计 3–5 日；批量导入另计 2–3 日。若只做用户手选目录、免压缩上传，预计 1–2 日，但不能替代跨 Agent 自动发现。以上是基于代码核查的估算，未做生产浏览器实测，不能承诺当天上线。

## SEP 当前实际状态

### 可复用的代码与接口

以下 URL 均相对 `/api`；本机桥接的 `/health` 等接口不经过 SEP `/api`。

| 位置 | 已有能力 | 本次判断 |
|---|---|---|
| [`skill-form.tsx`](../../web/src/app/(platform)/admin/capabilities/new/skill-form.tsx) | 选择 ZIP，上传后预填名称/描述，提交创建 | 截图对应的主改动入口；可增加“扫描本机”来源 |
| [`AdminUploadController`](../../backend/src/modules/admin/admin-upload.controller.ts) | `POST /admin/capabilities/upload-skill`，JWT + ADMIN；返回 `zipPath/sha256/fileCount/totalSize/content` | 首期直接复用，保持现有字段与鉴权 |
| [`CapabilityService.create`](../../backend/src/modules/capability/capability.service.ts) | `POST /capabilities` 的 SKILL 首次创建仅 ADMIN；重读已上传包并核对内容，创建初始待平台审核版本 | 本机导入继续走这条链路，上传成功不等于创建成功或审核通过 |
| [`scanner.mjs`](../../scripts/skill-scanner/scanner.mjs) | `discoverRoots/scanSkills/inspectSkillDirectory/packageSkill`；扫描器版本 `0.3.0`，提供文件清单与内容树哈希 | 可复用扫描核心，但需修正下述差距 |
| [`sep-skill.mjs`](../../scripts/skill-scanner/sep-skill.mjs) | `scan/list/package/publish/serve`；桥接仅监听 `127.0.0.1`，提供 `/health`、`/scan`、`/package` | 仍是开发原型，不能直接作为公网部署页面可用的生产助手 |
| [`upload.mjs`](../../scripts/skill-scanner/upload.mjs)、[`zip.mjs`](../../scripts/skill-scanner/zip.mjs) | 选目录打包、multipart 上传；独立 ZIP 实现支持 UTF-8 路径 | 可复用，需统一重复打包实现和已过时的创建路径 |
| [`SkillPackageService`](../../backend/src/modules/skill-package/skill-package.service.ts) | ZIP 结构、路径、CRC、体积、符号链接校验，服务端 SHA-256 与内容寻址存储 | 保留权威校验，不能信任本机传回的正文或哈希 |
| [`PackageSecurityService`](../../backend/src/modules/capability-contribution/package-security.service.ts) | 静态规则与凭据特征检查、审核/下载门禁 | 不执行包中脚本；现有检查不等于完整附件秘密检测、病毒库或沙箱认证 |

当前包预算来自 [`skill-content-schema.ts`](../../backend/src/shared/skill-content-schema.ts)：ZIP 100 MiB、解压后 500 MiB、10,000 条目、`SKILL.md` 2 MiB。现有打包器为 stored ZIP（不压缩），因此目录低于 500 MiB 仍可能超过 100 MiB 上传限制，需在本机打包前后检查。

### 不能沿用的历史结论

1. [2026-09-24 方案](../plans/2026-09-24-能力贡献中心-Skill与RPA投稿开发方案.md) 写有“前端扫描闭环已完成”，并列出旧体积限制。当前 `web/src` 中没有调用扫描器/3210 桥接的实现；贡献创建对话框只保留 RPA，Skill 上传组件为只读展示。旧方案不能作为当前已可用的验收证据。
2. 当前 [`CapabilityContributionService.create`](../../backend/src/modules/capability-contribution/capability-contribution.service.ts) 会拒绝 `type=skill` 或 `skillConfig`，返回“SKILL 首次创建仅支持运营后台”。`sep-skill publish` 和 `upload.mjs --create` 仍调用 `POST /contributions`，真实后端会拒绝创建，即使包已上传。
3. 现有 CLI 上传测试通过的是 mock API，它不能证明现行后端允许创建。这次另跑后端测试确认了权限限制。
4. 扫描器 README 写“到仓库根”，实现实际上一直枚举父目录到文件系统根；默认桥接的项目范围也来自启动进程的 cwd，无法代表网页用户选择的项目。

### 扫描与桥接的具体差距

| 差距 | 当前实现 | 开发要求 |
|---|---|---|
| 目录覆盖 | 预设 agents/Claude/Codex/Gemini/OpenCode；未完整覆盖 Cursor/Copilot/Antigravity、自定义配置和插件来源 | 按下文官方目录表维护小型目录适配表；插件/非标准目录须用户本机明确添加 |
| Agent 筛选 | `.agents/skills` 标记为 `agents`；过滤 `--agent codex` 会漏掉 Codex 官方使用的共享目录 | 来源允许多值，共享路径不能因单 Agent 筛选而消失 |
| 递归与错误 | 默认仅找根及直接子目录；错误项默认不返回；根目录读取错误还可能中止扫描 | 有限深度发现、取消、错误原因展示，单目录失败不拖垮整个清单 |
| 符号链接 | 跳过所有 symlink，可能漏掉真实安装的 Skills；包内链接也被静默跳过 | 链接候选显示目标与状态；目标在本机获准后复制为普通文件快照；无法安全解析时明确阻止，不能默默缺附件 |
| 性能与隐私 | 扫描即遍历每个候选的所有文件并读取内容计算哈希，无 `.git/node_modules/.env` 等过滤 | 发现阶段主要读入口和必要统计；选择后才生成完整清单、检查敏感文件并打包；只上传选中包 |
| frontmatter | 自写逐行正则，不能完整解析 YAML 多行描述等结构 | 复用项目已有 YAML 解析方式，不把预览解析失败当作技能无效 |
| ZIP 实现 | `scanner.mjs` 内嵌打包器与 `zip.mjs` 并存；前者未设置 UTF-8 文件名标记，后者已设置 | 统一到经测试的打包实现，补充中文文件名在真实后端的往返验证 |
| 本机身份 | 桥接没有配对 token、Host 校验、扫描会话或用户选择快照；CORS 仅控制响应头 | 增加下文配对与请求校验，CORS 不能替代授权 |
| 部署域名 | 默认允许的 Origin 只有 `localhost:3000` / `127.0.0.1:3000` | 精确配置正式 HTTPS Origin，处理 CORS/浏览器本地网络授权 |
| 哈希语义 | 本地 `id/sha256` 是路径与内容拼接得到的内容树哈希；服务端 `sha256` 是 ZIP 字节哈希 | 改名区分 `treeHash` 与 `packageSha256`，禁止混用版本包标识 |
| 重复与变化 | 清单按“路径+哈希”去重，但选包只凭哈希且会重新扫描；选中与打包间可能变化 | 会话内随机候选 ID + 快照校验；相同内容聚合展示多个位置，变化后要求重新选择 |

相邻 `sep-client` 仓库抽样核查：已有 Electron preload/IPC 与 `SkillLibraryService`，但后者主要围绕订阅员工的已授权技能和个人修改工作；没有据此证实已具备外部 Agent Skills 导入能力。普通浏览器也不能直接调用 Electron IPC。客户端方案需单独接入，本文不修改该仓库。

## 推荐实施方案

### 机器与数据边界

```text
用户电脑                                      部署环境
Agent Skills 目录
  -> 本地扫描助手（仅 loopback）
  -> 已配对的 SEP 网页：候选清单、选择、预览
  -> 助手生成选中 Skill 的 ZIP
  -> 网页以现有内存 Access Token 上传 ----------> SEP 包校验/存储
  -> 网页填写信息并创建 -----------------------> 初始 SkillVersion / 待平台审核
```

扫描助手与云端后端是两份不同进程。助手必须运行在浏览器使用者的设备上；将它放进服务器 Docker、给服务器挂目录，都不能扫描访问者的电脑。若浏览器运行在远程桌面/虚拟桌面内，扫描的是该运行环境，不能承诺扫描终端设备。

网页到助手传本地配对凭据；网页到 SEP 传现有 Access Token。助手不需要持有 SEP 登录凭据，refresh token 继续由现有 httpOnly cookie 管理。生产部署只需提供网页功能和助手下载/配置入口，不把本机 3210 端口暴露到公网。

### 方案比较与取舍

| 路径 | 是否自动发现多个 Agent | 安装要求 | 适用性 |
|---|---|---|---|
| 网页选择目录 | 否，仅能识别用户选择范围里的技能 | 无 | 可选快速补充，免手工压 ZIP；每个 Agent 的隐藏目录可能仍需逐一定位 |
| 网页 + 本地扫描助手 | 是，已授权的用户级预设目录和项目范围 | 本机运行助手；内测可使用现有 Node 脚本 | **推荐截图场景的首期主方案**，复用率高 |
| SEP 桌面客户端内部导入 | 是，由 Electron 主进程读文件并经窄 IPC 暴露 | 安装支持该功能的新客户端 | 长期可复用同一扫描核心；导入后网页刷新看到结果，或另加与网页配对的桥接 |
| 浏览器扩展 + Native Messaging | 是，但仍需本地程序 | 扩展与本机宿主均需安装 | 本期收益有限，增加分发维护成本 |
| 云端后端扫描 | 只能扫描服务器自己的目录 | 不适用 | 不满足用户电脑扫描目标 |

**首期直接做助手接入，不把目录选择当作自动发现已经完成。** 同时保留现有 ZIP 入口；无需为了新增来源重新设计后端包协议，也不新增未经请求的依赖。

### 首期用户流程

1. 运营 ADMIN 进入当前“新建 Agent 能力 > Skills”，在导入区域选择“扫描本机”；首次显示助手安装/启动入口。
2. 用户在本机启动助手，完成一次性配对；网页明确触发连接，处理浏览器的本地网络权限提示。未启动、版本过低、端口冲突、权限拒绝均给出可恢复状态。
3. 默认扫描当前用户的预设 Skills 根目录；项目目录由助手本机配置或系统选择器显式添加，不从网页接收任意路径，也不扫描所有磁盘。
4. 展示名称、描述、来源 Agent、作用域、本地路径、警告；支持搜索、来源筛选、刷新和取消。同一份技能多处安装时聚合来源，同名不同内容保持独立。
5. 用户选一个 Skill，查看入口与将上传的完整文件清单/体积；检查脚本、缺附件、链接和敏感文件等提示后确认导入。
6. 助手创建快照并打包，网页复用 `POST /admin/capabilities/upload-skill`；校验返回后，沿用现有表单补充名称、描述、行业和岗位。
7. 用户创建，调用 `POST /capabilities`，成功后进入待平台审核并跳转技能列表。打包、上传、创建分别显示状态；任何一步失败保留选择，避免让用户重做全部流程。

首期可以扫描并展示多个候选，仍按现有表单一次创建一个技能。批量勾选后分别上传、分别创建的队列列为后续；不能把整个 Agent skills 根目录打成一个多技能 ZIP 当作批量导入。包上传成功但创建失败时，应保留已返回元数据；创建请求超时且结果未知时先核对结果，不自动重复创建。

### 助手协议与授权建议

以下是**拟新增协议**，不是现有 `/health/scan/package` 已实现的能力：

| 接口 | 作用与限制 |
|---|---|
| `GET /v1/health` | 只返回协议版本、助手版本与最小状态，不暴露目录或技能清单 |
| `POST /v1/pair` | 本机生成一次性配对码，用户在受信 SEP 网页输入；校验精确 Origin 后签发短时 bridge token，失败次数受限 |
| `POST /v1/scans` | 携带 bridge token 与自定义请求头，按本机已批准的 root ID 创建扫描；返回 `scanId`、随机 `candidateId` 与摘要，不接受网页指定本地绝对路径 |
| `GET /v1/scans/:scanId` | 查询进度/候选、逐项错误；会话过期、取消后不得继续取包 |
| `POST /v1/scans/:scanId/package` | 仅对当前会话中明确选定的候选生成快照，校验变化并返回 ZIP；按内存/并发预算限制 |
| `DELETE /v1/scans/:scanId` | 取消扫描、释放快照与会话数据 |

实现要点：

- 绑定 `127.0.0.1`，校验 Host、方法、Content-Type 和精确 Origin；对未授权来源真正返回 403，不能只省略 `Access-Control-Allow-Origin`。拒绝 `null` Origin，生产不使用 `*`。
- bridge token 仅在内存中，绑定 Origin 与助手会话，可设置约 10 分钟有效期并支持撤销；配对码不可复用。token 不放 URL、日志、localStorage 或命令行。
- 每个候选绑定已批准 root、扫描会话和文件快照；不提供“根据网页任意 path 读文件”接口。读取/打包期间再次检查真实路径与文件变化，避免越界与选中后被替换。
- 仅向精确允许的 Origin 返回 CORS 头；为浏览器预检允许必要的方法和自定义头。是否可读取包名/哈希响应头也需通过 `Access-Control-Expose-Headers` 明确声明。
- 正式 HTTPS 页面到 loopback 的 LNA、mixed-content/CSP、浏览器策略分别实测；若页面使用 CSP，需要为助手连接配置精确 `connect-src`。不能仅凭 curl 成功认定浏览器可用，也不让用户关闭浏览器安全策略。
- 配对仅授权读取本机候选，不授予平台角色。用户退出 SEP/身份切换时，页面取消队列并清除桥接会话，上传和创建仍由后端再次鉴权。

### 文件、兼容与数据策略

- 以 `SKILL.md` 目录为包，保留脚本、模板、图片和引用文件；不执行内容，不自动安装依赖或访问远程依赖。不将 rules、commands、插件配置自动改造成 Skill。
- 扫描阶段不上传清单、正文或附件到 SEP；候选完整路径仅留在本机 UI 和短时桥接会话，服务端只记录必要来源，如 Agent、作用域、扫描器版本。保留许可证和来源说明，导入不自动公开。
- `.git`、`node_modules`、缓存等可设默认排除，必须展示实际打包清单；被入口引用的必要资源若遭排除，需阻止或要求处理，不能悄悄生成缺文件的包。真实 `.env`、私钥等应在本机阻断并说明位置，不回传秘密原文；`.env.example` 等模板不能一概当作真实密钥。
- 已知根目录下的 symlink 候选可提示其 realpath；跨根目标必须先在本机显式加入授权范围，再拷贝成普通文件。包内链接不能直接送 ZIP；遇到无法复制的必要链接资源应失败并说明，不承诺任意链接都支持。
- 名称与 YAML 兼容沿用当前共享解析/校验和 [10-14 核查后的修复](../progress/2026-10-14-Skill兼容性与员工可安装性修复.md)，不在扫描器重新加入 ASCII-only、最低正文长度等旧门槛；解析或质量提示不等同于授权通过。
- 本地用独立 `candidateId`，完整包用服务端 `packageSha256`。去重只在用户当前有权查看的内容范围内进行，不能通过哈希查询泄露他人私有技能；同名不代表同一能力，不能自动覆盖已有批准版本。
- 上传成功后仍需用户主动创建/审核，不自动绑定员工、不自动更新运行版本。导入成功也不保证目标员工具备所需系统命令、MCP、模型或网络权限，应由现有安装/运行验收判断。
- 首期原则上复用现有 metadata 和包字段，不要求数据库迁移。若后续需要可检索来源、批量任务和创建幂等记录，再补共享 DTO 与持久化设计；不得把未声明的来源字段硬传给当前接口。

### 开发拆分与估算

以下为单工程师估算，按现有代码可复用、内测用户可运行 Node、先验收一个明确的桌面浏览器组合计算；各项可能重叠，最终以上线范围为准。

| 阶段 | 交付 | 估算 |
|---|---|---|
| 核心修正 | 目录映射/共享来源、范围控制、symlink 提示、YAML/打包收敛、哈希区分 | 1–2 日 |
| 桥接可用 | 配对、Origin/Host 校验、会话与快照、超时取消、正式域名与版本探测 | 1–2 日 |
| 运营网页接入 | 来源切换、候选列表与预览、单项上传、沿用表单创建和错误恢复 | 1–2 日 |
| 联调验收 | HTTPS 部署页到本机、目标浏览器权限、真实后端权限/包链路与回归 | 1–2 日 |
| **运营内测合计** | **自动发现多个来源、一次导入一个技能** | **5–8 日，含整合余量** |
| 可选目录 fallback | 用户选 skills 目录后本机打包上传；单独交付时亦可先做 | 额外 1–2 日 |
| 批量导入 | 队列、部分成功、逐项重试、创建幂等与重复核对 | 额外 2–3 日；持久化设计可能增加工期 |
| 正式助手分发 | macOS/Windows/Linux 安装、签名/更新方案、系统与浏览器矩阵 | 额外 3–5 日；签名账号/证书准备时间另计 |

推荐首批稳定支持 Claude Code、Codex、OpenCode、Gemini CLI；Cursor/Copilot 可在目录适配中补齐，Antigravity 因产品形态差异先列为候选适配。范围是已知目录与明确添加的项目，不承诺发现所有安装方式、所有历史插件缓存或 WSL/容器内部目录。WSL 与远程容器需要对应环境内的扫描方式，另行验证。

若用户主要使用 SEP 桌面客户端，后续可以把同一核心移入其主进程，通过窄 IPC 暴露“扫描/预览/选包”，无需开放 renderer 任意文件系统访问。已有登录态与系统选择器可复用，但这涉及另一个仓库与客户端发版，不包含在本次网页内测估算中。

### 验收条件

1. 正式 HTTPS SEP 页面连接本机助手，能展示至少 Claude/Codex/OpenCode/Gemini 的 fixture 技能；同内容多位置、同名不同内容与共享目录筛选行为正确。
2. 未配对、错误 Origin/Host、过期 token、伪造候选 ID、越界路径和撤销后的请求不能获取清单或包；权限拒绝、未安装与端口冲突有可恢复状态。
3. 用户未选择时没有向 SEP 发送技能内容；选中后只上传该包。任何本机绝对路径、真实 token 或密钥不得出现在服务端业务字段和日志中。
4. 含 scripts/references/assets、中文文件名、多行 YAML、链接、权限错误、大目录均有用例；扫描可取消，文件变化后不能上传陈旧选择，未支持链接不能被静默漏掉。
5. 上传 ZIP/解压预算与后端一致；真实包可由 `SkillPackageService` 读取；内容树哈希与包哈希不混淆。
6. ADMIN 上传后创建得到初始待平台审核版本；普通成员与企业管理员无法借扫描入口首次创建；不走已禁止的 `/contributions` 创建路径。
7. 分别验证打包失败、上传失败、401、403、创建失败/超时和重试。批量若纳入范围，还需验证部分成功与防重复，不把响应丢失当作可以无条件重建。
8. 目标 Windows/macOS/Linux 与浏览器矩阵按实际发布承诺逐项验收；至少实测一个正式 HTTPS 域名到本机的浏览器链路。桌面客户端联动、真实员工安装/执行分别验收，不能由上传测试代替。

## 外部技术核查

### 浏览器对本地目录的访问

#### 用户选择目录

`window.showDirectoryPicker()` 会打开系统目录选择器，返回所选目录句柄；调用需要安全上下文（HTTPS）和瞬时用户手势，用户拒绝或取消会失败。MDN 将其标为 Limited availability，不能假设所有主流浏览器都有该 API。获准后，网页可枚举所选目录下的条目；这不是允许网页自行从磁盘根目录开始搜索。

兼容选择方式是 `<input type="file" webkitdirectory multiple>`。用户选择目录后，`FileList` 包含所选目录层级里的文件，`webkitRelativePath` 可保留相对路径。MDN 页面标记 `webkitdirectory` 为 Baseline 2025（2025-08 起较新设备/浏览器普遍可用），但旧版浏览器仍需特性检测。相比 Directory Handle API，它偏向一次性文件清单上传，不提供同等的持久句柄/目录交互模型。

**因此，浏览器方案可以扫描用户选定的技能目录树并上传包内容；它不能自动发现主目录下有哪些 Agent 安装、也不能在用户不选择时读取 `~/.claude`、`~/.agents` 等绝对路径。** 可以提供按产品提示“选择该 Agent 的 skills 目录”，也可以让用户选较大的父目录后在授权范围内筛选 `SKILL.md`，但后者会显著扩大读取/上传范围，必须把将上传的文件列表展示给用户。

#### 浏览器差异与后备

| 能力 | 官方资料确认 | 产品处理建议 |
|---|---|---|
| `showDirectoryPicker()` | HTTPS/安全上下文；需用户手势；MDN 标记 Limited availability / 非 Baseline | 特性检测；不可用时退回目录 input 或 ZIP |
| `webkitdirectory` | 通过用户选择目录获取其中层级文件；MDN 标记 Baseline 2025 | 适合作为广覆盖 fallback，保留 `webkitRelativePath` |
| 任意本机扫描 | File System API 的安全模型要求用户明确许可所访问文件/目录 | 不承诺一键无授权扫描；如需发现多个预设位置，提供本地进程 |

“Baseline 2025”表示兼容面改善，不等于用户安装的每个浏览器版本/企业策略都支持。发布时仍应做功能检测和真实浏览器测试；此处未逐个锁定某日 Chrome、Edge、Firefox、Safari 的最低支持版本。

### 部署网页访问本机 companion 的网络条件

HTTPS 部署页访问 `http://127.0.0.1` / `http://localhost` 的本机进程时，需要把跨源 CORS 和浏览器对本地/loopback 网络访问的政策分别处理。Chrome 官方 LNA 文档当前说明：从 public 来源连接到 loopback 需要 `loopback-network` 权限；连接到 RFC1918 等 local 地址需要 `local-network` 权限；发起请求的网页必须是安全上下文（HTTPS），否则 LNA 权限自动拒绝。读取跨源响应仍需标准 `Access-Control-Allow-Origin` 等 CORS 配置。

Chrome 官方在 2025-09-29 更新称 LNA permission prompt 随 Chrome 142 推出。其文档明确建议新实现**不要**依赖 PNA 预检头 `Access-Control-Request-Private-Network` / `Access-Control-Allow-Private-Network`；早期 PNA 路线已经暂停，由 LNA 权限提示路线替代。部署设计应避免照抄过时 PNA 教程。

LNA 是浏览器实现/版本相关的门槛，不应据 Chrome 文档推断 Firefox、Safari 有完全相同的提示机制。需要逐目标浏览器实测；即使没有 LNA 提示，标准跨源 CORS、端口占用、loopback IPv4/IPv6、代理服务鉴权仍要处理。远端容器化 SEP 服务不因 CORS 而获得宿主机文件权限。

### Agent 技能目录官方核查

以下只列官方文档明确称为 Agent Skills / skills 的目录。`~` 代表该用户的 home；项目目录需从用户授权选中的 workspace/repository 中发现。产品可以声明兼容某些目录，但并不表示用户电脑一定安装或启用了该工具。

| 工具 | 个人/全局技能目录 | 项目技能目录 | 发现/兼容说明 |
|---|---|---|---|
| Claude Code | `~/.claude/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md`；另有子目录与 `--add-dir` 场景 | 官方文档确认技能目录条目可为 symlink；旧式 `.claude/commands/*.md` 仍工作，但不能仅凭“可调用命令”视为同类目录包。插件/同步来源需另行适配。 |
| OpenAI Codex | `~/.agents/skills`；管理级 `/etc/codex/skills` | 当前工作目录到仓库根路径上的 `.agents/skills` | 官方文档确认支持 symlink 并跟随目标。技能是文件夹内的 `SKILL.md`；`.agents/skills` 是多个产品共享的常见目录，但仍需按文件包而非只按名称识别。 |
| OpenCode | `~/.config/opencode/skills/<name>/SKILL.md`，另兼容 `~/.claude/skills`、`~/.agents/skills` | `.opencode/skills`、`.claude/skills`、`.agents/skills` | 按工作目录向上遍历到 Git worktree；项目各支持路径均有记录。另可配置额外目录/HTTP catalog。官方 skills 文档没有在此处确认 symlink 行为，不推断。 |
| Gemini CLI | `~/.gemini/skills/` 或 `~/.agents/skills/` | `.gemini/skills/` 或 `.agents/skills/` | 官方称用户目录与 workspace 目录；workspace skills 受 workspace trust 影响。支持命令操作和 `skills link`，但这是本机 CLI 的发现机制，网页仍需用户给出文件访问权。 |
| GitHub Copilot | `~/.copilot/skills` 或 `~/.agents/skills` | `.github/skills`、`.claude/skills` 或 `.agents/skills` | 个人技能是否被使用依赖具体 surface；GitHub 官方明确 cloud session 的可用性差异。根目录下一 skill 一个子目录且含 `SKILL.md`。 |
| Cursor | `~/.cursor/skills/`、`~/.agents/skills/` | `.cursor/skills/`、`.agents/skills/` | 官方称 Cursor 会递归扫描技能目录，也发现仓库嵌套目录。个人 `~/.cursor/skills` 可选择同步到 Cloud Agents；同步属于 Cursor 自己的产品流，不能据此推断 SEP 可直接读。 |
| Google Antigravity | App/IDE: `~/.gemini/config/skills/<folder>/`，IDE 仍支持旧 `~/.gemini/antigravity/skills/`；CLI 还读取 `~/.gemini/antigravity-cli/skills/` 和 `~/.gemini/skills/` | `<workspace-root>/.agents/skills/<folder>/`，并沿父目录到仓库根 | 官方页面按 App、CLI、IDE 区分目录；默认 `.agents/skills`，兼容旧 `.agent/skills`。扫描时要区分使用的是哪个 surface。 |

#### 共享格式、命令和符号链接

多个官方产品文档都描述以独立目录为单位的 `SKILL.md`（常含 YAML `name`/`description`）及可选 scripts/references/assets。该格式有较强生态重叠，但字段校验、递归深度、frontmatter 要求、隐藏目录处理与工具执行语义仍不完全一致。导入宜保留完整所选 skill 子目录内的相对路径，并把 `SKILL.md` 作为发现锚点，而不是把所有 agent 配置目录、规则文件或命令都装成 SEP Skill。

“commands”不是统一的技能目录别名：Claude Code 文档只明确旧 `.claude/commands/*.md` 仍可工作；OpenCode 把 commands 作为命名 prompt 模板与 skills 分开；Cursor 将规则/命令迁移成 skill 作为不同类型处理；Copilot/Codex/Gemini/Antigravity 的此处官方 skills 资料要求/围绕 `SKILL.md` 目录。因此第一版扫描器应把 `SKILL.md` 目录设为默认导入对象；可另外报告可能的 command/rules 配置，但不可默认为 Agent Skill。

符号链接仅在 Claude Code 与 Codex 官方资料中得到明确确认（Codex 跟随目标，Claude 个人/项目/企业位置可用 symlink）。其他产品未找到足够官方证据，本调研不将其写为支持。浏览器目录选择 API 暴露的是经用户授权的目录句柄/文件对象，不能当作本机 CLI 的 `realpath`、环境变量展开或 unrestricted symlink traversal 能力。个人目录中的 `$HOME` 等路径需在本机侧解析；不以服务器用户的 home 推测访问者 home。

现有 SEP 还扫描 `~/.codex/skills`；可保留为已知兼容来源，但不能用它替代 Codex 当前官方 `~/.agents/skills` 路径。自定义 home/config、XDG 与插件目录应按目标工具版本逐项适配，不把硬编码默认路径等同于完整安装发现。

## 官方资料与证据链接

浏览器与网络：

- [MDN: `showDirectoryPicker()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) — 安全上下文、用户手势、支持有限。
- [MDN: `webkitdirectory`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory) — 用户目录选择、层级文件和 `webkitRelativePath`。
- [MDN: File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — 用户许可模型与句柄枚举。
- [Chrome for Developers: Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access) — 当前 LNA 权限、HTTPS、CORS 和不使用旧 PNA 头的要求。
- [Chrome for Developers: LNA permission rollout](https://developer.chrome.com/blog/local-network-access) — Chrome 142 rollout 时间；PNA 被搁置，LNA 转向权限提示。

Agent 官方路径：

- [Agent Skills Specification](https://agentskills.io/specification) — 目录型技能、`SKILL.md` 与脚本/参考/资源；另直接核对其 `/specification.md` 文本版。
- [Claude Code: Skills](https://code.claude.com/docs/en/skills) — 个人、项目、nested、额外目录与 symlink；legacy commands 区别。
- [OpenAI Codex: Skills](https://learn.chatgpt.com/docs/build-skills?product=breeze) — 仓库、个人、管理目录和 symlink。
- [OpenCode: Agent Skills](https://opencode.ai/docs/skills) — OpenCode、Claude-compatible、Agent-compatible 路径及工作树遍历。
- [Gemini CLI: Managing Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/) — 用户、workspace 路径、trust 和 skills link。
- [GitHub Copilot: Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) — project/personal skills 路径、结构与 `SKILL.md`。
- [Cursor: Agent Skills](https://cursor.com/docs/skills) — project/user 路径、递归发现与云同步边界。
- [Google Antigravity: Agent Skills](https://antigravity.google/docs/skills?app=antigravity-ide) — App、CLI、IDE 各自个人/项目目录。

## 本次验证与限制

| 核查 | 实际结果 |
|---|---|
| `node --test scripts/skill-scanner/scanner.test.mjs scripts/skill-scanner/upload.test.mjs` | 9 项通过；覆盖目录 fixture、哈希、链接跳过、打包、mock 上传/创建。mock 创建成功不代表真实贡献接口允许创建 |
| `pnpm --dir backend exec jest --runInBand src/modules/capability-contribution/capability-contribution.service.spec.ts src/modules/capability/capability.write-security.spec.ts` | 2 套、104 项通过；包含贡献入口拒绝首次 SKILL 创建、运营创建权限及包内容安全。审计/通知失败 WARN 为异常路径预期日志 |
| 代码与部署配置只读核查 | 运营表单、上传/创建服务、扫描器/桥接、包校验、Caddy HTTPS 配置；只核查仓库配置，未连接生产服务器 |
| 外部资料 | 搜索工具本轮未返回可用正文；改用 HTTPS 直接抓取官方页面核对，来源见上，不把 HTTP 200 本身当作浏览器功能验证 |

测试环境 Node `v26.7.0`，不代表项目声明的所有 Node >=20 版本都已验证。本次只新增/整理调研文档与导航，没有业务实现、依赖安装、数据库变更、真实用户目录扫描、Skill 上传、提交或部署。

未验证：真实生产页面到 loopback 的 CORS/LNA/mixed-content/CSP 行为，Firefox/Safari/Edge 的实际策略，Windows/Linux 路径与链接行为，正式助手安装签名，以及目标员工的实际安装/运行。现有测试使用 fixture/mock，不等于真实数据库、真实文件系统竞争条件或端到端验收。

资料截点为 2026-11-03；官方目录和浏览器策略可能更新。未能由官方明确确认的版本/优先级不作保证；Antigravity 各产品形态、插件管理目录、环境变量覆盖及 WSL 等应在实现时以目标版本 fixture 再确认。上述工期以这些边界为前提。
