# 给算力平台：SEP 企业账号与人民币结算改造交接

日期：2026-11-20。交付对象：算力平台后端开发、联调人员。

最新进展：算力已提供 `D:/github/LongdaoAI-worktree-one/docs/development/sep-compute-platform-api-v1.md`，SEP 已据此完成控制适配及第一阶段本机联调。以下保留原需求交接背景；具体实现差异、补充要求和剩余工作以 `sep-compute-v1-review-and-local-integration-2026-11-20.md` 为准。

本文是本轮需求交接稿，接口路径为建议命名，尚未实现、联调或部署。已有代码核对基于本地 `D:/github/LongdaoAI` 与 `D:/github/SEP-worktree-two`，未读取生产配置。

**本次接口范围以本文为准：复用现有模型执行入口，新增 9 个开户与账务接口，其中 Key 轮换可后续实施。** 早期技术评审稿中的独立价格目录、对话预算报价、register/prepare/dispatch 新执行入口，不是本次必须建设的接口。

## 1. 先明确这次要做什么

SEP 企业注册后，算力平台为它建立独立账号，创建对话、图片、视频三个 Key，共用一份付费余额。员工通过 SEP 使用模型，SEP 按企业及用途选择 Key。

| 事情 | 负责方 |
|---|---|
| 模型价格、倍率、图片和视频规格价格 | 算力平台统一维护，SEP 不修改 |
| 本次实际使用费用、美元转人民币 | 算力平台计算，给 SEP 可直接入账的人民币金额 |
| 免费额度、成员使用权限、费用由谁承担 | SEP 管理 |
| 企业算力账号及其付费余额 | 算力平台管理，与 SEP 的人民币资金变化关联 |
| 免费与付费拆分 | SEP 确认，算力平台校验后只扣付费部分 |
| 充值、退回、消费、重试和对账 | 双方用同一业务编号协作 |

以下边界已经确定：

- 不新增独立只读价格目录；不要求 SEP 维护模型价格表或美元映射账本。
- 对话继续先检查余额、执行后由 SEP 后台结算，不增加执行前资金预占或预算报价。
- 图片、视频保留 SEP 已有的报价、资金预占和实际费用结算流程，金额改为算力平台给出的人民币。
- 免费部分只消耗 SEP 免费额度，双方付费余额均不扣；不能先扣全额，再退款抵免费。
- 三个企业 Key 必须进入专门结算模式，不能同时走现有自动扣全额路径。
- 本次不改客户端使用方式。查询、下载原结果不应因为余额耗尽而失效。

## 2. 实际业务流程

### 2.1 对话

```text
SEP 检查权限和余额、创建执行记录
  -> 使用企业对话 Key 发送原有模型请求
  -> 算力平台执行、记录请求归属和实际人民币费用，暂不自动扣款
  -> SEP 后台取得实际费用，事务内消耗免费额度并扣付费资金
  -> SEP 提交结算决定
  -> 算力平台只扣决定中的付费金额，返回账务流水
  -> SEP 标记同步完成
```

对话允许并发。因为没有执行前预占，并发执行后可能余额不足，SEP 仍记录欠费。未收齐的费用不作为全额已付提交；该执行单保持待结算，补收入口需双方结合现有产品流程确认。不把欠费自动变成免费，也不能让算力平台先扣 SEP 尚未收取的金额。

### 2.2 图片、视频

继续通过原接口报价并在 SEP 预占资金；生成后以算力平台确认的实际人民币费用结算，退回多占的部分。算力平台本轮不因这个要求另建 register/prepare/dispatch 模型入口；如原媒体预占流程需要增加授权字段，在原请求上扩展。

平台管理员校验图片/视频参数使用管理员算力账号的 Key（用户已确认），配置在 SEP 的管理员图片/视频校验连接中；不能随意借用某企业 Key。目录发现与参数报价校验均使用该管理员连接，只报价、不生成、不扣生成费用；不要求为此另建一种专用报价认证。员工实际生成使用所属企业对应 chat/image/video Key。校验账号的结果不能直接作为某企业本次真实结算金额，企业执行前须用自己的 Key 取得适用报价。管理员 Key 不等于开户、充值或批准免扣款的 SEP 服务认证，这些管理与账务接口仍使用单独的集成认证。

### 2.3 一个混合结算例子

