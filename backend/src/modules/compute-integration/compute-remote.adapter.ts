import { BadRequestException, ConflictException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ComputeBalanceEventSchema, ComputeBalanceSequenceSchema, type ComputeExecutionFee, type ComputeIntegrationKind, type ComputeSettlementDecision, type ComputeTransferIntent, type ComputeSettlementReceipt, type ComputeTransferReceipt } from 'shared';
import { z } from 'zod';
import { Decimal } from '@prisma/client/runtime/library';
import { ComputeProtocolClient, ComputeWireId } from './compute-protocol.client';
import { BalanceResponse, BillingResponse, CredentialDelivery, EnterpriseResponse, LedgerResponse, RegistrationSnapshot,
  RegistrationPasswordHash, PasswordSyncResponse, SettlementResponse, TransferResponse, wireParse } from './compute-wire-contract';

export interface ProvisionedComputeAccount {
  remoteAccountId: string;
  credentials: Array<{ kind: ComputeIntegrationKind; remoteId: string; version: number; apiKey: string }>;
}

@Injectable()
export class ComputeRemoteAdapter {
  constructor(@Optional() private readonly protocol?: ComputeProtocolClient) {}
  isConnected(): boolean { return this.protocol?.isConfigured() ?? false; }
  private client() {
    if (!this.protocol) throw new ServiceUnavailableException({ code: 'REMOTE_NOT_CONNECTED', message: '算力平台接口尚未接通' });
    return this.protocol;
  }
  private id(value: string) { return wireParse(ComputeWireId, value); }
  async syncPassword(input: { enterpriseId: string; remoteAccountId: string; operationId: string; version: number; passwordHash: string }) {
    if (!RegistrationPasswordHash.safeParse(input.passwordHash).success || !Number.isSafeInteger(input.version) || input.version < 1) {
      throw new BadRequestException({ code: 'INVALID_PASSWORD_HASH', message: '密码同步凭证或版本无效' });
    }
    const response = wireParse(PasswordSyncResponse, await this.client().json(`/api/v1/sep/enterprises/${this.id(input.enterpriseId)}/password`, {
      method: 'POST', enterpriseId: input.enterpriseId, idempotencyKey: this.id(input.operationId),
      body: { contract_version: 1, enterprise_id: input.enterpriseId, compute_account_id: Number(input.remoteAccountId),
        operation_id: input.operationId, password_version: input.version, password_hash: input.passwordHash },
    }));
    if (response.enterprise_id !== input.enterpriseId || String(response.compute_account_id) !== input.remoteAccountId
      || response.operation_id !== input.operationId || response.password_version !== input.version
      || (response.status === 'applied' ? response.applied_version !== input.version : response.applied_version <= input.version)) {
      throw new ConflictException({ code: 'COMPUTE_IDENTITY_MISMATCH', message: '密码同步回执与原企业账号或版本不一致' });
    }
    return response;
  }
  registration(input: { enterpriseId: string; registrationRef: string; companyName: string; adminEmail: string; passwordHash: string; encryptionKeyId?: string }) {
    if (!RegistrationPasswordHash.safeParse(input.passwordHash).success) {
      throw new BadRequestException({ code: 'INVALID_PASSWORD_HASH', message: '开户需要有效的 bcrypt 密码哈希，请检查本地密码凭证' });
    }
    return wireParse(RegistrationSnapshot, { ...input, encryptionKeyId: input.encryptionKeyId ?? this.client().encryptionKeyId() });
  }
  async provision(input: { enterpriseId: string; registrationRef: string; companyName: string; adminEmail: string; passwordHash: string; encryptionKeyId?: string }): Promise<ProvisionedComputeAccount> {
    const value = this.registration(input);
    const body = { enterprise_id: value.enterpriseId, registration_ref: value.registrationRef, company_name: value.companyName,
      admin_email: value.adminEmail, encryption_key_id: value.encryptionKeyId, password_hash: value.passwordHash };
    const result = wireParse(EnterpriseResponse, await this.client().json('/api/v1/sep/enterprises', {
      method: 'POST', body, enterpriseId: value.enterpriseId, idempotencyKey: value.registrationRef,
    }));
    if (result.enterprise_id !== value.enterpriseId || result.company_name !== value.companyName || result.admin_email !== value.adminEmail || result.status !== 'ready') {
      throw new ConflictException({ code: 'COMPUTE_IDENTITY_MISMATCH', message: '开户响应的企业身份或状态与原请求不一致' });
    }
    return { remoteAccountId: String(result.compute_account_id), credentials: result.credentials.map(credential => {
      if (!credential.encrypted_key || credential.encryption_key_id !== value.encryptionKeyId) throw new ConflictException({ code: 'COMPUTE_CREDENTIAL_DELIVERY_INVALID', message: '开户响应缺少原版本凭证密文' });
      const clear = wireParse(CredentialDelivery, this.client().decryptCredential(credential.encrypted_key, credential.encryption_key_id));
      if (clear.enterprise_id !== value.enterpriseId || clear.compute_account_id !== result.compute_account_id || clear.type !== credential.type
        || clear.credential_id !== credential.credential_id || clear.credential_version !== credential.credential_version) {
        throw new ConflictException({ code: 'COMPUTE_IDENTITY_MISMATCH', message: '凭证密文内的企业、账号、用途或版本不匹配' });
      }
      return { kind: clear.type, remoteId: clear.credential_id, version: clear.credential_version, apiKey: clear.key };
    }) };
  }

