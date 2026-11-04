import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TaskQueueService } from '../modules/task-execution/task-queue.service';
import { KnowledgeQueueService } from '../modules/knowledge/knowledge-queue.service';
import { GatewayLifecycleService } from '../common/lifecycle/gateway-lifecycle.service';
import { SettingService } from '../modules/setting/setting.service';
import { SETTING_KEYS } from 'shared';

@Controller('health')
@ApiTags('Health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly taskQueue: TaskQueueService,
    private readonly knowledgeQueue: KnowledgeQueueService,
    private readonly gatewayLifecycle: GatewayLifecycleService,
    private readonly settings: SettingService,
  ) {}

  @Get()
  @ApiOperation({ summary: '存活检查（Liveness）' })
  @ApiResponse({ status: 200, description: 'Process alive; includes read-only Gateway lifecycle state' })
  liveness() {
    return { 
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'sep-backend',
      ...this.gatewayLifecycle.snapshot(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: '就绪检查（Readiness）- 检查核心服务依赖，不执行嵌入模型推理' })
  @ApiResponse({ status: 200, description: 'Dependencies ready and Gateway accepting requests' })
  @ApiResponse({ status: 503, description: 'Dependencies unavailable or Gateway draining/stopping' })
  async readiness(@Res({ passthrough: true }) response: Response) {
    const initial = this.gatewayLifecycle.snapshot();
    response.setHeader('Cache-Control', 'no-store');
    if (initial.draining) {
      response.status(503);
      return { status: initial.gatewayState, ...initial, timestamp: new Date().toISOString() };
    }
    const checks: Record<string, string> = {};
    
    // 数据库检查
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'failed';
    }
    
    // Redis 检查
    try {
      await this.redis.redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'failed';
    }
    
    // 队列检查
    checks.taskQueue = this.taskQueue.isReady() ? 'ok' : 'failed';
    checks.knowledgeQueue = this.knowledgeQueue.isReady() ? 'ok' : 'failed';
    
    // 生产环境额外检查
    if (this.config.get('NODE_ENV') === 'production') {
      checks.sub2api = await this.checkSub2Api() ? 'ok' : 'failed';
      // Feature-specific model inference must not gate the whole application's deployment.
      
      // 检查 OpenCode Skills Service
      const opencodeBaseUrl = this.config.get<string>('OPENCODE_API_BASE_URL');
      if (opencodeBaseUrl) {
        checks.opencode = await this.checkOpenCode(opencodeBaseUrl) ? 'ok' : 'failed';
      }
    }
    
    const lifecycle = this.gatewayLifecycle.snapshot();
    const status = lifecycle.draining ? lifecycle.gatewayState
      : Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'failed';
    const body = { 
      status, 
      checks,
      ...lifecycle,
      timestamp: new Date().toISOString(),
    };
    
    response.status(status === 'ok' ? 200 : 503);
    return body;
  }

  private async checkSub2Api(): Promise<boolean> {
    try {
      const [baseUrl, apiKey] = await Promise.all([
        this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_BASE_URL),
        this.settings.getEffectiveValue(SETTING_KEYS.SUB2API_API_KEY),
      ]);
      if (!baseUrl?.trim() || !apiKey?.trim()) return false;

      const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;

      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('data' in payload)) return false;
      const models = (payload as { data?: unknown }).data;
      return Array.isArray(models) && models.every(
        (model) => !!model && typeof model === 'object' &&
          'id' in model && typeof (model as { id?: unknown }).id === 'string',
      );
    } catch {
      return false;
    }
  }

  private async checkOpenCode(baseUrl: string): Promise<boolean> {
    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/health`;
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
