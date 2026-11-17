# 客户端多媒体模型信息与参数配置开发方案

日期：2026-11-13。

状态：2026-11-16 已实现 SEP 平台接口、共享契约、错误透传和本仓库企业后台预览适配；桌面客户端位于其他仓库，其设置页面、工具与缓存改造仍需在对应仓库完成。第 2 节保留改造前的现状说明；实现范围、接入方法和验证记录见 [客户端多媒体运行配置接入说明](../对接/2026-11-16-客户端多媒体运行配置接入说明.md)。尚未提交、推送或部署。

## 1. 目标与已确认的约束

客户端在主动请求员工运行配置时，一次获得当前企业允许使用的图片、视频配置，直接用于设置页面，并继续提供给现有工具。

- 复用 `GET /api/client/subscriptions/{subscriptionId}/runtime`，不新增模型目录接口。
- 直接完善现有开发中的 `protocolVersion: 3` 结构，不引入第 4 版，不为旧客户端保留旧版返回格式。
- 保留员工运行配置的整体结构，图片位于 `runtime.media`，视频位于 `runtime.video`。
- 模型清单仍按企业授权生成，`subscriptionId` 用于检查员工订阅和访问权限，不用于给多媒体模型增加一套员工绑定规则。
- 仅客户端主动请求时读取最新配置；没有服务端推送、轮询、窗口聚焦刷新、断网重连自动刷新。
- 查询配置不发起生成、不请求报价、不预占余额、不扣费，也不触发上游模型发现或配置同步。
- 生成、报价、结算继续走现有接口。本次不重做计费，不增加未经请求的依赖。
- 用户没有有效员工订阅或访问授权时，不能使用这个接口获取配置。这是选择复用原接口后保留的使用前提。
- 不新增 `subscriptionId` 的长度、字符等路径格式检查，沿用现有参数读取和订阅权限检查。
- 错误来源提供的业务错误、校验明细和诊断信息详细传给客户端，不二次改写消息、重新分类错误码或丢弃明细。

## 2. 当前代码情况

| 位置 | 当前行为 | 本次需要处理的内容 |
| --- | --- | --- |
| `backend/src/modules/client/client.controller.ts` | JWT 登录校验、读取订阅 ID 和协议参数 | 更新 Swagger 和请求参数约定，沿用现有订阅 ID 读取方式 |
| `backend/src/modules/client/client.service.ts` | 先检查企业和订阅，再查询图片、视频配置 | 默认返回两个多媒体区块，保留错误来源提供的详细信息 |
| `backend/src/modules/client/client-subscription-access.ts` | 检查企业隔离、订阅状态、到期时间、成员或部门授权 | 复用现有规则，不另写一套权限判断 |
| `backend/src/modules/media-config/media-config.service.ts` | 按企业授权构建图片 V3 配置 | 增加模型标识、结构化参数、有效能力限制 |
| `backend/src/modules/media-config/media-video-config.service.ts` | 按企业授权构建视频 V3 配置 | 同上，并处理不同视频操作的限制 |
| `backend/src/shared/media-spec.dto.ts` | V3 返回结构经过严格 Zod 校验，当前主要提供 `capabilityHints` | 更新共享结构及相关消费者、测试和样例 |
| `backend/src/common/filters/http-exception.filter.ts` | 本接口现有错误输出可能丢失来源中的业务码和字段明细 | 本接口完整透传来源错误字段，不做二次改写或错误码映射 |

当前接口对未传或不识别的媒体协议版本会省略对应区块；当前查询参数校验也允许大于 3 的正整数。因此，目前传 `4` 并不会得到新格式，可能只是拿不到多媒体区块。本次需要消除这种静默行为。

当前企业冻结检查抛出 401，并带有 `ENTERPRISE_SUSPENDED` 业务码；但本接口经过现有全局错误处理后，业务码通常不会传给客户端。本次要求原样保留来源状态、业务码和详细消息，不替换成另一种通用错误。

## 3. 请求约定

```http
GET /api/client/subscriptions/{subscriptionId}/runtime
Authorization: Bearer <accessToken>
```

两个媒体版本参数可省略，省略时均按完善后的第 3 版返回。需要显式传参时，下面的请求与省略参数等价：

```http
GET /api/client/subscriptions/{subscriptionId}/runtime?mediaProtocolVersion=3&videoProtocolVersion=3
```