  /** An implementation must recover an unknown result with the original business id. */
  async settle(input: ComputeSettlementDecision & { businessId: string; remoteAccountId: string }): Promise<ComputeSettlementReceipt> {
    await this.assertAccount(input.enterpriseId, input.remoteAccountId);
    if (!new Decimal(input.unpaidCny).isZero() || !new Decimal(input.grossCny).eq(new Decimal(input.freeCny).add(input.paidCny)) || input.billVersion !== 1) {
      throw new ConflictException({ code: 'LOCAL_DECISION_NOT_READY', message: '实际费用必须完整结清并匹配最终费用版本后才能同步' });
    }
    const bill = await this.billing(input.enterpriseId, input.executionId);
    if (bill.fee_status !== 'final' || bill.bill_id !== input.billId || bill.bill_version !== input.billVersion || bill.kind !== input.kind
      || !new Decimal(bill.gross_cny!).eq(input.grossCny)) throw new ConflictException({ code: 'SETTLEMENT_RECEIPT_MISMATCH', message: '远端最终费用与本地结算决定不一致' });
    const response = wireParse(SettlementResponse, await this.client().json(`/api/v1/sep/executions/${this.id(input.executionId)}/settlement`, {
      method: 'POST', enterpriseId: input.enterpriseId, idempotencyKey: input.businessId,
      body: { contract_version: 1, enterprise_id: input.enterpriseId, settlement_id: input.businessId, bill_id: input.billId,
        bill_version: input.billVersion, currency: 'CNY', gross_cny: input.grossCny, free_cny: input.freeCny, paid_cny: input.paidCny },
    }));
    if (response.enterprise_id !== input.enterpriseId || response.execution_id !== input.executionId || response.settlement_id !== input.businessId
      || response.bill_id !== input.billId || response.charged_paid_cny !== input.paidCny || response.recorded_free_cny !== input.freeCny) {
      throw new ConflictException({ code: 'SETTLEMENT_RECEIPT_MISMATCH', message: '远端结算回执与原决定不一致' });
    }
    return { enterpriseId: response.enterprise_id, executionId: response.execution_id, businessId: response.settlement_id,
      remoteAccountId: input.remoteAccountId, remoteLedgerId: response.ledger_entry_id, billId: response.bill_id, billVersion: bill.bill_version,
      currency: 'CNY', freeCny: response.recorded_free_cny, paidCny: response.charged_paid_cny, remoteSequence: response.sequence };
  }

