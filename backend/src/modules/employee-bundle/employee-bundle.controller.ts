import { Body, Controller, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { EmployeeBundleStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  CreateEmployeeBundleDtoSchema,
  GetEmployeeBundlesQuerySchema,
  UpdateEmployeeBundleDtoSchema,
  type CreateEmployeeBundleDto,
  type GetEmployeeBundlesQuery,
  type UpdateEmployeeBundleDto,
} from './employee-bundle.dto';
import { EmployeeBundleService } from './employee-bundle.service';
import { EmployeeBundleEditorService } from './employee-bundle-editor.service';
import { BundleCopyDraftDtoSchema, MAX_BUNDLE_COVER_SIZE, type BundleCopyDraftDto } from '../../shared/employee-bundle.dto';

@ApiTags('market bundles')
@Controller('market/bundles')
export class EmployeeBundleController {
  constructor(private readonly bundles: EmployeeBundleService, private readonly editor: EmployeeBundleEditorService) {}

  @Get()
  @ApiOperation({ summary: '查询已发布员工套餐' })
  @ApiResponse({ status: 200, description: '已发布套餐列表' })
  list() {
    return this.bundles.listPublished();
  }

  @Get('covers/:filename')
  @ApiOperation({ summary: '读取套餐封面图片' })
  @ApiParam({ name: 'filename', description: '封面文件名' })
  @ApiResponse({ status: 200, description: '套餐封面图片' })
  @ApiResponse({ status: 404, description: '封面不存在' })
  async cover(@Param('filename') filename: string, @Res() response: Response) {
    const image = await this.editor.readCover(filename);
    response.setHeader('Content-Type', image.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.send(image.buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: '查询员工套餐详情' })
  @ApiParam({ name: 'id', description: '套餐 ID' })
  @ApiResponse({ status: 200, description: '套餐详情' })
  @ApiResponse({ status: 404, description: '套餐不存在或未上架' })
  get(@Param('id') id: string) {
    return this.bundles.getPublished(id);
  }
}

@ApiTags('admin employee bundles')
@Controller('admin/employee-bundles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class EmployeeBundleAdminController {
  constructor(private readonly bundles: EmployeeBundleService, private readonly editor: EmployeeBundleEditorService) {}

  @Post('copy-draft')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'AI 生成套餐说明草稿' })
  @ApiResponse({ status: 201, description: '说明草稿及实际使用的模型' })
  @ApiResponse({ status: 400, description: '套餐名称或员工无效' })
  @ApiResponse({ status: 502, description: '文案模型暂时不可用' })
  copyDraft(@Body(new ZodValidationPipe(BundleCopyDraftDtoSchema)) body: BundleCopyDraftDto) {
    return this.editor.generateDescription(body);
  }

  @Post('cover')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BUNDLE_COVER_SIZE, files: 1, fields: 0 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: '上传套餐封面图片' })
  @ApiResponse({ status: 201, description: '封面的稳定公开路径' })
  @ApiResponse({ status: 400, description: '图片类型或内容无效' })
  @ApiResponse({ status: 413, description: '图片超过 5MB' })
  uploadCover(@UploadedFile() file?: Express.Multer.File) {
    return this.editor.uploadCover(file);
  }

  @Get()
  @ApiOperation({ summary: '查询员工套餐（平台运营）' })
  @ApiQuery({ name: 'status', required: false, enum: EmployeeBundleStatus })
  @ApiResponse({ status: 200, description: '套餐列表' })
  list(@Query(new ZodValidationPipe(GetEmployeeBundlesQuerySchema)) query: GetEmployeeBundlesQuery) {
    return this.bundles.listAdmin(query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: '查询员工套餐详情（平台运营）' })
  @ApiParam({ name: 'id', description: '套餐 ID' })
  @ApiResponse({ status: 200, description: '套餐详情' })
  @ApiResponse({ status: 404, description: '套餐不存在' })
  get(@Param('id') id: string) {
    return this.bundles.getAdmin(id);
  }

  @Post()
  @ApiOperation({ summary: '创建员工套餐' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '套餐数据无效或员工不可用' })
  @ApiResponse({ status: 409, description: '套餐编码已存在' })
  create(@Body(new ZodValidationPipe(CreateEmployeeBundleDtoSchema)) body: CreateEmployeeBundleDto) {
    return this.bundles.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改员工套餐' })
  @ApiParam({ name: 'id', description: '套餐 ID' })
  @ApiResponse({ status: 200, description: '套餐已更新' })
  @ApiResponse({ status: 400, description: '已发布套餐不可直接修改' })
  @ApiResponse({ status: 404, description: '套餐不存在' })
  @ApiResponse({ status: 409, description: '套餐编码已存在' })
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateEmployeeBundleDtoSchema)) body: UpdateEmployeeBundleDto) {
    return this.bundles.update(id, body);
  }

  @Post(':id/publish')
  @ApiOperation({ summary: '发布员工套餐' })
  @ApiParam({ name: 'id', description: '套餐 ID' })
  @ApiResponse({ status: 200, description: '套餐已发布' })
  @ApiResponse({ status: 400, description: '套餐不满足发布条件' })
  @ApiResponse({ status: 404, description: '套餐不存在' })
  publish(@Param('id') id: string) {
    return this.bundles.publish(id);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: '下架员工套餐' })
  @ApiParam({ name: 'id', description: '套餐 ID' })
  @ApiResponse({ status: 200, description: '套餐已下架' })
  @ApiResponse({ status: 404, description: '套餐不存在' })
  archive(@Param('id') id: string) {
    return this.bundles.archive(id);
  }
}
