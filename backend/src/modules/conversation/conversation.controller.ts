import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  Res,
  Logger,
  HttpCode,
  HttpStatus,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationService } from './conversation.service';
import { ConversationStreamService } from './conversation-stream.service';
import { streamErrorDetails } from '../../common/errors/upstream-http.exception';
import {
  ConversationCreateDto,
  ConversationCreateDtoSchema,
  ConversationSource,
  ConversationUpdateDto,
  MessageSendDto,
  MessageSendDtoSchema,
} from 'shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationController {
  private readonly logger = new Logger(ConversationController.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly streamService: ConversationStreamService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建对话会话' })
  @ApiResponse({ status: 201, description: '会话创建成功' })
  async create(
    @Body(new ZodValidationPipe(ConversationCreateDtoSchema)) dto: ConversationCreateDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.conversationService.create(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: '获取当前用户的所有会话' })
  @ApiQuery({ name: 'source', required: false, enum: ['CHAT', 'TASK'], description: '会话来源，默认 CHAT' })
  @ApiResponse({ status: 200, description: '会话列表' })
  async findAll(
    @Request() req: AuthenticatedRequest,
    @Query('source') source?: ConversationSource,
  ) {
    // 对话中心默认只展示普通聊天；任务中心如需查询任务会话可显式传 source=TASK。
    if (source && source !== 'CHAT' && source !== 'TASK') {
      throw new BadRequestException('source must be CHAT or TASK');
    }
    return this.conversationService.findAll(req.user.id, source ?? 'CHAT');
  }

  @Get(':id')
  @ApiOperation({ summary: '获取会话详情及消息历史' })
  @ApiResponse({ status: 200, description: '会话详情' })
  @ApiResponse({ status: 404, description: '会话不存在' })
  async findOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.conversationService.findOne(id, req.user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '重命名会话' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async update(
    @Param('id') id: string,
    @Body() dto: ConversationUpdateDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.conversationService.update(id, req.user.id, dto);
  }

  @Patch(':id/model')
  @ApiOperation({ summary: '切换会话使用的模型' })
  @ApiResponse({ status: 200, description: '切换成功' })
  async switchModel(
    @Param('id') id: string,
    @Body('modelId') modelId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.conversationService.switchModel(id, req.user.id, modelId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除会话（级联删除消息）' })
  @ApiResponse({ status: 204, description: '删除成功' })
  async remove(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.conversationService.remove(id, req.user.id);
  }

  /**
   * SSE 流式发消息
   * POST /conversations/:id/messages
   * Content-Type: text/event-stream
   */
  @Post(':id/messages')
  @Throttle({ chat: { ttl: 60000, limit: 60 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送消息（SSE 流式返回）' })
  @ApiResponse({ status: 200, description: 'SSE 事件流' })
  async sendMessage(
    @Param('id') id: string,
    // 显式挂 Zod 管道：全局 ValidationPipe 只认 class-validator 装饰的类，
    // MessageSendDto 是 z.infer 出来的类型，不挂管道等于完全不校验
    // （attachments 会原样落库并回渲染给前端）。
    @Body(new ZodValidationPipe(MessageSendDtoSchema)) dto: MessageSendDto,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const abort = new AbortController();
    const policyAbort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    const startStream = () => {
      if (res.headersSent) return;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    };

    try {
      const generator = this.streamService.streamConversation(
        id,
        dto.content,
        req.user.id,
        dto.targetEmployeeId, // 传递目标员工 ID（多员工协作）
        dto.attachments, // 多模态附件
        abort.signal,
        (reason) => policyAbort.abort(reason),
      );

      for await (const sseEvent of generator) {
        if (abort.signal.aborted) break;
        startStream();
        if (!res.write(`event: ${sseEvent.event}\ndata: ${JSON.stringify(sseEvent.data)}\n\n`)) {
          await new Promise<void>((resolve) => {
            if (policyAbort.signal.aborted || abort.signal.aborted) return resolve();
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              policyAbort.signal.removeEventListener('abort', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
            policyAbort.signal.addEventListener('abort', done, { once: true });
          });
        }
      }
    } catch (err) {
      this.logger.error(`SSE error session=${id} status=${err instanceof HttpException ? err.getStatus() : 'internal'}`);
      if (!res.headersSent && !abort.signal.aborted) throw err;
      if (!abort.signal.aborted) {
        res.write(`event: error\ndata: ${JSON.stringify(streamErrorDetails(err))}\n\n`);
      }
    } finally {
      res.off('close', onClose);
      if (res.headersSent && !res.destroyed) res.end();
    }
  }
}
