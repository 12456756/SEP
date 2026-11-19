# 客户端、SEP 与算力平台错误信息审计

日期：2026-11-18。本次只审计，未修改业务代码、接口协议或数据库。

## 1. 结论与范围

用户反馈的问题成立。错误原因会在多个边界被删减、替换，个别路径还会被归为错误的类别。不能仅通过修改某个统一报错文案解决。

当前实际链路是：

```text
模型供应商 -> 算力平台 sub2api -> SEP -> 客户端主进程 -> 客户端界面
                                  |
                                  +-> 运行日志 / 任务回执 / 账务对账
```

本次基于以下本地版本：

| 仓库 | 位置 | HEAD | 审计深度 |
| --- | --- | --- | --- |
| SEP | D:/github/SEP-worktree-two | 84318868 | 客户端接口入口、共享异常处理、全部检出的 sub2api 调用点、流式与媒体回执关键异常分支 |
| 桌面客户端 | D:/github/sep-client | f2e2d31 | 请求封装、知识库/任务同步/媒体/技能请求、IPC 错误映射 |
| 算力平台 | D:/github/LongdaoAI | 8fea90da | 选定的 OpenAI/兼容协议错误处理边界；不是整个算力平台仓库的全面内部审计 |

“全部接口”在本文指下文列出的客户端入口，以及 SEP 代码中检出的全部 sub2api 出站接口和调用方。进行了全入口错误边界梳理，并深入检查高风险分支；没有对每条业务分支逐一进行故障注入。未访问生产配置、未调用生产接口、未发起收费生成，不能证明线上部署与上述本地版本一致。

三个需要区别的判断：

- **原因保留**：客户端能区分发生了什么，服务端能凭 requestId 找到对应的原始诊断信息。
- **原因泛化**：如不同故障都变成“服务不可用”；不一定是虚假陈述，但不足以选择正确恢复动作。
- **原因错配**：如数据库查询失败被报成 token 无效、上游 503 被提示检查密钥；会误导用户和程序。

真实图片/视频接口的多数上游 HTTP 错误已经能够保留状态码与响应体，这是当前做得较完整的部分。不能得出“所有上游错误都被 SEP 隐藏”的结论。

## 2. 主要发现

优先级表示建议修复顺序，不表示已证实生产事故。

### F01 [P1] 普通业务接口的字段错误和业务 code 被统一过滤器删除

位置：`backend/src/common/pipes/zod-validation.pipe.ts:18`、`backend/src/common/filters/http-exception.filter.ts:169`。

Zod 管道生成 `message + errors[{field,message}]`，但普通业务接口只输出 `statusCode/message/requestId/timestamp/path`。大部分业务 `code`、`errors`、恢复信息均消失。知识库、Skill 导入、Skill 下载阻断、版本化模型策略是有限例外。

实际效果：缺少 `subscriptionId` 和其他参数错误，客户端都可能只收到“请求参数校验失败”；409 只剩文案，无法稳定区分幂等冲突、过期运行、不可变状态等。

适用范围：下文 A、C 类普通接口。网关接口会保留字段错误，不能套用相同结论。已通过真实 Nest HTTP 请求复现。

### F02 [P1] 客户端第二次按 HTTP 状态归类，进一步丢掉平台返回的具体原因

位置：客户端 `electron/common/platform/platform-api.ts:234`、`electron/errors/error-mapper.ts:92`。

通用解析器主要读取顶层 `message` 和少量关联字段，忽略 `error.code/errors/stage/recovery`。进入 IPC 的 `AuthApiError` 又按状态映射：403 统一权限拒绝、404 统一不存在、429 统一限流、5xx 统一服务不可用；普通 400/409/422 进入兜底 `INTERNAL_ERROR`。已登录路径的 401 映射为 `AUTH_REQUIRED`。

这条普通映射路径没有继续带上平台原始 message、业务 code、requestId。登录有单独的受控反馈分支；KnowledgeApiError、媒体错误也有专用分支，不能说所有客户端错误都完全相同。

影响：即使 SEP 对某个普通业务错误已经返回清晰文案，界面仍可能只显示通用错误。仅修 SEP 不足以消除客户端统一化处理。

### F03 [P1] 聊天流开始后，SEP 自身发生的错误通常只会断开连接

位置：`backend/src/modules/gateway/gateway.controller.ts:157`、`:211`、`:260`。

发送 SSE 响应头后，SEP 原样转发上游字节。上游已经写入流的错误事件会随字节转发；不能说所有 SSE 错误都被吞掉。