| 参数 | 来源和规则 |
| --- | --- |
| `subscriptionId` | 来自已有客户端订阅列表；必须是当前用户可以访问的有效订阅 |
| `Authorization` | 使用登录后的 access token，不使用员工执行凭证替代 |
| `mediaProtocolVersion` | 可选，当前仅接受 `3`，省略默认 `3` |
| `videoProtocolVersion` | 可选，当前仅接受 `3`，省略默认 `3` |
| `skillArtifactProtocolVersion` | 保持现有技能产物协议约定，与媒体配置独立处理 |

请求处理规则：

1. `subscriptionId` 沿用现有 `@Param('subscriptionId')` 读取方式，不新增长度、字符集或 cuid 格式检查；是否可访问继续由现有订阅查询和授权条件判断。
2. 两个媒体版本参数只接受字符串形式的整数 `3`，不接受数组、重复参数、空值、其他版本或未知字段。
3. 客户端不能通过 `enterpriseId`、`userId` 指定查询范围；这些额外字段返回 400。
4. 企业身份从登录用户解析，先通过权限检查，再读取或返回模型配置。
5. 未匹配到路由，例如遗漏路径中的订阅 ID，沿用框架原有的路由级 404，不另行转换为 runtime 业务错误码。

不为本接口继续维护旧格式分支；其他接口仍使用的旧服务方法，不在本次顺带删除。

## 4. 成功返回结构

### 4.1 顶层和多媒体区块

保留 `manifestVersion`、`subscriptionId`、`templateVersion`、`employee` 和 `runtime`。员工提示词、聊天模型、技能等既有字段继续按当前逻辑返回。

新增顶层 `fetchedAt`，表示本次配置响应组装完成的时间，不表示配置必然在该时刻发生过修改。

每次成功响应都包含 `runtime.media` 和 `runtime.video`，没有模型也返回明确的空状态，而不是省略字段。

| 多媒体区块字段 | 含义 |
| --- | --- |
| `protocolVersion` | 固定为 `3` |
| `executionMode` | 沿用 `real`、`disabled`、`mock`；本方案不新增模拟执行能力 |
| `status` | `ready`、`empty`、`disabled` 或 `unavailable` |
| `executionAvailable` | 是否至少有一个当前可执行的已授权配置；不是余额或上游在线保证 |
| `defaultProfileId` | 企业指定且当前可执行的默认配置，否则为 `null`；不擅自选列表第一项 |
| `tools` | 当前可以提供的工具列表，使用已有工具名称 |
| `profiles` | 企业已授权且仍有配置记录的配置列表，包括暂不可用项 |

`status` 的判定顺序固定为：没有已授权配置时为 `empty`；有配置但执行开关关闭时为 `disabled`；存在可执行配置时为 `ready`；其余为 `unavailable`。

读取数据库失败不能当成 `empty`，无法解析配置不能当成空列表。企业授权中指向已删除配置的引用，记录供管理员排查，不给客户端伪造一个可用模型。

### 4.2 每个 profile 的字段

| 字段 | 含义与规则 |
| --- | --- |
| `profileId` | 平台配置编号，生成时仍使用它选择路由 |
| `modelId` | 真实模型标识，来自现有 profile，不接受客户端覆盖路由 |
| `modelDisplayName` | 平台已有模型名称；没有单独名称时使用 `modelId`，不杜撰品牌或能力 |
| `displayName` | 平台为这套配置设置的名称；同一模型可以有多套配置 |
| `kind` | `image` 或 `video` |
| `configVersion` | 现有配置版本，不能当作本次响应时间或全局授权版本 |
| `operations` | 当前配置与适配器共同支持的操作 |
| `executionMode` | 沿用同步图片和异步视频执行方式 |
| `authorized` | 保留，返回列表中的配置均已获当前企业授权 |
| `adapter` | 保留适配器标识、版本、可用性、操作、参考图限制、查询和取消能力 |
| `parameters` | 结构化参数定义，替代仅用于提示的 `capabilityHints` |
| `constraints` | 参数之间的组合规则，无已知规则时为空数组 |
| `referenceRules` | 分操作的参考图数量、单张大小、格式和必填要求 |
| `unavailableReason` | 不可用原因码；可用时为 `null` |
| `unavailableMessage` | 对应的用户可读中文说明；可用时为 `null` |

成功配置响应不返回上游地址、连接详情、API key、内部账号、原始上游响应或其他企业的授权数据。

### 4.3 参数定义

`parameters` 使用以现有生成参数名为键的对象，参数名继续对应 `requestedSpec`，避免增加客户端字段翻译层。

