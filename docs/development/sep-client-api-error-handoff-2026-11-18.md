# SEP 客户端接口与错误信息交接清单

日期：2026-11-18。交接对象：桌面客户端开发团队。

## 1. 版本、范围与阅读约定

本文以 SEP 当前本地工作树为准：HEAD `84318868`，包含尚未提交的后端错误透传修改。HEAD 本身不包含本次全部修复，交接实现时应同时取得本次工作树变更。

覆盖客户端专用 API、模型网关、真实图片/视频、客户端复用的业务 API、知识库、Skill connector 和两个 WebSocket；同时列出 mock 和部分配套/停用接口，避免客户端接错入口。平台管理员接口、支付异步回调、算力平台直接接口不属于桌面客户端调用清单。

本文重点是错误接收与展示，表中列出主要输入、响应类型和处理要求；完整字段约束以文末所列共享 DTO 为准。表中举出的错误不是该接口所有可能状态码的穷举。全局认证、限流、参数校验、依赖/数据库异常也可能在业务处理之前返回。

- HTTP 表中的路径全部相对于 `/api`，例如 `/client/profile` 的实际路径是 `/api/client/profile`。若客户端 `SEP_BASE_URL` 已含 `/api`，不要再次拼接。
- `:id` 等表示路径参数；`Q` 表示 query；`B` 表示 JSON body；`F` 表示 multipart 文件。
- `A`：普通 `Authorization: Bearer <accessToken>`。
- `E`：`Authorization: Bearer <employmentToken>`，通过 `/client/auth/token` 换取，与普通 access token 不同。
- `R`：body 内的桌面 refreshToken；登录不需要已有令牌。不要把 refreshToken 放进 URL、错误详情或日志。
- `G`：Skill 导入专用受限 grant，不能用普通 A/E 代替。
- 错误消息字段可能不完整；只保留实际存在的字段。下文示例均为示意数据，不是线上抓包。

**本次后端修复恢复错误信息，不代表图像/视频生成失败的业务原因本身已经消失。客户端应显示失败原因并据状态选择恢复方式。**

## 2. 当前后端错误契约

### 2.1 SEP 本地 HTTP 错误

普通业务错误继续有 HTTP 状态和基础信息，现在保留业务方原有字段，包括嵌套 `error`、校验 `errors`、阶段和恢复建议，不再按固定字段名单删减。

2026-11-19 补充边界：显式 HTTP 业务异常和经适配器处理的传输诊断继续保留安全字段；未处理的程序、数据库异常返回 500、`Internal server error` 和请求编号，具体异常保留在服务端日志。内部 `storageKey/packageKey` 不下发，视频存储故障的原始数据库异常仅作为服务端 cause 保存。知识库本地错误另排除私有文档内容、名称、查询原文、内部主机和企业/成员身份字段，保留错误码、消息和安全恢复信息。这不影响上游业务错误正文、参数原因和恢复建议的透传。

```json
{
  "statusCode": 400,
  "message": "请求参数格式无效",
  "requestId": "sep-request-example",
  "timestamp": "2026-11-18T00:00:00.000Z",
  "path": "/api/gateway/v1/media/real/requests",
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "请求参数格式无效",
    "field": "requestedSpec.count",
    "reason": "Expected number, received string",
    "source": "request",
    "stage": "validation",
    "retryable": false,
    "submissionState": "not_submitted",
    "billingState": "not_reserved"
  },
  "errors": [
    { "field": "requestedSpec.count", "message": "Expected number, received string", "code": "invalid_type" }
  ]
}
```

不是每个接口都有 `error.code`：例如任务同步部分冲突是字符串 `ConflictException`，有真实 message，但没有稳定业务码。客户端不能把没有 code 当成没有原因。

网关 `/gateway/...` 的 SEP 本地错误会补兼容的 `error` envelope；普通业务接口可能只有顶层 `message/code`。保留两种结构。已有诊断 requestId 与 SEP requestId 冲突时，后端可另加 `sepRequestId`，不要互相覆盖。

### 2.2 来自算力平台的 HTTP 错误

常规失败保留收到的 HTTP 状态和脱敏后的原始 body。**不保证有 SEP 标准 envelope，也不保证是 JSON 对象。** 以下格式都要能接收：

```json
{"error":{"code":"bad_size","message":"Unsupported image dimensions","details":{"width":1300}}}
```

```json
{"code":"INVALID_API_KEY","message":"Invalid API key"}
```

```json
{"error":"Image generation rejected"}
```

纯文本错误按 `text/plain` 返回；JSON 数组、数字 code、未知扩展字段也不能在客户端 schema 中被静默删除。原始 JSON 的 `null`、数字、布尔值等不一定有可读 message，保留原值并明确提示“未返回可读原因”，不要编造原因。

特殊情况：

| 情况 | SEP 当前返回 | 客户端处理 |
| --- | --- | --- |
| 算力 HTTP 4xx/5xx | 原状态和脱敏 body | 保存具体原因；不要仅按状态生成通用文案 |
| 算力 HTTP 200 但被识别为业务 error | 外层 HTTP 502，原状态通过诊断保留 | 不能据算力原状态 200 当成生成成功 |
| 错误体读取异常/超限 | 保留已读内容并附 `readError/truncated`；通用 HTTP 路径可包装为 `{body,message,upstreamStatus,...}` | 展开 `body`，同时保留读取失败证据；不要将包装结构误判为“没有原因” |
| 连接失败，没有上游响应 | SEP 本地异常，含实际 message/cause 等可用诊断 | 不把本地 502 当成已收到供应商 HTTP 502 |
| 代理或网络先断开，未收到错误体 | 只能记录收到的状态、头或传输异常 | 明确是信息不完整，不能用猜测填入具体业务原因 |

错误读取有上限；通用上游错误读取默认最多 256 KiB、最多等待 5 秒，并非无限制、逐字节原样返回。

### 2.3 响应头与关联 ID

| Header | 含义/范围 | 客户端要求 |
| --- | --- | --- |
| `X-Request-ID` | SEP 本次 HTTP 请求关联 ID | 所有请求可记录，反馈问题时附带 |
| `X-SEP-Error-Source: upstream` | 该 HTTP 错误经上游异常透传分支返回 | 不将上游鉴权失败直接等同为客户端登录过期 |
| `X-Compute-Status` | SEP 收到的算力 HTTP 状态，可能为 200 | 与客户端收到的外层状态分别保存 |
| `X-Compute-Request-ID` | 算力响应原 `x-request-id` | 不覆盖 SEP `X-Request-ID` |
| `X-Client-Request-ID` | 算力返回的关联 ID，如存在 | 原名保留；不等同媒体 `clientRequestId` |
| `X-Upstream-Request-ID` | 算力透出的更上游请求 ID，如存在 | 与前两类 ID 分开保存 |
| `Retry-After` | 实际收到/平台明确计算出的等待信息 | 秒数或 HTTP 日期均按协议解析；未返回时不宣称服务器要求等 60 秒 |
| `X-Video-Dispatch` | 视频上游派发证据，如存在 | 记录原值；不以此单独推翻 SEP 回执状态/账务结果 |
| `X-Data-Degraded` | 上游降级标记，如存在 | 保留并结合 body 诊断 |
| `X-SEP-Execution-ID` | 聊天网关已创建的执行记录 ID，如存在 | 与会话 ID、任务 ID 分开记录 |
| `X-SHA256`、`Content-Length`、`Content-Type` | 文件交付校验 | 读取、验证完整性后再发布本地成品 |
| `X-SEP-Media-Mock` | 媒体下载是否 mock | 不把测试内容当真实生成结果 |