算力平台确认本次实际费用 10 元，SEP 剩余免费额度 3 元，则 SEP 消耗免费额度 3 元、扣付费资金 7 元，并通知算力平台扣 7 元。如果免费额度足够覆盖 10 元，两边付费余额都不变，但仍记录免费消费及结算结果。

## 3. 接口共同规则

### 3.1 路径、身份和安全

新增接口建议基路径 `/api/v1/sep`，下文完整列出。接口均由算力平台提供，只给 SEP 后端调用。

- 服务接口使用独立的 SEP 集成认证；不能让普通企业 Key 获得开户、增加余额或批准免费结算的权限。
- 现有执行请求除企业 Key 外，需要可信 SEP 服务身份，覆盖企业编号、执行编号、用途及请求内容，防止伪造免扣模式。具体签名或服务认证方式由双方部署联调前冻结。
- 免费金额只接受经过 SEP 服务认证的结算决定，不能接受客户端或提示词声明。
- 三个 Key 加密交付。采用双方确认的标准加密封装、公钥及密钥版本；不得返回明文、写日志或传给客户端。
- 注册信息复用企业名称、管理员邮箱等身份资料，不传递或复制 SEP 管理员明文密码；不按同邮箱自动合并不同企业。
- 集成账号关闭直接充值、人工无流水调余额、绕过 SEP 的模型消费，或将这些操作纳入明确的调整流程，不能无记录改变两边余额。

### 3.2 金额和编号

| 字段 | 说明 |
|---|---|
| `enterprise_id` | SEP 企业不可变编号，不能用邮箱代替 |
| `execution_id` | SEP 发模型请求前生成，关联一次执行及账务；恢复用原编号 |
| `compute_request_id` | 算力平台生成的稳定关联编号，不使用含义可能变化的 Header 代替 |
| `task_id` | 视频等异步任务编号，不能作为所有类型的统一账单编号 |
| `bill_id` / `bill_version` | 算力平台确认实际费用时生成；最终费用不可被后续改价覆盖 |
| `settlement_id` | SEP 为一份不可变结算决定生成的编号 |
| `transfer_id` | SEP 为一次充值或退回生成的编号 |
| `ledger_entry_id` / `sequence` | 算力平台账务流水编号和账户内递增序号 |

金额统一 `currency=CNY`，采用字符串，固定 6 位小数，例如 `"7.000000"`。负数不表示退款，划转方向单独传。JSON 不用浮点数或科学计数法。

SEP 只做人民币免费/付费分配与记账，不计算模型费用或汇率。算力平台可以保留内部美元成本，但返回的人民币金额必须可结算，不是随当前展示汇率变化的参考值。已确认费用及已充值人民币权益不能因之后改汇率而重算。

所有修改接口要求 `Idempotency-Key`。同编号同内容返回原结果；同编号不同内容返回 409；不能修改原单或再次执行。每个结算决定应保存规范化内容摘要，双方在完整 schema 冻结时约定字段编码。

## 4. 需要新增的接口一览

| 编号 | 方法与完整建议路径 | 用途 | 实施优先级 |
|---|---|---|---|
| N01 | `POST /api/v1/sep/enterprises` | 开户并创建三个 Key | 本轮 |
| N02 | `GET /api/v1/sep/enterprises/{enterpriseId}` | 查询开户及凭证交付状态 | 本轮 |
| N03 | `POST /api/v1/sep/enterprises/{enterpriseId}/keys/{type}/rotate` | 更换某类 Key | 可后续 |
| N04 | `GET /api/v1/sep/executions/{executionId}/billing` | 查询执行状态及实际人民币费用 | 本轮 |
| N05 | `POST /api/v1/sep/executions/{executionId}/settlement` | 确认免费/付费拆分并扣款 | 本轮 |
| N06 | `POST /api/v1/sep/transfers` | 增加或减少企业算力付费余额 | 本轮 |
| N07 | `GET /api/v1/sep/transfers/{transferId}` | 查询原划转结果 | 本轮 |
| N08 | `GET /api/v1/sep/enterprises/{enterpriseId}/balance` | 查询人民币可用、冻结和总余额 | 本轮 |
| N09 | `GET /api/v1/sep/enterprises/{enterpriseId}/ledger` | 分页查询账务流水与对账水位 | 本轮 |

如算力平台已有满足语义的管理能力，可在服务层复用，避免另写一套账务逻辑；对 SEP 交付一个稳定接口契约即可。所有查询按集成身份及企业绑定鉴权，不得仅凭路径 ID 读取其他企业数据。

## 5. 新接口各自需要返回什么

