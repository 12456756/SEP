# SEP 视频生视频开发方案

日期：2026-11-24。状态：设计方案已形成 SEP 本地实现；真实上游联调和部署尚未进行。接口、客户端要求及验证记录见 [接入说明](2026-11-24-video-to-video-implementation.md)。

## 1. 目标与核查基线

让客户端选择平台已授权的视频模型，上传一段或多段参考视频，填写提示词及生成参数，经 SEP 报价、提交、查询和下载生成的视频。

复用现有图生视频的业务流程和授权、账务、幂等恢复机制。参考视频先由 SEP 转传 Longdao，取得素材 ID；生成时发送素材 ID，不在生成请求中重复上传视频文件。

核查来源：

- SEP 本地提交：`fa583fd9171479ae731edfdc02257a75417380fe`。工作区已有其他修改，本方案不包含这些修改。
- Longdao 工作区：`D:/github/LongdaoAI-worktree-two`，HEAD 为 `761dcc47`，参考视频相关文档和实现存在未提交改动。
- 上游合同：该工作区的 `backend/OPENAI_VIDEOS.md`，以及 `video_reference.go`、`video_reference_file.go`、`video_reference_content.go`、`gateway_video_billing.go`。
- 上述是本地源码核查，不是远端分支或生产部署确认。联调前必须确认 Longdao 目标部署已经包含上传、生成、报价和素材归属校验相关实现。

## 2. 首期范围

1. 新增 `video-to-video` 操作，支持多个参考视频，单次上传一个文件。
2. 输入支持 MP4、MOV，单文件最多 90 MiB；输出继续使用现有 MP4 下载与校验流程。
3. 继续使用明确的正整数生成时长、已有分辨率、比例及音频生成参数。帧率保持现有“不转发”规则。
4. 首期提示词仍必填，保持当前任务输入约定；不接入 `seconds: -1` 自动时长。
5. 首期纯参考视频，不接入音频参考、任意 URL、`asset://`，也不把客户端直接提供的 Longdao 素材 ID 作为可信输入。
6. 图片加视频的混合参考后续单独接入。Longdao 新路径接收的是 `metadata.content`，SEP 当前图片参考存于私有缓存，不能直接当作可访问的图片 URL；也不能假定同时发送 `input_reference` 和 `metadata.content` 就会合并素材。

Longdao 文档声明 Seedance 2.0 系列最多 3 个参考视频、2.5 最多 10 个。这不是“上传接口每次可以上传多个文件”，也不是所有视频模型都支持视频参考。SEP 仅为已明确配置且经联调确认的 Profile 开放该操作。

## 3. 当前图生视频流程与复用点

```text
客户端主动获取订阅 runtime
    ↓
选择企业授权的 Profile 和参数
    ↓
POST /api/gateway/v1/media/video-real/references
SEP 校验并私有保存参考图片，返回 SEP referenceId
    ↓
POST /api/gateway/v1/media/video-real/quotes
冻结规格、参考图哈希、连接及报价，默认报价有效期不超过 60 秒
    ↓
POST /api/gateway/v1/media/video-real/requests
认领幂等请求、预留资金、转发图片并提交一次生成
    ↓
按原 clientRequestId / receiptId 查询
    ↓
查询原 Longdao 视频任务 → 下载原结果 → 校验成品 → 对账
    ↓
客户端下载 SEP 私有成品
```

当前参考图片通常有效 15 分钟、成品缓存通常 24 小时。参考视频是另一种资源，不能直接套用图片的 10 MiB 大小、15 分钟期限、图片 MIME 和宽高校验。

## 4. 接口设计

本节字段均为拟定契约，需要与 CSEP 同步后实现。

### 4.1 新增参考视频上传接口

```text
POST /api/gateway/v1/media/video-real/video-references
    ?profileId=<profileId>&configVersion=<configVersion>
Authorization: Bearer <employment token>
Content-Type: multipart/form-data; boundary=...
```