| 参数属性 | 含义 |
| --- | --- |
| `label` | 客户端显示名称，例如“视频时长” |
| `type` | `string`、`integer`、`number`、`boolean` |
| `support` | `supported`、`unsupported`、`unknown`；说明平台对这个字段的支持状态 |
| `required` | 是否为所列操作无条件必填；存在替代参数时用组合规则表达 |
| `operations` | 适用的操作列表 |
| `valuesMode` | `allowed` 为确认的允许值；`suggested` 为提示值；`unknown` 为未知 |
| `values` | 已知选项或建议值，可省略；必须与 `type` 一致 |
| `minimum`、`maximum`、`step` | 有依据的数字限制，可省略；`step` 必须为正 |
| `default` | 只有存在已确认默认值时才返回；省略不等于零或 false |
| `unit` | 例如 `seconds`、`pixels`，没有单位时省略 |
| `source` | `profile-config`、`adapter`、`platform-policy`、`provider` |
| `confidence` | `verified`、`declared`、`unknown` |
| `observedAt` | 证据时间；没有则为 `null` |

关键规则：

- 配置声明的建议选项不自动变成硬限制。当前模型驱动的 V3 规格允许一些超出旧预设列表的值，不能因设置页面改造把这些能力锁死。
- `valuesMode: suggested` 时，客户端可以给出建议选项，同时允许输入满足基础类型和已知硬限制的其他值；生成是否支持仍由现有校验和上游响应确认。
- `valuesMode: allowed` 只用于有明确约束依据的有限选项，例如当前下载适配器只支持 `video/mp4`；不能因为后台填了几个示例，就声称上游只支持这些值。
- `confidence: verified` 仅表示相应证据经过验证，不表示所有组合、所有时间都能执行成功。
- 参数范围未知时明确展示“范围暂未确认”，不得补一个猜测的最大值或默认值。
- `support: unsupported` 的字段不允许编辑或进入生成请求；例如当前视频适配器不能选择帧率。
- `support: unknown` 不等于适配器可以转发任意新字段。客户端仅使用已经纳入共享 schema 且适配器实际映射的参数。
- 明确的参数 `false` 必须保留，不能因真假判断而当作未填写。
- 不再维护一份独立 `capabilityHints` 数据；相关信息迁移至 `parameters`，调用它的客户端、工具、共享 schema、测试和样例同时更新。

第一批参数覆盖：

| 类型 | 参数 |
| --- | --- |
| 图片 | `size`、`width`、`height`、`aspectRatio`、`count`、`quality` |
| 视频 | `durationSeconds`、`resolution`、`width`、`height`、`aspectRatio`、`audio`、`outputFormat`；`frameRate` 明确标记当前不可选 |

`creativeBrief`、参考素材 ID、任务 ID 等已有请求字段继续按原接口使用，不混入模型规格参数。

### 4.4 参数组合和参考图规则

组合规则使用有限、可校验的 JSON 结构，不下发 JavaScript 表达式，不新增表达式执行引擎。

支持以下规则即可覆盖首批需求：

1. `requiredTogether`：例如填写 `width` 时必须同时填写 `height`。
2. `requireAny`：例如提供 `resolution`，或者同时提供 `width` 和 `height`。
3. `whenAllowed`：当某字段等于指定值时，另一字段仅允许某些值。只有存在真实依据时才返回这种规则。

规则统一带 `operations`、稳定 `code` 和中文 `message`。规则中的字段必须存在于参数定义中；无法表达的已知冲突继续由现有后端规格校验处理，不能声称空 `constraints` 代表任意组合都支持。

例如：

```json
{
  "type": "requireAny",
  "operations": ["text-to-video", "image-to-video"],
  "alternatives": [["resolution"], ["width", "height"]],
  "code": "VIDEO_DIMENSIONS_REQUIRED",
  "message": "请选择分辨率，或同时填写宽度和高度"
}
```

参考图片继续保留现有 `adapter.referenceSupport` 作为总体上限；新增 `referenceRules` 表达分操作的精确要求，两个字段由同一份有效规则生成，不手工维护两套数字。

```json
[
  { "operation": "text-to-video", "minCount": 0, "maxCount": 0, "maxInputBytes": 0, "mimeTypes": [] },
  { "operation": "image-to-video", "minCount": 1, "maxCount": 1, "maxInputBytes": 10485760, "mimeTypes": ["image/png"] }
]
```

