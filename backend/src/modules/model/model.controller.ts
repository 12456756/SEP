import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ModelService } from './model.service';
import { UpdatePlatformModelDtoSchema, type UpdatePlatformModelDto } from 'shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@ApiTags('models')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('models')
export class ModelController {
  constructor(private readonly modelService: ModelService) {}

  // ── 用户端 ──────────────────────────────────────────────────────────────

  @Get('enabled')
  @ApiOperation({ summary: '获取平台已启用的模型（用户端可选范围）' })
  @ApiResponse({ status: 200, description: '已启用模型列表' })
  listEnabled() {
    return this.modelService.listEnabled();
  }

  // ── 管理端 ──────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '列出平台全部模型（含禁用/失效，仅管理员）' })
  @ApiResponse({ status: 200, description: '模型列表' })
  listAll() {
    return this.modelService.listAll();
  }

  @Get('upstream')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '实时查看上游全量模型（仅管理员）' })
  @ApiResponse({ status: 200, description: '上游模型列表' })
  listUpstream() {
    return this.modelService.listUpstream();
  }

  @Post('sync')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '从上游同步模型到平台白名单（仅管理员）' })
  @ApiResponse({ status: 201, description: '同步结果摘要' })
  sync() {
    return this.modelService.syncFromUpstream();
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '更新模型（启用状态/活动免费开关/显示名/排序，仅管理员）' })
  @ApiResponse({ status: 200, description: '更新后的模型，包含 isFree 活动免费配置' })
  @ApiResponse({ status: 400, description: '模型配置字段无效' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePlatformModelDtoSchema)) body: UpdatePlatformModelDto,
  ) {
    return this.modelService.updateModel(id, body ?? {});
  }

  @Post(':id/test')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '测试模型可用性（仅管理员）' })
  @ApiResponse({ status: 200, description: '测试成功，返回响应内容和延迟' })
  @ApiResponse({ status: 503, description: '模型不可用或测试失败' })
  testModel(@Param('id') id: string) {
    return this.modelService.testModel(id);
  }
}
