# 个人付款方式

实现位于 `SEP-worktree-one`，尚未提交或部署。

## 页面

在“算力余额”的个人余额区域提供三项选择，企业管理员、部门负责人和普通成员均可设置本人选项：

| 值 | 页面名称 | 规则 |
| --- | --- | --- |
| AUTO | 自动选择 | 保留原扣费顺序，企业资金不足时个人余额补足 |
| ENTERPRISE_ONLY | 仅企业余额 | 使用原有授权、赠送余额和成员企业余额，不自动扣个人钱包 |
| PERSONAL_ONLY | 仅个人余额 | 不消耗企业资金、赠送余额或企业分配额度 |

选择后立即保存，不增加审批、切换次数、冷却时间或充值门槛。现有企业授权、每日/月度限额和余额不为负等规则继续有效。此设置只控制模型使用费用，不改变员工订阅付款方式。

## 接口与保存

网页使用 JWT 调用：

- `GET /api/compute-credit/payment-preference`
- `PATCH /api/compute-credit/payment-preference`

请求及成功响应：`{ "paymentMode": "PERSONAL_ONLY" }`。共享 Zod schema 拒绝非法枚举和额外身份字段；后端从登录身份解析用户及企业，只允许修改本人企业成员记录。无需管理员角色。

`EnterpriseMember.paymentMode` 保存每个企业成员的偏好，默认 `AUTO`。`ComputeUsageRecord.paymentMode` 保存本笔账单的模式；历史账单默认 `AUTO`，个人自费欠费不会计入企业额度消耗。

## 调用与结算

网页对话和客户端模型网关在调用前把模式冻结到既有计价快照，余额检查和最终扣费使用同一个快照。后台恢复也使用原记录，不读取新的个人选择。网关通过 `X-SEP-Payment-Mode` 返回本笔模式。

图片、视频报价把模式写入服务端报价的资金信息。提交预留费用时在事务内核对；报价后改变模式会返回 `PAYMENT_MODE_CHANGED` 具体原因，结束该未提交任务、不扣费、不调用模型，重新报价即可。已有请求按原幂等记录恢复，结算、退款使用原资金来源。

现有桌面客户端严格校验媒体 JSON，因此 HTTP 响应通过 `MediaPaymentModeInterceptor` 去除服务端新增的模式字段，改用 `X-SEP-Payment-Mode` 响应头；已有金额字段保持原样。客户端现有请求无需增加必填参数；在网页设置即可影响后续调用。客户端若要提供切换或显示模式，可另行对接设置接口/响应头。

文本费用在生成结束后才确定。选择单一来源后，如果实际金额超过可扣资金，保留现有 `unpaidCNY` 和对账机制，不改扣另一钱包、不重新请求模型，也不自动补扣历史欠费；图片视频仍按原有报价预留及退款流程处理。

## 迁移与验证

Prisma 工具生成两项迁移：

- `20261126052438_member_payment_preference`
- `20261126053147_usage_payment_mode`

仅在临时隔离 PostgreSQL 数据库应用，执行过 `pnpm db:migrate`、`pnpm db:generate`；未迁移共享本地或生产数据库。部署前需先应用迁移，再启动新版后端和前端。

验证：后端相关回归 19 组 528 项通过，额外对话创建与通知回归 2 组 30 项通过，前端 2 组 9 项通过，前后端类型检查及 `nest build` 通过。隔离数据库脚本 `backend/test/payment-preference.integration.ts` 验证默认值、成员隔离、模式变更、并发唯一预留、原路退款、仅企业付款拒绝及个人欠费额度隔离。Playwright 使用模拟接口检查两种身份桌面/手机的切换和刷新恢复，无真实充值、收费模型调用或生产写入。

隔离数据库脚本仅允许 `PAYMENT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/sep_payment_test?schema=public`，执行命令为 `pnpm --dir backend exec tsx test/payment-preference.integration.ts`。这是显式运行的测试脚本，不在普通单元测试中连接数据库。
