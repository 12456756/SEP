# 算力接口完整性核对与 SEP 本地联调交付

日期：2026-11-20。核对来源：`D:/github/LongdaoAI-worktree-one/docs/development/sep-compute-platform-api-v1.md` 及其对应服务、路由代码。没有修改算力平台代码、生产配置或生产数据。

## 一、结论

**后续业务接入已更新**：当前状态以 `sep-compute-business-delivery-2026-11-20.md` 为准。本文件下述“业务尚未接入、禁止启用”为第一阶段历史结论。新一轮已接入原模型业务和资金事务，实际联调发现 N09 两位数流水排序问题，交接见 `sep-compute-ledger-order-feedback-2026-11-20.md`。

算力平台文档已经足以实施第一阶段接口接入，但不能只凭该文档宣布整个方案开发完成。SEP 原先是未接通的适配器，本批已补签名、解密、控制接口、企业目录鉴权及重试差异，并实际连接本机算力服务完成接口层联调。

**现在可以进行本机接口联调；尚不能把企业实际业务全部切换到新计费。** 所有用户模型入口、原免费权益和付费资金事务、充值退回业务流程仍需接入。企业正式启用保持关闭，`activationAllowed=false`。

## 二、需要算力平台补充或明确的内容

### 1. `/v1/models` 必须补入正式接口说明

企业目录使用 `GET /v1/models`，需企业对应 Key、`X-SEP-Enterprise-ID` 和服务签名，不需要执行编号。返回 `{data:[{id,display_name?}]}`，空列表必须保留为空；部分/降级结果要明确标记，不能作为完整权限集合使用。SEP 当前最多接收 2000 个模型；更多模型需双方约定分页，不应截断后伪装完整。

代码定位：算力 `backend/internal/service/sep_execution.go` 的 `AuthorizeGateway` 确实允许签名后的 `/v1/models`，但 `backend/internal/handler/gateway_handler.go` 的 `Models` 仍沿用普通目录逻辑：分组中混入多个用途模型时可能全部返回，空目录时可能回退平台默认模型。用途 Key 拦截执行不等于目录已经按用途正确过滤。

算力平台应为 SEP 目录消除默认模型兜底，保证只返回该企业 Key 对应用途的真实可用模型。当前测试采用三个专用分组并明确配置每组 `models_list_config`，这证明正确配置下可联调，不证明上述通用目录语义已修复。

### 2. 明确两种管理员校验路径，不改变已确认方案

用户确认采用管理员算力账号 Key。**本次已实测兼容**：SEP 原图片/视频适配器使用管理员普通模型 Key，访问 `/v1/sub2api/images/pricing`、`/v1/sub2api/videos/pricing`；返回旧 `currency=USD,amount_usd`，仅检查正金额与规格，不用于企业新账务、不发生成、不扣生成费用。

这里的“管理员 Key”是管理员账号名下、分配了模型分组的调用 Key，不是后台登录 access token，也不是管理 API 专用 Key。

算力另提供 `/api/v1/sep/validation/images/pricing`、`.../videos/pricing`，只用服务签名，平台内部创建校验身份，返回 `quote_scope=platform_validation,currency=CNY,amount_cny`，`pricing_version` 为空。它是另一条可选能力；本批没有把 SEP 的管理员 Key 校验偷偷改成这条新路径。请算力文档补充现有管理员 Key 方式仍受支持，或明确提出双方评审的变更。

企业实际媒体报价必须使用企业 Key + 服务签名，返回人民币和可执行 `quote_id`；不能复用上述任何一种管理员校验金额作为企业扣款依据。

### 3. N01 原单恢复要说明固定开户资料和版本

重复 N01 返回原密文；N02 只返回元数据，不能恢复丢失的 Key 明文。因此 SEP 在第一次发送前持久化原 `company_name/admin_email/encryption_key_id/registration_ref`，后续重放保持原内容。不能读取企业最新名称、最新管理员邮箱或最新加密版本来重试同一编号。