大小字段明确表示单张输入上限。客户端检查是用户体验措施，后台上传和生成阶段必须继续校验。

### 4.5 成功响应示例

下面用于说明完整外层结构和一个视频配置。模型 ID 和配置内容是示例，`durationSeconds` 的 4、8 是建议值，不是声称当前模型只支持这两个时长。员工对象仅列出本方案相关字段，既有其他字段照常返回。

```json
{
  "manifestVersion": 1,
  "fetchedAt": "2026-11-13T06:00:00.000Z",
  "subscriptionId": "subscription_example",
  "templateVersion": "1",
  "employee": {
    "id": "employee_example",
    "name": "示例员工",
    "version": "1",
    "maxSteps": 100
  },
  "runtime": {
    "systemPrompt": "员工系统提示词",
    "modelId": "chat_model_example",
    "allowedModels": ["chat_model_example"],
    "config": null,
    "skills": [],
    "media": {
      "protocolVersion": 3,
      "executionMode": "real",
      "status": "empty",
      "executionAvailable": false,
      "defaultProfileId": null,
      "tools": [],
      "profiles": []
    },
    "video": {
      "protocolVersion": 3,
      "executionMode": "real",
      "status": "ready",
      "executionAvailable": true,
      "defaultProfileId": "video_example",
      "tools": ["video_generate", "video_from_image", "video_get_job"],
      "profiles": [{
        "profileId": "video_example",
        "configVersion": "1",
        "modelId": "video_model_example",
        "modelDisplayName": "video_model_example",
        "kind": "video",
        "displayName": "企业视频生成配置",
        "operations": ["text-to-video", "image-to-video"],
        "executionMode": "async-query",
        "authorized": true,
        "adapter": {
          "id": "sub2api-video",
          "version": "3",
          "available": true,
          "operations": ["text-to-video", "image-to-video"],
          "referenceSupport": {
            "maxCount": 1,
            "maxInputBytes": 10485760,
            "mimeTypes": ["image/png"]
          },
          "supportsTaskQuery": true,
          "supportsCancel": false
        },
        "parameters": {
          "durationSeconds": {
            "label": "视频时长",
            "type": "integer",
            "support": "supported",
            "required": true,
            "operations": ["text-to-video", "image-to-video"],
            "valuesMode": "suggested",
            "values": [4, 8],
            "minimum": 1,
            "unit": "seconds",
            "source": "profile-config",
            "confidence": "declared",
            "observedAt": null
          },
          "resolution": {
            "label": "分辨率",
            "type": "string",
            "support": "supported",
            "required": false,
            "operations": ["text-to-video", "image-to-video"],
            "valuesMode": "unknown",
            "source": "adapter",
            "confidence": "unknown",
            "observedAt": null
          },
          "width": {
            "label": "宽度",
            "type": "integer",
            "support": "supported",
            "required": false,
            "operations": ["text-to-video", "image-to-video"],
            "valuesMode": "unknown",
            "minimum": 1,
            "unit": "pixels",
            "source": "adapter",
            "confidence": "unknown",
            "observedAt": null
          },
          "height": {
            "label": "高度",
            "type": "integer",
            "support": "supported",
            "required": false,
            "operations": ["text-to-video", "image-to-video"],
            "valuesMode": "unknown",
            "minimum": 1,
            "unit": "pixels",
            "source": "adapter",
            "confidence": "unknown",
            "observedAt": null
          },
          "outputFormat": {
            "label": "输出格式",
            "type": "string",
            "support": "supported",
            "required": false,
            "operations": ["text-to-video", "image-to-video"],
            "valuesMode": "allowed",
            "values": ["video/mp4"],
            "source": "adapter",
            "confidence": "verified",
            "observedAt": null
          }
        },
        "constraints": [{
          "type": "requireAny",
          "operations": ["text-to-video", "image-to-video"],
          "alternatives": [["resolution"], ["width", "height"]],
          "code": "VIDEO_DIMENSIONS_REQUIRED",
          "message": "请选择分辨率，或同时填写宽度和高度"
        }, {
          "type": "requiredTogether",
          "operations": ["text-to-video", "image-to-video"],
          "fields": ["width", "height"],
          "code": "DIMENSIONS_PAIR_REQUIRED",
          "message": "宽度和高度必须同时填写"
        }],
        "referenceRules": [
          { "operation": "text-to-video", "minCount": 0, "maxCount": 0, "maxInputBytes": 0, "mimeTypes": [] },
          { "operation": "image-to-video", "minCount": 1, "maxCount": 1, "maxInputBytes": 10485760, "mimeTypes": ["image/png"] }
        ],
        "unavailableReason": null,
        "unavailableMessage": null
      }]
    }
  }
}
```

