# SEP 接入算力余额同步交付说明

日期：2026-11-23。依据算力平台 `outputs/sep-balance-sync-handoff-20261123.md` 实施。此次修改限 SEP 后端及本地联调启动配置，没有修改算力业务源码，没有提交、合并、推送或部署。

## 结果

新建隔离企业已完成双方本地联调：真实签名通知充值、后台扣减、通知失败补拉、并发去重、本地事务失败回滚、SEP 原划转不重复入账、重启及定时补拉均通过。最终公共算力余额两边均为 `2.460000 CNY`。未调用供应商生成，没有产生本次模型生成费用，没有使用银行或第三方支付充值。

这不代表所有存量账户已经接入完成，也不代表实际支付退款、兑换码充值、直接模型消费等所有算力侧入口都已在本轮端到端验收。

## 1. 新增接口

| 方法 | SEP 路径 | 作用与认证 |
| --- | --- | --- |
| POST | `/api/compute-integration/balance-events` | 算力平台通知接收端；使用算力 Ed25519 签名认证，不使用用户 JWT |
| GET | `/api/admin/compute-integrations/:enterpriseId/balance-sync` | 平台管理员 JWT；查看事件、水位、失败诊断和确认状态 |
| POST | `/api/admin/compute-integrations/:enterpriseId/balance-sync/pull` | 平台管理员 JWT；补拉、重试原事件和确认，不重新充值或生成 |
| POST | `/api/admin/compute-integrations/:enterpriseId/balance-sync/baseline` | 平台管理员 JWT；为存量企业设置经过核对的迁移起点 |

迁移起点请求：`{"afterSequence":"16"}`，只是示例，必须使用该企业实际核对后的水位。新账户从零开始处理第一个事件，通常无需调用。

通知校验固定六位人民币金额、方向、来源、企业及算力账户归属；`Idempotency-Key` 必须等于 `event_id`。确认体为 `{"event_id":"原事件编号","status":"applied"}`，仅本地事务完成后返回 HTTP 200。

已有算力平台补拉及确认接口复用 SEP 服务签名，没有新增模型供应商调用。

## 2. 资金规则

- `origin=compute`：同步到企业公共算力资金。外部增加同时增加钱包余额及其算力专款子集；外部减少同时减少两者。不会分配到成员，不会增加 SEP 的银行收款累计，不会再向算力平台发送一笔充值。
- 通过 `wallet_transactions` 的 `ADJUSTMENT` 记录保存来源、算力事件编号、业务编号、方向、汇率、事件时间和前后专款金额；直接消费事件另更新钱包消费累计。
- `origin=sep`：严格匹配原划转或结算的企业、金额、业务编号及远端流水。等待原操作确认后接受回执，不再次变更资金。免费记录不扣付费余额。
- 外部扣减超过 SEP 公共算力资金时，保留 `RECEIVED` 事件并返回 `COMPUTE_PUBLIC_FUNDS_INSUFFICIENT`，不挪用成员分配资金、个人资金、普通钱包自由资金或媒体预占。算力侧可能已经扣款，需要运营核对原事件，不能把 SEP 拒绝入账理解成算力侧已自动撤销。
- 后续序号必须等待前面的事件完成。对账仍记录差异，不使用远端余额覆盖本地账本。

事件去重和入账使用企业行锁及唯一索引。实际资金修改、钱包流水、事件 `APPLIED` 状态和序号推进在同一本地数据库事务内完成。验证后的通知先保存收件记录；入账失败不会返回成功确认。

本地已入账但调用算力确认接口失败时，返回 `COMPUTE_EVENT_ACK_PENDING`，明确 `accounting_status=committed`、`event_status=applied`；后台只恢复确认，不重复改余额。

## 3. 签名与启用配置

SEP 后端部署配置：

```text
COMPUTE_BALANCE_SYNC_ENABLED=true
COMPUTE_BALANCE_POLL_ENABLED=true
COMPUTE_EVENT_PUBLIC_KEY_FILES={"算力签名版本":"/run/secrets/compute-event-public.pem"}
```

继续保留原有 `COMPUTE_INTEGRATION_ENABLED`、SEP 服务签名、Key 解密和算力地址配置。`COMPUTE_BALANCE_POLL_ENABLED` 默认启用；显式设为 false 只用于临时隔离通知测试。全局启用开关未打开时，通知接收返回 503，定时任务不运行。

算力管理员配置：`balance_webhook_url=https://SEP后端可达地址/api/compute-integration/balance-events`。代理必须原样保留通知路径、查询字符串、正文及签名头；不得把 JSON 重新序列化。生产使用 HTTPS。

算力签名私钥由算力服务持有。SEP 仅部署经可信渠道核对后的版本和公钥文件，不信任通知自带公钥，不会自动替换信任配置。公钥可用原服务签名调用算力 `GET /api/v1/sep/balance-events/signing-key` 获取并核对。轮换期间可在版本映射中保留多个公钥。

验签使用原始请求字节的 SHA256、真实路径和查询、算力签名版本、时间及 nonce；时间窗口 300 秒。验签通过后以 Redis NX/TTL 阻止 nonce 重放。Redis 不可用时拒绝通知，不跳过验签。相同事件重新通知必须换 nonce；金额去重仍按事件编号处理。