- multipart 只允许一个非空 `file`，没有其他字段；Profile 信息放 Query，由共享 Zod DTO 校验。
- 文件上限 94,371,840 字节（90 MiB），整个请求上限 96,468,992 字节（92 MiB）。实际流量计数也必须受限，不能只相信 Content-Length。
- 沿用 `ClientEmploymentGuard`；先检查会员、订阅、企业授权、Profile 版本、真实执行开关及 `video-to-video` 能力，再接收文件和占用磁盘。
- 上传不预留生成资金，也不调用生成接口。资金检查和预留仍在报价、提交阶段处理。
- 单独的上传准入 Guard 在 multipart 解析之前获取并发槽；普通请求次数限流继续生效。

成功返回 HTTP 201，示例：

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

`referenceId` 是 SEP 自己创建的 ID，不是 Longdao 的 `vref_...`。客户端只保存、提交 SEP ID；上传时算出的 SHA-256、上游 ID 和连接指纹由服务端关联保存。

MP4 返回 `video/mp4`，MOV 返回 `video/quicktime`。`expiresAt` 使用 Longdao 实际回执，不根据图片 TTL 生成，也不每次查询顺延。Longdao 当前约定上传后 7 天内可用于新任务。

### 4.2 继续复用原报价、提交和恢复接口

| 用途 | SEP 接口 |
| --- | --- |
| 获取能力 | `GET /api/client/subscriptions/{subscriptionId}/runtime` |
| 参考图片上传 | 原 `/api/gateway/v1/media/video-real/references`，保持图片语义 |
| 参考视频上传 | 新 `/api/gateway/v1/media/video-real/video-references` |
| 获取报价 | 原 `POST /api/gateway/v1/media/video-real/quotes` |
| 提交生成 | 原 `POST /api/gateway/v1/media/video-real/requests` |
| 用客户端编号恢复 | 原 `GET /api/gateway/v1/media/video-real/requests/by-client-id/{requestId}` |
| 查询任务 | 原 `GET /api/gateway/v1/media/video-real/requests/{receiptId}` |
| 下载成品 | 原 `GET /api/gateway/v1/media/video-real/requests/{receiptId}/outputs/{outputId}/content` |

V3 请求增加 `videoReferenceIds`。现有 `referenceIds` 继续表示参考图片，不混用两种 ID。

首期操作与素材关系：

| operation | referenceIds（图片） | videoReferenceIds（视频） |
| --- | --- | --- |
| `text-to-video` | 空 | 空 |
| `image-to-video` | 按原规则至少一张 | 空 |
| `video-to-video` | 空 | 至少一个，且不超过有效 Profile 上限 |

未传 `videoReferenceIds` 时，原文生、图生请求按空数组规范化；新操作禁止重复素材 ID。客户端不能通过填错 operation 绕过视频报价。

视频生视频报价请求示例：

```json
{
  "protocolVersion": 3,
  "specRevision": 1,
  "profileId": "seedance_video_profile",
  "configVersion": "cfg_example",
  "operation": "video-to-video",
  "referenceIds": [],
  "videoReferenceIds": ["cm_sep_video_reference_example"],
  "creativeBrief": "保留参考视频的运镜，把场景改为夜间街道",
  "requestedSpec": {
    "durationSeconds": 5,
    "resolution": "720p",
    "aspectRatio": "16:9",
    "audio": false,
    "outputFormat": "video/mp4"
  },
  "parameterSources": {
    "durationSeconds": "user",
    "resolution": "user",
    "aspectRatio": "user",
    "audio": "user"
  }
}
```

提交请求使用相同生成字段，增加原有 `quoteId` 和唯一 `clientRequestId`。报价、回执中的 `operation`、`billingDimensions.operation` 同步支持 `video-to-video`。

V3 承担新操作，不扩展旧 V1/mock 的真实执行能力。必须检查共享枚举的引用：不能仅把公共 enum 增加一项，导致旧格式和 mock 被动接受未实现的操作。历史请求、报价和回执继续可读，不因本功能删除旧解析逻辑。

## 5. 平台后台、企业授权与 runtime

### 5.1 平台 Profile

后台视频 Profile 增加“视频生视频”操作，以及独立的输入能力：