算力已保存原请求摘要和原密文，该规则与代码一致；请在联调步骤突出说明。加密公钥更新后，SEP 必须保留旧版本 RSA 私钥直到原开户交付已可恢复。

### 4. 回执缺少的字段要按已验证来源处理

- `compute_account_id` 是 JSON 整数，SEP 内部保存为字符串。当前只接受 JavaScript 安全整数；若可能超过 9007199254740991，算力应将字段改为十进制字符串并发布版本变更，不能让解析先发生精度损失。
- N05 回执没有 `compute_account_id` 和 `bill_version`。SEP 先用 N02 核对企业绑定账号，再用 N04 的不可变 final 单核对费用和版本；不能将缺失字段凭空认作远端已返回。
- N06/N07 回执也没有账号字段，按 N02 校验；回执的企业、方向、金额、资金来源和原编号均须一致。
- N06 的 HTTP 200 + `status=rejected` 是持久化拒绝，后续重放仍拒绝；不是成功入账，也不是可通过同编号盲重试修复的超时。SEP 已将它处理为终态失败。
- N04 的 `reconciling` 单独保存为 `RECONCILING`，不降成失败零元或 final。不存在最终金额时不能结算。

### 5. 金额、认证轮换和错误边界

双方集成金额已对齐固定六位、最多 18 位整数。SEP 新集成记录已扩为 `DECIMAL(24,6)`，差额为 `DECIMAL(25,6)`；不使用 Number 计算金额或流水序号。原业务钱包和免费来源表还须在真实接入时核对自身限额。

服务签名只有一个活动公钥，切换必须协调，不存在双方都默认支持的双公钥窗口。关闭整个算力集成会关闭旧单查询和结算，不能把总开关当作“只暂停新任务”。

算力部分底层异常在 `SEPHandler.failure` 仍统一为 `SEP_STORAGE_UNAVAILABLE`。这不满足此前“尽量保留真实原因、只脱敏”的完整目标；请算力区分可公开业务原因与内部诊断，并提供稳定请求追踪编号。SEP 本批不会恢复被远端丢掉的信息；已收到的错误 code/message 会脱敏后保存，不再统一替换成“开户失败”。

### 6. 联调环境资料

同一电脑上服务已经存在：算力后端 `http://127.0.0.1:28080`，SEP 后端 `http://127.0.0.1:3012`。本机进程间可直接访问；如果 SEP 改为 Docker 容器运行，127.0.0.1 将指向容器自身，必须改成可达的宿主机或网络地址。跨机器测试需算力提供可达 HTTPS 地址。

还需在正式联调环境确认：三个测试分组、可用模型与基础价格、人民币汇率、管理员校验账号 Key、服务公钥版本、加密公钥版本及服务时钟。不得通过聊天或 Git 传私钥及真实企业 Key。

## 三、本批完成的 SEP 实现

| 内容 | 实现与验证状态 |
| --- | --- |
| Ed25519 服务签名 | 已实现；14 项原文、真实 Body 字节、raw query、新 nonce、禁止重定向，无自动补生成 |
| RSA-OAEP-256 / A256GCM JWE | 已实现；至少 3072 位 RSA，校验 alg/enc/kid、tag、企业/账号/用途/版本，真实 Go 服务密文已解密 |
| N01/N02 开户 | 已实现；原快照重放、三 Key 完整校验、SEP 加密入库，保持 PREPARING |
| 企业目录 | 已加服务签名，按企业和用途取 Key，不回退管理员 Key |
| N04 费用 | 已实现字段/归属/状态校验及内部映射，支持 PENDING / RECONCILING / FINAL，不自行计价 |
| N05 结算 | 已实现远端 final 核对、账号核对、幂等决定、回执校验及原任务投递 |
| N06/N07 划转 | 已实现账号和回执校验，原编号恢复，明确区分 rejected，失败任务不再作为未决反复投递 |
| N08/N09 余额和流水 | 已实现人民币守恒、企业归属、递增序号、固定分页快照校验 |
| 同步错误 | 保存脱敏后的真实 code/message，配置或幂等冲突阻断，日志不写 Key |
| 管理员 Key 校验 | 保留现有方式，已用真实算力接口及 SEP 图片/视频适配器验证 |

