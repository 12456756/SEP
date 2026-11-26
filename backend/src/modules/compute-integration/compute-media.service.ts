import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeConnectionService } from './compute-connection.service';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeAccountingService } from './compute-accounting.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeProtocolClient } from './compute-protocol.client';

export const ComputeMediaSnapshotSchema = z.object({ enterpriseId: z.string(), credentialId: z.string(), baseUrl: z.string(),
  quoteId: z.string().optional() }).strict();
export type ComputeMediaSnapshot = z.infer<typeof ComputeMediaSnapshotSchema>;
export interface ComputeMediaIdentity { enterpriseId: string; executionId?: string; quoteId?: string }

@Injectable()
export class ComputeMediaService {
  constructor(private readonly prisma: PrismaService, private readonly connections: ComputeConnectionService,
    private readonly integration: ComputeIntegrationService, private readonly accounting: ComputeAccountingService,
    private readonly remote: ComputeRemoteAdapter, private readonly protocol: ComputeProtocolClient) {}

  async connection(enterpriseId: string, kind: 'image' | 'video', pinned?: ComputeMediaSnapshot, sourceRef?: string) {
    const execution = sourceRef ? await this.findExecution(enterpriseId, kind, sourceRef) : null;
    const current = execution ? await this.integration.selectExecutionCredential(enterpriseId, execution.id) : await this.connections.resolve(enterpriseId, kind);
    const base = execution?.baseUrl ?? pinned?.baseUrl ?? ('baseURL' in current ? String(current.baseURL) : '');
    if (pinned && (pinned.enterpriseId !== enterpriseId || pinned.credentialId !== current.credentialId)) throw new ConflictException('媒体报价的企业凭证已变化，请重新报价');
    this.protocol.validateAddress(base);
    const compute: ComputeMediaIdentity = { enterpriseId, ...(execution ? { executionId: execution.id } : {}), ...(pinned?.quoteId ? { quoteId: pinned.quoteId } : {}) };
    return { base, key: current.apiKey, fingerprint: createHash('sha256').update(`${base}\0${current.apiKey}`).digest('hex'), compute,
      snapshot: { enterpriseId, credentialId: current.credentialId, baseUrl: base, ...(pinned?.quoteId ? { quoteId: pinned.quoteId } : {}) } };
  }

  async begin(enterpriseId: string, kind: 'image' | 'video', receiptId: string, pinned: ComputeMediaSnapshot, modelId: string) {
    const execution = await this.accounting.createExecution({ enterpriseId, kind, sourceRef: receiptId, credentialId: pinned.credentialId });
    await this.prisma.computeIntegrationExecution.update({ where: { id: execution.id }, data: { baseUrl: pinned.baseUrl, fundingContext: { modelId } } });
    return execution;
  }

  findExecution(enterpriseId: string, kind: 'image' | 'video', receiptId: string) {
    return this.prisma.computeIntegrationExecution.findUnique({ where: { enterpriseId_kind_sourceRef: { enterpriseId, kind, sourceRef: receiptId } } });
  }

  async markDispatch(enterpriseId: string, kind: 'image' | 'video', receiptId: string) {
    const claimed = await this.prisma.computeIntegrationExecution.updateMany({ where: { enterpriseId, kind, sourceRef: receiptId, dispatchStatus: 'PREPARED' }, data: { dispatchStatus: 'DISPATCHING' } });
    if (!claimed.count) throw new ConflictException('原媒体任务已发送或已关闭，不能再次生成');
  }

  async closeUnsent(enterpriseId: string, kind: 'image' | 'video', receiptId: string) {
    await this.prisma.computeIntegrationExecution.updateMany({ where: { enterpriseId, kind, sourceRef: receiptId, dispatchStatus: 'PREPARED' }, data: { dispatchStatus: 'NOT_SUBMITTED' } });
    return (await this.findExecution(enterpriseId, kind, receiptId))?.dispatchStatus === 'NOT_SUBMITTED';
  }

  async fee(enterpriseId: string, kind: 'image' | 'video', receiptId: string) {
    const execution = await this.findExecution(enterpriseId, kind, receiptId);
    if (!execution || ['PREPARED', 'NOT_SUBMITTED'].includes(execution.dispatchStatus)) return null;
    const context = z.object({ modelId: z.string().min(1) }).parse(execution.fundingContext);
    const evidence = await this.remote.executionEvidence(enterpriseId, execution.id, kind, context.modelId);
    const result = await this.accounting.recordFee(evidence.fee);
    if (result.feeStatus === 'FINAL') await this.prisma.computeIntegrationExecution.update({ where: { id: result.id }, data: { dispatchStatus: evidence.executionStatus.toUpperCase() } });
    return result;
  }
}