但 SEP 本地产生的流超时、读取失败、不完整结束、usage 检查点保存失败等，主要记录日志后 `res.destroy()`，没有补发客户端能识别的结构化失败事件。客户端可能已经收到 HTTP 200 和部分内容，最后只能看到连接中断，难以区分模型故障、SEP 存储故障、超时和网络故障。

连接关闭不应伪造成功结束；问题是缺少可关联的失败原因，而非异常断流本身不合理。

### F04 [P1] 媒体查询与对账会吞掉部分异常，HTTP 200 不能说明任务正常

位置：`backend/src/modules/media-gateway/media-real.service.ts:419`、`:468`；`media-video-real.service.ts:311`、`:366`。

图片对账除 `MediaUpstreamException` 外，其他异常可直接返回原回执；定时对账的外层 catch 没有原因日志。视频查询/下载对部分本地校验、缓存、探测、存储错误，只留下 `UPSTREAM_FAILED/OUTPUT_FAILED` 或原运行状态；对账错误可收敛到 `RECONCILING`。

结果可能是 HTTP 200 + `RUNNING/SUBMISSION_UNKNOWN/RECONCILING`，具体故障原因缺失。对真正的 `MediaUpstreamException`，当前服务仍会保存并重新抛出上游错误，不应误判为全部吞掉。

证据不足时保留冻结资金、查询原任务是合理的安全语义。缺陷在于没有独立保存/返回实际失败原因，不能据此改成自动重提或直接退款。

### F05 [P1] 聊天 HTTP 错误只识别一种上游格式，网络故障原因直接丢弃

位置：`backend/src/modules/gateway/gateway.service.ts:172`。

| 实际错误 | SEP 返回 | 一致性 |
| --- | --- | --- |
| 非 2xx，JSON `error.message/type/code/param` | 保留上游 HTTP 状态，保留上述四字段并截长 | 主要原因基本保留；扩展 details 等不保留 |
| 非 2xx，顶层 `{message,code}` | `sub2api 请求失败（HTTP N）`、`UPSTREAM_ERROR` | 原因丢失 |
| 非 2xx，`{error:"具体原因"}`、纯文本、HTML | 同上 | 原因丢失；不展示整段 HTML 有合理性 |
| DNS/TLS/拒绝连接等 fetch 抛错 | 502 `UPSTREAM_UNAVAILABLE`、“无法连接 sub2api” | 故障类别泛化，catch 未保留原异常 |
| 生命周期超时 | 对应超时 code | code 能区分阶段，文案较通用 |
| HTTP 200 但 body 是 error 或无效 completion | `UPSTREAM_INVALID_COMPLETION` | 若 body 中有实际原因，未继续提取 |

只有上游 429 明确标注 `source: upstream`，且仅 429 处理 `Retry-After`。其他上游错误缺少相同来源标识。普通 429 无可用等待信息时，全局过滤器会填 60 秒，这是兜底值，不是已确认的实际恢复时间。

### F06 [P1] 算力平台内部也可能先泛化错误，SEP 无法还原已丢失的内容

位置：算力平台 `backend/internal/service/openai_gateway_upstream_errors.go:341`、`:559`；`gateway_forward_as_chat_completions.go:150`；`gateway_forward_as_responses.go:535`。

并非所有协议共用同一种错误策略：

- OpenAI Responses 一般错误分支把上游 401/402/403 改成 502，429 保持 429，默认错误变成 502 `Upstream request failed`；部分上下文窗口/会话/安全策略错误有专门保留逻辑。
- Chat Completions/Anthropic 兼容错误分支通常保留状态和提取出的 message，但重新生成 type，原始 code/details 不完整保留。
- 账号配置判定为“不处理此状态码”时，可返回 500 `Upstream gateway error`。
- 错误透传规则、账号切换和特殊策略分支会影响最终响应，必须结合实际请求路由与配置判断，不能仅凭接口名称推断。
- 另一兼容转发分支可把供应商 5xx 统一映射为 502。

部分算力运维记录仍保存上游 message、状态和请求 ID；原始 body 的日志受配置控制。本次没有验证生产配置和运行日志，也没有穷尽算力平台内部所有接口。

因此，“SEP 原样保留了 sub2api 的响应”不等于“客户端拿到了模型供应商的原始原因”。

### F07 [P2] 图片/视频适配器把多种合同和输出校验失败收敛为少数通用原因

位置：`sub2api-image.adapter.ts:47`、`:113`、`:161`；`sub2api-video.adapter.ts:54`、`:103`、`:158`、`:165`，均位于 `backend/src/modules/media-gateway/`。