实际费用、结算和划转适配器已经能调用真实算力服务，但业务资金仍只通过测试夹具驱动，没有把用户钱包充值、免费消耗或真实生成按钮切到这套适配器。

## 四、配置及公钥交付

已生成仅供本地开发的一套 Key，位于 Git 忽略目录：

`outputs/compute-integration/local-dev-keys-20261120/`

**只将 `public-configuration.json` 提供给算力平台。** 它含两份 SPKI PEM 公钥及版本编号。`signing-private.pem`、`encryption-private.pem` 由 SEP 保管，不交给算力平台。本地开发私钥不用于生产。

生成工具：`node scripts/create-compute-integration-keys.mjs <被Git忽略的输出目录>`；文件已存在时拒绝覆盖，不输出私钥。

SEP 部署配置如下，默认不启用：

```dotenv
COMPUTE_INTEGRATION_ENABLED=false
COMPUTE_API_ORIGIN=https://compute-test.example.com
COMPUTE_SIGNING_KEY_ID=<public-configuration.json 中的 signing_key_id>
COMPUTE_SIGNING_PRIVATE_KEY_FILE=<SEP 签名私钥绝对路径>
COMPUTE_ENCRYPTION_KEY_ID=<public-configuration.json 中的 encryption_key_id>
COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES={"<加密版本>":"<RSA私钥绝对路径>"}
COMPUTE_ALLOW_LOOPBACK_HTTP=false
```

只有显式设为 true 且 NODE_ENV 不是 production 时，loopback HTTP 才允许；内网普通 HTTP 不在例外内。三个模型地址沿用 `SUB2API_BASE_URL`、`MEDIA_BASE_URL`、`MEDIA_VIDEO_BASE_URL`；控制接口源站配置不带 `/api` 或 `/v1`。

`isConnected` 当前表示本地协议配置和密钥完整，不保证远端已启用或网络实时连通；远端错误由实际请求记录。账务激活仍不开放。

## 五、真实本机联调

脚本：`backend/test/compute-platform.live.ts`。它导入本批实际 SEP 服务和适配器，连接真实算力 HTTP 服务和双方独立 PostgreSQL；供应商是临时本地模拟服务。没有真实模型、支付或生产余额调用。

已验证的流程：

1. SEP 准备任务 → 后台 worker 开户 → Go 服务 JWE → SEP 验证解密并加密存储，N01 原单可恢复。
2. 三个用途的签名模型目录，在三个显式限制目录的测试分组中分别返回对应模型。
3. 管理员普通账号 Key 经 SEP 图片/视频适配器校验报价，不调用供应商生成。
4. 签名 SSE 对话 → N04 final CNY → 全免费结算，远端余额为零也不扣款；重复执行编号不再次生成。
5. 同编号并发转入只入账一次；余额不足的退回返回 rejected；N07 可查询原结果。
6. 流水分页期间插入新资金，旧快照金额保持一致。
7. 并发混合结算只扣付费部分一次；缺少用量保持 RECONCILING、金额 null，并保存到 SEP。
8. 企业图片/视频人民币报价、携带 quote_id 的执行，以及视频异步费用确认。

测试结束恢复算力原公钥配置和关闭状态、停用测试企业/分组/管理员测试 Key、停止模拟供应商、移除临时私钥；保留测试账务证据。脚本只领取本次测试企业的 SEP 任务。

运行命令（PowerShell，仅限已有专用本地测试服务）：

```powershell
$env:SEP_COMPUTE_LIVE_TEST='local-isolated-only'
$env:COMPUTE_TEST_DATABASE_URL='<127.0.0.1:25434 的 sep_compute_test 连接串>'
$env:COMPUTE_TEST_ADMIN_EMAIL='pricing-admin@local.test'
$env:COMPUTE_TEST_ADMIN_PASSWORD='<本机隔离算力服务测试管理员密码>'
pnpm --dir backend exec ts-node --transpile-only -r tsconfig-paths/register test/compute-platform.live.ts
```