上述头都是条件存在，不保证每条接口/每种失败都有。WebSocket 不遵循这套 HTTP 关联头。

当前 `backend/src/main.ts` 的 CORS 配置没有显式 `exposedHeaders`。Electron 主进程原生 fetch 可直接读取响应头；浏览器 renderer 若跨域直连，部分自定义头可能对 JS 不可见，需另做 CORS 联调。本文未修改 CORS。

### 2.4 建议客户端内部保留的诊断对象

以下为客户端建议结构，**不是 SEP 新增的统一响应 DTO**，不要求后端把所有接口包装成这样：

```ts
type ApiDiagnostic = {
  operation: string;
  httpStatus?: number;           // 客户端实际收到的状态
  contentType?: string;
  sepRequestId?: string;
  computeRequestId?: string;
  upstreamRequestId?: string;
  source?: string;
  code?: string | number;        // 不能只允许大写字符串
  message?: string;
  field?: string;
  stage?: string;
  retryable?: boolean;
  recovery?: unknown;            // HTTP 错误可能是字符串；媒体回执是对象
  body?: unknown;               // 保留未知字段和原始结构
  headers?: Record<string, string>;
  transportError?: unknown;      // 没收到响应时另存
};
```

可以保留本地分类如 `SERVICE_UNAVAILABLE/MEDIA_FAILED`，但分类应与具体原因同时存在，并一路传到 IPC、工具结果和界面。不要让分类替换 message/body。诊断按文本安全展示，不将 HTML 错误正文作为可执行 HTML 渲染；客户端日志也继续脱敏。

## 3. 客户端专用接口

### 3.1 登录、身份、订阅与运行配置

| 方法 | 路径 | 鉴权、主要输入 | 响应与错误处理要求 |
| --- | --- | --- | --- |
| POST | `/client/auth/login` | 无已有令牌；B `email,password,fingerprint,platform,clientVersion?` | 200 返回桌面 access/refresh 会话信息；400 校验、401 账号/凭证/设备错误、429。保留服务端 message；refreshToken 不进入诊断。桌面 refresh 在 body，不能套用 Web cookie 登录假设 |
| POST | `/client/auth/refresh` | R；B `refreshToken` | 200 刷新普通 access token；401 可为会话、设备、账号问题。保留原因，限制刷新次数 |
| POST | `/client/auth/logout` | R；B `refreshToken` | 成功 204 无 body。不要无条件 `response.json()` |
| POST | `/client/auth/token` | R；B `refreshToken,subscriptionId` | 200 获取 E；400 订阅/配置问题、401 身份或授权、404 订阅不可用。订阅授权问题不能无限循环刷新普通 A |
| GET | `/client/profile` | A | 用户及企业展示资料；无头像/企业可能为正常 null。认证失败保留原原因 |
| GET | `/client/compute-balance` | A | 企业承担额度和个人钱包余额分别返回。余额不足与余额接口读取失败应区分 |
| GET | `/client/subscriptions` | A | 当前成员有授权的有效订阅列表。空列表不是 HTTP 失败 |
| GET | `/client/instances` | A | 控制器保留的旧兼容路径声明；客户端统一使用 `/client/subscriptions`，不新增对旧路径的依赖 |
| GET | `/client/subscriptions/:subscriptionId/runtime` | A；Q `mediaProtocolVersion=3,videoProtocolVersion=3,skillArtifactProtocolVersion=1` | 运行清单、模型策略、技能及媒体配置；400 协商、401 企业/身份、403 企业归属、404 不可用、429/5xx。成功体中的 `unavailableReason/unavailableMessage` 也要显示，不能仅提示“无模型” |
| GET | `/client/platform-employees` | A；Q `keyword,capabilityId,functionalCategory,page,pageSize,sort` | 员工目录分页；`pageSize<=100`。保留校验字段；区分查询失败和正常无结果 |
| POST | `/client/employee-access-requests` | A；必须 `Idempotency-Key`；B `targetType,subscriptionId?或employeeId?,reason,requestedCapabilities?` | 201 申请结果；缺头 400、资源不可用 404/400、重复/幂等冲突 409。重放沿用原幂等键和内容；显示具体冲突原因 |
| GET | `/client/employee-access-requests/:requestId` | A | 本人申请状态；404 表示不存在或无权查看。查询成功不代表申请已批准 |
| GET | `/client/subscriptions/:subscriptionId/skills/:capabilityId/versions/:versionId/artifact` | A；路径来自运行清单 | 200 Markdown/ZIP 字节，无 JSON envelope；400 参数、401/403、404 授权/版本失效、409 `SKILL_ARTIFACT_BLOCKED`、503 存储。失败时读取错误 body 和 `reason`；成功验证 `X-SHA256`、长度，避免安装半成品 |

运行配置中的不可用原因例子：`PROFILE_DISABLED`、`PROFILE_UNVERIFIED`、`EXECUTION_DISABLED`、`CONNECTION_UNAVAILABLE`、`ADAPTER_PROTOCOL_UNSUPPORTED`。这是配置状态，不能全部改写为网络故障。

### 3.2 客户端任务镜像/监控

以下均使用 A。这组是客户端本地任务向 SEP 同步的镜像接口，不是媒体 `/requests`，也不是服务端 `/tasks/:id/run`。