配置缺失/格式错误、模型列表结构错误、报价字段错误、报价过期、模型或规格不匹配等，常收敛为 `PRICE_UNAVAILABLE` 和“上游合同暂不可核验”。视频查询 task/model 不匹配也可能使用同一条合同提示。

图片缺请求 ID、回包模型不符、base64/PNG 无效、旧协议尺寸不符等，可变成 `SUBMISSION_UNKNOWN` 与“图片上游执行未完成，请查询原请求”；视频提交身份/结构不符有同样问题。

`SUBMISSION_UNKNOWN` 是对提交/账务确定性的描述，不是具体失败原因。应同时保留“无法确认提交结果”和“发现了什么异常”这两层信息。

### F08 [P2] 视频服务输出的 stage/recovery 被过滤器删除

位置：`backend/src/modules/media-gateway/media-video-gateway.store.ts:35`、`media-video-real.service.ts:483`；`backend/src/common/filters/http-exception.filter.ts:67`。

视频服务使用 `video-authorization/video-quote/video-submit/video-query/video-content`，过滤器仅允许 `validation/quote/submit/query/download/reconciliation`，所以这些视频阶段值都无法通过。`recovery` 没有进入允许字段列表，图片中提供的恢复建议也会受影响。

已用 HTTP 复现：`CONFIG_CHANGED + field:profileId + stage:video-quote + recovery:refresh_capabilities` 最终只保留 code/message/field，阶段与恢复建议消失。V3 参数校验管道本身也会把多数 Zod 原因改成“请求参数格式无效/请检查字段类型、取值和必需字段”。

### F09 [P2] 模型发现与计费依赖错误缺少实际原因，个别提示方向错误

位置：`backend/src/modules/model/model-billing.service.ts:23`、`model.service.ts:60`、`:279`。

- `/sub2api/billing` 的配置、HTTP、超时、JSON、schema 故障全部变成 `MODEL_BILLING_UNAVAILABLE`，catch 没有保留原原因日志。它可能在聊天转发前阻断请求。
- 模型目录的倍率查询失败会降级为成功列表，`billingMultiplier:null` 和“中转倍率暂不可用”能说明降级，但解释不了原因。
- 普通模型发现所有非 2xx 都变为 503，并提示“上游返回错误(N)，请检查密钥是否有效”；对上游 429/503 等，该建议不能代表真实原因。
- 模型测试部分保留截断文本，但一次超时后的能力判断提示过强，不能证明该模型固有不支持聊天。

### F10 [P2] 服务端 AI 链也存在多套泛化策略

| 调用方 | 代码位置 | 当前错误行为 |
| --- | --- | --- |
| Web 对话 | `conversation/conversation-stream.service.ts:473`、`:813` | AI SDK 的非 HttpException 错误可变成 `STREAM_CONSUMPTION_ERROR` 和“AI 回复生成失败”；外层另有“对话处理失败”，部分日志缺原异常 |
| 任务规划 | `task-planning/task-planning.service.ts:248` | 读取后丢弃上游失败 body，502“任务规划上游服务暂时不可用”；生命周期超时单独处理 |
| 任务交付物 | `task-execution/task-deliverable.service.ts:70`、`:214` | 内层有 HTTP 与截断文本，外层 fallback，输出 `deliverableDegraded:true`，但不提供原原因 |
| 能力分析 | `capability-insight/capability-insight.service.ts:355` | HTTP 错误部分保留文本；网络错误泛化为模型暂不可用 |
| 员工文案 | `admin/employee-copy-draft.service.ts:107` | HTTP body 被丢弃，文案模型暂不可用；网络故障另一条通用提示 |
| 数字员工 runner | `digital-employee/digital-employee.runner.ts:139` | SDK 错误没有在 runner 中结构化归一，普通 HTTP 路径最终可能成为通用 500；工具失败转为给模型的 `Error: ...` 字符串，并非稳定客户端错误协议 |

本表路径均相对 `backend/src/modules/`。这些是同一平台的服务端执行入口，不代表桌面客户端当前全部直接调用它们。

### F11 [P2] 知识库对向量故障做降级，但诊断原因不足

位置：`backend/src/modules/knowledge/embedding.service.ts:127`、`document-processor.service.ts:90`、`knowledge-search.service.ts:197`。

sub2api embedding HTTP 失败主要保留 HTTP N，网络/解析故障统一服务不可用；文档处理进一步收敛到 `EMBEDDING_UNAVAILABLE`。搜索降级会明确返回 `actualStrategy:LEXICAL/degraded:true/degradationReason:QUERY_EMBEDDING_UNAVAILABLE`，这是有效的状态表达，但无法知道向量不可用的底层原因。

