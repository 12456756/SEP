# 企业一键更换 Key 交付说明

日期：2026-11-26。涉及 SEP-worktree-two 和 LongdaoAI-worktree-one。

## 用户操作

企业管理员进入「设置 → 算力连接」，分别点击对话、图片、视频 Key 旁的更换图标。无需复制 Key，也不返回明文 Key。页面显示当前脱敏 Key、版本、更换进度和具体异常。

同一用途有未完成更换时不能发起第二次。被暂停的操作使用「恢复原操作」，保留原编号和原参数。不同用途可以独立更换。

更换只处理凭证，不创建账号，不修改企业余额、员工余额、价格或账务流水。沿用原分组、访问限制和有效期等 Key 配置，不把停用的 Key 自动恢复为启用。

## 完整流程

1. SEP 校验企业管理员身份、企业绑定和当前版本，在本地事务中保存更换任务，返回 HTTP 202。
2. 后台每 15 秒处理到期任务，携带固定操作编号、原凭证编号、预期版本及固定加密公钥版本，请求算力平台生成新凭证。
3. 算力平台幂等保存新 Key，通过 RSA-OAEP-256 / A256GCM JWE 返回。此时原 Key 仍为算力侧当前版本。
4. SEP 校验回执和密文的企业、账户、用途、版本及操作归属；在一个本地事务中加密保存新 Key、停止本地选择旧 Key、记录已切换状态。
5. SEP 发送 ACK，算力侧切换当前版本，原 Key 进入等待旧任务完成的状态。
6. SEP 和算力两边均检查旧任务及结算。全部完成后，旧 Key 停止接收新增生成，仅允许读取它原来创建的媒体任务；更换任务完成。

旧 Key 保留原任务查询能力，不是物理删除或全接口吊销。未知结果、未发出的 PREPARED 执行、待确认费用和未提交结算都会延迟旧 Key 停止生成；不得为了完成更换而丢弃这些记录。已经明确 NOT_SUBMITTED 的请求不阻塞。

## 并发与失败恢复

| 场景 | 处理 |
|---|---|
| 双击、多个页面同时更换 | 同编号返回原任务；同企业同用途仅一个未完成操作 |
| 多个 SEP 实例同时处理 | 数据库租约抢占；提交前再次校验租约及有效期 |
| 原处理进程超时后迟到 | 租约不匹配时拒绝写回，不覆盖后来状态 |
| 算力生成成功但响应丢失 | 原编号重试，拿回同一份加密凭证 |
| SEP 保存失败 | 本地事务回滚，原本地 Key 仍有效；后台重试原操作 |
| ACK 或停止旧生成响应丢失 | 重试同一个阶段，不重新生成 Key，不重新调用模型 |
| 正在创建新执行时切换 | 企业行锁序列化本地执行创建和切换；执行固定绑定凭证版本 |
| 已构建的对话客户端仍引用旧 Key | 仅当本地执行创建在发送前因版本变化拒绝时，重新取当前 Key；发送后绝不自动重发生成 |
| 旧图片/视频报价尚未提交 | 返回凭证变化，要求重新报价；已创建执行继续使用原凭证 |
| 旧任务仍进行或结算未知 | 新 Key 可以使用，旧 Key 保留；继续查询和结算原任务 |
| 回执归属或版本不匹配 | 暂停更换并显示原因，修正后恢复原操作 |
| 更换期间管理员调整算力分组 | 算力侧拒绝该用途分组变更，等待更换结束 |

远程调用在数据库事务之外执行，不持有数据库锁等待网络。算力侧执行受理和停止旧生成也使用企业行锁串行确认，防止刚确认可以停止就接受一个新旧版本请求。

## SEP 接口