| 方法 | 路径 | 主要输入/输出 | 具体处理要求 |
| --- | --- | --- | --- |
| POST | `/client/tasks` | B `clientTaskId,clientRunId,subscriptionId,title`；可选 `protocolVersion:2,queuedAt,taskType,modelId,clientVersion`；返回镜像 | 同 run 幂等；400 校验、403 归属/授权、409 不可变订阅或同步并发。保留真实 message；不要修改 ID 来掩盖冲突 |
| PATCH | `/client/tasks/:id/status` | B `status,clientRunId?,progress?,currentStep?,activity?,errorSummary?,startedAt?,completedAt?` | 409 可为 `Stale client run` 或终态不可修改；400 可为非终态带完成时间。原原因用于决定停止旧 run 同步或修正载荷 |
| POST | `/client/tasks/:id/heartbeat` | B `clientRunId?,progress?,currentStep?,activity?,clientVersion?` | 409 旧 run 心跳不能写入当前 run；不要持续无界重试同一旧心跳 |
| POST | `/client/tasks/:id/events` | B `sequence,type,clientRunId?,stepKey?,message?,progress?,occurredAt?,participation?` | 相同事件重放返回 `duplicate:true`；同序不同内容 409 `Duplicate event payload differs`；参与归属不可变等冲突保留原文。`message` 每片最多 1000 字符 |
| GET | `/client/tasks` | Q 分页、`scope,subscriptionId,scopeSubscriptionId,userId,statuses,view,taskType,from,to,q,sort` | 无 page/limit 可为数组，否则分页对象；403 可为越权查询；400 日期/过滤错误。不要将形状差异当服务器异常 |
| GET | `/client/tasks/filter-options` | Q 同任务查询 DTO | 与列表一致的权限；返回筛选项和计数。失败保留诊断，不伪装为空选项 |
| GET | `/client/tasks/:id` | 路径镜像 ID | 返回镜像、events、runs 和已验证参与关系；404 `Task not found`。云端查询失败不应直接把本地任务标成执行失败 |

`protocolVersion` 省略与 v2 有兼容差异。状态为 `QUEUED/RUNNING/WAITING_APPROVAL/PAUSED/INTERRUPTED/COMPLETED/FAILED/CANCELLED`。任务业务 `errorSummary` 是被同步任务自己的错误摘要，和本次同步 HTTP 错误分开保存。

## 4. 模型聊天网关

| 方法 | 路径 | 鉴权和输入 | 返回/错误 |
| --- | --- | --- | --- |
| POST | `/gateway/v1/chat/completions` | E；B 按 `ChatCompletionRequestSchema`，主要 `model,messages,stream,tools,tool_choice,max_tokens` 等 | `stream:false` 返回 completion JSON；`stream:true` 返回 SSE。准入前失败和算力 HTTP 失败按第 2 节接收 |

需要同时覆盖以下三个阶段：

1. **SSE 开始之前**：可能收到 JSON 或纯文本 HTTP 错误；先检查状态与 Content-Type，再建立流解析。
2. **SSE 进行中**：检测 `event:error`、`event:response.failed`、`event:response.error`，以及 data 内的错误结构。算力错误事件保留诊断并脱敏；SEP 本地异常在可写时发送 `event:error`。本地帧常为 `data:{"error":{...}}`，不要只认一个固定 code。
3. **SSE 结束/断开**：错误帧、缺少完整结束、读取异常都不能因为外层 HTTP 200、部分文本或后续 `[DONE]` 被改写成成功。连接已断时后端无法保证再送出错误帧，客户端保留已收错误和自己的传输异常。

SEP 本地流错误示意：

```text
event: error
data: {"error":{"code":"UPSTREAM_INCOMPLETE_STREAM","message":"sub2api 流未完整结束","requestId":"sep-request-example","executionId":"execution-example"}}

```

网关常见业务分类包括模型策略/授权/额度/并发/速率、生命周期超时、`UPSTREAM_INCOMPLETE_STREAM`、`UPSTREAM_INVALID_COMPLETION` 等。上游 code 为开放集合；429 可能是并发、额度、余额或其他限制，401/403 也可能来自算力，不可统一要求用户重新登录或盲目重试。

工具调用错误的反馈仍应带具体 message、code、param/field 和诊断；不能仅给模型 `Media tool request failed`，否则模型无法据错误修正参数。本文不要求修改工具的执行参数协议。

## 5. 真实图片：逐接口清单

前缀 `/gateway/v1/media/real`，全部使用 E。runtime 下发 V3 配置；profiles 可传 `protocolVersion=3`。不要把 legacy 的固定规格硬编码成 V3 模型能力。

| 方法 | 路径 | 输入/成功返回 | 错误接收及恢复 |
| --- | --- | --- | --- |
| GET | `/gateway/v1/media/real/profiles` | Q `protocolVersion=3`；当前企业授权 profile | 读取 profile/模型/连接/协议等具体错误；不可用不等同零模型 |
| POST | `/gateway/v1/media/real/references` | F `file`，PNG；返回 `referenceId,expiresAt,mimeType,byteLength,sha256,width,height` | 单文件限制 5 MiB，宽高上限 4096；格式/大小/解析/存储问题保留具体原因。失败不创建生成任务 |
| POST | `/gateway/v1/media/real/quotes` | B 图片报价请求；返回 `quoteId,expiresAt,pricingStatus,amountCny,funding`，V3 另有 `effectiveSpec,billingDimensions,...` | 报价不执行图片生成。合同、价格、参数、模型、连接等错误保留 body。失败不自动改规格或替换模型 |
| POST | `/gateway/v1/media/real/requests` | B 报价请求 + `quoteId,clientRequestId`；返回 200/202 回执 | 原上游 HTTP 错误可直接抛出，原回执仍保存；未知是否提交时按原 `clientRequestId` 找回。不可因网络/502 换 ID 重提 |
| GET | `/gateway/v1/media/real/requests/by-client-id/:requestId` | `requestId` 在这里是客户端业务 `clientRequestId`，不是 HTTP header 的请求 ID；返回原回执 | 用于提交结果不明时找回；404 或查询故障保留原因，不能据一次查询失败断言未提交 |
| GET | `/gateway/v1/media/real/requests/:receiptId` | 返回原回执，可推进对账 | 读取 `status,errorCode,upstreamError,billingStatus,outputErrors,recovery`；HTTP 200 不代表生成正常或账务完成 |
| GET | `/gateway/v1/media/real/requests/:receiptId/outputs/:outputId/content` | 成功 PNG 字节；有类型、长度、SHA256、mock 标记 | 开始前可返回普通/上游错误；410 `RESULT_EXPIRED` 不能改成“生成失败”；下载/校验失败只重取原输出，不自动重生成 |
| POST | `/gateway/v1/media/real/requests/:receiptId/cancel` | B `{}` | 当前真实同步图片不支持取消，409 `CANCEL_UNSUPPORTED`；不能提示“已取消/已退款” |

图片 V3 报价/提交主要字段：`protocolVersion:3,profileId,configVersion,operation,referenceIds,creativeBrief,requestedSpec,parameterSources,specRevision`；提交另加 `clientRequestId,quoteId`。`operation=generate` 不带参考图，`edit` 需要参考图，去重且总数最多 32；还受运行配置与总字节预算限制。`creativeBrief` 1 到 4000 字符。字段类型与业务约束见 `media-real.dto.ts`、`media-spec.dto.ts`。

### 5.1 `MEDIA_FAILED` 的核查结果与客户端修改点

SEP 当前 `backend/web` 中没有生成 `MEDIA_FAILED` 的代码。客户端仍有这些位置：