搜索其他未知错误会变成 `KNOWLEDGE_SERVICE_UNAVAILABLE`，日志仅有概括性文本。客户端知识库封装保留部分 code/requestId/Retry-After，但忽略平台原 message，重新生成受控文案。

内部 Ollama 的 `/api/tags`、`/api/embed` 是相邻的独立向量服务路径，不应混称 sub2api。它们也有类似泛化处理。

### F12 [P2] 部分认证与 WebSocket 错误原因错配

位置：`backend/src/modules/client/client-employment.guard.ts:74`、`enterprise/enterprise-context.service.ts:8`、`enterprise/employee-status.gateway.ts:39`。

- employment token 校验把会话/企业检查抛出的 UnauthorizedException 统一变成 token 无效或过期。企业冻结可能因此被当成重新获取 token 可解决的问题。
- 普通企业冻结异常虽然有 `ENTERPRISE_SUSPENDED`，但普通过滤器会删掉 code，客户端已登录 401 路径又提示重新登录。
- 员工状态 WebSocket 的 auth handler 把 token 验证和 `sendStatuses()` 放在同一个 try 中；后者查数据库/业务失败也关闭为 1008 `Invalid token`。广播失败只记录 debug，不给客户端失败事件。
- 通知 WebSocket 能区分部分 1008 认证错误与 1011 内部初始化错误，但不会给出完整内部原因；这是较粗的协议，需要配合服务端日志。

对登录凭证错误使用统一提示可有安全目的，问题在于把合法身份遇到的企业/存储故障也错误归类。

### F13 [P2] 运行配置接口与其他接口走相反方向，可能直接暴露内部异常

位置：`backend/src/common/filters/http-exception.filter.ts:143`。

`GET /api/client/subscriptions/:id/runtime` 特判会合并原始 Error 的 name/message、自有属性和一层 cause，而其他普通路由把非 HttpException 变成 `Internal server error`。

已用 HTTP 验证：模拟连接失败直接返回 500 + `ECONNREFUSED` + 原始 message。这里不是原因被隐藏，而是缺少统一的安全错误投影，可能暴露内部地址或数据库诊断等。不能通过对所有接口直接展开原始 Error 来修复其他接口。

### F14 [P2] 现有 HTTP 日志不能恢复已在 service catch 中丢掉的原因

位置：`backend/src/common/middleware/http-logging.middleware.ts:45`、`:58`。

日志已有 method/path/statusCode/durationMs/requestId/completed/message/code；500 另附有限的异常 name/code/message/stack，并有脱敏。Prisma 诊断文案被主动替换，部分代码与栈仍保留。

局限：JSON 响应通过拦截 `res.json()` 取 message/code；纯文本 `send()` 和 SSE 不走相同路径。SSE 中断日志可能是 HTTP 200 + `completed:false` + 通用连接关闭提示。最关键的是，service 已经丢弃的上游 body、fetch cause 或校验细节，HTTP 日志无法补回来。

## 3. 客户端入口清单与处理方式

除 WebSocket 外，以下路径统一带 `/api` 前缀。查询参数不改变错误边界。表中“普通处理”指 F01 + F02；不是宣称每个业务错误都没有具体 message。

### A. 专用客户端接口

代码：`backend/src/modules/client/client.controller.ts`、`client.service.ts`。

| 方法与路径 | 当前错误处理 |
| --- | --- |
| POST `/client/auth/login` | 明确的账号/凭证/设备错误 message；普通过滤；客户端登录专用受控反馈 |
| POST `/client/auth/refresh` | 会话、用户、设备等 Unauthorized；普通处理 |
| POST `/client/auth/logout` | 守卫及会话业务错误；普通处理 |
| POST `/client/auth/token` | 订阅不存在/失效、无企业或授权、TTL 配置错误；普通处理 |
| GET `/client/platform-employees` | 认证、查询参数、数据库错误；普通处理 |
| POST `/client/employee-access-requests` | 幂等头、员工、订阅及申请校验；普通处理，code/参数细节有损失 |
| GET `/client/employee-access-requests/:requestId` | 认证、范围与记录校验；普通处理 |
| GET `/client/compute-balance` | 认证、企业、余额查询；普通处理；不是逐次请求上游实时余额 |
| GET `/client/profile` | 认证、用户/设备/企业等校验；普通处理 |
| GET `/client/subscriptions` | 认证、授权、数据库查询；普通处理 |
| GET `/client/instances` | subscriptions 别名，沿用同一错误处理 |
| GET `/client/subscriptions/:subscriptionId/runtime` | 特殊原异常合并，见 F13；媒体配置还会下发 unavailableReason/unavailableMessage |
| POST `/client/tasks` | 运行归属、版本、不可变字段、并发冲突等；服务 message 多数明确，客户端任务封装进一步泛化 |
| PATCH `/client/tasks/:id/status` | stale run、终态不可变、非法结束时间等；同上 |
| POST `/client/tasks/:id/heartbeat` | stale run/身份/记录错误；同上 |
| POST `/client/tasks/:id/events` | 同序事件不同内容、归属不可变、协议不符等；同上 |
| GET `/client/tasks` | 权限/过滤条件/数据库错误；普通处理 |
| GET `/client/tasks/filter-options` | 同上 |
| GET `/client/tasks/:id` | 任务不存在/范围不可访问；普通处理 |
| GET `/client/subscriptions/:subscriptionId/skills/:capabilityId/versions/:versionId/artifact` | 服务端有 409 `SKILL_ARTIFACT_BLOCKED/reason` 专门保留；客户端下载封装丢弃失败 body，只报下载被拒绝 |