## 4. 存量迁移与恢复

新增 Prisma 迁移：`20261123025318_compute_balance_event_sync`，由 Prisma 工具生成。新增 `compute_balance_events` 收件与幂等记录、`compute_balance_sync_states` 同步水位及失败状态，不重建企业钱包。

生产需要先按现有部署流程应用迁移并生成客户端，再启用通知和补拉。禁止直接运行数据库 reset。

算力改造之前的流水没有通知事件。存量企业接入步骤：

1. 查询算力最早事件，确认第一条事件之前的历史水位。例如首条事件序号为 17，历史起点应为 16。
2. 完成 SEP 原账务核对，确保该水位有 `MATCHED` 的历史对账记录，金额与算力固定快照一致。
3. 平台管理员提交 baseline，然后调用 pull 补拉后续事件。接口禁止跳过已有事件，也禁止已推进水位后重新设置。
4. 开启通知及后台补拉。任务每 30 秒选择一批企业，使用同一入账逻辑处理推送和补拉；已入账但未确认的原事件也会恢复确认。

旧测试数据中的未知历史流水、未结视频和欠费不会因启用同步被自动清除。本轮没有批量重设存量账户起点，也没有声称它们均已对账完成。

## 5. 本地联调证据

本地地址：SEP 网页 `http://127.0.0.1:3010`，API `http://127.0.0.1:3012`；算力网页 `http://127.0.0.1:3301`，API `http://127.0.0.1:28080`。

算力通知地址已配置为 `http://127.0.0.1:3012/api/compute-integration/balance-events`，本机回环联调使用 HTTP。公钥版本 `compute-events-local-20261123` 已与实际算力签名公钥接口比对一致。

测试企业 `cmwsoov8f000avfesexju9zl0`，算力账户 `62`：

| 验证 | 结果 |
| --- | --- |
| 实际签名通知 | 算力增加 2 CNY、扣减 0.25 CNY，SEP 公共专款变为 1.750000；两笔事件均由实际通知一次确认 |
| 原充值编号重试 | 重试同一业务编号，远端不重复充值 |
| 通知地址故障 | 临时配置不存在的路径，算力保留真实 HTTP 404、请求追踪号与未确认事件，SEP 不提前增加资金 |
| 并发入账与补拉 | 对同一个补拉事件并发 6 次，钱包只有一条对应流水；补拉确认后两边 2.250000 |
| 真数据库事务回滚 | 在钱包流水写入时注入失败，余额及水位回滚、事件保持 RECEIVED；只重试原事件后两边 2.350000 |
| SEP 原划转回执 | 本地钱包测试调整后，从 SEP 划入算力 0.1 CNY；自身回执不重复增加，两边公共专款 2.450000 |
| 权限与对账 | 普通用户访问管理状态 403，缺签名通知 401；正常企业对账 MATCHED、差额 0 |
| 重启与自然定时补拉 | SEP 实际重启后保留原 5 条事件；通知地址故障期间新增加 0.01 CNY，由定时任务补拉并确认，原事件只有一条钱包流水，两边 2.460000 |

上述最终数值是“公共算力资金”，不是包含未划入算力部分的整个企业钱包总额。没有产生银行支付或模型生成调用。

原始结果保存在 Git 忽略目录 `outputs/compute-integration/balance-sync-live-results-20261123.json`；分阶段脚本 `balance-sync-live-20261123.ts`、`balance-sync-recovery-20261123.ts` 会变更测试资金，不能无差别重复执行。新测试数据和流水保留供复核。

## 6. 代码与检查范围

主要文件：共享 `compute-balance-event.dto.ts`；`compute-balance-signature.guard.ts`；`compute-balance-sync.controller.ts`、`compute-balance-sync.service.ts`、`compute-balance-sync.worker.ts`；原始正文解析中间件；算力远端适配器、流水 DTO、对账 worker；删除企业前的未结账务检查。已登记至现有对接模块。

单元和 HTTP 回归覆盖：签名篡改、时间窗口、未知版本、nonce 防重放、Redis 故障、金额格式与方向、跨企业账户、重复事件冲突、乱序、企业公共资金不足、免费回执、原划转和结算不重复扣款、补拉分页、确认失败恢复、迁移起点与对账。

实际执行结果：7 个相关测试文件、100 个测试全部通过；后端 `pnpm --dir backend typecheck`、`pnpm --dir backend exec nest build` 和 `git diff --check` 通过。新迁移已在本地预览数据库应用，随后执行 `pnpm db:generate`。不是全量后端、前端或生产部署验收。

已有 JSON 解析中间件完整测试运行另有 3 条断言失败，涉及旧错误透传后文案或字段结构的预期，不是余额通知路由的验签和入账用例。本轮未修改这些错误映射或为其放宽断言。

未覆盖：真实银行支付、实际退款渠道、真实供应商 direct 模型调用及其最终扣费事件、全部存量账户的迁移、生产代理及多节点故障演练。直接消费、退款类事件的 SEP 资金处理已由服务回归验证，不能据此声称所有算力侧业务入口都完成端到端验收。

本地配置及公钥已接好，服务继续运行；算力本地测试私钥保存在两个 Git 工作树以外，由算力启动进程读取，未交付前端或写入 Git。正式环境仍需独立部署配置与可信公钥核对。