  async transfer(input: ComputeTransferIntent & { remoteAccountId: string }): Promise<ComputeTransferReceipt> {
    await this.assertAccount(input.enterpriseId, input.remoteAccountId);
    const response = await this.transferResult(input, await this.client().json('/api/v1/sep/transfers', {
      method: 'POST', enterpriseId: input.enterpriseId, idempotencyKey: input.businessId,
      body: { contract_version: 1, enterprise_id: input.enterpriseId, transfer_id: input.businessId, direction: input.direction,
        currency: 'CNY', amount_cny: input.amountCny, funding_ref: input.fundingRef },
    }));
    if (response.status === 'rejected') throw new ConflictException({ code: 'COMPUTE_TRANSFER_REJECTED', message: `算力平台已拒绝原划转：${response.reason}`, remoteReason: response.reason });
    return { enterpriseId: response.enterprise_id, businessId: response.transfer_id, remoteAccountId: input.remoteAccountId,
      remoteLedgerId: response.ledger_entry_id, currency: 'CNY', direction: response.direction, amountCny: response.amount_cny, remoteSequence: response.sequence };
  }

  async enterprise(enterpriseId: string) {
    const response = wireParse(EnterpriseResponse, await this.client().json(`/api/v1/sep/enterprises/${this.id(enterpriseId)}`, { enterpriseId }));
    if (response.enterprise_id !== enterpriseId || response.credentials.some(value => value.encrypted_key)) throw new ConflictException('企业状态响应归属或凭证交付字段异常');
    return response;
  }

  async billing(enterpriseId: string, executionId: string) {
    const response = wireParse(BillingResponse, await this.client().json(`/api/v1/sep/executions/${this.id(executionId)}/billing`, { enterpriseId }));
    if (response.enterprise_id !== enterpriseId || response.execution_id !== executionId) throw new ConflictException('费用响应与原企业或执行不一致');
    if (response.settlement_receipt && (response.settlement_receipt.enterprise_id !== enterpriseId || response.settlement_receipt.execution_id !== executionId
      || response.settlement_receipt.bill_id !== response.bill_id)) throw new ConflictException('费用响应的结算回执归属不一致');
    return response;
  }

  async executionFee(enterpriseId: string, executionId: string, kind: ComputeIntegrationKind, expectedModel?: string): Promise<ComputeExecutionFee> {
    return (await this.executionEvidence(enterpriseId, executionId, kind, expectedModel)).fee;
  }

  async executionEvidence(enterpriseId: string, executionId: string, kind: ComputeIntegrationKind, expectedModel?: string) {
    const response = await this.billing(enterpriseId, executionId);
    if (response.kind !== kind) throw new ConflictException('实际费用的用途与原执行不一致');
    if (expectedModel && response.model_id !== expectedModel) throw new ConflictException('实际费用的模型与原执行不一致');
    const base = { enterpriseId, executionId, computeRequestId: response.compute_request_id, currency: 'CNY' as const,
      ...(response.task_id ? { taskId: response.task_id } : {}) };
    const fee: ComputeExecutionFee = response.fee_status === 'final' ? { ...base, status: 'FINAL', billId: response.bill_id, billVersion: response.bill_version, grossCny: response.gross_cny! }
      : { ...base, status: response.fee_status === 'reconciling' ? 'RECONCILING' : 'PENDING' };
    return { fee, usage: response.usage, executionStatus: response.execution_status };
  }

  async queryTransfer(input: ComputeTransferIntent & { remoteAccountId: string }) {
    await this.assertAccount(input.enterpriseId, input.remoteAccountId);
    return this.transferResult(input, await this.client().json(`/api/v1/sep/transfers/${this.id(input.businessId)}`, { enterpriseId: input.enterpriseId }));
  }

  private transferResult(input: ComputeTransferIntent, payload: unknown) {
    const response = wireParse(TransferResponse, payload);
    if (response.enterprise_id !== input.enterpriseId || response.transfer_id !== input.businessId || response.direction !== input.direction
      || response.amount_cny !== input.amountCny || response.funding_ref !== input.fundingRef) throw new ConflictException({ code: 'TRANSFER_RECEIPT_MISMATCH', message: '划转回执与原请求不一致' });
    return response;
  }

  private async assertAccount(enterpriseId: string, accountId: string) {
    if (String((await this.enterprise(enterpriseId)).compute_account_id) !== accountId) throw new ConflictException('企业绑定的远端账号与算力平台不一致');
  }

  async balance(enterpriseId: string) {
    const response = wireParse(BalanceResponse, await this.client().json(`/api/v1/sep/enterprises/${this.id(enterpriseId)}/balance`, { enterpriseId }));
    this.assertBalance(enterpriseId, response); return response;
  }

