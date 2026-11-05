import { BadRequestException, forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType, Prisma } from '@prisma/client';
import type { NotificationCategory } from 'shared';
export type { NotificationCategory } from 'shared';
import { NotificationsGateway } from './notifications.gateway';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'ERROR';

const CATEGORY_TYPES: Record<NotificationCategory, NotificationType[]> = {
  SYSTEM: ['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SKILL_VERSION_UPDATED', 'CONTRIBUTION_REWARD_CREDITED', 'SUBSCRIPTION_EXPIRING'],
  USAGE_ALERT: ['ALLOWANCE_WARNING', 'ALLOWANCE_EXHAUSTED', 'WALLET_LOW_BALANCE'],
  SECURITY: [],
  APPROVAL: [
    'SUBSCRIPTION_REQUEST_CREATED',
    'SUBSCRIPTION_REQUEST_APPROVED',
    'SUBSCRIPTION_REQUEST_REJECTED',
    'CONTRIBUTION_ENTERPRISE_APPROVED',
    'CONTRIBUTION_ENTERPRISE_REJECTED',
    'CONTRIBUTION_PLATFORM_APPROVED',
    'CONTRIBUTION_PLATFORM_REJECTED',
  ],
};

const TYPE_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_TYPES).flatMap(([category, types]) =>
    types.map((type) => [type, category]),
  ),
) as Record<NotificationType, NotificationCategory>;

export interface CreateNotificationDto {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedType?: string;
  relatedId?: string;
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  actionUrl?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService, @Optional() @Inject(forwardRef(() => NotificationsGateway)) private readonly gateway?: NotificationsGateway) {}

  /**
   * 创建通知
   */
  async create(dto: CreateNotificationDto) {
    const created = await this.prisma.notification.create({
      data: this.enrich(dto),
    });
    await this.publishNotification(dto.userId, created);
    return created;
  }

  /**
   * 批量创建通知（给多个用户）
   */
  async createBatch(userIds: string[], notification: Omit<CreateNotificationDto, 'userId'>) {
    const recipients = [...new Set(userIds.filter((userId) => userId.trim()))];
    if (recipients.length === 0) return { count: 0 };

    const created = await this.prisma.notification.createManyAndReturn({
      data: recipients.map((userId) => this.enrich({ userId, ...notification })),
    });
    if (this.gateway) {
      const recordsByUser = new Map<string, typeof created>();
      for (const record of created) {
        const records = recordsByUser.get(record.userId) ?? [];
        records.push(record);
        recordsByUser.set(record.userId, records);
      }
      await Promise.all(
        [...recordsByUser.entries()].map(async ([userId, records]) => {
          await Promise.all(records.map((record) => this.publishNotification(userId, record, false)));
          await this.publishUnreadCount(userId);
        }),
      );
    }
    return { count: created.length };
  }

  private async publishNotification(userId: string, notification: { userId: string; type: NotificationType; category?: string; severity?: string; [key: string]: unknown }, includeUnreadCount = true) {
    if (!this.gateway) return;
    const payload = {
      ...notification,
      category: notification.category ?? TYPE_CATEGORY[notification.type],
      severity: notification.severity ?? this.resolveSeverity(notification.type),
    };
    try {
      await this.gateway.pushToUser(userId, payload);
    } catch (error) {
      this.logger.warn(`Failed to push notification for userId=${userId}: ${this.formatError(error)}`);
    }
    if (includeUnreadCount) await this.publishUnreadCount(userId);
  }

  private async publishUnreadCount(userId: string) {
    if (!this.gateway) return;
    try {
      await this.gateway.pushUnreadCount(userId, await this.countUnread(userId));
    } catch (error) {
      this.logger.warn(`Failed to push unread count for userId=${userId}: ${this.formatError(error)}`);
    }
  }

  private formatError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 获取用户的通知列表
   */
  async findByUser(
    userId: string,
    limit = 50,
    offset = 0,
    category?: NotificationCategory,
    unreadOnly = false,
    keyword?: string,
  ) {
    const where = this.buildWhere(userId, category, unreadOnly, false, keyword);
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        category: item.category ?? TYPE_CATEGORY[item.type],
        severity: item.severity ?? this.resolveSeverity(item.type),
      })),
      total,
    };
  }

  /**
   * 获取未读通知数量
   */
  async countUnread(userId: string, category?: NotificationCategory) {
    return this.prisma.notification.count({
      where: this.buildWhere(userId, category, true),
    });
  }

  /**
   * 标记单条通知为已读
   */
  async markAsRead(id: string, userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    await this.publishUnreadCount(userId);
    return result;
  }

  /**
   * 标记所有通知为已读
   */
  async markAllAsRead(userId: string, category?: NotificationCategory) {
    const result = await this.prisma.notification.updateMany({
      where: this.buildWhere(userId, category, true),
      data: { read: true },
    });
    await this.publishUnreadCount(userId);
    return result;
  }

  /**
   * 删除通知
   */
  async delete(id: string, userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { id, userId },
    });
    await this.publishUnreadCount(userId);
    return result;
  }

  /**
   * 清空所有已读通知
   */
  async clearRead(userId: string, category?: NotificationCategory) {
    const result = await this.prisma.notification.deleteMany({
      where: this.buildWhere(userId, category, false, true),
    });
    await this.publishUnreadCount(userId);
    return result;
  }

  private buildWhere(
    userId: string,
    category?: NotificationCategory,
    unreadOnly = false,
    readOnly = false,
    keyword?: string,
  ): Prisma.NotificationWhereInput {
    if (category && !CATEGORY_TYPES[category]) {
      throw new BadRequestException(`Unsupported notification category: ${category}`);
    }
    const legacyTypeFilter = category
      ? { type: { in: CATEGORY_TYPES[category] } }
      : undefined;
    const categoryFilter = category
      ? {
          OR: [
            { category },
            ...(CATEGORY_TYPES[category].length > 0
              ? [{ category: null, ...legacyTypeFilter }]
              : []),
          ],
        }
      : {};

    const keywordFilter = keyword?.trim()
      ? { OR: [{ title: { contains: keyword.trim(), mode: 'insensitive' as const } }, { message: { contains: keyword.trim(), mode: 'insensitive' as const } }] }
      : undefined;
    const base = {
      userId,
      ...categoryFilter,
      ...(unreadOnly ? { read: false } : {}),
      ...(readOnly ? { read: true } : {}),
    };
    return keywordFilter ? { ...base, AND: [keywordFilter] } : base;
  }

  private enrich(dto: CreateNotificationDto) {
    return {
      ...dto,
      category: dto.category ?? TYPE_CATEGORY[dto.type] ?? 'SYSTEM',
      severity: dto.severity ?? this.resolveSeverity(dto.type),
    };
  }

  private resolveSeverity(type: NotificationType): NotificationSeverity {
    if (type === 'ERROR') return 'ERROR';
    if (
      type === 'WARNING' ||
      type === 'ALLOWANCE_WARNING' ||
      type === 'ALLOWANCE_EXHAUSTED' ||
      type === 'WALLET_LOW_BALANCE'
    ) {
      return 'WARNING';
    }
    return 'INFO';
  }
}
