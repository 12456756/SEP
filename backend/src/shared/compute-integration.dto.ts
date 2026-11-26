import { z } from 'zod';

export const ComputeIntegrationKindSchema = z.enum(['chat', 'image', 'video']);
export type ComputeIntegrationKind = z.infer<typeof ComputeIntegrationKindSchema>;
export interface PasswordUpdateResult {
  message: string;
  computePasswordSync: 'SYNCED' | 'PENDING' | 'NOT_REQUIRED';
}
export const computeIntegrationErrorMessages: Record<string, string> = {
  REMOTE_NOT_CONNECTED: '算力平台接口尚未接通',
  COMPUTE_ENTERPRISE_NOT_ENABLED: '企业算力开户或连接初始化尚未完成，请稍后重试',
  COMPUTE_CONNECTION_PENDING: '企业算力连接初始化未完成，后台将自动重试',
  COMPUTE_INITIAL_BALANCE_CONFLICT: '本地算力资金与远端已有流水需先核对，不能重复导入',
  COMPUTE_ENTERPRISE_CONTEXT_REQUIRED: '模型调用缺少企业算力连接，无法使用企业凭证',
  COMPUTE_SETTLEMENT_NOT_CONNECTED: '企业算力连接不可用，请检查开户状态和企业凭证',
  COMPUTE_INITIAL_FUNDS_PENDING: '初始算力余额尚未同步完成，请查询原划转',
  PROVISIONING_FAILED: '开户同步失败，等待原操作重试',
  EMAIL_ALREADY_EXISTS: '算力平台邮箱已被占用，开户已暂停；不能覆盖或自动绑定已有账户',
  INVALID_PASSWORD_HASH: '开户密码凭证格式无效，开户已暂停，请检查 bcrypt 哈希',
  LOCAL_PASSWORD_REQUIRED: '企业管理员尚未设置本地密码，请设置密码后重试原开户任务',
  COMPUTE_REGISTRATION_SECRET_UNAVAILABLE: '开户密码凭证无法解密，请检查原加密配置后重试',
  ACCOUNTING_SYNC_FAILED: '账务同步失败，等待查询原操作结果',
  ENTERPRISE_UNAVAILABLE: '企业或管理员不可用',
  MODE_NOT_ENABLED: '企业新模式账务尚未允许同步',
  LOCAL_DECISION_NOT_READY: '本地结算或划转记录尚未完整确认',
  SETTLEMENT_RECEIPT_MISMATCH: '远端结算回执与原决定不一致',
  TRANSFER_RECEIPT_MISMATCH: '远端划转回执与原操作不一致',
  LEASE_LOST: '同步处理权已转移，等待当前处理者完成',
  COMPUTE_TRANSFER_REJECTED: '算力平台已明确拒绝原划转，该原单不再重试',
};
export const ComputeIntegrationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const ComputeIntegrationMoneySchema = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{6}$/);
export const ProvisionedComputeAccountSchema = z.object({
  remoteAccountId: ComputeIntegrationIdSchema,
  credentials: z.array(z.object({ kind: ComputeIntegrationKindSchema, remoteId: ComputeIntegrationIdSchema,
    version: z.number().int().positive(), apiKey: z.string().min(5).max(8192).refine(value => value.trim() === value && !/[\r\n]/.test(value)),
  }).strict()).length(3).refine(value => new Set(value.map(key => key.kind)).size === 3),
}).strict();
export const ComputeIntegrationListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(100).default(''),
});
export type ComputeIntegrationList = z.infer<typeof ComputeIntegrationListSchema>;

export const ComputeIntegrationRecordsQuerySchema = z.object({
  keyword: z.string().trim().max(128).default(''),
  status: z.enum(['ALL', 'PENDING', 'FAILED', 'SUCCEEDED']).default('ALL'),
});
export type ComputeIntegrationRecordsQuery = z.infer<typeof ComputeIntegrationRecordsQuerySchema>;

export const ComputeExecutionContextSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  sourceRef: ComputeIntegrationIdSchema,
  kind: ComputeIntegrationKindSchema,
  credentialId: ComputeIntegrationIdSchema,
}).strict();
export type ComputeExecutionContext = z.infer<typeof ComputeExecutionContextSchema>;

const ComputeExecutionFeeBaseSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  executionId: ComputeIntegrationIdSchema,
  computeRequestId: ComputeIntegrationIdSchema,
  taskId: ComputeIntegrationIdSchema.optional(),
  currency: z.literal('CNY'),
});
export const ComputeExecutionFeeSchema = z.discriminatedUnion('status', [
  ComputeExecutionFeeBaseSchema.extend({ status: z.enum(['PENDING', 'RECONCILING']) }).strict(),
  ComputeExecutionFeeBaseSchema.extend({ status: z.literal('FINAL'), billId: ComputeIntegrationIdSchema, billVersion: z.number().int().positive(), grossCny: ComputeIntegrationMoneySchema }).strict(),
]);
export type ComputeExecutionFee = z.infer<typeof ComputeExecutionFeeSchema>;

export const ComputeReconciliationSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  businessId: ComputeIntegrationIdSchema,
  ledgerCursor: ComputeIntegrationIdSchema,
  localSequence: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  remoteSequence: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  currency: z.literal('CNY'),
  localBalanceCny: ComputeIntegrationMoneySchema,
  remoteBalanceCny: ComputeIntegrationMoneySchema,
}).strict();
export type ComputeReconciliation = z.infer<typeof ComputeReconciliationSchema>;

export const ComputeSettlementDecisionSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  executionId: ComputeIntegrationIdSchema,
  kind: ComputeIntegrationKindSchema,
  billId: ComputeIntegrationIdSchema,
  billVersion: z.number().int().positive(),
  currency: z.literal('CNY'),
  grossCny: ComputeIntegrationMoneySchema,
  freeCny: ComputeIntegrationMoneySchema,
  paidCny: ComputeIntegrationMoneySchema,
  unpaidCny: ComputeIntegrationMoneySchema,
}).strict();
export type ComputeSettlementDecision = z.infer<typeof ComputeSettlementDecisionSchema>;

export const ComputeTransferIntentSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  businessId: ComputeIntegrationIdSchema,
  direction: z.enum(['credit_compute', 'debit_compute']),
  currency: z.literal('CNY'),
  amountCny: ComputeIntegrationMoneySchema.refine(value => /[1-9]/.test(value), '金额必须大于零'),
  fundingRef: ComputeIntegrationIdSchema,
}).strict();
export type ComputeTransferIntent = z.infer<typeof ComputeTransferIntentSchema>;

const ComputeRemoteReceiptBaseSchema = z.object({
  enterpriseId: ComputeIntegrationIdSchema,
  businessId: ComputeIntegrationIdSchema,
  remoteAccountId: ComputeIntegrationIdSchema,
  remoteLedgerId: ComputeIntegrationIdSchema,
  remoteSequence: z.string().regex(/^(0|[1-9]\d*)$/).optional(),
  currency: z.literal('CNY'),
});
export const ComputeSettlementReceiptSchema = ComputeRemoteReceiptBaseSchema.extend({
  executionId: ComputeIntegrationIdSchema,
  billId: ComputeIntegrationIdSchema,
  billVersion: z.number().int().positive(),
  freeCny: ComputeIntegrationMoneySchema,
  paidCny: ComputeIntegrationMoneySchema,
}).strict();
export type ComputeSettlementReceipt = z.infer<typeof ComputeSettlementReceiptSchema>;
export const ComputeTransferReceiptSchema = ComputeRemoteReceiptBaseSchema.extend({
  direction: z.enum(['credit_compute', 'debit_compute']),
  amountCny: ComputeIntegrationMoneySchema,
}).strict();
export type ComputeTransferReceipt = z.infer<typeof ComputeTransferReceiptSchema>;

export interface ComputeIntegrationView {
  funds?: { totalBalanceCny: string; unallocatedCny: string; memberBalanceCny: string; syncShortfallCny: string;
    generationPaused?: boolean;
    localUnpaidCny: string; pendingSettlementCny: string; remoteAvailableCny: string | null; remoteFrozenCny: string | null;
    sequence: string; observedAt: string | null };
  enterpriseId: string;
  enterpriseName: string;
  remoteAccountId: string | null;
  mode: 'LEGACY' | 'PREPARING' | 'ENTERPRISE';
  status: 'NOT_CONNECTED' | 'PENDING' | 'READY' | 'FAILED';
  connected: boolean;
  credentials: Array<{ kind: ComputeIntegrationKind; configured: boolean; maskedKey: string | null; version: number | null }>;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastSyncedAt: string | null;
  ledgerCursor: string | null;
  pendingJobs: number;
  lastReconciliation?: { status: string; differenceCny: string; checkedAt: string } | null;
}
