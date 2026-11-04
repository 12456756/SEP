import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Response } from 'express';
import * as fs from 'fs';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SKILL_PACKAGE_MAX_BYTES,
  SkillPackageService,
} from '../skill-package/skill-package.service';
import { PackageSecurityService } from '../capability-contribution/package-security.service';

@ApiTags('admin/upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/capabilities')
export class AdminUploadController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skillPackage: SkillPackageService,
    private readonly security: PackageSecurityService,
  ) {}

  @Post('upload-skill')
  @ApiOperation({ summary: '上传 SKILL.md 压缩包（ZIP/TAR/TAR.GZ/TGZ）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'ZIP、TAR、TAR.GZ 或 TGZ 文件（必须包含 SKILL.md）',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: '上传成功，返回文件元数据' })
  @ApiResponse({ status: 400, description: '文件格式错误或缺少 SKILL.md' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: SKILL_PACKAGE_MAX_BYTES, files: 1 },
    }),
  )
  async uploadSkillZip(@UploadedFile() file: Express.Multer.File) {
    const stored = await this.skillPackage.store(file);
    await this.security.scanSkill(stored);
    // 响应保持原有字段名 —— 运营端的 skill-form 直接读 zipPath / totalSize。
    return {
      zipPath: stored.key,
      sha256: stored.sha256,
      fileCount: stored.fileCount,
      totalSize: stored.totalBytes,
      filename: stored.filename,
      content: stored.content,
      suggested: stored.suggested,
      warnings: stored.warnings,
    };
  }

  @Get(':capabilityId/download-skill')
  @ApiOperation({ summary: '下载 SKILL zip 包' })
  @ApiResponse({ status: 200, description: '返回 zip 文件' })
  @ApiResponse({ status: 404, description: '能力不存在或不是 SKILL 类型' })
  async downloadSkill(
    @Param('capabilityId') capabilityId: string,
    @Res() res: Response,
  ) {
    // 1. 查询能力记录
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      include: {
        // 贡献中心创建的能力把包挂在版本上；运营端早期上传的挂在 metadata。
        // 审核人两种都要能下载，所以这里查最近一个带包的版本作为回退。
        skillVersions: {
          where: { packageKey: { not: null } },
          select: { packageKey: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!capability) {
      throw new NotFoundException('能力不存在');
    }

    if (capability.type !== 'SKILL') {
      throw new BadRequestException('只有 SKILL 类型能力可以下载');
    }

    // 2. 包路径：优先 metadata（历史数据），回退到最近一个带包的版本
    const metadata = capability.metadata as { zipPath?: string } | null;
    const zipPath = metadata?.zipPath ?? capability.skillVersions[0]?.packageKey;
    if (!zipPath) {
      throw new NotFoundException('未找到 zip 文件路径');
    }

    res.setHeader('Content-Type', 'application/zip');
    if (this.skillPackage.isSharedStorage?.()) {
      const bytes = await this.skillPackage.readBytes(zipPath);
      res.setHeader('Content-Length', bytes.length);
      return res.attachment(`${capability.name}.zip`).send(bytes);
    }

    // 3. 构建完整文件路径
    const filePath = this.skillPackage.resolveStoredPath(zipPath);

    // 4. 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('zip 文件不存在');
    }

    // 5. 返回文件
    res.setHeader('Content-Length', fs.statSync(filePath).size);
    return res.download(filePath, `${capability.name}.zip`, (err) => {
      if (err) {
        // console.error('下载失败:', err);
      }
    });
  }
}
