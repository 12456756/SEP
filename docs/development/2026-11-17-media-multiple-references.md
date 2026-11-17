# 图片与视频多参考图接入

## 后台配置

在「系统设置 → 模型管理 → 图片 / 视频」中，对已创建的 Profile 点击「编辑能力配置」。自动同步生成的 Profile 也可以编辑能力，模型标识和执行协议仍由适配器维护。

- 图片：开启「支持参考图编辑」，选择「图片编辑」，填写「最多参考图数量」。
- 视频：选择「图生视频」，填写「最多参考图数量」。
- 配置保存在数据库 `MediaModelProfile.capabilities.maxReferenceCount`，不需要新增数据库字段或迁移。
- 保存能力配置会更新 `configVersion`、撤销原报价校验状态；视频同时停用。重新报价校验并启用后生效。企业仍须授权该 Profile。
- 再次同步目录不会把已保存的参考图数量重置为默认值。

系统保护上限为 32 张，实际请求必须同时满足 Profile 配置。未声明新字段的历史图片 Profile 默认 4 张，历史视频 Profile 保留原配置。总参考图字节数上限为 100 MiB；图片每张最多 5 MiB，视频每张最多 10 MiB，均只接受 PNG。视频 Profile 的单张限制还可进一步缩小。

## 客户端 V3 流程

1. 刷新运行时能力，读取 `profiles[].adapter.referenceSupport.maxCount`、`maxInputBytes`、`mimeTypes`。参考图数量是实际适配器限制，不是普通规格提示。
2. 每张图分别上传一次，获得不同的 `referenceId`。图片上传到 `POST /api/gateway/v1/media/real/references`；视频上传到 `POST /api/gateway/v1/media/video-real/references`。
3. 在同一次报价中按顺序提交全部 `referenceIds`；图片使用 `operation: "edit"`，视频使用 `operation: "image-to-video"`。
4. 提交生成时使用同样的参考图顺序、规格、报价 ID 和 `clientRequestId`。参考图属于当前企业、用户、成员和订阅，默认 15 分钟过期。
5. 已提交请求只能使用原请求查询恢复，不能因报错自动换幂等键重新生成。

视频报价示例：

```json
{
  "protocolVersion": 3,
  "profileId": "seedance-profile",
  "configVersion": "后台下发的当前版本",
  "operation": "image-to-video",
  "referenceIds": ["front-reference", "side-reference", "scene-reference"],
  "creativeBrief": "结合三张参考图制作商品宣传视频",
  "requestedSpec": {
    "durationSeconds": 4,
    "resolution": "720p",
    "aspectRatio": "16:9"
  },
  "specRevision": 1
}
```

平台在报价及提交前重新检查配置版本、授权、参考图数量、有效期和总大小。报价冻结参考图 ID、内容哈希及顺序；生成请求改变其中任一项必须重新报价。已提交的 V3 视频任务可在能力配置调整后继续按冻结配置查询，但撤销企业授权、删除 Profile 或替换模型会阻止访问。

旧图片 V1/V2 和视频 V1 的请求格式保持原有数量边界，多图扩展使用 V3。本仓库仅包含 SEP 后端与 Web；桌面客户端若仍限制一张图，需要同步调整上传和工具参数处理。

## SEP 调用 Longdao

- 图片报价：`POST /v1/sub2api/images/pricing`，仅发送现有报价合同字段，不添加参考图数量。
- 图片编辑：一次 `POST /v1/images/edits`，multipart 内按顺序重复 `image[]` 文件字段。
- 视频报价：`POST /v1/sub2api/videos/pricing`，仍发送 `model`、`operation`、`resolution`、`duration_seconds`。
- 视频生成：一次 `POST /v1/videos`，multipart 内按顺序重复 `input_reference` 文件字段。其他字段保持原有映射；不发送上游不支持的 `fps`。
- 视频查询与下载仍为 `GET /v1/videos/{id}`、`GET /v1/videos/{id}/content`。

参考图张数不等于输出张数；上传多图不会拆分成多次生成请求。

## 原始错误

上游非成功响应保留原 HTTP 状态与 JSON / 纯文本正文，并带 `X-SEP-Error-Source: upstream`。不把上游 `code`、`message` 替换为统一的生成失败文案。网络异常没有上游状态码时以 502 返回原异常名称和消息。仅遮盖正文中回显的实际连接 Key。错误正文保留原有 64 KiB 读取上限，超限时返回明确的超限诊断。

提交失败时，先保存请求和账务状态，再把原错误交给调用方；查询回执中的可选 `upstreamError` 保存原始错误，结构为 `{ "status": 403, "body": { "error": { "code": "permission_error", "message": "..." } } }`。上游异步任务以 HTTP 200 返回 `status: "failed"` 和 `error` 时，该错误也保留在回执中。

Web 识别上游来源的 401，不触发平台登录刷新或重新提交。平台本地的请求校验、授权、账务保护仍执行；无法确认上游是否扣费时保持对账状态，不凭 HTTP 错误直接重复生成。

验证仅覆盖本地模拟上游；真实 Longdao 多图生成、供应商张数限制和计费结果仍需部署后使用获授权的测试任务验收。