实际返回还应根据配置补齐其他已映射参数。`runtime.modelId` 仍是员工聊天模型；图片、视频模型分别看对应 profile 的 `modelId`，不要混淆。

## 5. 有效能力的来源与边界

复用现有企业授权、平台 profile 和适配器规则。最终展示的硬限制由明确的平台策略、当前适配器硬限制及有证据的上游约束共同确定；不把未知范围当作无限支持。

当前需要按实际实现处理的事项：

| 项目 | 本次设计要求 |
| --- | --- |
| 图片输出数量 | 当前适配器最多 4 个输出，设置页面不能仅因 profile 写了 8 就允许 8 |
| 图片参考图 | 当前 V3 声明支持时最多 4 张、单张 5 MiB、PNG；核对上传和执行限制后统一生成规则 |
| 视频参考图 | 当前图生视频只支持单张、10 MiB、PNG；不能把本次信息展示改造宣传为多图视频支持 |
| 视频输出格式 | 当前下载适配器仅实现 MP4，不能因 profile 存了 WebM 就开放 WebM 选择 |
| 视频帧率 | 当前不会作为可控参数传给上游，不开放可编辑帧率选项 |
| 图片质量、尺寸、视频时长和分辨率 | 尽量复用模型声明；区分建议与真实硬限制，不恢复旧版写死的模型白名单 |

设置页面与生成校验应复用相同的有效规则整理函数。先整理当前真实规则，再输出参数元数据，不额外造一套只对展示生效的限制。

`configVersion` 仍沿用现有值。企业授权撤销、全局执行开关、连接状态可能独立变化，因此不能仅靠这个版本判断请求是否仍然被允许。本次每次生成仍执行既有授权、适配器校验和报价检查。

## 6. 请求失败返回什么

### 6.1 详细错误直接传给客户端

错误处理层保留错误来源的 HTTP 状态和完整响应内容，包括原始 `message`、`code`、`errors`、嵌套 `error` 及其他已有诊断字段。平台不再二次概括、翻译或替换消息，不重新映射错误码，不通过固定字段列表删掉错误明细。

来源有 `retryable`、`retryAfterSeconds` 等字段时一并保留；来源没有的字段不强行补值，也不为了统一格式编造错误码。必要时可以补充现有 `requestId`、`timestamp`、`path` 等定位信息，但不能覆盖原错误内容。

以现有查询校验器生成的未知字段错误为例，客户端应能收到具体字段和原始提示：

```json
{
  "statusCode": 400,
  "message": "请求参数校验失败",
  "errors": [{
    "field": "enterpriseId",
    "message": "不支持的请求字段"
  }],
  "requestId": "runtime-request-example",
  "timestamp": "2026-11-13T06:00:00.000Z",
  "path": "/api/client/subscriptions/subscription_example/runtime?enterpriseId=enterprise_example"
}
```

示例说明错误明细保留后的效果，不代表当前全局过滤器已完整透传这些字段。来源没有业务错误码，因此示例没有额外添加 `code`。

传递规则：

- `message` 是来源给出的错误消息；无论是字符串还是消息数组，都保留原内容。
- `errors` 保留来源提供的每条校验明细及其已有字段，不只留下“校验失败”一句话。
- `code` 和嵌套 `error` 如有则完整保留，不改名、不重新分配业务分类。
- `requestId` 对应响应头 `X-Request-Id`，用于定位日志；补充定位信息不能替代详细错误。
- 客户端网络层、设置页面和工具同样保留收到的原错误，不能再次统一替换为“请求失败”。
- 认证凭据不作为业务错误内容生成；详细透传不要求把登录凭证或 API key 加入响应。

### 6.2 沿用错误来源的状态和内容

不再维护一张把来源错误重新映射成新错误码和新提示的转换表。以下仅说明已有错误如何传递，不定义另一层错误分类：