### N01 / N02：企业开户与查询

N01 输入：`enterprise_id, registration_ref, company_name, admin_email, encryption_key_id, password_hash`。`registration_ref` 对应开户幂等键。2026-11-21 新开户补充：`password_hash` 为 SEP 本地密码凭证的原始 bcrypt 哈希，不是明文或二次 bcrypt 结果；开户任务中加密存储并原样重放。算力平台使用注册邮箱和该哈希创建可登录用户，详见 `sep-compute-login-registration-delivery-2026-11-21.md`。已有专用账户转换不在本轮范围。

成功至少返回 `enterprise_id, compute_account_id, status, billing_mode, credentials`：

- `billing_mode=sep_settlement_v1`，表示本账号由 SEP 确认结算。
- `credentials` 包括 `type=chat|image|video`、`credential_id`、`credential_version`、遮罩及加密后的 Key；三者归属同一资金池，用途必须受限。
- 开户未完成返回 202 和 `status=provisioning`；完成返回 `ready`；失败附阶段和具体原因，不返回“已完成”但少一个 Key 的资源。
- 超时后通过 N02 或同参重放 N01 恢复原结果，不能再建账号。凭证密文需要能在首次交付失败后重新取得，具体通过原 POST 重放或受限交付字段返回，但查询绝不返回明文。
- N02 返回开户状态、账号编号、三类 Key 元数据及交付状态。公开响应不包含管理员密码。

N03 输入轮换编号、预期旧版本及加密公钥版本，返回新版本与密文。旧版本不执行新任务，但原任务、费用查询和下载必须有同账号的受限恢复途径。

### N04：查询一次实际费用

该接口同时承担“请求是否被接收”的查询，执行未完成时不能只返回金额空对象。建议返回：

```json
{
  "contract_version": 1,
  "enterprise_id": "ent_example",
  "execution_id": "exec_example",
  "kind": "chat",
  "model_id": "example-model",
  "compute_request_id": "compute_example",
  "provider_request_id": null,
  "task_id": null,
  "execution_status": "completed",
  "fee_status": "final",
  "bill_id": "bill_example",
  "bill_version": 1,
  "price_version": "price_example",
  "currency": "CNY",
  "gross_cny": "10.000000",
  "usage": { "input_tokens": 1000, "output_tokens": 500 },
  "settlement_status": "unsettled",
  "settlement_receipt": null,
  "finalized_at": "2026-11-20T08:00:00Z"
}
```

必要规则：

- `execution_status` 可为 `received/running/completed/failed/cancelled/unknown`；`fee_status=pending|final|reconciling`，与执行状态分开。
- 实际费用未确认时 `gross_cny=null`；确实零费用时才返回 `"0.000000"`。失败请求是否收费也需确认，不能根据 HTTP 失败直接归零。
- 返回实际模型、用量和价格版本；缓存、工具、长上下文、图像数量及视频规格等费用由算力平台计算，SEP 不再从 Token 重算。
- `final` 表示费用确定，不表示已扣余额。结算完成时返回 N05 的原回执，支持响应丢失后恢复。
- 404 只表示该时刻未查到，不能证明供应商一定没有执行；迟到请求仍可能被受理，不据此盲重发。
- 所有查询返回的执行、费用及结算状态应包含一致的资源版本，避免旧状态覆盖新状态。

### N05：结算确认

输入示例，`Idempotency-Key` 使用 `settlement_id`：

```json
{
  "contract_version": 1,
  "enterprise_id": "ent_example",
  "settlement_id": "settlement_example",
  "bill_id": "bill_example",
  "bill_version": 1,
  "currency": "CNY",
  "gross_cny": "10.000000",
  "free_cny": "3.000000",
  "paid_cny": "7.000000"
}
```

算力平台必须验证总金额与自己的最终费用一致、`gross_cny=free_cny+paid_cny`、免费/付费非负、主体归属正确及 SEP 服务授权可信。免费权益是否实际扣减由 SEP 本地事务保证，不能让普通客户端自行提交免费决定。

单个数据库事务内完成：检查账号付费余额、扣 `paid_cny`、记录 `free_cny`、记录唯一结算及账务流水。不得再走旧自动扣全额、旧配额扣全额的逻辑；免费部分不减少付费 Key 的金额配额。

成功回执：