任务同步客户端证据：`electron/common/platform/client-monitor-api.ts:119`。其大部分失败 body 未读取，仅少量固定 403 文案有特殊处理；409 可退化为 `SEP monitor HTTP 409`。

运行配置中 PROFILE_DISABLED、PROFILE_UNVERIFIED、EXECUTION_DISABLED、CONNECTION_UNAVAILABLE、ADAPTER_PROTOCOL_UNSUPPORTED 等不可用原因已有区分，是应该保留的设计。部分找不到的已授权 profile 仅被排除并写警告，不能认为每项缺失都有客户端可见解释。

### B. 模型与媒体双向通路

| 入口 | 实际处理 |
| --- | --- |
| POST `/gateway/v1/chat/completions`，非流式 | 平台认证/准入/额度/计费/模型策略 -> sub2api -> completion 校验；见 F03/F05/F09 |
| 同一路径，`stream:true` | 发送头前可返回 JSON 错误；发送后转发 SSE，本地产生的错误主要断流；见 F03 |
| `/gateway/v1/media/real` | 真实图片，HTTP 上游错误透传；合同/语义/对账异常见 F04/F07/F08 |
| `/gateway/v1/media/video-real` | 真实视频，HTTP 上游错误透传；任务状态/内容/对账异常见 F04/F07/F08 |
| `/gateway/v1/media` | 旧模拟图片实现，不代表真实算力调用 |
| `/gateway/v1/media/video` | 模拟视频实现，不代表真实算力调用 |

上述四个媒体前缀各有同样的 8 个接口，合计 32 条方法路径：

```text
GET  {prefix}/profiles
POST {prefix}/references
POST {prefix}/quotes
POST {prefix}/requests
GET  {prefix}/requests/by-client-id/:requestId
GET  {prefix}/requests/:receiptId
GET  {prefix}/requests/:receiptId/outputs/:outputId/content
POST {prefix}/requests/:receiptId/cancel
```

profiles/references 多为平台配置、授权、输入校验，通常不直接执行生成。quotes/requests 会涉及上游；query 可能触发同步查询、下载和对账；content 为文件/流，视频 pipeline 失败可直接销毁响应。真实 cancel 明确返回 409 `CANCEL_UNSUPPORTED`，没有调用未实现的上游取消接口。

真实媒体上游 HTTP 错误通过 `MediaUpstreamException` 返回原 status/body，并带 `X-SEP-Error-Source: upstream`。配置的当前媒体凭证会被替换。大于 64 KiB 或无法读取的失败 body 会改为本地 502；本地网络异常主要只留 name/message，常见 `fetch failed` 的 cause/code 没有完整保留。此处的“透传”不等于完全不作脱敏/限长。

视频上游任务以 HTTP 200 返回 failed/cancelled 时，SEP 会将任务错误写入回执 `upstreamError`，不是 HTTP 错误。这种成功查询到失败任务的表达是合理的，调用方必须检查业务状态。

### C. 客户端复用的业务 API

以下入口按客户端封装和服务端控制器交叉检索，普通业务异常最终同样经过全局过滤器。