| 错误来源 | 返回原则 |
| --- | --- |
| 查询参数校验失败 | 保留原 400、原消息及全部字段明细 |
| 登录或会话检查失败 | 保留认证模块的原状态、消息和已有字段 |
| 企业冻结 | 保留原 401、`ENTERPRISE_SUSPENDED` 和完整冻结说明 |
| 用户无企业身份 | 保留现有企业检查产生的 403 和原消息 |
| 订阅查询没有符合访问条件的结果 | 沿用原有 404 和 `Runtime unavailable`，不另加错误码或改写提示 |
| 限流 | 保留来源状态、响应体、已有等待字段和 `Retry-After` 响应头 |
| 企业上下文读取失败 | 保留当前来源产生的 503 和“企业访问状态暂不可用” |
| 其他读取、配置解析或程序异常 | 保留来源提供的异常描述和结构化诊断信息；非 HTTP 异常沿用 500，不额外转换为某个业务错误码 |

JWT guard、查询 pipe、service 和配置读取层都适用上述原则。错误出现在哪一层，不应决定客户端能否看到其详细内容。

任一必需配置读取失败，整个请求按来源错误返回，不能吞成空列表或成功响应。订阅访问仍复用现有企业、有效期、成员或部门授权查询，不新增跨企业存在性查询。

### 6.3 请求成功，但配置不可用

以下情况不是整个接口请求失败，HTTP 返回 200：

- 企业没有授权图片或视频配置：对应区块 `status: empty`、`profiles: []`、`executionAvailable: false`。
- 已授权配置被停用或未验证：仍可展示名称，但不能选择生成。
- 生成执行开关关闭、已知连接尚未配置、适配器不支持该执行方式：返回相应不可用原因。

不可用配置示例片段：

```json
{
  "profileId": "video_example",
  "authorized": true,
  "unavailableReason": "CONNECTION_UNAVAILABLE",
  "unavailableMessage": "视频服务连接尚未就绪，请联系管理员",
  "adapter": { "available": false }
}
```

上面只展示有关字段，实际 profile 仍遵守完整响应 schema。

| 原因码 | 用户提示 |
| --- | --- |
| `PROFILE_DISABLED` | 该配置已停用 |
| `PROFILE_UNVERIFIED` | 该配置尚未通过验证 |
| `EXECUTION_DISABLED` | 平台暂未开启此类生成服务 |
| `CONNECTION_UNAVAILABLE` | 生成服务连接尚未就绪，请联系管理员 |
| `ADAPTER_PROTOCOL_UNSUPPORTED` | 当前适配器不支持该执行方式 |
| `ADAPTER_OPERATION_UNSUPPORTED` | 当前适配器不支持该操作 |

这里的“连接就绪”来自本地配置检查，不代表已探测上游实时在线。查询过程中不发送生成请求来验证可用性；真正的上游故障仍可能在报价或执行时返回。

### 6.4 客户端没有收到平台响应

断网、超时、DNS 错误时可能根本没有平台响应，客户端需单独展示本地连接错误。这种情况不属于改写平台错误，不能伪造平台业务错误码。

如果反向代理直接返回 HTML 502/504，客户端应保留实际状态和可读取的响应内容，以文本方式查看详情，不能丢弃后伪装成平台返回的另一种错误。取消请求不显示成服务器失败。

## 7. 客户端交互和缓存

1. 客户端获得登录身份和有效订阅 ID 后主动请求 runtime；启动时可以由客户端主动发起一次。
2. 设置页面和现有工具共享同一份成功响应，避免分别维护模型清单和限制。
3. 设置页面展示模型名称、配置名称、操作、参数、参考图限制及不可用原因。存在同模型多配置时，不按 `modelId` 去重丢失配置。
4. 用户选择模型后，以 `profileId` 保存选择；生成请求中的参数继续使用现有 `requestedSpec` 字段名。
5. `allowed` 用固定选项控件；`suggested` 可提供建议并允许合规输入；`unknown` 明确说明未知；不支持的参数不可编辑。
6. 只有用户点击刷新、明确切换员工或其他客户端主动动作才重新请求。不因重新打开设置页面而默认重复刷新；首次没有数据时可以主动请求。
7. 若使用 TanStack Query，关闭定时、窗口聚焦、重连和挂载自动刷新，并关闭此配置请求的通用自动重试；使用显式请求或 `refetch`，防止默认行为违背要求。
8. 请求期间显示加载状态。首次失败显示来源错误的详细消息、字段明细和重试入口，不二次概括或替换错误，不能伪装成“没有模型”。
9. 已有成功数据时刷新失败，保留并标记“上次获取的配置，刷新失败”，显示原 `fetchedAt`；若本次失败属于权限撤销、企业冻结、订阅失效或退出登录，则禁用并清理相应缓存。
10. 缓存至少按登录用户、企业和订阅隔离；如当前登录响应尚无企业 ID，使用现有会话标识与用户、订阅隔离，且退出或企业身份变化时清空。不能跨用户或跨企业复用旧配置。
11. 切换员工后，先取消或丢弃旧请求结果，避免旧响应覆盖新员工页面。新请求失败时，不展示上一员工的配置作为当前结果。
12. 平台配置变化不自动刷新客户端。真正生成时服务端依然检查最新权限和参数；失败后提示用户主动刷新，不自动改参数、重新报价或重复提交生成。