```json
{
  "supportsVideoToVideo": true,
  "maxVideoReferenceCount": 3,
  "maxVideoReferenceBytes": 94371840,
  "videoReferenceMimeTypes": ["video/mp4", "video/quicktime"]
}
```

- 已存 Profile 默认 `supportsVideoToVideo=false`、视频参考数量为 0，不能因升级自动获得新能力。
- 支持该操作时，数量至少为 1；平台适配器首期总上限为 10，具体 Profile 配置与真实模型合同取更小值。2.0 示例可配置 1～3，2.5 示例可配置 1～10；这两档依据来自 Longdao 当前合同，不从任意模型名猜测能力。
- 大小允许低于上游 90 MiB，不能高于上游上限；格式只能选择适配器已实现的 MP4/MOV。
- `maxReferenceCount`、`maxInputBytes` 仍是图片参考配置，不能改成视频上限。`supportsAudio` 是生成声音，与“允许上传音频参考”无关。
- 输出时长仍使用已有最短/最长设置；分辨率、比例及质量等建议选项的软硬限制规则不因这次改动改变。
- 修改操作或输入合同后，沿用当前 Profile 版本变更和重新校验、启用机制。已有任务使用冻结快照恢复，不依赖新素材期限。
- Profile 校验可验证模型目录、连接和 `video-to-video` 报价；它不发收费生成，也不能证明模型实际生成成功。新增 `supportsVideoToVideo` 默认关闭，真实联调通过后才启用。

### 5.2 企业管理员

继续按现有方式选择允许使用的 Profile 和默认 Profile，无需新增一套企业视频模型绑定。页面展示该 Profile 已开放的三种操作及图片/视频各自的输入数量与大小。

不重新启用历史企业字段 `maxConcurrentJobs`、`allowedOperations` 等当前已不参与真实执行限制的逻辑。

### 5.3 客户端主动获取配置

继续复用原订阅 runtime，不新增推送或后台变更后自动刷新。客户端主动调用接口时，才获得新的能力。

建议在 V3 中增加 `adapter.videoReferenceSupport` 与顶层 `videoReferenceRules`，现有 `adapter.referenceSupport`、`referenceRules` 保持图片语义。示例片段：

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
    {
      "operation": "video-to-video",
      "minCount": 1,
      "maxCount": 3,
      "maxInputBytes": 94371840,
      "mimeTypes": ["video/mp4", "video/quicktime"]
    }
  ]
}
```

上面是 Profile 的新增字段片段，不是完整 runtime 响应。对于原有操作，视频参考数量按 0 处理；显式返回的图片规则也须覆盖新操作并标明图片数量为 0。视频规则不重复维护一套数字：由 Profile 与适配器的同一份有效限制生成，并在服务端执行同样校验。

生成参数的 `operations`、规则 schema、有效操作过滤、工具注册一并扩展，只有存在授权且可执行的 Profile 时才下发 `video_from_video`。继续复用 `video_get_job` 查询和能力查看，不另建一套模型目录。

现有 schema 使用 strict，新增字段不是对任意旧客户端都透明。SEP 与 CSEP 必须一起更新共享合同、解析器和样例；发布前核对现网 CSEP 版本。无需为此另开 V4，但不能在旧解析器尚未接入时直接启用、下发新结构或新操作。

## 6. 上传与生成的完整流程

```text
客户端主动获取 runtime，确认 video-to-video 可用
    ↓
选取参考 MP4/MOV，按下发的单文件大小和数量预检查
    ↓
逐个调用 SEP video-references（每次一个 file）
    ↓
SEP 认证 → 业务授权 → Profile 版本/操作检查 → 上传并发准入
    ↓
流式写入私有临时文件，计数并计算 SHA-256
检查空文件、multipart 结构、大小和真实视频容器/视频轨
    ↓
SEP 使用冻结的 Longdao 视频连接和 Key
POST /v1/videos/references，以 file 字段转传临时文件
    ↓
验证 HTTP 201、reference_id、content_type、size_bytes、expires_at
    ↓
