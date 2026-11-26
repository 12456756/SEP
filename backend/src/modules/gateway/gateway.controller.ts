import {
  Controller,
  Post,
  Body,
  UseGuards,
  Res,
  HttpCode,
  HttpStatus,
  Headers,
  Req,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { ClientEmployment } from '../client/client-employment.decorator';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { GatewayService } from './gateway.service';
import { GatewayRateLimitGuard, GatewayPolicyRequest } from './gateway-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ChatCompletionRequestSchema } from 'shared';
import type { ChatCompletionRequest, ChatCompletionUsage } from 'shared';
import { GatewayExecutionService } from './gateway-execution.service';
import { waitForGatewayOperation } from './gateway-operation';
import { GatewayAdmissionService, GatewayAdmissionLease } from './gateway-admission.service';
import { GatewayLifecycleService } from '../../common/lifecycle/gateway-lifecycle.service';
import { gatewayUpstreamError, validGatewayCompletion, validGatewayUsage } from './gateway-response';
import { streamErrorDetails, upstreamException, upstreamHeaders } from '../../common/errors/upstream-http.exception';
import { exceptionDetails, hasBusinessError } from '../../common/errors/error-diagnostics';

@ApiTags('gateway')
@Controller('gateway/v1')
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);
  constructor(
    private readonly gatewayService: GatewayService,
    private readonly executions: GatewayExecutionService,
    private readonly admission: GatewayAdmissionService,
    private readonly lifecycle: GatewayLifecycleService,
  ) {}

  @Post('chat/completions')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ default: true, auth: true, chat: true })
  @UseGuards(ClientEmploymentGuard, GatewayRateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '模型网关（OpenAI 兼容）' })
  @ApiResponse({ status: 200, description: 'Chat Completion JSON 或 SSE 流' })
  @ApiResponse({
    status: 400,
    description: '请求字段或模型白名单校验失败，返回 OpenAI 兼容 error',
  })
  @ApiResponse({ status: 401, description: '雇佣令牌无效或过期' })
  @ApiResponse({ status: 403, description: '无订阅授权或余额不足' })
  @ApiResponse({ status: 413, description: 'HTTP 请求体或规范化模型请求超过大小上限' })
  @ApiResponse({
    status: 429,
    description:
      '平台模型请求频率限制或上游限流，含 Retry-After 和 error.source',
  })
  @ApiResponse({ status: 502, description: '上游不可用' })
  @ApiResponse({ status: 503, description: '平台限流服务或上游暂不可用' })
  async chatCompletions(
    @Body(new ZodValidationPipe(ChatCompletionRequestSchema))
    dto: ChatCompletionRequest,
    @ClientEmployment() claims: ClientEmploymentClaims,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: GatewayPolicyRequest,
    @Res() res: Response,
  ) {
    const releaseRequest = this.lifecycle.beginRequest();
    const requestId =
      req.requestId || getHeaderValue(headers, 'x-request-id') || randomUUID();
    const client = new AbortController();
    let executionId: string | undefined;
    let lease: GatewayAdmissionLease | undefined;
    let forwarding = false;
    let upstreamFailed = false;
    let usageUncertain = false;
    const saveUsage = async (usage: ChatCompletionUsage) => {
      try { await waitForGatewayOperation(this.executions.saveUsage(executionId!, usage)); }
      catch (error) { usageUncertain = true; throw error; }
    };
    const onClose = () => {
      if (!res.writableFinished && !upstreamFailed) client.abort();
    };
    res.on('close', onClose);
    if (res.destroyed) client.abort();
    try {
      const snapshot = req.modelRuntimePolicy;
      if (!snapshot) throw new ServiceUnavailableException({ error: {
        message: '模型策略快照不可用', type: 'server_error', source: 'platform',
        code: 'MODEL_RUNTIME_POLICY_UNAVAILABLE',
      } });
      const authorization = await waitForGatewayOperation(this.gatewayService.validateAndAuthorize(claims, dto.model), 'PLATFORM_AUTHORIZATION_TIMEOUT');
      res.setHeader('X-SEP-Payment-Mode', authorization.billingSnapshot?.paymentMode ?? 'AUTO');
      const { request: prepared } = await waitForGatewayOperation(this.gatewayService.prepareRequest(claims, dto, snapshot), 'PLATFORM_MODEL_POLICY_TIMEOUT');
      client.signal.throwIfAborted();
      const execution = await waitForGatewayOperation(this.executions.start(claims, authorization.employeeId, prepared.model, requestId, snapshot, authorization.billingSnapshot));
      executionId = execution.id;
      res.setHeader('X-SEP-Execution-ID', executionId);
      const acquisition = this.admission.acquire(claims, snapshot);
      try { lease = await waitForGatewayOperation(acquisition, 'PLATFORM_ADMISSION_TIMEOUT'); }
      catch (error) {
        // A queued Redis command can admit after we stop waiting; release its owned lease.
        void acquisition.then(late => waitForGatewayOperation(late.release(), 'PLATFORM_ADMISSION_RELEASE_TIMEOUT'), () => undefined)
          .catch(() => this.logger.error({ event: 'gateway_late_admission_cleanup_failed', executionId, requestId }));
        throw error;
      }
      client.signal.throwIfAborted();
      await waitForGatewayOperation(this.admission.reserve(claims, snapshot, prepared, prepared.max_tokens), 'PLATFORM_ADMISSION_TIMEOUT');
      client.signal.throwIfAborted();
      const startedAt = Date.now();
      forwarding = true;
      const upstreamRes = await this.gatewayService.forwardChatCompletion(
        prepared,
        snapshot,
        requestId,
        client.signal,
      );
      const streamMetrics = {
        headerLatencyMs: Date.now() - startedAt,
        firstByteLatencyMs: null as number | null,
        // Unix milliseconds when the last nonempty upstream chunk was received, before checkpointing.
        lastDataAt: null as number | null,
        // Raw body bytes handed to the downstream pipeline, not bytes confirmed received by the client.
        bytesForwarded: 0,
      };
      const logContext = {
        requestId,
        executionId,
        subscriptionId: claims.subscriptionId,
        model: prepared.model,
        policyVersion: snapshot.version,
        upstreamRequestId: upstreamRes.headers
          .get('x-request-id')
          ?.replace(/[^a-zA-Z0-9._:-]/g, '')
          .slice(0, 128),
      };
      await waitForGatewayOperation(this.executions.setUpstreamRequest(executionId, logContext.upstreamRequestId));
      if (prepared.stream)
        this.logger.log({
          message: 'provider response received',
          ...logContext,
          ...streamMetrics,
          status: upstreamRes.status,
          contentType: upstreamRes.headers.get('content-type'),
        });
      if (prepared.stream) {
        if (!upstreamRes.body || upstreamRes.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
          const failure = await upstreamException(upstreamRes);
          if (hasBusinessError(failure.upstreamError.body)) throw failure;
          throw gatewayUpstreamError('UPSTREAM_INVALID_CONTENT_TYPE', 'sub2api 未返回有效的 SSE 流', {
            upstreamStatus: upstreamRes.status, contentType: upstreamRes.headers.get('content-type'),
            ...(failure.readDiagnostics ?? {}),
          });
        }
        // Successful frames retain their bytes; upstream failure frames have already been redacted.
        for (const [name, value] of Object.entries(upstreamHeaders(upstreamRes))) {
          res.setHeader(name === 'x-request-id' ? 'X-Compute-Request-ID' : name, value);
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const observer = this.gatewayService.observeChatCompletionStream();
        let complete = false;
        let errorCode: string | undefined;
        let savedUsage: ChatCompletionUsage | null = null;
        let checkpointError: unknown;
        const streamLogger = this.logger;
        const checkpoint = async (usage: ChatCompletionUsage | null) => {
          if (!usage || (savedUsage?.prompt_tokens === usage.prompt_tokens && savedUsage?.completion_tokens === usage.completion_tokens)) return;
          try { await saveUsage(usage); }
          catch (error) { checkpointError = error; throw error; }
          savedUsage = usage;
        };
        try {
          const source = Readable.fromWeb(
            upstreamRes.body as NodeReadableStream<Uint8Array>,
          );
          source.once('error', () => {
            upstreamFailed = true;
          });
          await pipeline(
            (async function* () {
              try {
                for await (const chunk of source) {
                  if (chunk.byteLength > 0) {
                    const receivedAt = Date.now();
                    streamMetrics.firstByteLatencyMs ??= receivedAt - startedAt;
                    streamMetrics.lastDataAt = receivedAt;
                  }
                  observer.write(chunk);
                  await checkpoint(observer.snapshot().usage);
                  streamMetrics.bytesForwarded += chunk.byteLength;
                  yield chunk;
                }
                const summary = observer.finish();
                await checkpoint(summary.usage);
                if (!summary.finishReason || summary.protocolError) {
                  upstreamFailed = true;
                  throw gatewayUpstreamError('UPSTREAM_INCOMPLETE_STREAM', 'sub2api 流未完整结束');
                }
                complete = true;
              } catch (error) {
                upstreamFailed = true;
                const diagnostic = observer.snapshot().errorDiagnostic ?? streamErrorDetails(error, { requestId, executionId });
                errorCode = String(streamErrorDetails(observer.snapshot().errorDiagnostic ?? error).code ?? 'UPSTREAM_STREAM_ERROR');
                streamLogger.warn({ message: 'gateway stream interrupted', ...logContext, ...streamMetrics,
                  durationMs: Date.now() - startedAt, clientDisconnected: client.signal.aborted, code: errorCode, diagnostic });
                if (!client.signal.aborted && !res.destroyed && !observer.snapshot().errorDiagnostic) {
                  yield Buffer.from(`\n\nevent: error\ndata: ${JSON.stringify({ error: diagnostic })}\n\n`);
                }
              }
            })(),
            res,
          );
        } catch (error) {
          errorCode = error?.getResponse?.()?.error?.code || error?.code || 'UPSTREAM_STREAM_ERROR';
          this.logger.warn({
            message: 'gateway stream interrupted',
            ...logContext,
            ...streamMetrics,
            durationMs: Date.now() - startedAt,
            clientDisconnected: client.signal.aborted,
            code: errorCode,
            diagnostic: exceptionDetails(error),
          });
          // Headers are already sent: terminate abnormally, never fabricate a successful end.
          res.destroy();
        }
        const { usage, finishReason, done } = observer.finish();
        if (checkpointError) throw checkpointError;
        await checkpoint(usage);
        if (complete) {
          const summary = {
            message: 'gateway stream ended',
            ...logContext,
            ...streamMetrics,
            durationMs: Date.now() - startedAt,
            finishReason,
            done,
          };
          if (!done) this.logger.warn(summary);
          else this.logger.log(summary);
        }

        await waitForGatewayOperation(this.executions.finish(executionId, { finishReason, done, errorCode }));
      } else {
        const json = await this.gatewayService.readCompletion(upstreamRes);
        const usage = validGatewayUsage((json as { usage?: unknown } | null)?.usage);
        if (usage) await saveUsage(usage);
        if (!validGatewayCompletion(json)) {
          throw gatewayUpstreamError('UPSTREAM_INVALID_COMPLETION', 'sub2api 未返回有效模型结果');
        }
        res.json(json);
        const finishReason = (json as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason;
        await waitForGatewayOperation(this.executions.finish(executionId, { finishReason }));
      }
    } catch (error) {
      client.abort();
      if (executionId) {
        const definitive = !forwarding || (error?.getStatus?.() < 500 && error?.getStatus?.() >= 400);
        await waitForGatewayOperation(this.executions.fail(executionId, String(streamErrorDetails(error).code ?? 'EXECUTION_FAILED'), definitive, usageUncertain))
          .catch(() => this.logger.error({ event: 'gateway_journal_update_failed', executionId, requestId }));
      }
      // A response may already be complete when settlement storage becomes unavailable.
      if (res.headersSent) {
        this.logger.error({ event: 'gateway_finalization_failed', executionId, requestId });
        if (!res.writableFinished) res.destroy();
      } else throw error;
    } finally {
      res.off('close', onClose);
      try {
        if (lease) await waitForGatewayOperation(lease.release(), 'PLATFORM_ADMISSION_RELEASE_TIMEOUT')
          .catch(() => this.logger.error({ event: 'gateway_admission_release_timeout', executionId, requestId }));
      }
      finally { releaseRequest(); }
    }
  }
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0]?.slice(0, 200) || undefined;
  return value?.slice(0, 200) || undefined;
}