均使用现有用户 JWT；企业从管理员成员身份解析，前端不得传企业 ID。列表和详情仅返回公开状态字段，不包含 Key 明文、密文或租约。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/enterprise/compute-integration/credential-rotations` | 保存更换任务，202 |
| GET | `/api/enterprise/compute-integration/credential-rotations` | 最近 30 项和所有未完成任务 |
| GET | `/api/enterprise/compute-integration/credential-rotations/:operationId` | 查询原操作 |
| POST | `/api/enterprise/compute-integration/credential-rotations/:operationId/retry` | 恢复被暂停的原操作，202 |

创建请求：

```json
{
  "operationId": "8b3c3147-1108-4faf-ac4c-273e6dcf7adc",
  "kind": "chat",
  "expectedVersion": 1
}
```

`kind` 为 `chat` / `image` / `video`。公开状态为 `PENDING`、`SWITCHED`、`DRAINING`、`COMPLETED`、`BLOCKED`。

## 算力控制接口

沿用现有 SEP v1 服务签名和 14 项规范串。每次重试使用新时间戳、nonce、签名，保持原操作编号。签名中的企业必须等于路径企业。

| 方法 | 路径 |
|---|---|
| POST | `/api/v1/sep/enterprises/:enterpriseId/credential-rotations` |
| GET | `/api/v1/sep/enterprises/:enterpriseId/credential-rotations/:operationId` |
| POST | `/api/v1/sep/enterprises/:enterpriseId/credential-rotations/:operationId/ack` |
| POST | `/api/v1/sep/enterprises/:enterpriseId/credential-rotations/:operationId/retire` |

POST 请求头 `Idempotency-Key` 与 `operation_id` 或路径操作编号相同。创建请求字段：

```json
{
  "contract_version": 1,
  "operation_id": "8b3c3147-1108-4faf-ac4c-273e6dcf7adc",
  "kind": "chat",
  "expected_credential_id": "cred_original",
  "expected_version": 1,
  "encryption_key_id": "existing-encryption-key-version"
}
```

回执包含 `contract_version`、`operation_id`、`enterprise_id`、`compute_account_id`、`kind`、`old_credential_id`、`expected_version`、`status` 和 `credential`。`status` 为 `prepared` / `acknowledged` / `completed`。

`credential` 包含 `type`、`credential_id`、`credential_version`、`encryption_key_id`、`encrypted_key`，其中新版本必须等于旧版本加一。JWE 解密内容沿用开户的 CredentialDelivery 结构。ACK/retire 回执的新凭证编号必须与 SEP 已保存的新编号一致。

主要冲突码：`CREDENTIAL_ROTATION_IN_PROGRESS`、`CREDENTIAL_VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`CREDENTIAL_NOT_ACKNOWLEDGED`、`CREDENTIAL_TASKS_PENDING`、`CREDENTIAL_RETIRED`、`CREDENTIAL_NOT_CURRENT`、`ENCRYPTION_KEY_VERSION_MISMATCH`。

## 数据库与发布

- SEP：`backend/prisma/schema.prisma` 新增 `ComputeCredentialRotation`。工具生成迁移 `20261126025127_compute_credential_rotations`；另有工具生成并已在隔离库执行的空迁移 `20261126025412_compute_credential_rotations`，不改写已执行的迁移历史。
- 算力：`backend/migrations/196_sep_credential_rotations.sql` 新增更换记录，凭证由每用途单行变成保留多个版本、每用途一个当前版本。
- 部署前执行双方迁移，生成 SEP Prisma Client，然后部署双方新后端及 SEP 前端。沿用现有服务签名和 JWE 密钥配置，无需新增第三方依赖。
- 本次只在本地测试库执行迁移；未部署线上，未提交、合并或推送 Git。

## 验证边界

- SEP：更换数据库事务、同编号重放、同用途并发、不同用途并发、保存失败回滚、ACK 丢失恢复、旧任务及结算保护、失效租约拒绝迟到写回、HTTP 鉴权、DTO 和远端回执校验测试。
- 算力：使用隔离 PostgreSQL schema 执行 SEP 服务和 handler 相关测试，验证版本切换、重复确认、旧任务只读权限、原配置继承和余额流水不变。
- 跨平台：Go 隔离 HTTP 测试服务连接 SEP 真实签名客户端、真实解密代码和独立 SEP PostgreSQL；对话、图片、视频三个用途更换完成、双方版本一致且不变账。此项验证服务契约，HTTP 包装由测试提供，不等同于完整部署环境验收。
- 页面：桌面 1440px、手机 390px 截图已检查；17 项 Playwright 用例通过，接口使用测试替身，覆盖重复点击、进度刷新、失败状态、恢复原操作、响应丢失、普通成员访问等。
- 未调用真实供应商生成，未验证真实供应商执行中的长任务切换；未进行线上部署、长时间压力和进程强杀测试。

关键代码：`compute-credential-rotation.service.ts`、`compute-credential-rotation.remote.ts`、`compute-credential-rotation.controller.ts`、`compute-model-transport.service.ts`、`compute-accounting.service.ts`、`credential-rotation-panel.tsx`；算力侧为 `sep_rotation.go`、`sep_rotation_gateway.go`、`sep_execution.go`、`sep_handler.go`。
