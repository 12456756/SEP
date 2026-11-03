# Web 本机 Skills 扫描与开发者身份方案复核

> 日期：2026-11-03。状态：调研与方案，尚未实施。已核查 SEP Web/后端、相邻 `sep-client` 源码与官方浏览器/Electron 资料。推荐方案是根据这些证据作出的架构判断，不是浏览器原生能力或已完成的功能。
>
> 本文更新[首次可行性调研](./2026-11-03-本地Agent-Skills扫描上传可行性调研.md)与[前端方案 v1](../plans/2026-11-03-Skills本机扫描导入前端开发方案-v1.md)的连接方式建议：保留已确认的导入页面，生产主路径改为免登录连接器主动连接云端；原 localhost 协议仅作为低成本过渡方案。本文不自动授权开始业务实现、提交或部署。

## 直接结论

1. **部署后的普通 Web 页面不能在用户不授权目录、也不安装本地程序的情况下，静默枚举 `~/.claude`、`~/.agents`、`~/.config/opencode` 等任意本机路径。** `showDirectoryPicker()` 的入口是用户选择目录；它要求 HTTPS 和用户手势，浏览器只返回用户选中的目录句柄。`startIn` 只能使用浏览器定义的常用目录或一个已经取得的句柄，不能由网页填入任意绝对路径。[MDN: showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
2. **如果目标是“用户不知道目录，点一次就发现多个 Agent 的 Skills”，必须由运行在用户电脑上的受信进程扫描已知路径。** 这个进程可以是已有 SEP 桌面客户端中的模块，也可以是独立轻量连接器。网页只负责创建导入任务、展示候选和确认上传。
3. **低操作量的生产优选是：Web 创建短期导入会话 → 自定义协议拉起 SEP 客户端/连接器 → 本地程序主动通过 HTTPS 领取任务并回传候选 → Web 展示候选 → 本地程序仅上传用户选中的 Skill 包。** 浏览器不访问 localhost，因此这条链路不依赖 Chrome 的 loopback LNA 提示、localhost CORS 或固定端口。
4. **如果 SEP 桌面客户端已经是目标用户的标准安装项，优先把扫描核心放进客户端。** 独立连接器更适合尚未安装客户端的运营/开发者，但会新增安装、签名、更新和进程生命周期维护。两种形态可以复用同一套扫描核心和云端导入协议。
5. **Electron 自定义协议只负责拉起本地程序和携带会话定位信息，不提供文件访问授权，也不能把深链接中的 `sessionId` 当成上传凭据。** 文件访问来自本地客户端自身的操作系统权限；实际上传应使用服务端签发的短期、限定用途授权。
6. **开发者不需要为了扫描再注册一个普通用户账号。** 本机连接器免业务登录；平台上传、创建和审核使用当前 Web 身份。当前首次创建 Skill 仍要求全局 `ADMIN`，普通 `USER`、企业管理员和 `CONTRIBUTOR` 均不能因此获得首次创建权限。现有桌面客户端强制企业归属，不能直接承载无企业运营账号的导入流程，具体代码证据见下文。

## 针对当前需求的最终选择

推荐交付 **SEP Web 导入工作区 + 免登录 SEP Connector + 云端短期导入会话**。Connector 负责扫描和打包，平台权限只由 Web 发起者决定。已有 SEP 客户端的设备可用新增的免登录扫描模式承载同一协议；没有客户端的运营/开发者安装独立连接器，不要求创建企业、订阅员工或登录消费端。

这个选择优先满足“用户不知道路径、以后尽量少操作、上传仍在 Web 完成”。它需要比 localhost 原型更多的服务端开发，但减少了浏览器访问本机服务的权限、端口和跨源故障。若只追求最快内部演示，安全补齐后的 localhost 方案开发量较小；不能把内部演示等同于生产交付。

三项要求不能同时满足：**普通浏览器、没有任何本机组件、自动发现未知的本机路径**。要免安装，就必须让用户选择目录；要自动定位，就需要本机运行程序。企业预装或复用已有客户端可以省去用户自行安装步骤，但不改变这个边界。

## 方案比较

| 方案 | 首次用户动作 | 后续用户动作 | 能否自动找已知 Agent 路径 | 部署/兼容成本 | 判断 |
|---|---|---|---|---|---|
| 纯 Web 目录选择 | 点击按钮并自行找到目录 | 浏览器可能记住上次目录，但权限可能重新提示 | 否，只能扫描用户选中的范围 | 最低；`showDirectoryPicker` 兼容面有限，需目录 input/ZIP fallback | 适合作为无安装 fallback，不满足“不知道路径” |
| Web → localhost helper | 安装 helper，允许浏览器访问 loopback，完成配对 | 通常点击扫描；浏览器权限或 helper 状态变化时需处理 | 是 | 中等；受 LNA、CORS、端口、浏览器版本影响 | 可做内测/低成本版本 |
| Web → 自定义协议 → 客户端主动 HTTPS 回连 | 安装 SEP Client/connector，首次完成站点与设备绑定 | 网页点扫描；客户端未启动时由协议拉起 | 是 | 中等；要做客户端发版和云端会话 | **生产优选** |
| 浏览器扩展 + Native Messaging | 安装扩展和本地宿主程序 | 点击扩展或网页触发扩展 | 是，由本地宿主扫描 | 最高；扩展商店、浏览器适配、宿主注册都要维护 | 除非产品已有扩展战略，否则不推荐 |
| 云端后端直接扫描 | 无 | 无 | 否，只能扫描服务器磁盘 | 不适用 | 技术上无法满足目标 |

PWA、给网页“安装到桌面”或把服务器部署到用户所在局域网，都不会自动赋予网页任意文件系统权限。把远端网页放进 Electron 并通过窄 IPC 提供扫描能力则可行，但这已经是需要安装的桌面软件；Electron 官方要求隔离远程内容能力，不能直接对网页开放 Node.js 文件系统。[Electron: Security](https://www.electronjs.org/docs/latest/tutorial/security)

还可以提供两种补充入口，但不能替代上述主路径：

- **开发者从 Agent/CLI 发起导入：** 在已有 Codex/Claude 等本地执行环境中调用 SEP 扫描命令，接入同一导入会话；免装完整消费端，但仍需要执行命令、运行时和 Agent 的本地工具授权。SEP 现有 `publish` 创建路径已过时，不能直接交付使用，详见首次调研。
- **Git 仓库导入：** 对已经提交到远端仓库的 Skills 可免读本机；它不覆盖本地未提交内容、仅本机存在的包，因此只能作为另一个来源。

## 为什么纯 Web 仍需要用户选择目录

`showDirectoryPicker()` 的官方定义就是“显示目录选择器，让用户选择一个目录”。它要求安全上下文和瞬时用户交互。`startIn` 只接受 `desktop/documents/downloads/music/pictures/videos` 等常用目录，或已经存在的 `FileSystemHandle`；因此不能写成 `startIn: '~/.claude/skills'`，也不能利用它遍历用户 home 后再自动定位隐藏目录。[MDN: showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)

浏览器可以改善第二次使用体验：目录句柄可序列化并保存到 IndexedDB；picker 的 `id` 可让浏览器记住该用途上次打开的位置。但是 Chrome 官方同时说明，文件/目录权限并不保证跨会话持续，重新打开页面后仍要用 `queryPermission()` 检查，必要时通过用户手势调用 `requestPermission()`。这能减少重复找路径，不能消除首次目录选择，也不能承诺以后永不提示。[Chrome: File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)；[MDN: requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission)

此外，MDN 截至本次核查仍将 `showDirectoryPicker()` 标为 Limited availability / 非 Baseline。即使 Chromium 浏览器可用，产品仍应保留 `<input webkitdirectory>` 或 ZIP 入口，不能把该 API 作为所有浏览器唯一入口。

## localhost helper 的实际限制

部署在公网 HTTPS 域名的页面访问 `127.0.0.1`、`localhost` 或 `[::1]` 上的本地服务时，Chrome 当前将其纳入 `loopback-network` 权限；公网来源访问局域网私有地址则使用 `local-network` 权限。页面必须是 HTTPS，首次连接应由明确用户动作触发，读取跨源响应还需要标准 CORS。Chrome 当前文档也明确不应再依赖旧 PNA 的 `Access-Control-Allow-Private-Network` 方案。[Chrome: Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)

因此 localhost 方案不是错误方案，但它会把以下问题放到 Web 联调中：浏览器权限提示、用户曾拒绝后的恢复指引、CORS、CSP `connect-src`、固定端口冲突、IPv4/IPv6、helper 未启动和不同浏览器策略。它适合快速复用现有本地桥接原型；如果要求多浏览器、低故障和低用户认知成本，不应是唯一生产链路。

## 推荐的云端导入会话方案

建议连接关系如下：

```text
SEP Web
  1. 登录用户点击“扫描本机”
  2. 后端创建短期 importSession
  3. 网页打开 sep-import://skills?... 拉起本机连接器（拟议协议名）
                      │
                      ▼
SEP Client / Connector（用户电脑）
  4. 解析会话定位信息；首次配对，或用已绑定设备密钥领取任务
  5. 扫描本机已知 Agent Skills 路径
  6. 只回传候选摘要；网页轮询任务状态并显示候选
  7. 用户选择某个 Skill 后，本地程序打包并上传选定内容
                      │
                      ▼
SEP Backend
  8. 服务端重新校验包、角色、会话用途、大小、结构和重复状态
  9. Web 取得现有包元数据，用户填写信息后创建待审核 Skill
```

Electron 官方支持将应用注册为自定义协议处理器，网页点击该协议后可启动应用；Windows/Linux 通过 `second-instance` 处理，macOS 通过 `open-url` 处理，macOS/Linux 正式使用需要正确打包和注册协议。[Electron: Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

这条方案的关键收益来自网络方向：本地程序主动访问 SEP 公网 HTTPS API，网页也只访问 SEP 公网 API，浏览器不与本机地址通信。因此不触发“公网网页访问 loopback”的 LNA/CORS 链路。这是基于 Chrome LNA 适用范围和 Electron 协议能力作出的**架构推导**，并非 Web 获得了扫描权限；真正扫描磁盘的仍是安装在用户电脑上的本地程序。

实现上可先用 HTTPS 短轮询，避免首版引入新的实时连接复杂度；候选较多或需要连续进度时再复用现有 WebSocket/SSE 基础。轮询不会改变权限模型。

### 会话和设备边界

- 深链接中的参数可以被其他应用或网页构造，因此只能用于定位短期会话，不能直接作为上传授权。Electron 的安全指南说明 Electron 代码拥有文件系统等更高权限，并要求验证 IPC sender、限制远程内容能力和使用安全协议；同样应把外部深链接输入视为不可信。[Electron: Security](https://www.electronjs.org/docs/latest/tutorial/security)
- 首次使用应建立“这个 SEP 站点允许调用这台设备”的绑定关系，并在网页与本地客户端显示同一短码供用户确认。之后可复用本机设备密钥，减少重复输入。短码比对和设备密钥属于 SEP 的协议设计建议，不是 Electron 自动提供的认证机制。
- 导入会话应短期有效、一次性或有限次数、绑定发起用户/设备/用途，并限制为候选摘要和选定包上传。它不应把通用 ADMIN JWT 放进 URL，也不应让免登录连接器获得平台管理接口的长期权限。
- 本地扫描结果默认只上传名称、来源、相对位置、体积和警告等必要摘要；绝对路径和完整文件清单应尽量留在本机。用户选择后才上传完整包。

### 首次与后续使用

**首次：** Web 点击“扫描本机” → 未安装时下载并安装连接器 → 打开连接器 → 确认 SEP 站点和扫描范围 → 网页确认对应设备 → 自动发现预设目录 → 选择 Skill 并导入 → 补充信息、创建待审。首次设备确认可以比对两端短码后点击确认，不把手工输入配对码作为默认流程；异常时保留短码配对入口。

**后续：** 已绑定设备在线时，Web 点击“扫描本机”即创建任务；设备未启动时，按钮拉起连接器。随后选 Skill、导入、创建。无需重新寻找目录，也无需登录客户端。浏览器/操作系统可能再次提示是否打开外部应用，更新或本机访问策略变化也可能要求重新确认，不能承诺跨所有环境固定两次点击。

网页不能可靠地静默判断应用是否已安装。在线状态来自已授权设备向服务器上报的连接状态；离线状态同时提供“打开连接器”“下载连接器”。不能仅凭协议唤起超时自动认定未安装，也不能尝试扫描用户电脑的端口来判断。

“记住设备”只保存站点绑定和扫描范围，不允许云端在用户未发起任务时后台遍历文件。连接器与账号的绑定可撤销；更换 Web 账号、SEP 部署域名或操作系统用户，必须重新核实授权，不能继承另一账号的导入会话。

### 自动发现覆盖范围

用户级默认路径由连接器根据实际操作系统 home/XDG/工具配置解析，不要求用户手工定位。来源至少包括已核查的共享 `.agents/skills`、Claude、Codex 兼容目录、Gemini、OpenCode、Cursor/Copilot；具体版本、目录和链接规则沿用[官方目录表](./2026-11-03-本地Agent-Skills扫描上传可行性调研.md#各-agent-skills-目录与兼容性)。

项目级 Skills 可能位于任意仓库，不能承诺仅靠默认路径发现全部项目。首期扫描已授权的项目根；可让用户选择“代码工作区”一次，此后记住该根。读取某 Agent 最近项目记录只能在有稳定格式和额外授权时作为候选提示，不能假设所有 Agent 都有统一可读的项目索引。不做无界全盘搜索。

按发现、预览、打包三阶段读取：先找 `SKILL.md` 和摘要；用户选择后读取预览和完整清单；用户确认后创建一致文件快照并打包。忽略无关构建/版本控制目录，对符号链接、越界、敏感文件和文件变化明确处理；不执行 Skill 中脚本。云端只接收当前用户已授权导入会话所需的数据，不收集全部 Skills 正文。

### 账号与传输的安全约束

以下均为拟开发要求，不是现有扫描原型已经具备的能力：

1. Web 用当前内存 access token 创建导入会话，后端当场校验当前用户的首次创建权限，并绑定用户、会话、预期设备和用途。后续上传与创建再次检查权限，不仅在发起时检查。
2. 深链接只携带会话定位 ID 和已登记实例标识，不携带密码、Web access/refresh token、可直接使用的上传凭据或任意本机 path。连接器不根据深链接提供的任意地址发送文件，只访问已批准的 SEP HTTPS 实例。
3. 首次设备配对必须完成两端确认；仅知道会话 ID、首先抢到领取请求或自行生成密钥，均不能获得扫描/上传授权。已有设备用操作系统安全存储中的设备密钥证明身份，设备凭据只能参与导入协议，不能调用通用管理接口。
4. 认领/配对阶段设置短有效期，任务阶段有独立到期时间；失效、取消、注销、角色撤销后不得继续回传。多设备、多标签页和 Web A 账号/客户端 B 账号并存时，始终按发起的 Web 用户与选定设备隔离。
5. 包上传使用绑定导入会话、用户、设备和候选的一次性短期授权，限制文件数、体积、次数和过期时间；允许安全重试但不重复创建。授权不等于平台发布权限。连接器不能直接调用现有 `ADMIN` 上传接口，也不能借用桌面消费端的登录 token。
6. 云端会看到被回传的候选摘要和按需预览，这是相对于 localhost 的新增数据经过范围。只保留短期会话所需内容，默认使用根标签/相对位置，不上传含系统用户名的绝对路径；不将正文、凭据或完整文件清单写进访问日志。若要求未选择文件的任何信息都不经过云端，应选 localhost 或在客户端本地选择，不能承诺同时满足此隐私条件和云端候选列表。
7. 选中包仍走现有 `SkillPackageService`、`PackageSecurityService` 权威校验，得到当前 `zipPath/sha256/fileCount/totalSize/content/suggested/warnings` 结果。Web 拿结果继续原表单；上传成功不等于创建成功，更不等于审核通过。

### 需要新增的服务端能力

不能声称云端会话方案“只改前端即可”。建议在现有业务模块内增加导入会话编排，复用现有包处理服务，不另建独立网关或改变 Skill 包协议。

| 能力 | Web 侧权限 | 连接器侧权限 |
|---|---|---|
| 创建/查询/取消导入会话 | JWT + 当前允许首次创建的角色；只看本人任务 | 不开放通用任务列表 |
| 设备配对/撤销/在线状态 | 绑定当前用户，确认与撤销明确可见 | 设备密钥证明；首次等待两端确认 |
| 领取任务、回传候选/进度 | 仅读取所选设备在本次会话的结果 | 限当前会话和已批准 roots，不接受任意文件读写命令 |
| 请求预览、选择候选 | 本会话随机 candidate ID | 返回必要内容，候选与快照绑定 |
| 接收选定包、返回元数据 | 仅发起者可读取结果 | 独立受限上传入口，不放开现有 ADMIN guard |
| 最终创建 Skill | 继续 `POST /capabilities`，现行 ADMIN 权限 | 连接器不创建、不审核、不发布 |

首版使用有界 HTTPS 轮询、取消和超时；是否持久化会话到 Redis/数据库，由实现阶段结合现有部署及恢复要求确定。轮询间隔、清单分批、事件顺序和上传幂等必须在正式接口文档中约定，本文不把拟议名称当成已有接口。

## SEP 桌面客户端与独立连接器如何取舍

| 条件 | 更合理的形态 |
|---|---|
| 所有目标用户本来就必须安装 SEP 桌面客户端 | 直接集成客户端；用户无额外安装，更新走现有发布渠道 |
| 上传主要由平台运营/Skill 开发者完成，而这些人未必安装 SEP 客户端 | 提供轻量 SEP Connector，或先以独立连接器验证再并入客户端 |
| 希望网页在客户端未启动时也能一键拉起 | 两者都注册相同或不同的自定义协议；安装时完成协议注册 |
| 希望一个扫描核心同时服务客户端和 connector | 把路径发现、目录校验、预览、打包做成不依赖 Electron UI 的本地库，由两个壳复用 |

如果 SEP 客户端已经覆盖目标人群，集成免登录扫描模式可以复用本地文件系统能力和发版渠道。该模式必须能在登录页之前启动，不能以企业会话或员工订阅作为扫描前置条件。现有消费端会话和导入设备凭据分开，客户端退出业务账号不应隐式把 Web 上传者切换成另一身份。

“用户使用客户端”和“开发者上传 Skill”应作为两个维度处理。本地客户端负责扫描并不等于扫描者自动拥有上传/发布权；最终上传接口仍由 SEP 后端根据当前平台身份和角色决定。技术上没有因为使用桌面客户端就必须创建第二个账号的要求。是否需要独立开发者身份、同账号追加开发者角色，或只由 ADMIN 代上传，应以 SEP 当前账号模型和产品规则为准。

## SEP 当前账号与客户端的实际证据

| 核查点 | 代码证据 | 结论 |
|---|---|---|
| 用户身份 | [`schema.prisma`](../../backend/prisma/schema.prisma)，`User` 第 17 行、`UserRole` 第 144 行 | 同一 User，email 唯一；全局角色为 USER/CONTRIBUTOR/ADMIN，没有 DEVELOPER 角色；当前为单值枚举，不是多角色授权表 |
| 企业身份 | 同文件 `EnterpriseMember` 的 `role`；[`平台布局`](../../web/src/app/(platform)/layout.tsx) | 企业内角色与全局角色不同；运营 Web 只要求 ADMIN，不要求企业归属 |
| 首次包上传 | [`admin-upload.controller.ts`](../../backend/src/modules/admin/admin-upload.controller.ts)，第 31-33 行 | `POST /admin/capabilities/upload-skill` 要求 JWT + ADMIN |
| 首次创建 | [`capability.service.ts`](../../backend/src/modules/capability/capability.service.ts)，第 166-168 行 | 非 ADMIN 创建 Skill 会被拒绝；包导入来源不能绕过该规则 |
| 贡献入口 | [`capability-contribution.service.ts`](../../backend/src/modules/capability-contribution/capability-contribution.service.ts)，第 454-458 行 | `/contributions` 不再允许首次创建 Skill，不能把 CONTRIBUTOR 当成已可用的开发者上传角色 |
| 运营归属 | [`admin.service.ts`](../../backend/src/modules/admin/admin.service.ts)，第 851 行 | 已有运营创建链路将操作人员记为 contributor；不需要为此另造一个消费者身份 |
| 后端桌面登录 | [`client.service.ts`](../../backend/src/modules/client/client.service.ts)，第 277-310 行 | 无企业账号可验证并获得 `enterprise: null` 响应；后端登录本身没有要求企业归属 |
| 实际桌面入口 | 相邻 `sep-client/electron/controller/routes/auth.ts:85`、`electron/common/platform/auth-session-manager.ts:37-40` | Electron 登录路由和会话管理器均拒绝无企业归属，因此当前 ADMIN 不能仅靠网页登录身份直接进入消费端工作区 |
| 桌面技能库 | `sep-client/electron/service/skill-library-service.ts:180-205` | 依赖企业 scope 和已有授权 Skill，保存的是个人版本，不是扫描外部 Skill 后首次创建平台能力 |
| 桌面唤起 | `sep-client/electron/bootstrap/result-file-protocol.ts:4-10` 以及启动代码定向搜索 | 只发现 `sep-result` 资源协议；未发现现成 Web 唤起扫描、免登录连接器或导入会话，需要新增 |

客户端路径相对于 `/Users/yao/LLM/sep-client`，只做只读核查，未修改相邻仓库；未运行客户端实际登录或安装包。

### 你是否需要单开账号

- **你是当前平台运营/开发人员，用 ADMIN 上传：** 沿用现有 Web ADMIN 账号，免登录连接器负责扫描。不需要普通用户账号，也不需要为了扫描创建企业或订阅员工。
- **同一个人既上传又使用员工：** 技术上不需要因扫描增加身份；当前消费端业务要求企业归属，是否以测试账号体验消费端是另一项产品/运营选择，不是导入前置条件。
- **未来让外部开发者自行上传新 Skill：** 当前权限不支持。应为同一 User 设计开发者准入、首次投稿权限及审核规则，避免要求另注册重复身份；也不能把外部开发者全部授予平台 ADMIN。当前单值 UserRole 和现有 guards 需要一起评估，不能只加前端入口或认为注册 CONTRIBUTOR 就完成了开发者平台。

因此本期只解决“已有有权上传者的本机导入”，保留当前 ADMIN 边界。外部开发者开放作为独立需求评估，连接器协议预留按 Web 发起者授权即可。

## 为什么不优先选择浏览器扩展

Chrome Native Messaging 确实能让扩展与本机程序通信，但官方要求本地应用注册 native messaging host；Windows 需要安装器写注册表，macOS/Linux 需要在约定目录安装 host manifest，manifest 还要绑定允许访问的扩展 ID。扩展还必须声明 `nativeMessaging` 权限，Chrome 会提示其可与协作的本地应用通信。[Chrome: Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)；[Chrome: Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)

这意味着扩展并没有消除本地安装，只是把“网页到本地程序”的桥接改成“网页/扩展到 Native Messaging host”。同时还增加扩展商店审核、企业策略、Chrome/Edge/Firefox 差异、扩展与宿主版本配套以及网页消息 sender 校验。Chrome 官方也特别提醒，扩展 service worker 转发内容脚本消息前需要验证 `sender.origin`/`sender.url` 并清理 payload。因此它更适合产品本来就需要浏览器扩展的场景，不适合作为单一 Skills 导入功能的首选。

## 建议的产品落地顺序

1. **首选主路径：SEP Web + SEP Client/轻量 connector + 云端短期导入会话。** 首版使用 HTTPS 轮询；自定义协议只负责拉起应用和定位会话。
2. **保留无安装 fallback：目录选择/ZIP。** 用户知道目录时可以直接导入；已授权的目录句柄可用于减少后续定位操作。
3. **localhost helper 作为原型或过渡路径。** 如果现有桥接改造成本明显更低，可以先交付 Chromium 定向内测，但要单独验收 LNA、CORS、CSP 与权限拒绝恢复。
4. **暂不做扩展。** 只有当 SEP 后续确实需要浏览器侧常驻能力时，再评估扩展 + Native Messaging。

## 前端方案 v1 如何调整

| 原方案内容 | 复核后的处理 |
|---|---|
| 本机扫描/ZIP 页签、候选列表、来源筛选、预览、能力信息表单 | 保留已确认设计 |
| 下载助手、连接、默认输入配对码 | 改成“扫描本机/打开连接器”，首次两端确认设备，手工短码仅作异常恢复 |
| 浏览器直接请求 `127.0.0.1:3210` 与 `/v1/pair` | 生产主路径改为同源导入会话 hooks；本机协议由连接器主动请求云端 |
| bridge token 内存隔离 | Web JWT、导入会话、连接器设备凭据分别处理；JWT 不传本机程序 |
| 助手返回 ZIP Blob，再由浏览器上传 | 生产主路径为连接器受限上传、Web 接收权威包元数据；localhost 过渡方案仍可浏览器取包上传 |
| 页面第 6 节上传、第 7 节协议与关联任务/测试 | 实现前按本复核重写正式契约与测试，不可把两套传输混接 |
| 创建与审核 | 沿用当前权限和 `POST /capabilities`；首期单项创建 |

实施分三部分交付：本机连接器及签名安装包、后端导入会话及限定上传、现有 Web 导入工作区。先用一台真实设备验证首次安装、免登录唤起、跨账号隔离、自动目录发现和真实包校验，再扩展目标系统与浏览器。现有扫描核心仍有首次调研列出的路径、符号链接、快照、隐私和 ZIP 编码差距，不能把连接协议接通当成扫描器已经可上线。

### 验收重点

1. 在正式 HTTPS 部署域名下使用普通浏览器，全流程无 localhost 请求；服务端不能直接读访问者本机文件。
2. 无企业归属的 ADMIN 可从 Web 完成导入，本机模式无消费端登录；客户端已有另一账号时，上传归属仍是 Web 发起者。
3. 未安装、未运行、拒绝唤起、拒绝配对、设备离线、协议版本不符和会话过期均有可恢复状态，不重复要求找路径。
4. 默认目录自动发现，项目目录授权可复用；权限不足/自定义路径/符号链接失败明确报告，不宣称找到“全部 Skills”。
5. 伪造深链接、抢领会话、跨用户访问、角色撤销、重放与超范围上传被拒绝；候选变化后要求重新检查。
6. 只上传选中包；权威元数据、大小/路径校验、静态安全检查和待审状态与当前 ZIP 流程一致。取消、超时、重试不产生重复能力。

本次只更新文档。已做源码定向核查、官方资料核对、Markdown 链接/代码围栏与 diff 检查；未执行新连接器、真实设备配对、跨浏览器/跨系统扫描、真实上传或安装包签名验证。此前扫描器/后端测试结果见首次调研，它们不是本方案的端到端证据。

## 版本与资料说明

- 核查日期为 2026-11-03。
- Chrome Local Network Access 指南页面最后更新于 2026-10-07，当前将权限拆分为 `local-network` 与 `loopback-network`；不要继续使用旧的组合权限名或旧 PNA 预检教程。
- MDN 当前仍将 `showDirectoryPicker()` 和 `FileSystemHandle.requestPermission()` 标为 Limited availability / Experimental，发布时必须做特性检测和目标浏览器实测。
- Electron 深链接文档的示例版本随 Electron 文档站更新；具体客户端仓库应按其锁定的 Electron 版本核对 `app.setAsDefaultProtocolClient`、打包器协议注册和单实例事件行为。

## 官方资料

- [MDN: Window.showDirectoryPicker()](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
- [MDN: FileSystemHandle.requestPermission()](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission)
- [Chrome: The File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Chrome: Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
- [Electron: Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)
- [Electron: Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Chrome Extensions: Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Extensions: Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome Extensions: Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
