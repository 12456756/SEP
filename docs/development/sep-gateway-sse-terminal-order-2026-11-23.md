# SEP 对话 SSE 结束顺序修复

日期：2026-11-23。对应本地复验报告 F07，仅涉及 SEP 后端对话网关。

## 修复后的行为

普通内容和工具调用事件继续实时转发。上游的 `[DONE]` 暂存，等待上游实际 EOF、正常 `finish_reason` 校验、用量保存和执行结束记录保存成功后，再发送给客户端。

如果上游缺少正常结束原因、发送错误事件、读取过程中断，或本地用量和执行结束记录保存失败，客户端收到错误或异常断连，不会再收到 `[DONE]`。上游在 `[DONE]` 后才发送的错误也不会被此前的成功标记掩盖。

具体错误信息继续沿用现有脱敏透传逻辑；已经转发的上游错误事件不会再补发一条重复错误。SSE 响应头已经发出时，HTTP 状态仍可能是 200，应以流内错误事件判断失败。

兼容既有协议：不凭空补造缺失的 `[DONE]`；有效结束原因但没有该标记的流仍按原规则处理。普通事件保留原字节；沿用现有单事件 8 MiB 上限，避免缓存整个响应。此处等待执行记录保存，不是等待后台费用结算完成。

## 变更文件

- `backend/src/modules/gateway/gateway.controller.ts`：暂存成功标记，调整校验、落库和发送顺序。
- `backend/src/modules/gateway/gateway-stream-delivery.ts`：有界事件分帧与成功标记暂存。
- `backend/src/modules/gateway/gateway-controller-stream.spec.ts`：字节分片、提前结束、晚到错误、正常实时输出、记录保存失败及传输失败回归。
- `backend/src/modules/gateway/gateway-stream-delivery.spec.ts`：UTF-8、换行格式、EOF 尾帧、重复标记及事件上限回归。
- `backend/src/modules/gateway/gateway.http.spec.ts`：真实 Nest HTTP 层异常事件、无成功标记、错误脱敏和资源释放回归。

未修改数据库结构，没有新增依赖，不需要数据库迁移。本次没有提交、合并或推送 Git。

## 验证

- 控制器、发送助手和 SSE 错误诊断测试：3 个文件、54 项通过。
- HTTP 本次相关定向测试：5 项通过。
- 扩展网关回归：120 项通过、10 项跳过、1 项已有失败，失败为非流式 503/502 错误状态断言。
- HTTP 完整文件：48 项通过、7 项已有失败，涉及此前错误透传调整后的 MIME 错误包装、响应体追踪字段和限流字段预期；未在本次修改无关错误契约。
- 后端 TypeScript 检查、`pnpm --dir backend exec nest build` 和本次已有文件 diff 空白检查通过。未运行包含资源预检查的完整项目构建。
- 本地后端重新编译并重启；SEP 和算力平台页面、API 健康检查均返回 200。
- 真实供应商简短流式对话通过：HTTP 200，首字节约 2.6 秒，总耗时约 2.9 秒，最后仅有一个 `[DONE]`，无错误事件；执行结束记录已保存，双边结算为 `COMMITTED`。

真实供应商仅验证正常路径，未人为制造供应商故障；异常路径使用可控 HTTP 测试验证。

本地测试脚本与证据保存在 Git 忽略目录 `outputs/compute-integration/`：`gateway-terminal-live-20261123.ts`、`gateway-terminal-live-evidence-20261123.json`、`gateway-terminal-http-regression-20261123.json` 等。证据不得复制到版本库。
