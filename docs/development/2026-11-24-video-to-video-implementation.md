# SEP 参考视频生成视频接入说明

日期：2026-11-24。本文描述本地实现；不表示已部署，也不表示已经通过真实付费生成验收。

## 本期范围

- 仅真实执行的 V3 请求支持 `video-to-video`，可以引用一个或多个参考视频。
- 单次上传一个 MP4/MOV；单文件最大 90 MiB，整个 multipart 请求最大 92 MiB。
- 实际可引用数量、文件大小和格式取决于平台 Profile；系统参考视频数量上限为 10。具体模型的 Profile 必须按算力平台实际合同配置，例如 Seedance 2.0 的数量应配置为不超过 3。
- 暂不支持图片与视频混合参考、音频参考、任意 URL、`asset://` 或客户端直接提交算力平台素材 ID。
- 提示词、明确的正整数生成时长仍然必填。`audio: false` 会保留；帧率保留在请求记录中，不转交上游。
- 复用原有报价、预留资金、提交、回执恢复、任务查询、下载及账务核对；不新增数据库表或迁移。

## 后台配置

平台管理员进入「系统设置 → 模型管理 → 视频」，编辑或新建人工 Profile：

1. 勾选「视频生视频」。
2. 填写「最多参考视频数量」和「单个参考视频上限（MiB）」。
3. 勾选允许的 MP4/MOV 格式。图片参考数量、图片字节上限仍是独立设置。
4. 保存后该 Profile 变为未验证、停用；提供任务规格进行报价校验，再启用。
5. 企业管理员按原方式授权该 Profile，无需新建另一套模型授权。

新能力对应的 capabilities 示例：

```json
{
  "supportsVideoToVideo": true,
  "maxVideoReferenceCount": 3,
  "maxVideoReferenceBytes": 94371840,
  "videoReferenceMimeTypes": ["video/mp4", "video/quicktime"]
}
```

以上是现有 capabilities 的新增字段片段。旧 Profile 没有这些字段时视为未开放新能力。报价校验不会上传真实参考视频或触发付费生成，不能代替真实模型验收。

## 客户端流程

### 1. 主动读取 runtime

继续使用原订阅 runtime 接口。授权且可执行的新 Profile 会返回 `video-to-video`，并下发 `video_from_video` 工具标识。配置变更不主动推送给客户端。

新增字段片段：

```json
{
  "operations": ["text-to-video", "image-to-video", "video-to-video"],
  "adapter": {
    "videoReferenceSupport": {
      "maxCount": 3,
      "maxInputBytes": 94371840,
      "mimeTypes": ["video/mp4", "video/quicktime"]
    }
  },
  "videoReferenceRules": [
    {"operation":"text-to-video","minCount":0,"maxCount":0,"maxInputBytes":0,"mimeTypes":[]},
    {"operation":"image-to-video","minCount":0,"maxCount":0,"maxInputBytes":0,"mimeTypes":[]},
    {"operation":"video-to-video","minCount":1,"maxCount":3,"maxInputBytes":94371840,"mimeTypes":["video/mp4","video/quicktime"]}
  ]
}
```

这不是完整响应。原 `adapter.referenceSupport`、`referenceRules` 仍表示参考图片；新操作对应的图片数量为 0。新增视频字段只在 Profile 配置了新操作时返回。

### 2. 上传参考视频

```http
POST /api/gateway/v1/media/video-real/video-references?profileId=seedance_video_profile&configVersion=cfg_example
Authorization: Bearer <employment token>
Content-Type: multipart/form-data; boundary=...
```

只允许一个非空 `file`，不能增加其他 multipart 字段。多段参考视频分别上传。

成功 HTTP 201 示例：

```json
{
  "mock": false,
  "kind": "video",
  "referenceId": "cm_sep_video_reference_example",
  "profileId": "seedance_video_profile",
  "configVersion": "cfg_example",
  "mimeType": "video/mp4",
  "byteLength": 5242880,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "expiresAt": "2026-12-01T03:00:00Z"
}
```

`referenceId` 是 SEP ID；算力平台 `vref_...` 保存在内部。有效期采用算力平台真实回执，不采用图片的 15 分钟期限。素材绑定企业、订阅、成员、用户、Profile 版本及算力连接；切换 Profile 或连接后应重新上传。

处理顺序：身份认证 → 企业/成员/订阅授权 → Profile 版本和执行能力 → Redis 全平台上传准入（最多 2 个）→ 临时磁盘接收和大小限制 → SHA-256 → 真实容器和视频轨检查 → 使用同一算力 Key 上传 → 校验 201 回执 → 再查权限和配置 → 保存素材映射 → 返回 → 清理临时文件、释放上传名额。