| 客户端文件 | 当前行为 | 建议优化 |
| --- | --- | --- |
| `electron/service/media-service.ts:144` 的 `publicJobError()` | 未列入少量已知业务码的错误返回 `MEDIA_FAILED` | 可保留此本地分类，同时保留独立 `upstreamError` 和具体显示 message；不要依赖此字段承载全部原因 |
| `electron/service/media-service.ts:460` 附近的 submit catch | 提交异常先显示“提交结果尚未确认”，进入找回/跟踪 | 保存本次 HTTP 原始诊断；“未知是否提交”作为状态，原失败原因作为诊断，两者同时保留 |
| `electron/service/media-service.ts:513` 附近的 `acceptReceipt()` | 已接收 `upstreamError/errorCode/outputErrors/recovery` | 后续 view、持久化、IPC、工具输出继续带出；不要只保留 errorCode |
| `src/shared/media-upstream-error.ts` | 当前 schema 对 error body 主要允许 `message/code/type/error`，使用 `.strip()` | 接收递归 JSON 和可选 headers，保留 details、原因链、数字 code、扩展字段和 `sepDiagnostics`；与 SEP DTO 对齐 |
| `src/shared/media-feedback.ts:59` 附近的 `mediaIssueMessage()` | `SUBMISSION_UNKNOWN` 在读取 upstreamMessage 前直接返回固定文案 | 显示“提交结果未确认”时同时提供已有具体原因；保留禁止重复提交提示 |
| `electron/errors/media-tool-error.ts:53` 的 `mediaToolFailureFrom()` | 部分已知异常按本地 message/固定字段输出；未知异常兜底 `MEDIA_FAILED` | 对实际收到的安全错误保留具体 message 和诊断；兜底仅用于确实没有可读原因的情况 |

行号可能随客户端后续变更移动，以函数名为准。这些是本次只读核查，不表示已经修改客户端。

## 6. 真实视频：逐接口清单

前缀 `/gateway/v1/media/video-real`，全部使用 E。与图片共用错误保留原则，但执行、下载、规格和账务结果单独判定。

| 方法 | 路径 | 输入/成功返回 | 错误接收及恢复 |
| --- | --- | --- | --- |
| GET | `/gateway/v1/media/video-real/profiles` | Q `protocolVersion=3`；企业授权视频 profile | 配置、协议、连接、授权错误保留具体原因 |
| POST | `/gateway/v1/media/video-real/references` | F `file`，校验后的 PNG；返回参考图元数据 | 保存输入校验/存储错误；参考图过期不应归为模型执行错误 |
| POST | `/gateway/v1/media/video-real/quotes` | B 视频请求；返回冻结的 `quoteId,expiresAt,amountCny,amountUsd,pricingVersion,funding` 等 | 可有 V3 `effectiveSpec,billingDimensions`；报价失败不表示已创建视频任务 |
| POST | `/gateway/v1/media/video-real/requests` | B 请求 + `quoteId,clientRequestId`；处理中 202，其他回执 200 | 创建/报价保护/派发/网络错误保留；不明结果查原 ID，不能因超时自动创建第二笔 |
| GET | `/gateway/v1/media/video-real/requests/by-client-id/:requestId` | 按客户端业务 ID 找回回执 | 非新的生成请求；查询失败与原任务失败分开呈现 |
| GET | `/gateway/v1/media/video-real/requests/:receiptId` | 查询原任务，可触发结果校验、缓存和对账 | 同时看任务状态与 `upstreamError`；失败任务可 HTTP 200，查询故障可保留原 RUNNING 状态并附诊断 |
| GET | `/gateway/v1/media/video-real/requests/:receiptId/outputs/:outputId/content` | 已验证输出字节，长度、类型、SHA256、mock 标记 | 响应开始前按错误体处理；开始后 pipeline 异常可能只能断流。未完整收取/校验通过不发布成品，重试原下载 |
| POST | `/gateway/v1/media/video-real/requests/:receiptId/cancel` | B `{}` | 当前真实视频取消不支持，409 `CANCEL_UNSUPPORTED`；不得显示已退款 |

视频 V3 主要请求字段与图片同名，但 `operation=text-to-video/image-to-video`，`requestedSpec` 是视频规格。图生视频至少一张参考图，文生视频不带参考图，不允许重复。实际模型/时长/分辨率等来自运行配置和本次协商结果，不沿用旧协议固定枚举。

### 6.1 图片、视频回执的公共判读

| 字段 | 语义 | 客户端要求 |
| --- | --- | --- |
| `receiptId` | SEP 媒体回执 ID | 与算力 taskId、HTTP requestId、clientRequestId 分别记录 |
| `status` | 生成/交付状态 | 与 HTTP 请求状态、账务状态分别判断 |
| `errorCode` | SEP 回执业务分类，可 null | 不是全部具体原因；不覆盖算力原 code |
| `upstreamError.status` | 保存的错误状态证据 | 可能来自算力，也可能是 SEP 本地错误投影；不能只看字段名认定来自供应商 |
| `upstreamError.body` | 任意 JSON 值或文本，已脱敏 | 原结构保留，不使用窄白名单丢字段 |
| `upstreamError.headers` | 可选诊断头 | 保存但不假设每条回执都有 |
| `upstreamError.body.sepDiagnostics` | 后续查询/退款/对账异常附加诊断，如存在 | 不用后来的账务异常覆盖先前生成失败原因 |
| `billingStatus` | `RESERVED/SETTLED/RELEASED/RECONCILING`，视频还允许 `NOT_RESERVED` | 失败不等于已退款；成功不等于已结算 |
| `outputErrors` | 各输出项的失败分类 | 部分输出失败不能把全部已生成结果当失败或重新生成 |
| `recovery` | `canQuery/canCancel/canDownload` | 控制允许操作；HTTP 错误中的 recovery 可能是另一种字符串建议 |
| `pollAfterMs` | 后续轮询建议，或 null | 结合 recovery 判断；视频终态仍可能需要账务查询 |
| `effectiveSpec/actualSpec` | 协商规格/实际交付规格 | 与错误诊断一起保留；未知规格不能假装匹配 |
| 图片 `acceptance` / 视频 `deliveryStatus` | 规格验收结果 | 区分 `matched/mismatched/unknown`，不只看 status |

回执状态：`SUBMITTING/QUEUED/RUNNING/SUBMISSION_UNKNOWN/SUCCEEDED/PARTIAL_SUCCEEDED/FAILED/CANCELLED/RESULT_EXPIRED`。

示意诊断片段（不是完整可提交的回执）：

```json
{
  "status": "SUBMISSION_UNKNOWN",
  "billingStatus": "RECONCILING",
  "errorCode": "SUBMISSION_UNKNOWN",
  "upstreamError": {
    "status": 403,
    "body": {"error":{"code":"permission_error","message":"Image edit denied"}}
  },
  "recovery": {"canQuery":true,"canCancel":false,"canDownload":false}
}
```

正确展示包括两层：“提交结果尚未确认，请查询原任务”；“收到的错误原因：Image edit denied”。客户端不能仅据错误 HTTP 403 将原账务标为已释放，也不能自动重新生成。