```json
{
  "contract_version": 1,
  "enterprise_id": "ent_example",
  "execution_id": "exec_example",
  "settlement_id": "settlement_example",
  "bill_id": "bill_example",
  "status": "committed",
  "currency": "CNY",
  "charged_paid_cny": "7.000000",
  "recorded_free_cny": "3.000000",
  "ledger_entry_id": "ledger_example",
  "sequence": "42",
  "committed_at": "2026-11-20T08:00:01Z"
}
```

同一执行/费用单只允许一个完整结算决定成功；不同 settlement_id 不能把同笔费用重复结算。全免费也返回回执，余额为 0 不得阻止合法零付费结算。远端余额不足时明确拒绝扣款并保留待结算，不返回伪成功或自动透支。

SEP 对话先在本地实际扣款和记录决定，再发 N05；成功后只标记同步完成，不再次扣本地。图片/视频完成远端确认后按原预占完成本地结转。N05 只改变账务，绝不再次执行模型。

### N06 / N07：充值与退回

N06 请求：

```json
{
  "contract_version": 1,
  "enterprise_id": "ent_example",
  "transfer_id": "transfer_example",
  "direction": "credit_compute",
  "currency": "CNY",
  "amount_cny": "100.000000",
  "funding_ref": "sep_wallet_entry_example"
}
```

- `direction=credit_compute|debit_compute`，转入或退回；金额为正，不能自由传任意账号。
- 算力平台在本地事务中按 transfer_id 去重、检查余额、增减人民币资金权益、写流水并保存结果。转入 100 元就确认 100 元人民币权益，内部换汇不由 SEP 处理。
- 退回只允许扣可退未消费金额，余额判断与并发扣款必须原子处理，不能退已冻结资金或免费额度。
- 响应包含原业务字段、`status=processing|committed|rejected`、原因、流水编号、sequence 和完成时间。`rejected` 为该操作终态；重新发起新的业务操作才使用新 transfer_id。
- N07 返回原状态与回执；暂时未查到不表示请求必然失败。处理中或未知时 SEP 不解锁原资金，不用新编号补发。
- 本轮不另建跨平台换汇报价及两阶段划转接口。SEP 先保存本地锁款和待办，再调用 N06；远端已完成而本地收尾失败，查原单并补齐本地即可。
- 不允许“超时后直接取消”与迟到转入同时成功。若后续需要取消接口，需另定义关闭墓碑和竞争规则，当前流程通过原单查询解决。

成员间分配资金不调用 N06 重复充值。现有企业资金首次映射为迁移操作，只入账一次，不把整个钱包和算力专款重复相加。

### N08 / N09：余额与流水

N08 必须返回 `currency=CNY, total_paid_cny, available_paid_cny, frozen_paid_cny, sequence, observed_at`，并满足 `total_paid_cny=available_paid_cny+frozen_paid_cny`。不把 SEP 免费权益当作付费余额。

N09 参数 `after_sequence, limit`，建议最多 200 条。返回追加流水、分页游标、此次快照水位及同水位人民币余额；各页固定快照水位，不能把不同时间余额硬拼在一起。每条至少含企业、流水 ID、sequence、类型、人民币金额、关联 transfer_id/execution_id/settlement_id、实际生效时间。

类型至少区分转入、转出、付费消费、免费记录及受控调整；如远端确有冻结操作，另含冻结/释放。重复页按流水 ID 去重；同水位总账可用以下关系核对：转入减转出减付费消费等于付费资金总余额，免费记录不减少该余额。

## 6. 现有接口需要怎么调整

| 原接口 | 本轮要求 |
|---|---|
| `POST /v1/chat/completions` | 原 JSON/SSE 协议继续使用，关联企业与执行编号；计算人民币实际费用，不自动扣全额 |
| `POST /v1/images/generations`、`POST /v1/images/edits` | 原生成/编辑协议继续使用；同样关联执行及账务，按确认拆分扣款 |
| `POST /v1/videos` | 保留异步受理和 task_id，关联 execution_id，不把受理当费用已确定 |
| `GET /v1/videos/{taskId}`、`GET /v1/videos/{taskId}/content` | 企业归属校验，Key 轮换后可恢复；余额见底仍可读取原任务，无新生成费 |
| `POST /v1/sub2api/images/pricing`、`POST /v1/sub2api/videos/pricing` | SEP 模式返回 `currency=CNY, amount_cny`、报价版本、有效期和原请求规格；不能只改 currency 标签却仍放美元数值 |
| `GET /v1/models` | 复用原模型/权限目录；本轮不新增独立价格目录。SEP 需要展示字段不足时明确原字段扩展方案 |
| `GET /v1/sub2api/billing` | 原倍率信息可保留作展示，不能再要求 SEP 用它乘本地价格算费 |
| `GET /v1/sub2api/usage`、`GET /v1/sub2api/videos/usage` | 旧消费者维持原协议；SEP 新账务通过 N04 获得统一实际人民币费用，内部复用现有证据和账务实现 |