不在客户端计算出一个固定费用当作最终扣费金额。本接口不返回一次生成的承诺报价，费用继续由原报价、预占、结算流程处理。

## 8. 平台开发步骤和修改范围

### 第一步：先固定共享契约

- 修改 `backend/src/shared/media-spec.dto.ts`，定义扩展 profile、参数、组合规则、参考图规则和区块状态。
- 根据文件大小和现有导出方式，必要时新增小范围共享 DTO 文件，并从 `shared` 统一导出；不引入新的架构层或依赖。
- 修改 `backend/src/shared/media.dto.ts` 中 runtime 查询规则：两个媒体版本默认 3，仅接受 3；其他协议独立。
- 配置响应 schema 应能检查参数类型、默认值、范围和跨字段引用是否一致；不新增 runtime 路径参数 schema，不定义丢弃来源字段的封闭错误结构。
- 更新共享测试与 fixtures，删除本次格式中对 `capabilityHints` 的依赖。

### 第二步：整理有效能力并构建响应

- 修改图片、视频配置服务，复用现有企业授权、profile 查询和适配器能力。
- 在现有媒体模块内抽出有实际复用需要的纯函数，整理有效参数与参考图规则；展示和已有校验使用一致的硬限制。
- 补充 profile 中的模型信息，不新增一套模型表。
- 生成默认项、可用状态、工具列表和用户提示；明确区分已知配置未就绪与数据库读取失败。
- 整理前先读取所需配置，避免同一响应内部重复读取产生不必要的不一致；本次不承诺跨请求或长时间运行的配置快照。
- `configVersion` 变化时沿用现有机制；若参数规则实际改变却不更新版本，实施时需要修正对应更新路径。授权和连接变化仍需实时检查，不能只靠 profile 版本。

### 第三步：接入原 runtime 路由

- controller 仅负责 HTTP、Swagger、查询参数校验和调用 service；订阅 ID 沿用现有读取方式。
- `ClientService.getRuntime` 保持先鉴权后查询，成功时始终返回图片、视频两个区块和 `fetchedAt`。
- 继续使用原有订阅访问检查和异常，不为本次功能再重新定义错误码、替换来源消息或改变来源 HTTP 状态。
- 保留参数校验、配置解析和服务异常的详细消息及诊断字段；服务中不得把异常吞成空配置或通用成功结果。

### 第四步：保留详细错误输出

- 调整本接口经过 `HttpExceptionFilter` 的输出路径，让来源响应字段完整到达客户端；不新增错误码映射、消息替换或字段裁剪。
- 保留原始 `message`、`code`、`errors`、嵌套 `error` 和来源已有的其他诊断字段；没有的字段不编造。
- 覆盖 guard、pipe、service 阶段的错误，尤其是服务逻辑之前发生的认证和限流错误，确认这些阶段的详情不会丢失。
- 保留 `ENTERPRISE_SUSPENDED` 及原说明，客户端按来源信息处理，不能因二次包装而反复恢复登录。
- 其他普通业务接口、gateway、技能下载和技能导入保留各自既有错误结构；用回归测试保护。

### 第五步：更新共享消费者和客户端

- 检索所有 V3 profile、`capabilityHints` 和 runtime builder 消费者，包括 gateway 配置查询、预览、测试及样例；共享严格 schema 更新后一起调整，避免只修改一个 controller。
- 客户端更新响应解析、设置页面、参数保存、参考素材提示和错误展示；网络层、页面和工具都保留平台返回的详细错误，不再次替换或归类。
- `media_get_capabilities`、`video_get_job({})` 从同一份新配置读取信息，不再维护独立的旧参数提示。
- 客户端代码若在另一仓库，单独提供契约文档及样例进行联调；不能仅修改 SEP 后就声称客户端功能已完成。
- 本项目 Web 后台优先复用已有配置；本次不新增参数编辑器。现有数据没有的可靠信息标记未知，不能为填满 UI 而猜测。

