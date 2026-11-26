# SEP 修改密码同步算力账号

日期：2026-11-24。本轮同时修改两个后端，SEP 前端显示同步结果。

## 行为

- 原开户管理员在 SEP 修改密码或通过邮件重置后，立即尝试同步原绑定的算力登录账号。普通员工只改本人的 SEP 密码。
- 根据开户快照中的管理员用户 ID 选择绑定；老快照无 ID 时才使用原邮箱，不因企业管理员变动而覆盖另一人的账号。
- SEP 密码和同步任务在同一本地事务内保存，提交后立即请求远端。网络故障时保留任务，页面显示“SEP 密码已修改，算力平台密码同步中”。这不是跨数据库原子事务，故障期间两边密码可能短暂不同。
- 后台每 15 秒扫描，失败退避 15 到 60 秒。一个企业仅保留最新待同步密码，成功后清除同步任务的哈希密文。
- 开户未完成时保留最新密码任务，开户继续复用原快照；原账号创建完成后自动补同步最新密码，不修改 N01 幂等内容。
- 当前密码在用户行锁内校验，版本号按企业递增；算力侧行锁与版本检查防止旧密码覆盖新密码，本地旧响应不能清除新任务。
- 算力旧 JWT/refresh 因密码派生的 token version 变化失效。三个用途 Key、模型调用凭证、余额和账务不改动。
- 本轮仅为 SEP 到算力平台同步；直接在算力平台改密不会反向修改 SEP。邮箱与公司资料不在范围内。

## 接口

新增算力接口 `POST /api/v1/sep/enterprises/{enterpriseId}/password`。沿用现有 HTTPS、Ed25519 服务签名和 nonce 防重放规则，不使用公共 Key 或用户登录 Token。`X-SEP-Enterprise-ID`、路径与正文企业一致，`Idempotency-Key` 等于 `operation_id`。

```json
{
  "contract_version": 1,
  "enterprise_id": "ent1",
  "compute_account_id": 12,
  "operation_id": "pwd_sync1_2",
  "password_version": 2,
  "password_hash": "<SEP 本次保存的 bcrypt 哈希>"
}
```

版本为 1 到 2147483647 的整数，允许跳过被新密码替代的版本。业务编号由同步记录 ID 和版本派生，重试保持不变，每次重新生成签名及 nonce。不传明文密码，不对 bcrypt 哈希再次做 bcrypt，不记录请求正文。

HTTP 200 回执：

```json
{
  "contract_version": 1,
  "enterprise_id": "ent1",
  "compute_account_id": 12,
  "operation_id": "pwd_sync1_2",
  "password_version": 2,
  "applied_version": 2,
  "status": "applied"
}
```

同版本同内容重放返回原结果，不再写密码；旧版本返回 `superseded` 和更大的 `applied_version`。同版本不同内容返回 409 `IDEMPOTENCY_CONFLICT`；账号不符返回 409 `COMPUTE_ACCOUNT_MISMATCH`；账号不可用返回 409 `COMPUTE_ACCOUNT_UNAVAILABLE`；哈希或版本无效返回 400。SEP 校验回执归属和版本，`superseded` 不作为当前任务成功。

SEP 原 `POST /api/auth/password/change` 从 204 改为 200，返回 `{ message, computePasswordSync }`；原 `POST /api/auth/password/reset` 保留 200，增加同一字段。状态为 `SYNCED`、`PENDING`、`NOT_REQUIRED`。旧客户端忽略返回正文仍可使用原请求字段。

平台管理员可在“算力连接 → 企业详情 → 最近同步操作”查看密码同步状态及脱敏原因，接口不返回哈希或密文。登录页保留忘记密码重置后的同步中提示。

## 部署与文件

- SEP 新增 `compute-password-sync.service.ts`、共享响应类型、模块注册；修改 auth 两条密码路径及 `compute-remote.adapter.ts`、`compute-wire-contract.ts`、同步记录查询。
- 前端修改登录密码、个人资料、管理员账号、重置跳转和算力连接详情。
- SEP 新增 Prisma 迁移 `20261124105520_compute_password_sync`，由 Prisma schema diff 工具生成，只新增同步表。
- 算力新增 `sep_password.go`、签名 handler 和路由；迁移 `194_sep_password_sync.sql` 新增版本及幂等字段，不修改历史迁移。
- 两边均需部署新后端并应用迁移，建议先部署算力接收接口，再部署 SEP。
- 已有账号从下一次 SEP 改密开始同步，不会自动重置所有现存算力账号。

## 验证

- SEP 后端 9 个相关文件共 127 项测试通过，覆盖修改密码与重置密码、同事务保存任务、签名适配、身份校验、失败恢复、旧响应保护及既有开户流程。
- 前端 11 项组件测试通过；Playwright 5 项密码页面测试通过，覆盖桌面/手机、已同步、同步中及忘记密码跳转提示。原算力连接的 9 项页面测试也通过。已查看桌面及手机截图。
- 两边类型检查及 SEP Nest 编译通过；算力平台服务、handler、路由的 SEP 测试通过，算力 Windows 后端二进制编译通过。SQL mock 覆盖远端事务回滚、版本重放、账号隔离与旧登录版本失效。
- 两个工作树的 `git diff --check` 通过。未执行全量仓库测试或 SEP 资源预检查构建。
- 2026-11-25 本地服务已恢复，两边迁移已应用，两个新后端正在运行。SEP 的 3 项真实 PostgreSQL 改密事务测试通过；算力侧真实 PostgreSQL 密码版本及并发持久化测试通过。
- 已实际验证登录后改密、Mailpit 邮件找回密码、新旧密码在双方的登录结果、旧算力会话失效、成功后清除加密哈希，以及暂不可用后自动恢复。恢复场景通过专用测试企业绑定短暂 PENDING 制造，不代表实际切断整个远端网络。
- 完整联调结果与未通过项目见 `sep-compute-acceptance-results-2026-11-25.md`。

密码专项未修改已有管理员密码，未提交、合并或推送 Git。同日整体联调另有真实模型与一张图片调用，费用及证据见上述结果文档。