SEP 不转码或压缩参考视频。正常和异常路径都会清理临时文件；清理失败记录服务端日志，下一次上传会清除本功能目录内超过一小时的残留。进程异常退出后的并发租约会自动到期。

### 3. 获取报价

```http
POST /api/gateway/v1/media/video-real/quotes
Authorization: Bearer <employment token>
Content-Type: application/json
```

```json
{
  "protocolVersion": 3,
  "specRevision": 1,
  "profileId": "seedance_video_profile",
  "configVersion": "cfg_example",
  "operation": "video-to-video",
  "referenceIds": [],
  "videoReferenceIds": ["cm_sep_video_reference_example"],
  "creativeBrief": "保留参考视频的运镜，将场景改为夜间街道",
  "requestedSpec": {
    "durationSeconds": 5,
    "resolution": "720p",
    "aspectRatio": "16:9",
    "audio": false,
    "outputFormat": "video/mp4"
  }
}
```

`referenceIds` 保持为空，视频放入 `videoReferenceIds`。服务器校验重复、数量、素材种类、归属、有效期、大小、格式、Profile 版本和连接。报价按 `video-to-video` 取得，包含 `billingDimensions.operation`。报价有效期不晚于参考视频有效期。

### 4. 提交与恢复

向原 `POST /api/gateway/v1/media/video-real/requests` 提交相同生成字段，增加报价返回的 `quoteId` 和唯一的 `clientRequestId`。

SEP 冻结素材 ID、哈希、上游素材 ID、规格、报价及连接。先原子认领请求、预留资金，写入派发标记后，向算力平台 `POST /v1/videos` 提交一次 JSON：

```json
{
  "model": "seedance-2.0-fast",
  "prompt": "保留参考视频的运镜，将场景改为夜间街道",
  "seconds": 5,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "generate_audio": false,
  "output_format": "video/mp4",
  "metadata": {
    "content": [
      {"type":"video_url","video_url":{"reference_id":"vref_0123456789abcdef0123456789abcdef"},"role":"reference_video"}
    ]
  }
}
```

派发同时携带原有幂等键、客户请求编号、`X-Video-Operation: video-to-video` 和报价版本。不会把视频文件再次放进生成请求。

继续使用：

- `GET /api/gateway/v1/media/video-real/requests/by-client-id/{clientRequestId}`
- `GET /api/gateway/v1/media/video-real/requests/{receiptId}`
- `GET /api/gateway/v1/media/video-real/requests/{receiptId}/outputs/{outputId}/content`

已受理任务使用原任务编号查询和下载。参考素材过期不触发重新上传或重新生成。提交响应丢失时保留 `SUBMISSION_UNKNOWN`，只恢复原请求；不能换一个请求编号自动重试。异步生成失败不代表上游没有扣费，也不承诺自动退款。

平台同时每 6 小时分批恢复待处理视频任务，按服务器本地时间每天 00:00、06:00、12:00、18:00 扫描，每页最多 20 条、同时最多 2 条。不判断客户端是否在线，客户端主动查询仍可触发恢复。客户端关闭后，后台仍可查询原任务、保存生成成品和核对原费用；进程重启后在下一个调度时间从数据库重新扫描。后台与客户端使用同一恢复逻辑和每任务 Redis 租约，始终不再次创建生成任务。获取文件前仍执行成员、订阅及 Profile 授权校验。

SEP 成品首次获取时固定 24 小时有效窗口，下载失败重试不延长。私有缓存每 12 小时分批清理过期条目（服务器本地时间 00:00 和 12:00），每轮最多扫描 1000 个目录项、删除 100 条；只删除文件，不删除任务及财务记录。文件过期立即禁止下载，物理清理受分批进度影响，积压时可能超过 12 小时才删除。客户端仍需通过下载接口将文件写入本地并校验，平台保存不等于客户端已保存。

## 错误

SEP 本地错误沿用普通网关错误响应，包含状态、消息、请求编号、时间、路径和 `error`。新上传处理错误增加 `origin: sep` 和处理 `stage`。例如：

```json
{
  "statusCode": 413,
  "message": "参考视频请求不能超过 92 MiB",
  "requestId": "sep-request-example",
  "timestamp": "2026-11-24T03:00:00.000Z",
  "path": "/api/gateway/v1/media/video-real/video-references",
  "error": {
    "code": "VIDEO_REFERENCE_TOO_LARGE",
    "message": "参考视频请求不能超过 92 MiB",
    "origin": "sep",
    "stage": "receive"
  }
}
```