## 7. 客户端复用的普通业务接口

以下均为 A，公开图片读取除外；部分需要企业管理员/特定角色。错误按第 2 节保留，下面注明每条接口的专项处理。

| 方法 | 路径 | 用途/主要输入输出 | 客户端处理重点 |
| --- | --- | --- | --- |
| GET | `/models/enabled` | 可选启用模型列表 | 正常列表、倍率未知/降级与列表请求失败分开；保留倍率诊断字段（若返回） |
| GET | `/enterprise/organization` | 本企业组织、成员、数字员工及授权 | 企业冻结/归属/查询失败保留原因，不统一清登录 |
| GET | `/enterprise/overview` | 企业员工目录与统计 | 查询失败不能伪装为没有员工 |
| GET | `/enterprise/employee-status` | 员工实时状态快照 | 可作 WS 的补查；保留请求错误，不清空现有状态冒充下线 |
| GET | `/enterprise/employees/:employeeId/skills` | 员工技能与当前版本 | 员工无授权与列表为空区分 |
| GET | `/enterprise/skill-versions` | Q `status,capabilityId`；企业可见版本 | 保留参数、权限、查询错误 |
| POST | `/enterprise/skill-versions` | B `SubmitPersonalSkillVersionDtoSchema`；提交完整个人 SKILL.md 及审核 | 保留字段/状态冲突原因；重复提交不静默新建另一份 |
| GET | `/enterprise/skill-versions/:id/preview` | 技能正文预览 | 有权预览不等于有权安装/执行；404/权限错误保留 |
| GET | `/enterprise/skill-version-reviews` | Q `PersonalSkillReviewQuerySchema`；管理员审核列表 | 管理权限不足不能显示为暂无待审 |
| POST | `/enterprise/skill-versions/:id/review` | B `ReviewSkillVersionDtoSchema`；审核 | 保留审核状态冲突/校验原因，刷新原记录后再操作 |
| POST | `/users/me/avatar` | F `file`；头像上传 | 文件类型、大小、存储失败保留原 message |
| GET | `/users/avatars/:filename` | 公开头像字节，无 A | 图片加载失败与 API JSON 错误分开记录 |
| POST | `/enterprise/logo` | F `file`；仅企业管理员 | 权限、类型/大小、存储错误区分 |
| GET | `/enterprise/logos/:filename` | 公开企业图片字节，无 A | 不能按普通 JSON 响应解析 |
| GET | `/personal-wallet` | 个人钱包余额 | 读取失败不是余额为零 |
| GET | `/personal-wallet/transactions` | Q `TransactionQueryDtoSchema`；流水 | 保留分页/范围/存储错误 |
| POST | `/personal-wallet/recharge` | B `PersonalRechargeCreateDtoSchema`；充值订单及支付信息 | 金额、账号、支付创建故障保留；不属于模型/算力生成错误 |
| GET | `/personal-wallet/recharge/:orderNo` | 本人订单状态 | 查询成功但待支付不是接口错误；跨用户/不存在保留原错误 |
| POST | `/personal-wallet/recharge/:orderNo/reconcile` | 主动查询原订单账务 | 对账失败不代表支付失败，不新建充值来重试 |
| GET | `/compute-credit/my-allowance` | 本人本周期额度 | 额度不足与查询不可用区分 |
| GET | `/compute-credit/usage-records` | Q 日期、分页、范围等；账单 | 保留日期/权限/依赖错误 |
| GET | `/compute-credit/usage-breakdown` | Q 统计范围；用量分析 | 失败不能显示为零用量 |
| GET | `/notifications` | 通知分页/筛选 | 查询失败不丢已有通知 |
| GET | `/notifications/unread-count` | 未读数及范围筛选 | 读取失败不写回 0 |
| POST | `/notifications/:id/read` | 标记单条已读 | 失败保留原因；乐观更新需恢复/重新查询 |
| POST | `/notifications/read-all` | 标记范围内全部已读 | 失败不宣称已读成功 |
| DELETE | `/notifications/clear-read` | 清理范围内已读通知 | 失败不永久清空本地列表 |
| DELETE | `/notifications/:id` | 删除单条通知 | 保留权限/不存在/存储错误 |
| POST | `/upload/file` | F `file`；单附件 | 读取失败错误体，不只报“上传失败” |
| POST | `/upload/files` | F 多文件；批量附件 | 保留接口返回的整体/逐项结果和错误；不因一项失败隐藏其他结果 |
| POST | `/upload/refresh-url` | Q `key`；为原对象续签 URL | 失败可能是归属/存储问题，不一定是链接过期；签名 URL 不进入公开诊断 |
| GET | `/uploads/*` | API 返回的本地附件资源路径 | 成功为文件，可能是公开/代理资源路径；不要强套 A/JSON；开始前解析错误，开始后检测断流 |

下载路径可能由后端返回为完整对象存储 URL，不限于 `/uploads/*`。客户端按批准资源下载规则访问，不能把任何错误正文中的 URL 当成可自动访问的资源。

## 8. 知识库逐接口清单

全部使用 A，经 KnowledgeAuthGuard。这里的权限以真实企业成员授权为准。现用成员检索 DTO 是 `KnowledgeMemberSearchDtoSchema`，不是旧的 `subscriptionId + strategy` 检索 DTO。