| 功能 | 接口 | 当前错误特点 |
| --- | --- | --- |
| 模型列表 | GET `/models/enabled` | 普通错误；倍率查询可成功降级，见 F09 |
| 企业信息 | GET `/enterprise/organization`、`/enterprise/overview`、`/enterprise/employee-status` | 普通处理；冻结企业 401 可能被当登录失效 |
| 员工技能 | GET `/enterprise/employees/:employeeId/skills` | 普通处理 |
| 技能版本 | POST/GET `/enterprise/skill-versions`；GET `/enterprise/skill-versions/:id/preview` | 业务 message 可存在，但普通 code/校验细节被删；客户端还有来源头等专门判断 |
| 技能审核 | GET `/enterprise/skill-version-reviews`；POST `/enterprise/skill-versions/:id/review` | 普通处理 |
| 头像/企业 logo | POST `/users/me/avatar`、`/enterprise/logo`；返回的图片资源 GET | 上传校验可有具体 message；普通处理；文件资源与 JSON 错误需分开识别 |
| 钱包 | GET `/personal-wallet`、`/personal-wallet/transactions` | 用户、账号状态、查询错误；普通处理 |
| 充值 | POST `/personal-wallet/recharge`；GET `/personal-wallet/recharge/:orderNo`；POST `/personal-wallet/recharge/:orderNo/reconcile` | 金额、订单、账号/并发冲突 message；普通处理；不属于 sub2api 出站接口 |
| 算力 | GET `/compute-credit/my-allowance`、`/compute-credit/usage-records`、`/compute-credit/usage-breakdown` | 企业/成员/日期等校验；普通处理 |
| 通知 | GET `/notifications`、`/notifications/unread-count`；POST `/notifications/:id/read`、`/notifications/read-all`；DELETE `/notifications/clear-read`、`/notifications/:id` | 普通处理，网络/权限/存储错误到客户端后按类别泛化 |
| 附件 | POST `/upload/file`、`/upload/files`、`/upload/refresh-url`；GET `/uploads/*` 等返回资源路径 | 文件类型/大小/归属可有具体 message；普通处理；下载还可能发生流错误 |

知识库入口另列，避免遗漏动态路径：

```text
GET/POST       /knowledge-bases
GET/PATCH/DELETE /knowledge-bases/:kbId
GET            /knowledge-bases/:kbId/sources/:sourceId
GET            /knowledge-bases/:kbId/documents
GET/DELETE     /knowledge-bases/:kbId/documents/:docId
POST           /knowledge-bases/:kbId/documents/upload
POST/GET       /knowledge-bases/:kbId/documents/:docId/versions
GET            /knowledge-bases/:kbId/documents/:docId/preview
POST           /knowledge-bases/:kbId/documents/:docId/reprocess
GET/POST       /knowledge-bases/:kbId/grants
DELETE         /knowledge-bases/:kbId/grants/:memberId
GET            /enterprise/members?view=knowledge-grant
POST           /knowledge-bases/search
```

知识库后端还提供文档 download、reindex、test-search、documents/status、documents/batch-reprocess、analytics、chunks CRUD、旧 grants 删除/订阅授权查询，以及 `/admin/knowledge/metrics`。这些附加入口共享已检查的过滤边界；不把它们全部当成当前桌面封装的直接调用。

知识库错误 code 有允许名单，优于普通接口；仍会丢 errors 等非允许字段。客户端 KnowledgeApiError 可保留 code/requestId，文案按客户端规则重新生成。权限保护有意不区分不存在和无权访问的资源，不能将这种防枚举设计直接认定为缺陷。

### D. 本机 Skill 导入与 WebSocket

Skill 导入 connector 前缀 `/skill-import/connector`：

```text
POST   /pairings
POST   /challenges
POST   /grants
GET    /sessions/:id/commands
POST   /sessions/:id/events
GET    /sessions/:id/operations/:operationId
POST   /sessions/:id/operations/:operationId/upload-grant
POST   /sessions/:id/package
DELETE /sessions/:id
POST   /devices/:deviceId/revoke
```

配套 Web 接口前缀 `/skill-import`：GET config；POST sessions；GET sessions/:id；POST sessions/:id/confirm-device、preview、selection；DELETE sessions/:id；GET devices；DELETE devices/:deviceId。

这组接口有明确错误码允许名单、retryable 和 Retry-After；客户端也解析对应字段，是目前相对完整的契约。客户端文案仍受控，不能理解为展示任意原始异常。

| WebSocket | 当前错误边界 |
| --- | --- |
| `/ws/notifications` | 来源/认证等 1008，部分初始化内部错误 1011；需结合服务端日志 |
| `/ws/employee-status` | 首次状态查询失败可被误报 1008 Invalid token，见 F12；不是客户端当前通知 socket 的同一入口 |

## 4. SEP -> sub2api 出站接口全集与调用方

以下是代码检出的出站方法/路径，不是算力平台公开 API 文档全集。通用配置 baseURL 可以带 `/v1`；图片/视频适配器将其规范成 `/v1`，embedding 单独补齐 `/v1`。不要直接把表中后缀当成完整请求 URL。