把 SEP ID、Longdao ID、用户作用域、文件哈希和连接指纹持久保存
提交本地 metadata 成功后才向客户端返回 HTTP 201
清除本次临时文件，释放并发槽
    ↓
全部素材上传完成后，客户端请求 quotes
SEP 再查授权、有效 Profile、素材归属、类型、期限和连接一致性
    ↓
向 Longdao 请求 operation=video-to-video 的报价，冻结规格和素材快照
    ↓
客户端确认后提交 requests
    ↓
先按 clientRequestId 查原请求；存在则恢复，不再上传、不再提交
    ↓
新请求检查报价和素材 → 原子认领 → 预留资金 → 记录派发标记
    ↓
POST Longdao /v1/videos，仅提交一次生成
    ↓
保存原 taskId 与可验证的计费关联 ID，返回原回执
    ↓
原查询 → 原任务下载 → 成品检查 → 原账务查询
```

### 6.1 上传存储与资源使用

- 90 MiB 不能直接照抄参考图的 `memoryStorage()` 再多次复制 Buffer。使用现有 Multer 的磁盘/自定义流式存储，限制单文件和整体字节数，在固定私有目录生成随机文件名。
- 上传到 Longdao 时从临时文件读取，使用标准 multipart 工具及当前 Node 支持的文件对象；实现前验证构建和生产 Node 均支持所选文件 API，不新增未经批准的依赖。
- 可以借鉴既有 ffprobe 文件检查，但输入 MP4/MOV 与输出 MP4 的校验合同应分开；不能套用成品时长、帧率和“必须恰好一个视频轨”等规则。只检查真实容器、有可读视频轨及可安全解析；不知道的供应商输入时长、分辨率、编码限制不凭空填写硬上限。
- ffprobe 限定本地文件访问、运行时限及输出大小，避免输入文件触发远程资源读取。参考视频不转码、不降质、不重新封装。
- 建议 SEP 初始上传并发为全平台最多 2 个，使用 Redis 租约覆盖所有后端实例，不把 Longdao 并发额度当作 SEP 额度。超限返回 429，不在内存排长队。租约要有有界续期和所有权校验，覆盖整个接收、校验、转传阶段。
- 建议上传整体预算 300 秒，单次向 Longdao 转传预算不超过 180 秒且受整体剩余预算约束；Caddy 和客户端至少覆盖整体预算及响应余量（建议 330 秒）。这是拟定值，需用实际带宽验证，不改变生成或知识库向量化超时。
- 成功、失败、超时、断连都清理本次临时文件；启动时清理超龄且无活跃租约的残留文件，不能删除正在上传的文件。目录设磁盘预算和剩余空间阈值。
- 临时目录仅应用账号可写，文件使用不可预测的服务端文件名，不使用客户端原始路径。转传前后重新检查授权、Profile 和冻结连接，处理长上传期间企业停用、Profile 更新或连接变化；不能在权限已撤销后返回可用素材承诺。
- Longdao 已持久保存成功的视频，SEP 首期只保存 metadata，不再长期复制一份参考视频，不新增公开下载地址。

### 6.2 素材 ID、归属与有效期

复用现有 `media_gateway_references` 表，在 metadata 中使用新的明确判别值，例如 `adapter: sub2api-video-reference-v1`，避免现有图片解析器误读。拟保存：

- 当前 `scope`：企业、订阅、成员、用户，沿用现有作用域。
- `kind=video`、Profile ID、Longdao `reference_id`、MIME、字节数、SHA-256、实际到期时间。
- 连接指纹和上传时实际收到的请求追踪信息；不保存 Key 明文或签名 URL。

客户端传入的 ID 必须在当前作用域内解析为视频素材。不存在、属于别人或类型不符，返回不泄露资源归属的信息。

上传和提交必须使用同一份 Longdao 连接身份；现有连接指纹由基地址和 Key 生成，发生变化时禁止将旧素材 ID 交给新 Key，提示重新上传并报价。Longdao 还会校验同 Key/分组的归属；Key 所属分组在 Longdao 后台变化而 SEP 指纹不变的情况，仍需保留其真实 404，不能宣称本地指纹已覆盖所有变化。

Profile 的小范围版本更新不必物理删除素材；新任务仍按当前 Profile 重新检查，不把旧版本输入上限当永久授权。已经提交的任务使用冻结素材快照和原任务 ID，不能因“用于新任务的素材 ID 过期”而阻止查询、下载。

本次新增字段都可位于既有 JSON metadata/configuration 中，预计不需要 Prisma 表结构迁移；实现时若出现必须改 schema 的需求，另行说明并使用工具生成迁移。

### 6.3 上传结果丢失

如果 Longdao 已保存素材但 SEP 未收到/未保存回执，不创建生成任务、不预留生成费，也不伪造成功素材 ID。可能留下未被引用的上游素材，依赖上游到期清理。

首期不实现断点续传，不自动无限重传。客户端可重新上传素材；这不会重新生成视频，但会占用带宽与临时存储。上传成功、metadata 已保存但客户端丢失响应时，重新上传可能产生另一份素材，不能承诺上传幂等。

## 7. Longdao 适配器变化

新增 `uploadVideoReference()`，使用已验证、冻结的连接调用 `/videos/references`，只转传文件，不把 SEP 的 Profile、订阅和用户信息塞进 multipart。

上传回执检查：

1. 必须实际收到 201；正文是有效且有大小上限的 JSON。
2. `reference_id` 符合 Longdao `vref_` ID 合同；不能缺失或随意替换。
3. MIME 是 MP4/MOV，字节数与本地接收文件一致。
4. `expires_at` 可解析且未来有效，不超过合同允许范围及合理时钟偏差；客户端收到的是上游实际值。
5. 不能假称上游提供了 SHA-256：当前回执没有该字段，本地哈希只证明 SEP 接收和发送的文件内容。

生成时，SEP 从本地关联记录取 Longdao ID，组装 JSON，例如：

```json
{
  "model": "seedance-2.0-fast",
  "prompt": "保留参考视频的运镜，把场景改为夜间街道",
  "seconds": 5,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "generate_audio": false,
  "output_format": "video/mp4",
  "metadata": {
    "content": [
      {
        "type": "video_url",
        "video_url": {
          "reference_id": "vref_0123456789abcdef0123456789abcdef"
        },
        "role": "reference_video"
      }
    ]
  }
}
```

生成请求继续设置：

```text
X-Video-Operation: video-to-video
X-Video-Pricing-Version: <真实报价版本>
X-Client-Request-ID: <原 clientRequestId>
Idempotency-Key: <原 clientRequestId>
```

视频参考路径发送 JSON；图片参考继续原 multipart 路径。明确使用三分支，不能让视频参考误走“不是文生就按图片读取”的旧逻辑。`audio=false` 必须保留；不转发 fps，不复制供应商密钥给客户端。

`PricingSchema`、报价/回执 `billingDimensions`、冻结规格、存储解码、操作校验等同步增加 `video-to-video`。不只改提交函数。

## 8. 报价、计费和防止重复生成

- 所有参考视频先上传完，再请求短有效期报价，避免 90 MiB 上传消耗掉报价期限。
- 报价 operation 使用 `video-to-video`，提交头也必须一致，不能拿图生价格提交视频参考。
- 金额以 Longdao 当前 Key 可核验的客户报价为准，按现有汇率和资金来源处理。不把上游成本、平台售价、用户余额消耗混为一谈。
- 首期要求明确输出时长；Longdao 自动时长需要按次定价和可空时长账务字段，而 SEP 当前合同要求正整数时长，所以不能只开放 `-1`。
- 素材列表的顺序、SEP ID、文件哈希、Longdao ID、连接指纹与生成规格一起冻结，进入报价校验和请求语义哈希；旧请求缺少新数组时规范化为空，不能让既有幂等哈希无意改变。
- 上传调用和生成调用的请求编号分开，只有生成回执中的实际计费关联信息才能用于用量对账。不能用素材上传请求编号替代生成计费编号。
- 复用现有数据库认领/CAS、资金预留、派发标记及 `SUBMISSION_UNKNOWN`。先查原 clientRequestId，重放原请求时不重新校验已过期的新任务素材、不重新派发。
- 提交超时、连接断开、回执缺任务标识时保留已知证据和不确定状态，不自动重发、不切换账号再生成。只有真实证据确认未派发/未收费时，才按现有合同释放资金。
- 查询/下载/对账失败不能冒充生成失败；生成原错误需要保留，后续故障另记阶段。
- Longdao 当前文档明确“上游受理后记录一次用量，异步失败不自动退款”。因此生成失败与扣费成立可以同时出现；SEP 不能因 failed 自动宣称退款，也不能因 SETTLED 就认定成品生成成功。

## 9. 错误与客户端恢复

### 9.1 SEP 本地新增/复用错误

| HTTP | 拟用 code | 阶段和含义 | 客户端处理 |
| --- | --- | --- | --- |
| 400 | `INVALID_VIDEO_REFERENCE_UPLOAD` | 少文件、空文件、多字段或 multipart 不合法 | 修正文件上传 |
| 401/403 | 现有认证/授权错误 | 身份、订阅、企业或 Profile 无权使用 | 按真实来源处理身份/授权 |
| 404 | `MEDIA_NOT_FOUND` | 本作用域没有对应视频素材 | 重新选择/上传，不泄露他人资源 |
| 409 | `CONFIG_CHANGED` | Profile 或视频连接已改变 | 主动刷新配置，必要时重新上传、报价 |
| 410 | `REFERENCE_EXPIRED` | 素材不能再用于新任务 | 重新上传，再报价 |
| 413 | `VIDEO_REFERENCE_TOO_LARGE` | 文件超过有效上限，或请求超过 92 MiB | 减小文件 |
| 415 | `UNSUPPORTED_VIDEO_REFERENCE_FORMAT` | 不是有效 MP4/MOV，或无视频轨 | 更换真实视频文件 |
| 422 | `INVALID_REFERENCE` | 素材种类、数量、操作不匹配 | 按字段错误修正 |
| 429 | `VIDEO_REFERENCE_UPLOAD_BUSY` | SEP 上传槽已满 | 按实际 Retry-After 退避 |
| 502 | `VIDEO_REFERENCE_RESPONSE_INVALID` | 真收到 Longdao 响应，但上传回执不符合合同 | 保留实际状态与编号，未生成任务 |
| 503 | `VIDEO_REFERENCE_STORAGE_UNAVAILABLE` | SEP 私有临时存储/素材 metadata 保存不可用 | 稍后重新上传；不报生成成功 |
| 503 | `VIDEO_INSPECTOR_UNAVAILABLE` | 本地视频检查组件不可用 | 联系平台处理 |
| 504 | `VIDEO_REFERENCE_UPLOAD_TIMEOUT` | SEP 接收或转传超时 | 上传状态不确定，未自动生成 |

建议上传诊断阶段为 `reference-upload-receive`、`reference-upload-inspect`、`reference-upload-forward`、`reference-upload-validation`、`reference-upload-persist`。生成后的 query/download/output-validation/billing 阶段继续按媒体错误交接方案明确区分，不能为了本功能覆盖已知原错误。

### 9.2 Longdao 实际错误原样保留

| HTTP | Longdao error.code |
| --- | --- |
| 400 | `invalid_video_reference_upload` / `invalid_video_reference` |
| 413 | `video_reference_too_large` |
| 415 | `unsupported_video_reference_format` |
| 429 | `rate_limit_error` |
| 503 | `video_reference_storage_error` |
| 404 | `video_reference_not_found` |
| 410 | `video_reference_expired` |

保留真实状态、原始安全 message、数字或字符串错误码及追踪头。Longdao 的 `source: platform` 指 Longdao 自己，SEP 不应把其正文 source 擅自改写；用 SEP 的来源响应头和分层诊断识别这一跳。

本地传输失败未收到响应时，不设置虚假的 `X-Compute-Status`。若 Longdao 真返回 201 但 SEP 校验失败，对外可以 502，但明确 `origin=sep`、阶段 `reference-upload-validation`，实际算力状态只记 201。不得把它包装成“算力返回 502”。可复用异常工具，但不能直接继承现有媒体来源误标缺陷。

没有 Retry-After 时不要编造上游恢复倒计时。上游 401/403 不等于 SEP 会话失效，不能让客户端自动退登。响应和日志排除 Key、签名地址、完整敏感提示词；保留 SEP、Longdao、供应商和任务 ID 的层次，不互相代填。

## 10. 客户端需要同步的内容

1. runtime 和视频任务 schema 支持新操作、新参考视频字段和工具 `video_from_video`。
2. 在任务参考素材区允许选 MP4/MOV，按有效数量和单文件大小预检查，展示逐文件进度、上传失败和过期状态。
3. 一次上传一个文件；按服务器并发额度控制并行上传，不把多个文件塞进一个 file 请求。
4. 上传完成保存 SEP ID、文件哈希、期限及其连接/Profile 关联；文件变化后重新上传，不能复用原素材或报价。
5. 新操作发 `videoReferenceIds`，原图片 ID 字段为空；取得报价后再经现有确认流程提交。
6. 客户端持久化原 clientRequestId、quoteId、receiptId 和任务状态；中断后查询原任务，不自动新建收费生成。
7. 保留 `video_get_job` 的任务查询；更新工具注册、编排操作枚举、任务历史和恢复记录，避免新操作被默认归为文生视频。
8. 设置页仍由客户端主动获取 runtime，不增加平台配置实时推送。

本方案不修改 CSEP 仓库，交付接口及样例后由两端配合实施。

## 11. 预计修改文件

| 范围 | 文件/模块 | 修改要点 |
| --- | --- | --- |
| 共享合同 | `backend/src/shared/media-video.dto.ts`、`media-video-real.dto.ts`、`media-video-config.dto.ts` | 新操作、素材响应、请求/报价/回执和 Profile 字段，区分旧格式 |
| runtime | `backend/src/shared/media-spec.dto.ts`、`media-runtime-parameters.ts`、共享导出 | 参考视频规则、工具、三种操作与默认值 |
| 配置服务 | `backend/src/modules/media-config/media-video-config.service.ts`、`media-runtime-capabilities.ts` | 有效能力、报价校验、授权 Profile、runtime 组装 |
| 上传接口 | `backend/src/modules/media-gateway/media-video-real.controller.ts`、新上传 Guard/Interceptor/临时存储服务 | 文件流、前置授权、大小/并发/中断清理及 Swagger |
| 适配器 | `backend/src/modules/media-gateway/sub2api-video.adapter.ts` | 上传素材、JSON 提交、报价和错误来源 |
| 业务/存储 | `backend/src/modules/media-gateway/media-video-real.service.ts`、`media-video-real.store.ts` | 素材 metadata、冻结/哈希/幂等恢复及原任务流程 |
| 模块注册 | `backend/src/modules/media-gateway/` 对应 module | 注册新增 provider，不绕过现有依赖注入 |
| 文件检查 | 新输入视频检查服务，参考 `video-file-cache.service.ts` | 输入检查与已有成品检查分开 |
| 平台后台 | `web/src/features/admin/media-profile-workflow.tsx`、`media-models-panel-view.tsx` 及 hooks | 视频生视频选项和独立素材数量/大小 |
| 企业后台 | `web/src/features/enterprise-settings/video-policy-panel.tsx` 及配置类型 | 展示新能力，沿用 Profile 授权 |
| 入口配置 | `deploy/standalone/Caddyfile` 及相关发布检查 | 独立视频上传路由、92 MiB 上限、上传预算 |
| 测试与交接 | 对应共享 schema、配置、适配器、HTTP、存储、计费、UI 测试及客户端文档 | 包含错误样例和实际验收结果 |

入口配置特别注意：当前普通 `/api` 请求经 Next.js 转发，本地 `web/next.config.mjs` 已声明代理请求体上限 110mb、默认代理超时 180 秒；这不是生产配置确认。不能只改 Nest 文件大小。建议参照现有独立上传路径，为新参考视频上传精确匹配并直接代理后端，检查 method/path、上限、超时和公共域名访问，使上传预算不受 Next.js 通用代理预算影响；不扩大全站 JSON 限制。

## 12. 实施顺序与验收

### 12.1 实施顺序

1. 与 CSEP 确认本方案字段、工具和首期范围；确认 Longdao 目标部署的合同版本。新能力开关默认关闭。
2. 共享 schema、Profile、runtime、存储 JSON 合同及历史读取回归。
3. 上传接口、私有临时存储、上传并发、Longdao 上传适配及 metadata 持久化。
4. 复用报价/提交/查询，接入视频参考快照、JSON 转发和计费维度。
5. 平台/企业页面与客户端接入；先本地 mock 验证，再在测试环境联调。
6. 验证上传入口和 Node/ffprobe/磁盘等部署条件；生成用真实任务验收后再开放生产 Profile。

### 12.2 必须覆盖的验收场景

| 类别 | 场景及通过标准 |
| --- | --- |
| 原功能 | 原文生、单图/多图生视频及历史回执可用；图片大小仍为原限制，不被视频的 90 MiB 改写 |
| 上传 | MP4/MOV 各一份成功；伪造后缀、纯音频、损坏容器、空文件、多 file、额外字段分别拒绝 |
| 边界 | 90 MiB 文件边界、超过 1 字节、92 MiB 请求上限、无 Content-Length 实际超限、慢上传及中途断开 |
| 资源 | 超并发返回 429；失败和断连释放租约/临时文件；低磁盘空间、服务重启残留处理 |
| 权限 | 未授权在解析大文件前拒绝；跨企业/订阅/成员素材不可用；不能以原始 vref 绕过归属 |
| 连接 | Key/基地址变化阻止旧素材新提交；Longdao 分组变化的真实 404 可见；原任务恢复不重新路由 |
| Profile | 新能力默认关闭；上限/时长/操作生效；runtime、界面和后端限制一致；frameRate 不转发、audio=false 保留 |
| 素材与报价 | 缺失/重复/过期/类型错误/数量超限；报价后顺序/文件/连接/规格变化会拒绝；上传在报价前完成 |
| 上游回执 | 实际 201 正常；201 缺 ID/大小错误/期限错误会报 SEP 校验错误，不伪装成算力 502 |
| 任务 | 受理后成功、供应商明确失败、HTTP 200 内业务失败；查询一次失败不改生成终态；下载失败只查/下载原任务 |
| 幂等 | 并发提交只派发一次；相同 ID 不同素材冲突；提交响应丢失保留 UNKNOWN；素材过期后原任务仍能恢复 |
| 账务 | operation 与报价版本一致；预留/结算/对账按原合同；扣费后生成失败如实呈现，不假称已退款 |
| 脱敏 | 多层 ID 独立保存；上游 401/403 不触发 SEP 退登；原始原因保留且不泄露 Key/签名 URL |
| 入口 | 公共域名上传与响应可达，大小/预算一致；新路由不影响其他 API、图片和下载 |
| 前端 | 平台及企业配置页保存、回显、窄屏和桌面截图；客户端选择/上传/报价/任务恢复完整操作 |

先运行对应测试，再执行受影响的后端/前端 typecheck、构建和入口配置检查。上传的真实联调只创建素材，不提交生成；最终付费测试须明确一次模型、时长和费用预算，并记录 taskId 后仅查询原任务，不把自动化回归连接到付费上游。

## 13. 交付标准

交付代码、测试记录、接口 JSON/错误样例、CSEP 接入说明、测试环境完整流程记录和发布配置检查结果。分别报告上传、生成、查询、下载、账务是否通过，不能用“接口 201/202”代替整条链路验收。

方案编写后已按本期范围完成 SEP 本地实现。没有上传真实素材或发起收费生成，没有修改生产配置、提交代码或部署。实际验证与未验证项以接入说明为准。