| 方法 | 路径 | 主要输入/响应 | 错误与业务状态处理 |
| --- | --- | --- | --- |
| GET | `/knowledge-bases` | Q `page,pageSize,keyword`；列表 | 失败与正常空列表分开 |
| POST | `/knowledge-bases` | B `name,description?`；创建 | 名称 1 到 80 字符、description 最多 1000；保留 errors/field |
| GET | `/knowledge-bases/:kbId` | 基础详情和本人权限 | 404/403 保留原原因；不要推断受保护资源是否存在 |
| PATCH | `/knowledge-bases/:kbId` | B 至少 `name/description` 之一 | 校验/权限/并发原因显示到对应操作 |
| DELETE | `/knowledge-bases/:kbId` | 成功 204 | 无 body 不做 JSON 解析；失败恢复本地状态 |
| POST | `/knowledge-bases/search` | B `query,knowledgeBaseIds?,topK?`；200 检索结果 | `query` 最多 1000 字符，topK 1 到 20，库 ID 去重且最多 100；同时读取 status/degraded/diagnostic |
| GET | `/knowledge-bases/:kbId/sources/:sourceId` | 来源片段/版本/定位 | 404 可表示不可访问、过期或不存在，不统一解释为网络问题 |
| GET | `/knowledge-bases/:kbId/documents` | 文档列表 | 上传受理不代表处理完成；读取逐文档处理状态 |
| GET | `/knowledge-bases/:kbId/documents/:docId` | 文档详情/处理结果 | 保留处理错误字段，而不只看详情查询 200 |
| DELETE | `/knowledge-bases/:kbId/documents/:docId` | 文档删除；客户端发送并发/幂等头 | 失败保留冲突信息，不直接移除确认依据 |
| POST | `/knowledge-bases/:kbId/documents/upload` | F 文件；客户端带 `Idempotency-Key` | 受理后还需解析/向量化；HTTP 成功不等于文档可检索 |
| POST | `/knowledge-bases/:kbId/documents/:docId/versions` | F 新文件；客户端带 `Idempotency-Key/If-Match` | 保留版本冲突与校验原因；新版本处理失败不能伪装为原版本丢失 |
| GET | `/knowledge-bases/:kbId/documents/:docId/versions` | 版本记录 | 显示逐版本状态/错误，保留原查询诊断 |
| GET | `/knowledge-bases/:kbId/documents/:docId/preview` | Q `page,pageSize,versionId?`；分页块 | 翻页固定版本，过期/版本不符保留具体原因 |
| POST | `/knowledge-bases/:kbId/documents/:docId/reprocess` | 客户端带 `Idempotency-Key/If-Match` | 受理、正在处理、失败重试和不可重试原因分开 |
| GET | `/knowledge-bases/:kbId/grants` | Q 分页；授权列表 | 失败不伪装为空授权 |
| POST | `/knowledge-bases/:kbId/grants` | B `memberIds`，1 到 100、去重 | 200 `addedMemberIds/existingMemberIds`；旧 subscription/department 授权载荷已停用，不自动重试旧载荷 |
| DELETE | `/knowledge-bases/:kbId/grants/:memberId` | 成功 204 | 无授权本可幂等；404/403 按服务端原因处理 |
| GET | `/enterprise/members` | Q `view=knowledge-grant,page,pageSize,keyword` | 知识库授权候选成员专用视图，按真实成员 ID 提交 |

文档操作中的 `If-Match` 使用文档版本并发标识，`Idempotency-Key` 使用本次逻辑操作的稳定键；不要拿 HTTP requestId 代替。每个操作允许/要求的头由 `document.controller.ts` 和对应 service 校验，客户端不要丢弃原先的并发控制。

检索 200 响应需要保留：

| 字段 | 意义 |
| --- | --- |
| `status` | `MATCHED/NO_MATCH/NO_ACCESS/NOT_READY`；不是统一的“没有结果” |
| `actualStrategy` | 实际 `HYBRID/LEXICAL` 或 null |
| `degraded/degradationReason` | 是否降级及原因，目前可为 `QUERY_EMBEDDING_UNAVAILABLE` |
| `diagnostic` | 本次新增的可选具体降级原因，任意结构，不应被客户端 schema 删除 |
| `partial` | 是否部分结果 |
| `searchId/results[].sourceId/versionId/location` | 来源追踪，不与 HTTP requestId 混用 |

知识库的保护性 404 可能有意合并“不存在/无访问权限”，客户端沿用这种权限边界，不尝试还原隐藏资源信息。

## 9. Skill 本机导入 connector

以下前缀 `/skill-import/connector`。配对/挑战/签名接口按专用协议校验；后续会话接口使用 G。

| 方法 | 路径 | 输入/授权 | 错误与结果处理 |
| --- | --- | --- | --- |
| POST | `/skill-import/connector/pairings` | B `SkillImportPairingSchema` | 200 配对请求；保留设备/签名/配对状态错误 |
| POST | `/skill-import/connector/challenges` | B `SkillImportChallengeSchema` | 200 挑战；会话证明与离线设备撤销挑战区分 |
| POST | `/skill-import/connector/grants` | B `SkillImportGrantSchema`，签名和 consent | 200 grant 或 202 `pending-web-confirmation`；202 不是错误，不重新配对制造重复会话 |
| GET | `/skill-import/connector/sessions/:id/commands` | G；Q `cursor` | 未确认命令至少一次投递；按协议去重，不把重复命令当请求失败 |
| POST | `/skill-import/connector/sessions/:id/events` | G；B `SkillImportEventSchema` | 200 ack；序号/快照冲突 409 应显示原因并按协议恢复 |
| GET | `/skill-import/connector/sessions/:id/operations/:operationId` | G | 上传操作安全摘要；保留操作状态和失败原因 |
| POST | `/skill-import/connector/sessions/:id/operations/:operationId/upload-grant` | G；B `SkillImportUploadGrantSchema` | ZIP 就绪后绑定摘要并换取短期上传授权；摘要不一致不能无限重试 |
| POST | `/skill-import/connector/sessions/:id/package` | G + 上传专用授权；F ZIP | 校验鉴权/并发槽/文件预算和包内容；保留包校验具体原因 |
| DELETE | `/skill-import/connector/sessions/:id` | G | 取消导入会话；结束状态错误不误报为普通登录过期 |
| POST | `/skill-import/connector/devices/:deviceId/revoke` | B `SkillImportDeviceRevokeSchema`，专用签名 | 无需活动导入会话；保留撤销签名/设备错误 |

这组会返回 400/401/403/409/410/413/429/503 等，并可带 `code,retryable,retryAfterSeconds,Retry-After`。专用 grant 失效不等同普通 A 失效；410 表示导入已结束等终止状态，不继续轮询。保留服务端本来的 code/message，客户端可增加本地说明。

## 10. WebSocket

路径不带 `/api`。两者使用原生 WebSocket，连接后 5 秒内发送 `{"type":"auth","token":"<accessToken>"}`，不要将 token 放在 URL。

| 路径 | 成功消息 | 失败消息/关闭 | 客户端要求 |
| --- | --- | --- | --- |
| `/ws/employee-status` | `type:status_update,data,timestamp` | 认证/Origin 问题 1008；认证后的查询故障发送 `{"type":"error","error":<诊断>}`，初始化失败可再关闭 1011；广播故障也会发送 error | 同时监听 message 和 close。1011 不清登录；显示已收到的具体 error；保留已有状态，可按退避重连/HTTP 补查 |
| `/ws/notifications` | `type:connected` 含未读数，及通知/心跳等消息 | 认证/消息/Origin 问题 1008，初始化/内部错误可 1011；当前并非所有内部错误都会先发完整诊断帧 | 保存 close code/reason；没有 body 时不要编造具体原因；1011 与普通 token 失效区分 |

员工状态 WS 会检查配置允许的 Origin；通知 WS 对未带 Origin 的原生客户端另有处理。不要假设两条 WS 的握手限制完全一致。客户端收到错误帧后，不能仅显示随后 close 的通用文案而覆盖原始诊断。

## 11. Mock 接口逐条列出

全部 E，另有 mock 开关/环境守卫。以下只供开发测试，不能作为真实图片/视频接口的自动降级目标。

