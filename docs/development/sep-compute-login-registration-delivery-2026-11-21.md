# SEP 新开户可登录账号交付

日期：2026-11-21。范围为新开户，包含新用户注册和已有 SEP 用户创建新企业；未处理已有算力专用账户转换、后续密码/邮箱/公司资料同步。未修改算力平台代码、未提交或部署。

## 行为与流程

1. `AuthService.register` 仅执行一次 bcrypt。创建用户、企业、管理员成员和开户待办共用一个本地事务，将本次原始 bcrypt 哈希通过 AES-256-GCM 加密后存入任务 JSON。
2. `AuthService.createEnterprise` 在原用户行锁和企业创建事务内读取本地密码凭证，固定管理员用户 ID、当时邮箱和公司名称；没有本地密码仍保存身份快照，不制造密码。
3. 后台 worker 在内存解密原哈希，首次发送前固定 `encryption_key_id`，通过原 N01 与服务签名提交 `password_hash`。只有在尚无哈希的暂停任务中，才从原管理员的本地凭证补取一次；不会借另一管理员的密码。
4. 超时等临时错误沿用原任务及原注册编号重试，保留公司名、邮箱、哈希和已冻结加密版本；协议层每次重新生成时间戳、nonce 与签名。
5. 成功后沿用原账号及三用途 Key 的归属校验、JWE 解密、加密存储。不开启新的密码同步，不改变模型及资金路径。

加密存储使用现有 `COMPUTE_CREDENTIAL_SECRET`，缺省沿用 `JWT_SECRET`。开户任务及历史 Key 所需的秘密必须保持可用。使用现有 `requestPayload` JSON，无新增数据库字段或迁移，无新增依赖。

## 暂停与恢复

| 原因 | 处理 |
| --- | --- |
| `EMAIL_ALREADY_EXISTS` | 标记原任务 `BLOCKED` 并展示邮箱占用；不覆盖或绑定现有账户，也不自动修改原邮箱 |
| `INVALID_PASSWORD_HASH` | 本地 bcrypt 格式/成本检查或远端校验失败时暂停，不发送明文密码、不二次计算 bcrypt |
| `LOCAL_PASSWORD_REQUIRED` | 保存原开户身份并暂停；管理员设置本地密码后，由平台管理员在原算力连接记录中重试原任务 |
| `COMPUTE_REGISTRATION_SECRET_UNAVAILABLE` | 原任务密文不能解密时暂停；修复原加密配置后重试，不替换成当前密码 |

原任务重试复用既有 `POST /api/admin/compute-integrations/jobs/:jobId/retry`。恢复不创建第二个账号或开户编号。哈希已经固定后，修改 SEP 密码不会改写开户快照；开户使用的仍是最初固定的密码。

## 敏感信息

- 前端查询的任务字段显式选择，不返回原始任务 JSON、哈希或密文；账号状态也不返回哈希。
- 错误诊断对 `password_hash`、`encryptedPasswordHash` 及自由文本中的 bcrypt 哈希脱敏。
- HTTP 日志额外遮蔽 bcrypt 哈希，避免错误消息回显凭证；worker 日志只记录任务和企业编号。
- 签名覆盖包含 `password_hash` 的原始请求正文；生产传输仍要求 HTTPS。

## 验证

- 注册、创建企业、开户服务、worker、协议和错误诊断六组单测通过。覆盖同一哈希交付、原快照重试、暂停及恢复、替代管理员拒绝、失去租约不发送、非法哈希和损坏密文暂停、错误响应脱敏。
- 隔离 PostgreSQL 专项 12 项全部通过，新增实际事务回滚和重复创建保留原密文快照检查。
- `compute-platform.live.ts` 完整执行退出码 0：使用真实 SEP `AuthService.register/login`、`SessionService`、本地数据库及算力平台 N01/login，确认同邮箱和初始密码可登录两边、两边拒绝错误密码、算力账号 ID 对应原绑定、重放返回原账号、邮箱冲突拒绝绑定。
- 同一完整脚本继续通过三类模型目录、图像/视频报价与生成、免费/付费、个人补资、钱包退回、13 条流水小分页及最终 `MATCHED` 对账。供应商仍为本地模拟，未使用正式供应商额度。
- 后端 `tsc --noEmit --incremental false`、联调脚本独立类型检查、`nest build`、Web 类型检查通过；新增 bcrypt HTTP 日志测试单独执行通过。
- 包含 HTTP 日志完整套件的一批回归为 108 项通过、3 项失败。三项仍是通用内部错误提示、数据库错误文本、413 中文提示的旧预期与当前详细错误透传不一致；本轮未修改 HTTP 错误映射或这些旧断言，不宣称全量测试通过。

邮件验证码消费及默认部门初始化在联调脚本中模拟，未验证真实邮件投递或页面交互；脚本调用真实注册服务，不等同于浏览器/真实邮件端到端验收。后台预览服务是否已重新加载本次代码不作为本轮验收依据。

## 主要变更文件

- `backend/src/modules/auth/auth.service.ts` 及两份认证回归测试：注册和新企业事务快照。
- `backend/src/modules/compute-integration/compute-integration.service.ts`：加密快照、无密码和解密失败处理。
- `backend/src/modules/compute-integration/compute-integration.worker.ts`：固定原管理员、密文快照、租约、错误暂停和原任务恢复。
- `backend/src/modules/compute-integration/compute-remote.adapter.ts`、`compute-wire-contract.ts`：N01 哈希字段及 bcrypt 校验。
- `backend/src/shared/compute-integration.dto.ts`：新增错误原因的共享展示文案。
- `backend/src/common/errors/error-diagnostics.ts`、`http-logging.middleware.ts` 及测试：哈希脱敏。
- 开户单元/数据库测试和 `backend/test/compute-platform.live.ts`：安全、事务和实际登录联调。
