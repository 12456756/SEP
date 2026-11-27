# 上游媒体错误 HTTP 状态透传

## 规则

- 图片、视频本次创建、查询或视频取消实际收到的上游 HTTP 4xx/5xx，保留对应状态和原始错误正文，不因为已保存 SEP 回执而改成 200/202。
- 本次上游查询成功，查到任务生成失败或取消，仍返回 HTTP 200，回执描述任务的结果与费用状态。
- 本次查询成功时，回执中的历史 `submissionHttpStatus`、`submissionError`、`taskError` 不改变本次查询的 HTTP 状态。
- 查询过程中从上游下载原成品失败，同样返回该次上游 HTTP 错误；已知任务状态、成品下载状态及账务信息继续保存。
- 已保存回执的错误响应通过 `X-SEP-Receipt-ID` 和 `X-SEP-Client-Request-ID` 告知原编号。正文采用现有错误脱敏机制，不额外套一层通用错误，不丢弃上游明细。
- 上游提供 `Retry-After` 时保留，包括 200/202 处理中响应；秒数或 HTTP 日期均原样转发。需要轮询时，`pollAfterMs` 不短于上游剩余等待时间；未提供时采用既有默认轮询间隔。`X-Compute-Request-ID` 标识算力请求。CORS 允许浏览器读取上述响应头。

## 示例

上游创建返回 HTTP 429：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 7
X-SEP-Receipt-ID: receipt_example
X-SEP-Client-Request-ID: client_example
X-Compute-Request-ID: compute_example
Content-Type: application/json
```

响应正文保留上游实际提供的 JSON，例如：

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "请求过于频繁，请稍后重试"
  }
}
```

若上游提供的是完整媒体回执，则正文保留该上游回执，仍使用 HTTP 429。客户端通过 SEP 回执编号或原 `clientRequestId` 查询后续状态，不因 429 就自动换编号重新生成。

## 状态保存与账务

先保存本次操作证据与原任务，再返回对应错误。429 本身不证明上游一定未执行，也不代表应直接退款。明确未收费须以算力最终费用单为依据；已有收费结论继续保留；未确认继续待核对。

视频查询失败时仍尝试独立查询最终费用单，保存结算结果后再返回原查询错误。结算失败保留 `RECONCILING` 与具体原因，不覆盖生成失败原因，不重复生成。

后续 GET 查询成功返回 HTTP 200，已恢复的查询或下载 429 不再保留为当前操作错误；原任务提交或生成失败的历史证据仍保留。相同创建请求的幂等重放只恢复原回执；不重复向上游 POST，如恢复过程发生新的查询错误，则返回该次错误。

## 临时错误恢复与等待时间

- 上一次查询临时失败时，下一次查询会重新查询上游原任务，即使本地已经保存成品且独立账单已经结清；不能因任务与账务终态提前返回旧查询错误。
- 本次查询成功，清除已经恢复的 `execution.operationError` 与对应 `upstreamError`，本次没有 `Retry-After` 时不沿用上一次等待信息。
- 本次仍然被限流，返回本次的 429、错误正文和新的 `Retry-After`。上游每次要求的等待时间可以不同。
- 图片或视频重新下载成品成功后，清除已经恢复的下载错误。只重试原成品，不重新生成、不重复扣费。
- 原任务的 `submissionError`、`submissionHttpStatus`、`taskError` 仍保留真实历史证据；它们不等同于本次查询错误。
- 等待信息保存在现有任务配置 JSON 中，无数据库结构迁移；传输头不新增到客户端严格 JSON schema。日期换算和剩余时间用于 `pollAfterMs`，原始头用于 HTTP 透传。

## 对话流

首次 SSE 事件发送前的上游 HTTP 错误保留原状态、正文及等待头；避免 SDK 包装异常后丢失原始错误。

自费提示缓冲到模型开始返回内容时发送，仍排在模型内容之前，避免先发提示就提前确定 HTTP 200。

若已经发送 SSE 响应头或内容，HTTP 状态无法重新发送，继续通过 `event: error` 保留真实错误与 `httpStatus`，不伪造成功结束。客户端必须解析流内错误。

## 验证边界

回归使用本地隔离数据与模拟上游，覆盖普通错误正文、完整媒体回执、签名传输异常、等待头、历史失败查询、取消失败、原任务恢复及独立账单。未调用真实付费模型，未修改服务器或数据库结构。

2026-11-27 验证结果：19 组相关测试，418 项通过，1 项依赖桌面客户端环境的联调按条件跳过。后端 `tsc --noEmit --incremental false -p tsconfig.json` 通过；相关 ESLint 无错误，保留 4 个既有警告；`git diff --check` 通过。

同日补充等待时间与临时错误恢复后的回归：18 组相关测试，430 项通过，1 项按条件跳过；覆盖连续限流时更新等待时间、按原客户端请求编号恢复、图片下载恢复、账务结清后重新查询，以及成功后清除旧错误和等待信息。后端类型检查通过；本轮相关文件 ESLint 无错误，保留 1 个既有未使用导入警告。本轮使用模拟上游，未进行真实上游联调、提交或部署。

## 涉及文件

- `backend/src/modules/media-gateway/media-real.service.ts`：保存图片创建、查询及成品下载证据后透传本次上游错误。
- `backend/src/modules/media-gateway/media-video-real.service.ts`：视频创建、查询、取消及下载错误透传，保留独立最终账单查询。
- `backend/src/modules/media-gateway/media-upstream-retry.ts`：解析并保存上游等待头，计算剩余轮询等待时间，识别需要重新查询的操作错误。
- `backend/src/modules/media-gateway/media-real.store.ts`、`media-video-real.store.ts`：在现有任务配置 JSON 中持久化等待信息。
- `backend/src/modules/media-gateway/media-payment-mode.interceptor.ts`：在成功回执的 HTTP 响应中透传等待头，不改变客户端 JSON 格式。
- `backend/src/modules/media-gateway/longdao-media-contract.ts`：从当前 HTTP 响应提取操作错误，与历史提交错误分开。
- `backend/src/common/errors/media-upstream.exception.ts`：沿用现有上游异常，补充 SEP 回执关联响应头。
- `backend/src/modules/conversation/conversation-stream.service.ts`：保留首次上游错误，缓冲提前提示，并保留 SDK 包装前的异常。
- `backend/src/modules/media-gateway/media-real.controller.ts`、`media-video-real.controller.ts`：更新 Swagger 状态说明。
- `backend/src/main.ts`：允许跨域客户端读取等待信息和回执关联响应头。
- 对应媒体 HTTP、媒体 Service、回执恢复、对话流及付款提示测试：更新旧成功状态断言并增加错误透传回归。
