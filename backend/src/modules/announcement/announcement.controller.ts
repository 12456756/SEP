import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { AnnouncementService, CreateAnnouncementDto, UpdateAnnouncementDto } from './announcement.service';

@ApiTags('Announcements')
@Controller()
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  /**
   * 获取有效公告（客户端 - 无需认证）
   */
  @Get('announcements/active')
  @ApiOperation({ summary: '获取有效公告（客户端）' })
  @ApiResponse({ status: 200, description: '返回已发布且在有效期内的公告列表' })
  async getActiveAnnouncements() {
    return this.announcementService.findActive();
  }

  /**
   * 创建公告（运营端 - 需要管理员权限）
   */
  @Post('admin/announcements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建公告（运营端）' })
  @ApiResponse({ status: 201, description: '公告创建成功' })
  async create(@Request() req, @Body() createDto: any) {
    const data: CreateAnnouncementDto = {
      ...createDto,
      startTime: createDto.startTime ? new Date(createDto.startTime) : undefined,
      endTime: createDto.endTime ? new Date(createDto.endTime) : undefined,
    };
    return this.announcementService.create(data, req.user.id);
  }

  /**
   * 获取公告列表（运营端）
   */
  @Get('admin/announcements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取公告列表（运营端）' })
  @ApiResponse({ status: 200, description: '返回公告列表（包含未发布的）' })
  async findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('type') type?: any,
    @Query('published') published?: string,
    @Query('activeAt') activeAt?: string,
  ) {
    return this.announcementService.findAll(
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 20,
      { keyword, type, published: published === undefined ? undefined : published === 'true', activeAt: activeAt ? new Date(activeAt) : undefined },
    );
  }

  /**
   * 获取单个公告详情（运营端）
   */
  @Get('admin/announcements/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取公告详情（运营端）' })
  @ApiResponse({ status: 200, description: '返回公告详情' })
  async findOne(@Param('id') id: string) {
    return this.announcementService.findOne(id);
  }

  /**
   * 更新公告（运营端）
   */
  @Patch('admin/announcements/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新公告（运营端）' })
  @ApiResponse({ status: 200, description: '公告更新成功' })
  async update(@Param('id') id: string, @Body() updateDto: any) {
    const data: UpdateAnnouncementDto = {
      ...updateDto,
      startTime: updateDto.startTime ? new Date(updateDto.startTime) : undefined,
      endTime: updateDto.endTime ? new Date(updateDto.endTime) : undefined,
    };
    return this.announcementService.update(id, data);
  }

  /**
   * 删除公告（运营端）
   */
  @Delete('admin/announcements/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除公告（运营端）' })
  @ApiResponse({ status: 200, description: '公告删除成功' })
  async remove(@Param('id') id: string) {
    return this.announcementService.remove(id);
  }

  /**
   * 发布/取消发布公告（运营端）
   */
  @Patch('admin/announcements/:id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '发布/取消发布公告（运营端）' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async togglePublish(
    @Param('id') id: string,
    @Body('published') published: boolean,
  ) {
    return this.announcementService.togglePublish(id, published);
  }
}
