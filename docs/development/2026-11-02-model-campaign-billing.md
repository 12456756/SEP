# 模型活动免费与中转倍率

## 配置与适用范围

平台后台的模型管理增加 `isFree` 活动免费开关，默认 `false`。
管理员通过 `PATCH /models/:id` 设置 `{ "isFree": true }` 开启，设置
`false` 关闭。同步上游目录不会覆盖该配置，开关也不会改变模型启用状态或企业授权。
本次适用于 Web 对话、任务执行复用的对话链路及客户端会话网关；图片、视频计费保持各自规则。
任务规划保留原有独立流程，仅让活动免费模型通过其余额预检。

免费时 SEP 向用户收取零元，保留实际 token 用量和零金额账单，不占用付费额度，
不因余额或额度耗尽阻断。上游费用仍由平台承担，认证、企业授权和资源限流继续生效。

## 倍率和金额

非活动模型通过当前转发使用的 `SUB2API_BASE_URL` / `SUB2API_API_KEY` 请求
`GET {baseUrl}/sub2api/billing`。通常 `baseUrl` 已包含 `/v1`。
只接受 `sub2api.key_billing`、版本 `1`、`billing_scope=token` 响应，
读取非负有限数 `effective_rate_multiplier`。
该值由 sub2api 的用户/分组生效倍率乘当前高峰倍率得到。
当前 SEP 各企业/用户共用平台配置的转发密钥，没有额外账号级倍率覆盖。

正常金额为：

```text
USD = (输入 token × SEP 基础输入单价 + 输出 token × SEP 基础输出单价)
      / 1,000,000 × 中转生效倍率
CNY = USD × 生效美元汇率
```

SEP 基础单价来自现有模型价目表，未知模型使用现有保底价。
并未改为读取上游逐请求实际账单，不能保证与 sub2api 实际扣费完全一致。
现有接口没有可核实的官方原价折扣来源，不生成“官方一折”等标签。

## 列表契约

`GET /models/available` 和企业模型配置的可用模型列表保留原有字段，并返回：

| 状态 | `isFree` | `billingMultiplier` | `discountLabel` |
| --- | --- | --- | --- |
| 平台活动免费 | `true` | `"0"` | `活动免费` |
| 正常中转 | `false` | 当前倍率的字符串 | `按中转倍率计费` |
| 上游倍率为零 | `false` | `"0"` | `中转免费` |
| 上游倍率查询失败 | `false` | `null` | `中转倍率暂不可用` |

另返回 `modelId` 和 `displayName`。客户端按已有授权过滤模型，展示服务端值，
不自行计算官方折扣。倍率查询失败不会默认一倍或免费；需付费的调用在转发前返回 503。

## 快照与上线

请求开始时冻结活动状态、倍率、有效单价和汇率。同一次 Web 对话的成本展示与扣费使用同一快照；
网关将快照持久化到 `gateway_executions.billingSnapshot`，恢复和重试也使用原快照。
活动在请求中途开关不追溯改价。升级前无快照的网关执行保留旧版一倍计价，
不追溯套用新活动，旧记录的汇率/保底价仍按其结算时配置读取。

上线前先在部署环境执行：

```bash
pnpm --filter backend exec prisma migrate deploy
pnpm --filter backend exec prisma generate
```

新增迁移 `20261102070000_model_free_billing_snapshot` 只添加
`platform_models.isFree`（默认 `false`）和网关快照 JSONB 列。
然后构建并部署后端、Web。还需确认部署中的 sub2api 提供上述计费查询接口。
首次上线需要部署；上线后调整免费开关即时影响后续请求，无需再次部署，列表在重新请求后更新。

开发环境曾因历史迁移校验不一致拒绝 `migrate dev`；未执行 reset，未对持久表应用本迁移。
迁移由 Prisma schema diff 生成，并在 PostgreSQL 临时表上验证 SQL 和默认值。
部署环境如存在历史迁移漂移，应先核实历史状态，不得直接重置数据库。