| 方法/路径后缀 | SEP 调用方 | 当前错误处理 |
| --- | --- | --- |
| POST `/chat/completions` | GatewayService | F03/F05；嵌套标准错误部分保留、非标准体泛化、流后错误断开 |
| 同上 | ConversationStreamService | AI SDK 错误多泛化，F10 |
| 同上 | TaskPlanningService | 丢弃失败 body，F10 |
| 同上 | TaskDeliverableService | 部分保留后降级交付，F10 |
| 同上 | CapabilityInsightService | HTTP 文本部分保留，网络泛化，F10 |
| 同上 | EmployeeCopyDraftService | 泛化，F10 |
| 同上 | DigitalEmployeeRunner | SDK 异常往外抛，普通过滤边界，F10 |
| 同上 | ModelService.testModel | 截断文本/通用异常混用，F09 |
| GET `/models` | ModelService.fetchUpstreamModels | body 未保留，HTTP 错误提示检查密钥，F09 |
| 同上 | Sub2apiImageAdapter.discoverModels | HTTP 错误透传；成功 body 结构错误改 PRICE_UNAVAILABLE |
| 同上 | Sub2apiVideoAdapter.discover | 同上 |
| 同上 | HealthController readiness probe | 失败转 checks.sub2api=failed，503；不向健康探针暴露内部诊断，但也不能靠它定位原因 |
| GET `/sub2api/billing` | ModelBillingService | HTTP/网络/配置/schema 等统一错误，F09 |
| POST `/sub2api/images/pricing` | Sub2apiImageAdapter.pricing | HTTP 错误透传；报价语义失败泛化，F07 |
| GET `/sub2api/usage?request_id=...` | Sub2apiImageAdapter.usage | HTTP 错误透传；证据无效改 BILLING_PENDING；对账外层见 F04 |
| POST `/images/generations` | Sub2apiImageAdapter.execute | HTTP 错误保留；回包/成品/请求 ID 问题见 F07 |
| POST `/images/edits` | 同上 | 同上；另有参考图/规格校验 |
| POST `/sub2api/videos/pricing` | Sub2apiVideoAdapter.pricing | HTTP 错误透传；报价语义失败泛化，F07 |
| GET `/sub2api/videos/usage?request_id=...` | Sub2apiVideoAdapter.usage | HTTP 错误透传；证据无效改 BILLING_PENDING；对账外层见 F04 |
| POST `/videos` | Sub2apiVideoAdapter.submit | HTTP 错误保留；回包身份/schema 不符变 SUBMISSION_UNKNOWN |
| GET `/videos/:taskId` | Sub2apiVideoAdapter.query | HTTP 错误保留；语义失败泛化；task.error 可以在 HTTP 200 的回执内保留 |
| GET `/videos/:taskId/content` | Sub2apiVideoAdapter.rawContent | 非 2xx 保留；本地长度/MIME/读取异常转本地错误，后续缓存/下载边界见 F04 |
| POST `/v1/embeddings` | EmbeddingService，provider=sub2api 时 | 状态部分保留，原 body 和网络 cause 丢失；见 F11 |

媒体配置/发现/验证后台入口也复用上述适配器：图片 `/admin/media/profiles` 的 GET/POST/PATCH、`models/discover`、`profiles/:id/verify`、connection GET/PUT；视频有 `/admin/media/video/...` 对应入口。企业图片/视频配置 GET/PUT、preview、available-profiles 主要是平台配置与授权检查。不能只修客户端媒体控制器而遗漏共用适配器的管理入口。

其他会触发服务端模型链的入口：POST `/conversations/:id/messages`、`/task-plans/preview`、`/enterprise/capabilities/:capabilityId/insights/generate`、`/admin/employees/copy-draft`、`/digital-employees/:id/run`，以及任务执行/交付物链。它们共享上述出站调用，但输入错误和最终响应分别还经过各自的普通 HTTP/SSE/任务持久化边界。

Coze、OpenCode、支付、钉钉等不是本文的 sub2api 算力接口；未把它们的全部第三方错误协议纳入本次全面审计。工具适配器的失败结果会进入业务/模型上下文，不能与网关 HTTP 错误混为一谈。

## 5. 客户端不同封装的差异