建议仅对已登记 SEP 账号启用新协议版本，普通算力平台客户继续原模式。涉及报价响应字段变化需显式版本识别，不让旧消费者把人民币当美元再次换算。

原模型执行请求建议增加 `X-SEP-Enterprise-ID`、`X-SEP-Execution-ID`、集成版本及服务认证信息，原 `Authorization` 继续携带企业对应用途 Key。具体 Header 名可双方统一，但企业/执行关联及不可伪造授权必须实现。

算力平台在派发供应商之前持久化 execution_id 与请求摘要，并原子取得一次执行权。相同编号不同内容拒绝；相同编号已执行返回明确重复状态及查询依据，不要求重放完整 SSE，但绝不能再次生成。派发前后崩溃无法证明未执行时保留 unknown，后台核查，不自行重发。

响应保留 `X-Request-ID`、`X-Client-Request-ID` 等排障编号；N04 明确返回 compute_request_id。任意追踪 Header 不能代替双方执行/结算编号。

## 7. 并发、故障及错误返回

| 情况 | 必须行为 |
|---|---|
| 多个 Key 同时付费或退回 | 同一个账号资金条件更新/行锁保护，不重复花同一余额 |
| 两个结算进程处理同单 | 数据库唯一约束与事务确保最多一次扣款 |
| 模型请求超时或 SSE 断开 | 查询 N04，不以超时判免费，也不换编号重发 |
| 费用未确认 | 返回 pending/reconciling，金额 null，不假设 0 元 |
| N05 成功但 SEP 没收到响应 | 通过 N04 查原回执，或重放同一结算决定 |
| N06 成功但 SEP 没收到响应 | N07 查原单，不能再次新增一笔充值或退回 |
| 对话执行后余额不足 | SEP 记录欠费；远端不得自行扣全额或抹掉费用单 |
| 免费覆盖全部、付费余额为 0 | 合法服务授权下允许使用；扣费阶段只记录免费消费 |
| Key 轮换、企业停用 | 停止新执行，保留受控的旧任务读取和账务结清能力 |

请求可并发，网络等待和模型运行期间不长期持数据库余额锁。幂等结果、待办及账务状态持久化，不能只保存在单进程内存。

控制接口错误至少包含 `code, message, stage, retryable, next_action` 及业务编号；保留真实原因并脱敏。建议 409 区分 `IDEMPOTENCY_CONFLICT/BILL_NOT_FINAL/SETTLEMENT_MISMATCH/INSUFFICIENT_PAID_FUNDS`，401/403 区分服务认证与企业权限问题。已进入 SSE 后按原协议透传错误，不能把错误包装成正常结束。

`retryable` 只表示可用同一业务编号恢复该步骤，不授权重执行模型。金额、币种或版本不匹配时拒绝结算，双方保留记录并对账，不自动补差或修改价格。

## 8. 请算力平台开发方交付什么

1. 反馈上述接口能否按现有服务复用，以及最终路径、完整请求响应 schema、认证和凭证加密方式。
2. 对开户、混合结算、转入、退回、待确认、余额不足和重复请求分别提供示例；金额全部明确人民币。
3. 明确模型执行记录与账务落库时点、实际费用何时 final，以及 N04 如何恢复未知状态。
4. 实现并提供隔离测试环境，双方联调后再发布切换；不能把本文建议路径当成现有生产能力。

最低联调用例：重复开户只建一个账号；三 Key 共用余额且用途隔离；全免费零扣款；部分免费只扣差额；对话无预占可执行；重复结算/充值/退回不重复过账；超时查原单；视频长任务与轮换可恢复；人民币余额和流水同水位可核对。

待业务确认：对话欠费补收入口、个人钱包支付归属、停用/删除时的旧账处理。它们不能被默认实现成“企业能退走个人资金”或“删记录即免账”。

SEP 侧会配合实现企业凭证绑定、请求编号与服务认证、人民币实际费用读取、免费/付费拆分、本地账务事务、可靠重试和对账。此交接不要求算力平台修改 SEP 业务代码。