### 第六步：验证与上线

- 先完成下节对应测试，再执行后端 typecheck 和 build。
- 客户端完成实际设置页面操作和桌面窗口尺寸验证，确认参数不会被截断、不可用项不能生成、刷新动作符合约定。
- 开发阶段统一更新平台和客户端，使用同一契约联调，不保留旧格式响应分支。部署应在明确要求时执行。
- 预计不需要新增数据库表或迁移；若实施中发现现有配置无法承载必要的明确策略，应先说明具体缺口，不顺带扩展数据库或后台功能。

## 9. 测试与验收

### 9.1 契约与权限

- 不传媒体版本默认返回两个扩展后的 V3 区块；显式 3 结果等价；1、2、4、数组、重复参数和未知字段返回 400。
- 订阅 ID 沿用现有读取和访问检查，不新增格式校验或对应格式错误分支；登录失败保留认证模块原始响应。
- 只有当前用户所属企业授权的配置被返回；跨企业访问、订阅到期、成员或部门授权过期统一 404。
- 无企业身份 403、企业冻结 401 且保留对应业务码；未通过权限检查前不返回模型或技能信息。
- 无模型是 200 空状态，配置读取失败按来源错误返回，不混淆，不额外把所有读取异常统一改成 503。

### 9.2 能力与参数

- 保留企业授权但暂不可用的配置及原因；默认配置不可执行时为 null。
- 图片输出最多 4，参考图规则与执行链一致；视频单参考图、MP4、不可选帧率符合实际实现。
- 建议选项不变成硬枚举；仍允许既有 V3 合法的扩展规格进入原报价与执行判断。
- 不编造默认值；保留 audio false；不同操作的参考素材要求正确。
- 参数类型、默认值、选项、数值范围、组合规则引用一致；非法配置返回服务端错误。
- 配置查询不触发报价、生成、余额预占、账务写入或远程能力发现。

### 9.3 错误与回归

- 使用带完整 guard、pipe、全局 filter 的 HTTP 测试逐字段比较错误来源与实际响应，确认消息、业务码、校验明细、嵌套错误和来源其他诊断字段没有丢失、改写或重新分类。
- 验证来源没有业务码或重试字段时不额外编造；检查 `requestId` 与响应头一致，限流原有等待字段和响应头被保留。
- 验证配置解析和非 HTTP 异常的详细描述可到达客户端，不被统一替换为通用提示；错误内容不生成认证凭据。
- 本次错误透传调整不影响 gateway 和其他业务接口的现有返回结构。
- 检查图片、视频 V3 gateway 配置查询和企业预览等共享 builder 消费者。
- 现有聊天、技能运行配置及生成、报价、结算测试保持通过；不实际连接收费上游执行测试。

### 9.4 客户端场景

- 首次加载、空状态、部分 profile 不可用、整个请求失败有不同展示。
- 首次失败不展示空模型列表；刷新失败可看到上次成功时间；权限类失败清空或禁用缓存。
- 校验错误能看到具体字段和原说明，其他平台错误能查看完整详情；客户端网络层、页面和工具不再二次改写。
- 后台改配置后页面不自动变化；用户主动刷新后才更新。
- 切换员工、退出登录、企业身份变化和并发请求不会造成配置串用。
- 设置页面和模型工具读到同一份 profile、参数和参考图规则。
- 旧配置生成失败时不自动重试生成、不自动替换参数、不自动扣第二次费用。

实施后建议执行的基础命令：

```powershell
pnpm --dir backend exec jest --runInBand client.service.spec.ts media-spec.dto.spec.ts http-exception.filter.spec.ts
pnpm --dir backend typecheck
pnpm --dir backend build
```

上面是基础验证入口，不是完整测试清单。实际验证记录见接入说明；桌面客户端仍需在其实际仓库完成适配与检查，不能仅凭 SEP 测试通过宣称端到端完成。

## 10. 交付内容和范围

交付顺序：共享契约与 JSON 样例、平台接口和错误处理、客户端设置与工具适配、联调和测试记录。

完成标准是：客户端主动调用原 runtime 接口后，无需先调用 AI 工具，就能查看企业授权的图片、视频模型与当前可声明的参数限制；发生失败时能够查看来源提供的完整错误信息，不经过二次改写，并可用请求编号定位问题。

本次不包含多图视频能力、新生成协议、新计费方式、固定报价、新后台编辑器、自动推送，以及没有有效员工订阅时独立查看企业模型目录的能力。
