# HTTP 运行日志

后端通过 `httpLoggingMiddleware` 输出一条请求结束日志，安装在请求上下文之后、限流与请求体解析之前。日志使用 Nest Logger 输出到 stdout/stderr；Docker 按现有 `json-file` 配置保存和轮转，不新增数据库表。

## 字段

| 字段 | 含义 |
| --- | --- |
| `event` | 固定为 `http_request` |
| `method` / `path` | 方法与路径，路径不记录查询参数 |
| `statusCode` / `durationMs` | 最终 HTTP 状态码与请求耗时（毫秒） |
| `requestId` | 对应响应头 `x-request-id` 和错误响应中的请求 ID |
| `completed` | 是否完成响应；客户端提前断开时为 `false` |
| `message` | 优先使用 JSON 响应中的 `error.message`，其次为顶层 `message`；字符串数组合并，最多 500 字符 |
| `messageSource` | `response` 表示来自响应；`http_status` 表示无消息时使用状态说明；`connection` 表示连接提前关闭 |
| `code` | 响应提供的 `error.code` 或顶层 `code`，存在时记录 |
| `errorType` / `errorCode` | 500 及以上错误的内部异常类型和异常代码，存在时记录 |
| `errorMessage` / `errorStack` | 500 及以上错误的脱敏内部摘要和最多 6 行调用位置，不返回给客户端 |

成功响应并非都有 `message`。直接返回数据的成功接口会记录 `OK` / `Created` / `No Content` 等 HTTP 状态说明，而不是强制修改接口返回格式。

示例（省略 Nest Logger 的时间、级别和 `HTTP` 上下文前缀）：

```json
{"event":"http_request","method":"POST","path":"/api/example","statusCode":400,"durationMs":12,"requestId":"debug-123","completed":true,"message":"name is required; age must be a number","messageSource":"response"}
```

成功用 LOG 级别，4xx 和提前断开用 WARN，5xx 用 ERROR。使用请求 ID 可将浏览器显示的失败响应与运行日志关联。

## 数据边界

- 仅提取诊断字段，不记录请求体、响应数据、请求头或文件内容。已知凭据、URL、联系方式和控制字符会进行脱敏/规范化处理。
- Prisma 异常保留类型、错误代码和调用位置，不记录可能含 SQL/参数的原始错误消息。
- 普通异常的内部消息也执行相同脱敏。业务代码仍应避免在错误消息中拼接用户原文或其他隐私数据；规则脱敏无法识别任意业务秘密。
- SSE 与文件响应直接传输，不拦截 `write` / `end`，不缓存数据流。HTTP 200 之后在 SSE 数据中发生的业务错误，仍由对应业务模块记录；HTTP 请求日志不能把它自动判定为 500。
- 通用异常诊断通过现有 `HttpExceptionFilter` 收集，不改变现有响应契约。

## 检查

```powershell
pnpm --dir backend exec jest --runInBand --runTestsByPath src/common/middleware/http-logging.middleware.spec.ts src/common/filters/http-exception.filter.spec.ts
```

此改动需发布后端并重建容器后才会用于线上请求。