脚本拒绝覆盖已启用的算力集成，不用于生产。测试中临时设置测试企业为 ENTERPRISE 只用于驱动原语，不代表存在可供管理员正式启用的接口。

## 六、对照完整开发方案的剩余工作

| 开发项 | 当前状态 | 正式业务联调前还需完成 |
| --- | --- | --- |
| 账号/凭证/控制 API | 本批完成，接口联调通过 | 部署双方测试公钥和稳定地址，补目录契约 |
| 模型偏好、企业媒体权限 | 已实现；目录签名已补 | 上游目录消除兜底，验证撤权与分组变化 |
| 所有对话及员工、编排入口 | 未完成切换 | 企业 Key、执行记录、签名、N04 关联及 SSE 各入口接入 |
| 对话免费与付费后台结算 | 本地记录和远端适配完成，真实资金事务未接 | 将 final CNY、免费权益和原付款来源、账单、待办放入同一本地事务；仍无执行前预占 |
| 图片/视频真实业务 | 协议原语验证通过，原业务仍未切换 | 原适配器人民币报价/quote_id、任务记录、预占及最终结转、N05 待办接入，不二次换汇 |
| 钱包充值/退回 | 控制原语验证通过，钱包流程未接 | 本地锁款、资金来源、原单恢复、rejected 释放及成功收尾；处理用户真实资金映射 |
| 对账后台 | 比较和远端查询能力已具备 | 构造本地同水位账本、持续拉取、差异处理和恢复，不直接修余额 |
| Key 轮换 | 算力 N03 未实现 | 按原计划延期，保留历史任务查询约束 |
| 欠费补收/个人钱包/删除后账务 | 方案已有未定事项 | 确认业务归属和恢复规则后实施，不自行猜测 |
| 真实用户全流程与上线 | 未完成 | 资金与所有入口接好后再验收、受控启用 |

因此这次的结论是“控制接口及协议可以本机联调，且已跑通”，不是“全部方案已开发完成、可以上线”。

## 七、数据库及检查结果

本批增加两次由 Prisma 生成的迁移，均已在专用测试库应用并重新生成 Client：

- `20261120093704_compute_protocol_delivery`：开户请求快照与脱敏错误原因。
- `20261120095726_compute_contract_money_precision`：扩大新集成账务的 Decimal 精度。

未重建旧业务表、修改旧历史迁移或调整生产余额。整个工作树还包含先前两次准备迁移，正式部署须一起按迁移链执行。

检查结果：

- 集成模块 7 个套件、71 项通过，包含 10 项专用 PostgreSQL 验证：实际行锁/唯一性、事务回滚、凭证隔离、金额最大精度及 RECONCILING 状态。
- 模型策略、客户端配置、媒体配置/执行和 HTTP 合约回归 12 个套件、473 项通过；1 项跨客户端仓库测试按环境开关跳过。
- 最终本机跨平台脚本完整通过；每轮只有 6 次本地模拟供应商生成提交，管理账号 Key 校验不增加供应商调用。最后一轮验证了 RECONCILING 记录真实入库，测试清理完成。
- 后端及前端 TypeScript 检查通过，后端直接 `nest build` 通过，公钥生成脚本 `node --check` 通过，`git diff --check` 通过。
- 最新 Nest 后端启动后 15 项 HTTP 冒烟通过。启动后第一次检查曾遇到一次 PostgreSQL P1001 连接失败，随后相同脚本重跑通过；未据此改动生产连接配置或宣称已定位该瞬态原因。
- 前端本批没有视觉改动，未重新执行上一批浏览器截图或前端生产构建；不将旧截图当作本次真实业务联调验收。

标准后端构建仍有先前记录的员工头像索引检查问题；全仓网关/旧计费测试的已知基线失败未纳入本批修复，见首批交付记录。不宣称全仓测试或所有业务流程通过。

本地后端恢复到本批最新构建，使用原专用数据库，集成默认关闭；算力测试集成配置已恢复且保持关闭。未提交、合并、push 或部署。