  async balanceEvents(enterpriseId: string, after = '0', limit = 100) {
    wireParse(ComputeBalanceSequenceSchema, after);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ConflictException('事件分页条数无效');
    const page = wireParse(z.object({ contract_version: z.literal(1), after_sequence: ComputeBalanceSequenceSchema,
      has_more: z.boolean(), items: z.array(z.object({ event_id: ComputeWireId, sequence: ComputeBalanceSequenceSchema,
        payload: ComputeBalanceEventSchema, status: z.string(), attempts: z.number().int().nonnegative(),
        last_error: z.string(), next_attempt_at: z.string().datetime({ offset: true }) })).max(200) }),
      await this.client().json(`/api/v1/sep/enterprises/${this.id(enterpriseId)}/balance-events?after_sequence=${after}&limit=${limit}`, { enterpriseId }));
    let last = BigInt(after);
    for (const item of page.items) {
      if (item.payload.enterprise_id !== enterpriseId || item.event_id !== item.payload.event_id
        || item.sequence !== item.payload.sequence || BigInt(item.sequence) <= last) throw new ConflictException({
        code: 'COMPUTE_EVENT_PAGE_INVALID', message: '余额事件分页归属、编号或顺序不一致', enterpriseId });
      last = BigInt(item.sequence);
    }
    if (BigInt(page.after_sequence) !== last || page.has_more && !page.items.length) throw new ConflictException('余额事件分页游标无效');
    return page;
  }

  async acknowledgeBalanceEvent(enterpriseId: string, eventId: string) {
    const receipt = wireParse(z.object({ event_id: ComputeWireId, status: z.literal('applied') }),
      await this.client().json(`/api/v1/sep/balance-events/${this.id(eventId)}/ack`, {
        method: 'POST', enterpriseId, idempotencyKey: eventId,
      }));
    if (receipt.event_id !== eventId) throw new ConflictException('余额事件确认编号不一致');
    return receipt;
  }

  private assertBalance(enterpriseId: string, value: { enterprise_id: string; total_paid_cny: string; available_paid_cny: string; frozen_paid_cny: string }) {
    if (value.enterprise_id !== enterpriseId || !new Decimal(value.total_paid_cny).eq(new Decimal(value.available_paid_cny).add(value.frozen_paid_cny))) {
      throw new ConflictException('远端人民币余额归属或金额守恒无效');
    }
  }

  async ledger(enterpriseId: string, after = '0', snapshot = '0', limit = 100) {
    if (!/^\d+$/.test(after) || !/^\d+$/.test(snapshot) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ConflictException('流水游标无效');
    const response = wireParse(LedgerResponse, await this.client().json(`/api/v1/sep/enterprises/${this.id(enterpriseId)}/ledger?after_sequence=${after}&snapshot_sequence=${snapshot}&limit=${limit}`, { enterpriseId }));
    this.assertBalance(enterpriseId, response);
    let last = BigInt(after);
    for (const entry of response.items) {
      if (entry.enterprise_id !== enterpriseId) throw new ConflictException({ code: 'COMPUTE_LEDGER_IDENTITY_MISMATCH', message: '远端流水不属于当前企业', expectedEnterpriseId: enterpriseId, entryEnterpriseId: entry.enterprise_id, ledgerEntryId: entry.ledger_entry_id });
      if (BigInt(entry.sequence) <= last) throw new ConflictException({ code: 'COMPUTE_LEDGER_ORDER_INVALID',
        message: `算力流水未按数字升序返回：上一条 ${last}，本条 ${entry.sequence}；请修复算力平台分页排序`,
        afterSequence: after, previousSequence: last.toString(), entrySequence: entry.sequence, snapshotSequence: response.snapshot_sequence });
      if (BigInt(entry.sequence) > BigInt(response.snapshot_sequence)) throw new ConflictException({ code: 'COMPUTE_LEDGER_WATERMARK_INVALID', message: '远端流水超出原快照水位', entrySequence: entry.sequence, snapshotSequence: response.snapshot_sequence });
      last = BigInt(entry.sequence);
    }
    if ((snapshot !== '0' && response.snapshot_sequence !== snapshot) || BigInt(response.after_sequence) !== last
      || response.has_more && !response.items.length) throw new ConflictException('远端流水分页快照不一致');
    return response;
  }
}