| 客户端位置 | 保留/丢失情况 |
| --- | --- |
| `electron/common/platform/platform-api.ts:234` | 主要解析顶层 message；不完整读取嵌套错误和业务 code |
| `electron/errors/error-mapper.ts:92` | 普通 AuthApiError 的 HTTP 归类替换 message，关联字段未继续传到界面，F02 |
| `electron/common/platform/client-monitor-api.ts:119` | 多数任务同步失败体丢失，仅有 HTTP N 和少数特殊分支 |
| `electron/common/platform/knowledge-api.ts:200` | 保留部分业务码/requestId/等待信息；忽略原 message |
| `electron/common/platform/skill-artifact-api.ts:85` | 非成功体不解析，下载阻断 reason 丢失 |
| `electron/common/platform/skill-import-api.ts:107` | 解析允许的 code/retryable/等待信息，契约相对完整 |
| `electron/data/sep-real-media-gateway.ts:275` | 上游标识路径能提取安全 message 与部分 details；平台错误多按 code/status 套文案 |
| `electron/data/sep-video-media-gateway.ts:292` | 上游错误可保留 message/source；不认识的平台错误可能变 VIDEO_HTTP_ERROR |
| `electron/common/media-upstream-error.ts` | 对上游可展示信息脱敏、限长，是合理的输出边界 |
| `electron/pi/sdk/model-transport-diagnostics.ts` | 已有连接/响应体读取、requestId、耗时与 cause 诊断；只能记录客户端实际收到的信息 |

因此，错误原文、用于程序判断的错误码、可向用户展示的文案、服务端排障详情必须区分。保留真实原因不等于把供应商 body、密钥、URL、SQL 和堆栈原封不动展示给用户。

## 6. 已执行验证

### 6.1 现有回归测试

执行：

```powershell
pnpm --dir backend exec jest --runInBand src/common/filters/http-exception.filter.spec.ts src/modules/gateway/gateway.service.spec.ts src/modules/gateway/gateway-controller-stream.spec.ts src/modules/media-gateway/sub2api-image.adapter.spec.ts src/modules/media-gateway/sub2api-video.adapter.spec.ts src/modules/client/client-runtime.http.spec.ts src/modules/media-gateway/media-spec-validation.pipe.spec.ts
```

结果：7 个测试套件、418 项测试通过。上游使用模拟，不连接生产数据库或模型服务。测试通过说明当前处理符合这些既有断言，不代表上述信息丢失符合用户需求。

### 6.2 实际 HTTP 最小复现

通过临时内存 Nest 模块，同时注册 `APP_FILTER: SensitiveDataFilter` 和 `app.useGlobalFilters(new HttpExceptionFilter())`，与生产注册方式对应。未创建测试文件、未修改代码、未读真实配置。4 个请求场景全部符合断言：

| 场景 | 实际 HTTP 结果 |
| --- | --- |
| 普通 client 路由抛包含 errors 的 BadRequestException | 400，message 保留，errors 消失 |
| gateway 路由抛同一异常 | 400，errors 保留，code=INVALID_PARAMETER、param=subscriptionId |
| video-real 路由抛 CONFIG_CHANGED + stage/recovery | 409，code/field 保留，stage/recovery 消失 |
| runtime 路由抛带 code 的普通 Error | 500，原始 message/name/code 返回 |

这也验证了本次关键 HTTP 响应确实由 HttpExceptionFilter 处理，不能根据另一个未注册的旧 `GlobalExceptionFilter` 文件判断线上行为。不同异常过滤器不是自动逐层串联脱敏。

直接调用过滤器的其他内存检查还验证了普通业务 code 删除、MediaUpstreamException 原 status/JSON body 保留等。

排除的误报：不能仅把 SyntaxError 直接传给过滤器后得到 500，就认定真实非法 JSON 请求一定返回 500。Nest 路由异常层会先映射相关解析错误，项目已有 `json-body.middleware.spec.ts:80` 的非法 JSON 400 用例；本次不将该猜测列为缺陷。

## 7. 后续修改的范围建议

本次未实施以下修改：

1. 优先修普通业务错误投影与客户端 IPC 传递，让受控 code、字段和 requestId 跨完整链路保留。
2. 为流式、下载与任务回执定义明确失败表达；区分传输错误、平台故障、模型拒绝、输出异常、账务未确认。
3. 统一 sub2api 错误提取规则，并保留内部脱敏 cause/上游请求 ID；无法安全展示的细节仍能供管理员按 requestId 排查。
4. 将媒体提交确定性、账务状态与事实原因分开保存，保持现有防止重复生成/错误退款的保护。
5. 修 stage/recovery 不兼容及 token/密钥提示错配，收敛 runtime 的原异常直出。
6. 联合客户端和算力平台调整错误契约，并针对上游 HTTP 错误、200 业务失败、SSE 中断和本地存储失败分别验收。

尚未验证：线上实际部署版本、反向代理对错误页/超时的改写、生产算力平台错误透传规则、真实第三方返回样本、每条业务分支的实际故障注入和客户端 UI 端到端表现。