| HTTP | 典型原因 / code |
| --- | --- |
| 400 | 请求字段、空文件、重复素材、混用图片、损坏视频或没有可读视频轨：`INVALID_PARAMETER`、`INVALID_VIDEO_REFERENCE_UPLOAD`、`INVALID_VIDEO_REFERENCE` |
| 401 | SEP employment token 无效；在接收文件前拒绝 |
| 403 | 成员、订阅、企业授权失效：`MEDIA_FORBIDDEN` |
| 404 | 素材不存在、种类不符或不属于当前作用域：`MEDIA_NOT_FOUND` |
| 408 | 上传断开或五分钟预算耗尽：`VIDEO_REFERENCE_UPLOAD_TIMEOUT` |
| 409 | Profile/连接变更、报价过期、重复请求语义冲突：`CONFIG_CHANGED`、`QUOTE_EXPIRED`、`IDEMPOTENCY_CONFLICT` |
| 410 | 输入素材过期：`REFERENCE_EXPIRED` |
| 413 | 文件超过 Profile 单文件上限或请求超过 92 MiB：`VIDEO_REFERENCE_TOO_LARGE` |
| 415 | 实际文件不是支持的 MP4/MOV，或 Profile 未允许该格式：`UNSUPPORTED_VIDEO_REFERENCE_FORMAT` |
| 422 | 不支持该操作或参考视频数量超过 Profile 上限：`INVALID_REFERENCE` |
| 429 | SEP 上传名额占满：`VIDEO_REFERENCE_UPLOAD_BUSY`，附 `Retry-After` |
| 502 | 上传连接/响应解析失败：`VIDEO_REFERENCE_UPLOAD_FAILED`；回执字段不一致：`INVALID_VIDEO_REFERENCE_RESPONSE` |
| 503 | 新执行关闭、磁盘不可用、准入 Redis 不可用、ffprobe 不可用等 |

连接断开时客户端不一定收到 HTTP 错误响应。五分钟内各阶段执行可用预算与 ffprobe/算力请求自身时限共同约束；网络连接错误不能仅凭状态判定素材已经保存。

算力平台真实返回的错误保持原 HTTP 状态、错误正文和安全的诊断头，按现有机制增加 `X-SEP-Error-Source: upstream`、`X-Compute-Status`。Key、签名链接等敏感数据脱敏。比如算力 429 的原 message、code 和 Retry-After 会保留。

算力返回 201 但缺少素材 ID、大小或期限不匹配时，SEP 返回自身的 502 校验错误，`origin: sep`，`stage: upload-validation`，`computeStatus: 201`；不会把它写成算力返回了 502。生成、查询、下载及账务错误继续沿用原链路。

## 部署与客户端要求

- 部署前确认 Longdao 目标版本已包含参考视频上传、视频生视频生成及报价合同。本地 Longdao 源码存在接口不等于线上已部署。
- SEP 继续使用现有视频连接和 Key。本地 pnpm 工具链为 Node 22.23.5；现有后端 Dockerfile 为 Node 20.19.0。本次没有修改运行时版本，已在对应 Node 20.19.0 Alpine 镜像离线验证文件型 multipart 和 AbortSignal API。部署前仍须核对 ffprobe、Redis 和临时目录写入权限。
- Caddy 已增加专用上传转发：仅此 POST 路径直达后端，限制 92 MiB，传输预算 330 秒；后端整条上传预算五分钟。其余 API 和图片上传不扩大超时。
- 不修改模型服务生命周期，不执行数据库迁移。
- CSEP 是另一个项目；本次没有修改它的源代码。客户端需扩展严格 schema、设置界面、参考视频选取和上传、`video_from_video` 工具及任务请求构造，发布时一起核对版本。
- 本地测试使用合成视频和模拟算力响应，没有调用付费生成或部署生产环境。真实部署后的完整验收仍需实际模型完成上传、生成、查询、下载和账务核对。

## 视频生视频异常验收补充

本地 HTTP 验收使用实际 MP4/MOV 文件、上传检查、算力适配器、任务存储和下载链路；算力网络与数据库、钱包采用测试替身，不代表真实付费联调完成。

