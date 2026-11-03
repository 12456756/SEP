import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Request, UseGuards, Query, HttpCode, HttpStatus,
  Res, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CapabilityService, CapabilityCreateDto, CapabilityCreateDtoSchema } from './capability.service';
import { CapabilityUploadDto, CapabilityUploadDtoSchema } from 'shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { existsSync, statSync } from 'fs';
import { SkillPackageService } from '../skill-package/skill-package.service';
import { SessionService } from '../auth/session.service';

@ApiTags('Capabilities')
@Controller('capabilities')
export class CapabilityController {
  constructor(
    private capabilityService: CapabilityService,
    private skillPackage: SkillPackageService,
    private sessionService: SessionService,
  ) {}

  // ────────────── Public / User browsing ──────────────

  @Get()
  @ApiOperation({ summary: 'Browse capabilities' })
  @ApiQuery({ name: 'type', required: false, enum: ['agent', 'rpa', 'skill', 'ai-app'] })
  @ApiQuery({ name: 'industry', required: false })
  @ApiQuery({ name: 'position', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of capabilities' })
  async findAll(
    @Query('type') type?: string,
    @Query('industry') industry?: string,
    @Query('position') position?: string,
    @Query('status') status?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.capabilityService.findAll({ type, industry, position, status, page: +page, limit: +limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get capability details' })
  @ApiResponse({ status: 200, description: 'Capability found' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(@Param('id') id: string) {
    return this.capabilityService.findOne(id);
  }

  @Get(':id/download')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download SKILL capability package' })
  @ApiResponse({ status: 200, description: 'Skill package downloaded' })
  @ApiResponse({ status: 400, description: 'Not a SKILL type capability' })
  @ApiResponse({ status: 404, description: 'Capability or file not found' })
  async download(
    @Param('id') id: string,
    @Request() req: { user: { id: string; role: string } },
    @Res() res: Response,
  ) {
    const { key, filename } = await this.capabilityService.getSkillPackageForDownload(
      id,
      req.user.id,
      req.user.role,
    );
    res.setHeader('Content-Type', 'application/zip');
    if (this.skillPackage.isSharedStorage?.()) {
      const bytes = await this.skillPackage.readBytes(key);
      res.setHeader('Content-Length', bytes.length);
      return res.attachment(filename).send(bytes);
    }

    const fullPath = this.skillPackage.resolveStoredPath(key);
    if (!existsSync(fullPath)) {
      throw new NotFoundException('Skill package file does not exist on disk');
    }
    res.setHeader('Content-Length', statSync(fullPath).size);
    return res.download(fullPath, filename);
  }

  // ────────────── Contributor routes ──────────────

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload a new capability (SKILL: Admin only)' })
  @ApiResponse({ status: 201, description: 'Capability created, pending review' })
  @ApiResponse({ status: 400, description: 'Invalid capability or package metadata' })
  @ApiResponse({ status: 403, description: 'SKILL creation requires Admin role' })
  async create(
    @Body(new ZodValidationPipe(CapabilityCreateDtoSchema)) dto: CapabilityCreateDto,
    @Request() req: { user: { id: string; role: string; sid?: string } },
  ) {
    if (dto.type === 'skill' && req.user.role === 'ADMIN') {
      if (!req.user.sid) {
        throw new ForbiddenException('Active Web session required for Skill creation');
      }
      await this.sessionService.assertActiveSession(req.user.sid, req.user.id, 'WEB');
    }
    return this.capabilityService.create(req.user.id, dto, req.user.role);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update capability (owner or Admin)' })
  @ApiResponse({ status: 200, description: 'Capability updated' })
  @ApiResponse({ status: 400, description: 'Invalid parameters or capability type change' })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CapabilityUploadDtoSchema.partial())) dto: Partial<CapabilityUploadDto>,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.capabilityService.update(id, req.user.id, req.user.role, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete capability (owner or Admin)' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async remove(
    @Param('id') id: string,
    @Request() req: { user: { id: string; role: string } },
  ) {
    await this.capabilityService.remove(id, req.user.id, req.user.role);
  }

  // ────────────── Admin review routes ──────────────

  @Post(':id/approve')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve capability (Admin only)' })
  @ApiResponse({ status: 200, description: 'Capability approved' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 409, description: 'SKILL requires exactly one pending platform version; use version review otherwise' })
  async approve(
    @Param('id') id: string,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.capabilityService.approve(id, req.user.id, req.user.role);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject capability (Admin only)' })
  @ApiResponse({ status: 200, description: 'Capability rejected' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiResponse({ status: 400, description: 'SKILL rejection requires a reason' })
  @ApiResponse({ status: 409, description: 'SKILL requires exactly one pending platform version; use version review otherwise' })
  async reject(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.capabilityService.reject(id, req.user.id, req.user.role, reason);
  }

  // ────────────── My capabilities (contributor) ──────────────

  @Get('mine/list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List current contributor's capabilities" })
  @ApiResponse({ status: 200, description: 'List of own capabilities' })
  async findMine(@Request() req: { user: { id: string } }) {
    return this.capabilityService.findByContributor(req.user.id);
  }
}
