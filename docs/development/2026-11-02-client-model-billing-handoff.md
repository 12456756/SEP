# 客户端模型倍率与活动免费接入说明

## 当前状态

后端和 Web 端实现已合入提交 `2806d9d`，但尚未部署到目标环境。客户端部署前需要等待后端完成数据库迁移和服务发布；在此之前，目标环境不会返回这些新字段。

## 模型列表接口

两个已认证接口都会返回模型倍率和计费标签：

| 场景 | 请求 |
| --- | --- |
| 平台启用模型列表 | `GET /api/models/enabled` |
| 企业模型配置中的可用模型列表 | `GET /api/enterprise/model-config/available-models` |

请求使用现有 JWT Bearer token。客户端继续按现有企业/用户授权模型 ID 列表过滤，并遵循现有的模型切换权限；本次新增字段不替代授权判断。实际调用时使用 `modelId`，不要使用数据库记录 ID。

列表保留原有模型字段，并增加：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `modelId` | `string` | 中转调用使用的模型 ID |
| `displayName` | `string` | 用户界面展示名；当前与模型管理中的 `label` 一致 |
| `billingMultiplier` | `string \| null` | 服务端已解析的当前中转倍率；以十进制字符串传输，查询暂不可用时为 `null` |
| `discountLabel` | `string` | 服务端返回的展示文案 |
| `isFree` | `boolean` | 是否由平台开启活动免费 |

示例（倍率数字仅为结构示例，运行时由后端读取，不是固定值）：

```json
{
  "modelId": "model-a",
  "displayName": "模型 A",
  "billingMultiplier": "2.19",
  "discountLabel": "按中转倍率计费",
  "isFree": false
}
```

活动免费模型返回：

```json
{
  "modelId": "model-b",
  "displayName": "模型 B",
  "billingMultiplier": "0",
  "discountLabel": "活动免费",
  "isFree": true
}
```

## 倍率和折扣口径

- 正常模型的 `billingMultiplier` 来自当前 SEP 转发密钥对应的 sub2api `effective_rate_multiplier`，该值包含中转侧当前生效的分组/用户倍率和高峰倍率。当前 SEP 使用平台配置的转发密钥，各企业和用户没有单独的倍率覆盖。
- SEP 用户侧费用按现有模型基础单价乘该倍率，再按当前美元汇率折算成人民币。未知模型继续使用 SEP 现有保底价。
- 没有从上游取得可验证的“官方原价折扣”数据，因此 `discountLabel` 不代表官方折扣率，也不应据此还原单价。常规模型显示“按中转倍率计费”；不要把它改写成“官方一折”等文案。
- 平台开启活动免费时，SEP 向用户收取零元，列表返回倍率 `"0"` 和“活动免费”。活动只免 SEP 用户侧费用，上游转发费用仍由平台承担。
- 如果 sub2api 返回的实际中转倍率本身为 `0`，列表会返回 `isFree: false`、`billingMultiplier: "0"` 和“中转免费”。这表示上游中转规则免费，不等同于平台活动免费；客户端应以 `isFree` 区分两者。

## 客户端展示约定

1. 先按现有授权模型 ID 列表过滤模型，再展示服务端返回的名称及计费字段。
2. `billingMultiplier` 非 `null` 时可组合显示为“`{billingMultiplier} 倍率 · {discountLabel}`”，例如“`2.19 倍率 · 按中转倍率计费`”。
3. `billingMultiplier` 为 `null` 时只展示 `discountLabel`（“中转倍率暂不可用”）；不要回退成 `1`、推算折扣或显示为免费。列表仍可用于展示，付费调用是否可继续由服务端计费校验决定。
4. `isFree` 可用于免费活动的视觉强调；展示文字仍以 `discountLabel` 为准。
5. 模型列表可能被客户端缓存。管理员切换活动状态后，客户端应在常规刷新/重新获取模型列表后更新展示；不能用旧列表值推断已开始请求的计费状态。

## 失败和计费时点

- sub2api 倍率查询失败时，模型列表仍返回；付费模型的 `billingMultiplier` 为 `null`，`discountLabel` 为“中转倍率暂不可用”。
- 付费请求无法取得有效倍率时，后端不会按一倍或免费结算，而会在转发前返回服务不可用错误。客户端应按现有服务端错误处理展示重试提示。
- 请求开始时，后端冻结当次请求的活动状态、倍率、模型单价和汇率。活动开关变化不追溯修改已经开始的请求；客户端不参与计费计算。
- 历史 Gateway 执行若没有计费快照，会按兼容逻辑保持旧版一倍计价，不追溯套用活动免费。

## 首次部署依赖

目标环境首次上线需要先部署后端数据库变更，再发布后端与客户端/Web：

1. 执行 Prisma 迁移 `20261102070000_model_free_billing_snapshot`，增加模型 `isFree` 配置和 Gateway 计费快照字段。
2. 生成 Prisma Client，并构建、部署后端。
3. 确认部署中的 sub2api 支持以当前转发密钥调用 `/sub2api/billing` 并返回兼容的 token 计费倍率。
4. 发布客户端/Web 后，通过上述模型列表接口读取新字段。

部署上线后，管理员调整模型免费开关会即时影响后续新请求；该配置不要求再次部署。完整计费实现与迁移注意事项见 [模型活动免费与中转倍率](2026-11-02-model-campaign-billing.md)。