| 场景 | 客户端回执及恢复要求 |
| --- | --- |
| Longdao 明确失败且不扣费 | HTTP 400/401/402/403/409/422/429/500/502/503/504 的完整回执均关闭任务；保留具体原因和原 HTTP 状态，释放 SEP 预留，重复读取不重复提交 |
| 只有错误 HTTP 状态，没有完整回执 | 保留提交未知、原错误及冻结资金，按原 request ID 恢复；不凭 403 或 502 推断未创建或免费 |
| 协议错误并携带诊断任务 ID | 保留任务 ID、原提交错误和记录错误；按明确失败、不扣费结束，不查询诊断任务或重建生成 |
| 已确认不扣费，但 SEP 释放失败 | 生成结束，钱包待核对；后台仅重试释放原预留，恢复后清除账务错误，保留原提交原因 |
| 已受理后生成失败 | submissionStatus 仍是 accepted，generationStatus 是 failed；保留 taskError，按上游独立账务证据核对 |
| 生成失败、账务未知 | 允许用户主动新建任务，继续核账，不推断退款；后续确认不扣费才释放 |
| 文件获取失败后恢复 | generationStatus 保持 completed，只重试原成品；成功后清除已解决的下载错误，保留历史提交诊断，不重复结算 |
| 用量金额与回执不一致 | 已生成文件仍可保存和下载，金额不强行结算或退款，账务待核对；证据修正后只结算一次 |
| 查询无证据或回执损坏 | 保留已知任务状态、原请求 ID 和资金，只记录本次查询错误；恢复后继续原任务 |
| 应用重启与参考素材过期 | 重建服务实例后按数据库原 request ID 恢复，沿用原素材映射和成品文件，不重复上传、生成或结算 |

定时任务沿用项目已安装的 NestJS Schedule。测试实际注册两个调度任务并推进虚拟时间，检查 6 小时前不扫描、每 6 小时触发恢复、每 12 小时触发清理，以及应用关闭后不再触发。等待到点期间保留少量定时器和状态，没有数据库事务或生成 HTTP 连接占用；真正扫描、查询、下载时才使用数据库、网络和磁盘。等待已经发出的网络请求时仍有连接、缓冲和内存开销，异步等待不等于零资源。每个后端进程本轮最多处理 2 个恢复任务，同任务跨进程通过 Redis 租约协调；多实例总体并发会随实例数增加。

## 本地验证记录

| 检查 | 结果 |
| --- | --- |
| 本轮视频生视频异常验收及相关回归 | 8 组、211 项通过。包含明确失败/协议错误、不完整回执、生成失败、下载失败恢复、账务证据矛盾、释放失败恢复、服务实例重启及定时器实际注册/触发/关闭验证。数据库和算力响应为测试替身；不代表真实付费联调或原有文件安全测试全部通过 |
| 新增请求 schema、上传准入/大小/中断及真实文件 HTTP 链路 | 3 组、25 项通过。包含合成 MP4/MOV、纯音频/损坏文件拒绝、chunked 请求实际 92 MiB 超限、并发重复提交和原回执恢复。算力响应为测试替身 |
| 视频/图片网关、媒体配置及共享合同扩展回归 | 执行时记录为 44 组通过、1 组失败、6 组跳过；1,284 项通过、5 项失败、44 项跳过。最后新增的 3 项上传资源测试在上行单独通过 |
| 未通过的扩展回归 | 未改动的 `video-file-cache.security.spec.ts` 中 5 项：2 项 Windows 并发文件发布失败，3 项符号链接创建 `EPERM`。相应实现文件本次未修改；不能据此声称全量回归通过 |
| 前端配置和授权相关单测 | 5 组、48 项通过 |
| 真实页面检查 | Playwright 桌面 1440px、窄屏 390px 两项通过；覆盖后台显示/保存、企业授权页限制展示及页面无水平溢出。API 为合成数据替身，截图在 `output/video-reference-ui/` |
| 后端、前端类型检查 | 通过 |
| 后端代码编译 | `pnpm --dir backend exec nest build` 通过 |
| 标准后端 build | 前置头像资源检查未通过。92 份资源的版本哈希均匹配，现有索引包含 CRLF，而检查脚本按 LF 生成后逐字比较。本次未改动索引或头像资源，未绕过发布检查 |
| 前端生产构建 | `pnpm --dir web build` 通过 |
| Caddy 上传入口 | 以本地 `caddy:2-alpine` 容器执行 `caddy validate`，配置有效。存在原有格式及冗余转发头警告，未顺带格式化整个文件 |
| 现有镜像运行时兼容性 | 以 `node:20.19.0-alpine3.21` 容器、禁用网络，实际创建文件型 Blob、组装 multipart 并消费 Request 字节，正文及 MIME 均正确；`AbortSignal.any` 可用 |
| Git diff | 空白检查通过；未提交、合并或推送 |

尚未验证真实 Longdao 上传、付费生成、生产入口传输速度及生产账务。真实数据库并发专项测试仍按原环境开关跳过。
