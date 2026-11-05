import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  NotificationCategoryQuerySchema,
  NotificationListQuerySchema,
} from 'shared';
import type {
  NotificationCategoryQuery,
  NotificationListQuery,
} from 'shared';

@ApiTags('notifications')
@Controller('notifications')
// 通知属于普通业务：所有 REST 操作保留 default，跳过认证/聊天专属规则。
@SkipThrottle({ auth: true, chat: true })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@ApiResponse({ status: 429, description: '超过普通业务请求额度；Retry-After 为剩余等待秒数' })
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: '获取通知列表' })
  @ApiResponse({ status: 200, description: '返回当前用户的通知列表及总数' })
  @ApiResponse({ status: 400, description: '查询参数校验失败' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async list(
    @Request() req,
    @Query(new ZodValidationPipe(NotificationListQuerySchema))
    query: NotificationListQuery,
  ) {
    const userId = req.user.id;
    return this.notificationsService.findByUser(
      userId,
      query.limit,
      query.offset,
      query.category,
      query.unreadOnly,
      query.keyword,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: '获取未读通知数量' })
  @ApiResponse({ status: 200, description: '返回未读通知数量' })
  @ApiResponse({ status: 400, description: '查询参数校验失败' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async unreadCount(
    @Request() req,
    @Query(new ZodValidationPipe(NotificationCategoryQuerySchema))
    query: NotificationCategoryQuery,
  ) {
    const userId = req.user.id;
    const count = await this.notificationsService.countUnread(userId, query.category);
    return { count };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '标记单条通知为已读' })
  @ApiResponse({ status: 204, description: '标记成功；响应无 body' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async markAsRead(@Param('id') id: string, @Request() req) {
    const userId = req.user.id;
    await this.notificationsService.markAsRead(id, userId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '标记所有通知为已读' })
  @ApiResponse({ status: 204, description: '标记成功；响应无 body' })
  @ApiResponse({ status: 400, description: '查询参数校验失败' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async markAllAsRead(
    @Request() req,
    @Query(new ZodValidationPipe(NotificationCategoryQuerySchema))
    query: NotificationCategoryQuery,
  ) {
    const userId = req.user.id;
    await this.notificationsService.markAllAsRead(userId, query.category);
  }

  @Delete('clear-read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '清空所有已读通知' })
  @ApiResponse({ status: 204, description: '清理成功；响应无 body' })
  @ApiResponse({ status: 400, description: '查询参数校验失败' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async clearRead(
    @Request() req,
    @Query(new ZodValidationPipe(NotificationCategoryQuerySchema))
    query: NotificationCategoryQuery,
  ) {
    const userId = req.user.id;
    await this.notificationsService.clearRead(userId, query.category);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除通知' })
  @ApiResponse({ status: 204, description: '删除成功；响应无 body' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async delete(@Param('id') id: string, @Request() req) {
    const userId = req.user.id;
    await this.notificationsService.delete(id, userId);
  }
}
