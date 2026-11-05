import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnnouncementType } from '@prisma/client';

export interface CreateAnnouncementDto {
  title: string;
  content: string;
  type: AnnouncementType;
  priority?: number;
  startTime?: Date;
  endTime?: Date;
  published?: boolean;
}

export interface UpdateAnnouncementDto {
  title?: string;
  content?: string;
  type?: AnnouncementType;
  priority?: number;
  startTime?: Date;
  endTime?: Date;
  published?: boolean;
}

@Injectable()
export class AnnouncementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建公告（运营端）
   */
  async create(data: CreateAnnouncementDto, createdById: string) {
    return this.prisma.announcement.create({
      data: {
        ...data,
        createdById,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * 获取公告列表（运营端）- 包含未发布的
   */
  async findAll(page = 1, pageSize = 20, params?: { keyword?: string; type?: AnnouncementType; published?: boolean; activeAt?: Date }) {
    const skip = (page - 1) * pageSize;
    const where: any = {};
    if (params?.keyword?.trim()) where.title = { contains: params.keyword.trim(), mode: 'insensitive' };
    if (params?.type) where.type = params.type;
    if (params?.published !== undefined) where.published = params.published;
    if (params?.activeAt) {
      where.AND = [
        { OR: [{ startTime: null }, { startTime: { lte: params.activeAt } }] },
        { OR: [{ endTime: null }, { endTime: { gte: params.activeAt } }] },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.announcement.findMany({
        skip,
        take: pageSize,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        where,
        include: {
          createdBy: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.announcement.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 获取有效公告（客户端）- 仅已发布且在有效期内的
   */
  async findActive() {
    const now = new Date();

    return this.prisma.announcement.findMany({
      where: {
        published: true,
        AND: [
          {
            OR: [
              { startTime: null },
              { startTime: { lte: now } },
            ],
          },
          {
            OR: [
              { endTime: null },
              { endTime: { gte: now } },
            ],
          },
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        content: true,
        type: true,
        priority: true,
        createdAt: true,
      },
    });
  }

  /**
   * 获取单个公告详情
   */
  async findOne(id: string) {
    return this.prisma.announcement.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * 更新公告
   */
  async update(id: string, data: UpdateAnnouncementDto) {
    return this.prisma.announcement.update({
      where: { id },
      data,
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * 删除公告
   */
  async remove(id: string) {
    return this.prisma.announcement.delete({
      where: { id },
    });
  }

  /**
   * 发布/取消发布公告
   */
  async togglePublish(id: string, published: boolean) {
    return this.prisma.announcement.update({
      where: { id },
      data: { published },
      include: {
        createdBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }
}
