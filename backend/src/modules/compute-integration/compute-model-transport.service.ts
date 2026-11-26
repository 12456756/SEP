import { ConflictException, ForbiddenException, HttpException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ComputeIntegrationService } from './compute-integration.service';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PaymentModeSchema } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeAccountingService } from './compute-accounting.service';
import { ComputeProtocolClient } from './compute-protocol.client';

export interface ComputeChatFunding {
  userId?: string;
  memberId?: string;
  subscriptionId?: string;
  employeeId?: string;
  sessionId?: string;
  gatewayId?: string;
}
export const ComputeChatContextSchema = z.object({ userId: z.string().min(1), memberId: z.string().min(1), modelId: z.string().min(1),
  paymentMode: PaymentModeSchema.default('AUTO'),
  subscriptionId: z.string().optional(), employeeId: z.string().optional(), sessionId: z.string().optional(), gatewayId: z.string().optional() }).strict();

@Injectable()
export class ComputeModelTransportService {
  constructor(private readonly prisma: PrismaService, private readonly accounting: ComputeAccountingService,
    private readonly protocol: ComputeProtocolClient, @Optional() private readonly integrations?: ComputeIntegrationService) {}

  async provider(enterpriseId: string, connection: { baseURL: string; apiKey: string; credentialId: string }, funding: ComputeChatFunding = {}) {
    const member = await this.prisma.enterpriseMember.findFirst({ where: { enterpriseId,
      ...(funding.memberId ? { id: funding.memberId } : { userId: funding.userId ?? '' }), user: { status: 'ACTIVE' } }, select: { id: true, userId: true, paymentMode: true } });
    if (!member || funding.userId && funding.userId !== member.userId) throw new ForbiddenException('模型请求缺少有效的企业付款成员');
    const context = ComputeChatContextSchema.omit({ modelId: true }).strip().parse({ ...funding, memberId: member.id, userId: member.userId, paymentMode: member.paymentMode });
    return { baseURL: connection.baseURL, apiKey: connection.apiKey, fetch: (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const base = new URL(connection.baseURL);
      if (url.origin !== base.origin || !['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname)
        || url.search || (init?.method ?? 'POST') !== 'POST' || typeof init?.body !== 'string') {
        throw new ServiceUnavailableException('企业模型请求的路由或请求体无效');
      }
      const body = JSON.parse(init.body);
      if (typeof body.model !== 'string') throw new ServiceUnavailableException('企业模型请求缺少模型');
      init.signal?.throwIfAborted();
      const sourceRef = context.gatewayId ?? randomUUID();
      let credential = connection;
      let execution;
      try {
        execution = await this.accounting.createExecution({ enterpriseId, kind: 'chat', sourceRef, credentialId: credential.credentialId });
      } catch (error) {
        const response = error instanceof HttpException ? error.getResponse() : null;
        if (!this.integrations || !response || typeof response !== 'object' || (response as any).code !== 'CREDENTIAL_VERSION_CONFLICT') throw error;
        const current = await this.integrations.selectEnterpriseCredential(enterpriseId, 'chat');
        credential = { ...connection, ...current };
        // The previous attempt failed before execution creation or any network send.
        execution = await this.accounting.createExecution({ enterpriseId, kind: 'chat', sourceRef, credentialId: credential.credentialId });
      }
      await this.prisma.$transaction(async tx => {
        const claimed = await tx.computeIntegrationExecution.updateMany({ where: { id: execution.id, dispatchStatus: 'PREPARED' }, data: {
          baseUrl: connection.baseURL, fundingContext: { ...context, modelId: body.model }, dispatchStatus: 'DISPATCHING',
        } });
        if (!claimed.count) throw new ConflictException('原模型请求已经提交或结果未知，只能查询原执行');
        await tx.computeIntegrationJob.upsert({ where: { businessId: `fee_${execution.id}` }, update: {}, create: {
          enterpriseId, businessId: `fee_${execution.id}`, kind: 'FEE', status: 'PENDING', nextRunAt: new Date(Date.now() + 60000),
        } });
      });
      if (init.signal?.aborted) {
        await this.prisma.$transaction(async tx => {
          await tx.computeIntegrationExecution.update({ where: { id: execution.id }, data: { dispatchStatus: 'NOT_SUBMITTED' } });
          await tx.computeIntegrationJob.update({ where: { businessId: `fee_${execution.id}` }, data: { status: 'SUCCEEDED', lastErrorCode: 'REQUEST_ABORTED_BEFORE_SEND' } });
          if (context.gatewayId) await tx.gatewayExecution.update({ where: { id: context.gatewayId }, data: { status: 'FAILED', errorCode: 'REQUEST_ABORTED_BEFORE_SEND' } });
        });
        init.signal.throwIfAborted();
      }
      // One durable execution per physical request. Never retry generation in this transport.
      return this.protocol.request(url.pathname, { method: 'POST', enterpriseId, executionId: execution.id,
        apiKey: credential.apiKey, rawBody: Buffer.from(init.body), contentType: 'application/json', signal: init.signal ?? undefined }, url.origin);
    }) as typeof fetch };
  }
}