| 方法 | 图片 mock 路径 | 视频 mock 路径 | 返回/错误处理 |
| --- | --- | --- | --- |
| GET | `/gateway/v1/media/profiles` | `/gateway/v1/media/video/profiles` | mock profile，读取 mock 标记 |
| POST | `/gateway/v1/media/references` | `/gateway/v1/media/video/references` | mock 参考图/fixture 校验 |
| POST | `/gateway/v1/media/quotes` | `/gateway/v1/media/video/quotes` | 模拟报价，不代表真实钱包扣费 |
| POST | `/gateway/v1/media/requests` | `/gateway/v1/media/video/requests` | 模拟回执，不是供应商生成 |
| GET | `/gateway/v1/media/requests/by-client-id/:requestId` | `/gateway/v1/media/video/requests/by-client-id/:requestId` | 原 mock 回执找回 |
| GET | `/gateway/v1/media/requests/:receiptId` | `/gateway/v1/media/video/requests/:receiptId` | mock 查询 |
| GET | `/gateway/v1/media/requests/:receiptId/outputs/:outputId/content` | `/gateway/v1/media/video/requests/:receiptId/outputs/:outputId/content` | 固定测试字节，校验 mock header |
| POST | `/gateway/v1/media/requests/:receiptId/cancel` | `/gateway/v1/media/video/requests/:receiptId/cancel` | 依 mock 能力返回，不能沿用为真实取消承诺 |

## 12. 配套与停用接口

本节为相关后端能力清单，不表示桌面客户端已逐条直接使用。错误同样经过第 2 节的本地过滤边界；停用接口应移除调用，不循环重试。

### 12.1 Skill 导入配套 Web 接口

均需 A 和相应角色/会话权限，前缀 `/skill-import`：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/skill-import/config` | 导入开关/协议 |
| POST | `/skill-import/sessions` | 创建 Web 导入会话 |
| GET | `/skill-import/sessions/:id` | 查询会话/指定视图 |
| POST | `/skill-import/sessions/:id/confirm-device` | Web 确认设备 |
| POST | `/skill-import/sessions/:id/preview` | 生成/请求预览 |
| POST | `/skill-import/sessions/:id/selection` | 确认导入选择 |
| DELETE | `/skill-import/sessions/:id` | Web 取消 |
| GET | `/skill-import/devices` | 已关联设备 |
| DELETE | `/skill-import/devices/:deviceId` | Web 撤销设备 |

### 12.2 知识库附加/旧接口

| 方法 | 路径 | 状态/处理 |
| --- | --- | --- |
| GET | `/knowledge-bases/:kbId/documents/:docId/download` | 原文档下载；文件与失败 JSON 区分 |
| POST | `/knowledge-bases/:kbId/test-search` | 管理员检索验证，按实际角色限制使用 |
| GET | `/knowledge-bases/:kbId/documents/status` | 处理状态汇总，不代表所有文档已成功 |
| POST | `/knowledge-bases/:kbId/chunks` | 手工片段创建，保持权限/校验错误 |
| GET | `/knowledge-bases/:kbId/chunks` | 片段列表 |
| GET | `/knowledge-bases/:kbId/chunks/:chunkId` | 片段详情 |
| PATCH | `/knowledge-bases/:kbId/chunks/:chunkId` | 片段更新 |
| DELETE | `/knowledge-bases/:kbId/chunks/:chunkId` | 片段删除 |
| POST | `/knowledge-bases/:kbId/reindex` | 已停用，授权校验后 410 `KNOWLEDGE_OPERATION_RETIRED` |
| GET | `/knowledge-bases/grants/by-subscription/:subscriptionId` | 旧订阅授权已停用 |
| DELETE | `/knowledge-bases/grants/:grantId` | 旧授权删除已停用；改用按成员撤销 |
| POST | `/knowledge-bases/:kbId/documents/batch-reprocess` | 已停用 |
| GET | `/knowledge-bases/:kbId/analytics` | 已停用 |

## 13. 给客户端团队的实施清单

下面是建议修改位置；不要求客户端照搬 SEP 的类名。

| 客户端位置 | 需要核对/修改的内容 |
| --- | --- |
| `electron/common/platform/platform-api.ts` | 通用 HTTP 错误读取：支持 JSON/文本/不同 envelope，保留 HTTP 状态、body、message/code、校验细节、请求 ID/等待头 |
| `electron/errors/error-mapper.ts`、`app-error.ts` 与 IPC 结果 | 本地分类同时携带安全原诊断，避免 400/409/422/5xx 进入统一文案后丢原因；401 根据来源处理 |
| `electron/common/platform/client-monitor-api.ts` | 任务同步失败读取 body；保留不可变冲突、旧 run、事件序号冲突的 message；不只返回 `SEP monitor HTTP N` |
| `electron/common/platform/knowledge-api.ts` 与知识库 schema | 保留具体 message/errors/diagnostic；200 检索降级与真实失败分开；停用/冲突按原原因展示 |
| `electron/common/platform/skill-artifact-api.ts` | 下载失败先解析错误 body，保留 `SKILL_ARTIFACT_BLOCKED/reason` 和关联 ID；成功完整校验 |
| `electron/data/sep-real-media-gateway.ts`、`sep-video-media-gateway.ts` | 保留上游正文、头、数字 code、扩展字段；上游 401 不等同客户端登录失效；正确解析 200/202 回执 |
| `src/shared/media-upstream-error.ts` 及关联合同 schema | 对齐 SEP 的任意 JSON `body` 和可选 `headers`；不能 `.strip()` 删除全部未知诊断 |
| `electron/service/media-service.ts` 及视频 service | 提交/查询/下载/保存各阶段的诊断分别保留；状态、账务与原因分开；保持原任务找回和不重复提交 |
| `electron/errors/media-tool-error.ts`、`video-tool-error.ts` | 将安全具体原因返回工具调用方；保留本地分类但不统一替换原因 |
| `src/shared/media-feedback.ts` 及媒体 UI | `SUBMISSION_UNKNOWN/FAILED/PARTIAL_SUCCEEDED` 均可展示已有实际原因；状态提示和原因同时显示 |
| 聊天 SSE/SDK 包装 | HTTP 错误、SSE error/failed、异常 EOF 分开保留；错误不被 `[DONE]` 或部分内容覆盖 |
| 员工状态/通知 WS 客户端 | 错误帧和 close 一起处理；1011 不当成 token 无效；已有错误不被 close 通用提示覆盖 |
| 客户端日志/问题反馈 | 保留脱敏诊断及多层请求 ID；不记录 Authorization、refreshToken、Cookie、真实 Key 和完整签名 URL |

### 13.1 原因提取与展示建议

保留整个原始 body 后，再提取显示文案。优先使用具体的业务错误 message/reason/detail；如 `error.message` 只是“请求参数格式无效”，同时展示 `error.reason` 和 `errors[]` 的字段原因。兼容字符串 `error`、顶层 message、包装体 body 和纯文本。

code 用于机器分类，message/reason 用于解释。未知 code 不等于未知原因。多个异常并存时展示主失败原因，查询/下载/账务异常作为附加诊断，不能互相覆盖。

需要翻译或增加用户可读说明时，仍保留原始安全原因供展开查看/问题反馈。工具调用方也应取得具体原因，不能只在 UI 中显示。

### 13.2 客户端验收矩阵

使用模拟响应，不需要付费模型请求。以下是客户端待实施验收，不是声称已经在客户端全部执行。

| 编号 | 模拟场景 | 验收要求 |
| --- | --- | --- |
| C01 | 400 顶层 `message + errors[]` | 界面/IPC 保留每个 field/message，不只“参数错误” |
| C02 | 409 字符串 `ConflictException`，没有业务 code | 仍显示 `Stale client run` 等具体原文，不要求 code 必须存在 |
| C03 | 上游 401 顶层 code/message，source header=upstream | 保留 Invalid API key；不无限刷新桌面登录 |
| C04 | 上游 502 嵌套 error，内含 `upstream_status:422/details` | 外层502、上游422、原 message/details 同时保留 |
| C05 | 纯文本失败、`error` 为字符串、code 为数字 | 均可读，JSON 解析/schema 失败不覆盖原原因 |
| C06 | 错误体被截断/读取失败 | 原 body 片段与 `readError/truncated` 都保留 |
| C07 | HTTP 200 的业务 error 被 SEP 以 502 返回 | 正确失败；保留 `X-Compute-Status:200` |
| C08 | 429 的并发、额度、余额三种不同原因 | message/code 分别保留；有 Retry-After 按其等待，无则不编造等待值 |
| C09 | SSE 200 后 error/response.failed，随后 DONE 或 EOF | 原错误保留，不能终态成功 |
| C10 | SSE 部分文本后断流且没有错误帧 | 保留部分文本与传输失败；不编造供应商原因 |
| C11 | 图片回执 SUBMISSION_UNKNOWN + 具体 upstreamError | 状态与原因同时可见，不只 MEDIA_FAILED；查询原 ID，不重复生成 |
| C12 | 视频回执 200 + FAILED，error.code 为数字 | 标为失败，message/details 可读；不按 HTTP200 判成功 |
| C13 | 生成失败后账务查询又失败 | 原生成原因保留，附加 sepDiagnostics；退款状态不凭空变更 |
| C14 | 媒体任务 RUNNING，某次查询失败 | 展示查询异常；原任务不被直接改为 FAILED |
| C15 | 部分成功、规格不匹配或未知 | 结果、逐项错误、验收状态分别显示；不自动重生成 |
| C16 | 视频下载半途断开或 SHA256 不符 | 不发布成品，仅重试原下载 |
| C17 | 知识库检索降级成功 + diagnostic | 正常结果保留，同时提供具体降级原因 |
| C18 | 知识库 NO_ACCESS/NOT_READY/NO_MATCH | 不全部显示“没有搜索到内容” |
| C19 | Skill 下载409 + SKILL_ARTIFACT_BLOCKED/reason | 安装阻断原因可见，不只“下载被拒绝” |
| C20 | Connector 202 等Web确认、410终止、429 | 三种状态分别处理；不无限创建新配对 |
| C21 | 员工状态 WS error 帧后 close1011 | 展示具体帧诊断，不改成登录过期 |
| C22 | 204 logout/delete | 成功，不因空响应 JSON 解析制造异常 |
| C23 | 网络/TLS/DNS异常，无HTTP响应 | 保存传输异常，不伪造已收到的供应商状态 |
| C24 | 三层 requestId 不同 | SEP、算力、供应商各自可追踪，不互相覆盖 |
| C25 | 敏感 Key、Bearer、Cookie、签名URL出现在错误中 | 具体非敏感原因仍可读，敏感片段不可见；按文本安全渲染 |

## 14. 核对依据与验证边界

SEP 路径相对于本仓库，客户端路径相对于 `D:/github/sep-client`：

| SEP 依据 | 内容 |
| --- | --- |
| `backend/src/main.ts` | `/api` 前缀、CORS |
| `backend/src/common/filters/http-exception.filter.ts` | 本地错误 envelope、上游原体、头和关联 ID |
| `backend/src/common/errors/upstream-http.exception.ts` | 上游 HTTP/业务错误读取、状态、限长、SSE诊断 |
| `backend/src/common/errors/error-diagnostics.ts` | 脱敏、异常原因保留 |
| `backend/src/common/errors/media-upstream.exception.ts` | 媒体诊断和后续故障追加 |
| `backend/src/modules/client/client.controller.ts` | 客户端身份/任务/运行清单路由 |
| `backend/src/modules/client/client-skill-artifact.controller.ts` | Skill 产物下载 |
| `backend/src/modules/client/client.service.ts` | 具体认证、申请、任务冲突原因 |
| `backend/src/modules/gateway/gateway.controller.ts` | 聊天 HTTP、SSE、执行ID和中断 |
| `backend/src/modules/media-gateway/` 下四个 controller、real service、image/video adapter | 真实/mock媒体路由、回执、下载 |
| `backend/src/shared/index.ts` | ClientLogin/Refresh/Token、ChatCompletionRequest DTO |
| `backend/src/shared/client-employee.dto.ts`、`client-task.dto.ts` | 员工申请/任务输入 |
| `backend/src/shared/media.dto.ts`、`media-real.dto.ts`、`media-video.dto.ts`、`media-video-real.dto.ts`、`media-spec.dto.ts`、`media-reference.dto.ts` | 协商/规格/回执/任意JSON诊断 |
| `backend/src/modules/knowledge/`、`backend/src/shared/knowledge.dto.ts` | 知识库路由、当前成员检索、降级诊断 |
| `backend/src/modules/skill-import/`、`backend/src/shared/skill-import*` | 导入专用协议 |
| `backend/src/modules/enterprise/employee-status.gateway.ts`、`backend/src/modules/notifications/notifications.gateway.ts` | WS 协议和关闭行为 |
| 其余对应模块 controller | 第7节复用业务路由 |

本文是基于当前代码的交接说明，新增文档时没有修改业务实现、客户端、数据库或依赖。未访问生产接口，未部署，未调用收费生成，也未在客户端执行验收矩阵。

文档检查：已对客户端、聊天、四类媒体、知识库和 Skill 导入共14个控制器的104条 HTTP 路由声明进行路径覆盖比对，未发现遗漏；这里统计的是源码声明，不是启动服务后的路由探测，也不包含第7节全部复用业务路由的逐分支测试。5个 JSON 示例均通过解析检查。

上一步针对图像错误透传重新执行的后端验证：`media-real.service.spec.ts`、`http-exception.filter.spec.ts`、`http-exception.http.spec.ts` 共107项通过；`sub2api-image.adapter.spec.ts` 定向13项通过、80项未选中。该120项结果证明对应后端模拟路径通过，不等同客户端端到端或所有接口已完成故障注入。

历史 `client-compute-error-audit-2026-11-18.md` 描述的是修复前审计。当前后端契约优先依据本文与当前代码，不把历史泛化行为当作修复后的协议。
