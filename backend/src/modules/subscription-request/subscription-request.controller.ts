import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionRequestService } from './subscription-request.service';
import {
  CreateSubscriptionRequestDto,
  ApproveSubscriptionRequestDto,
  RejectSubscriptionRequestDto,
  SubscriptionRequestResponseDto,
} from './dto';
import { RequestStatus } from '@prisma/client';

@ApiTags('Subscription Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('subscription-requests')
export class SubscriptionRequestController {
  constructor(
    private readonly subscriptionRequestService: SubscriptionRequestService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建订阅申请（普通成员）' })
  @ApiResponse({ status: 201, description: '申请创建成功', type: SubscriptionRequestResponseDto })
  @ApiResponse({ status: 409, description: '已存在待处理的申请或企业已订阅' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  async createRequest(
    @Request() req,
    @Body() dto: CreateSubscriptionRequestDto,
  ) {
    return this.subscriptionRequestService.createRequest(req.user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: '查询我的申请（申请人）' })
  @ApiResponse({ status: 200, description: '我的申请列表', type: [SubscriptionRequestResponseDto] })
  async getMyRequests(@Request() req, @Query('status') status?: RequestStatus, @Query('keyword') keyword?: string) {
    return this.subscriptionRequestService.getMyRequests(req.user.id, status, keyword);
  }

  @Get('pending')
  @ApiOperation({ summary: '查询待审批申请（管理员）' })
  @ApiResponse({ status: 200, description: '待审批申请列表', type: [SubscriptionRequestResponseDto] })
  @ApiResponse({ status: 403, description: '权限不足' })
  async getPendingRequests(@Request() req, @Query('keyword') keyword?: string) {
    return this.subscriptionRequestService.getPendingRequests(req.user.id, keyword);
  }

  @Get()
  @ApiOperation({ summary: '查询所有申请（管理员，可筛选状态）' })
  @ApiQuery({ name: 'status', enum: RequestStatus, required: false })
  @ApiResponse({ status: 200, description: '申请列表', type: [SubscriptionRequestResponseDto] })
  @ApiResponse({ status: 403, description: '权限不足' })
  async getAllRequests(
    @Request() req,
    @Query('status') status?: RequestStatus,
    @Query('keyword') keyword?: string,
  ) {
    return this.subscriptionRequestService.getAllRequests(req.user.id, status, keyword);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: '审批通过订阅申请（管理员）' })
  @ApiResponse({ status: 200, description: '审批通过，订阅已创建并授权' })
  @ApiResponse({ status: 403, description: '权限不足' })
  @ApiResponse({ status: 404, description: '申请不存在' })
  @ApiResponse({ status: 400, description: '申请状态不允许审批' })
  async approveRequest(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: ApproveSubscriptionRequestDto,
  ) {
    return this.subscriptionRequestService.approveRequest(req.user.id, id, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: '拒绝订阅申请（管理员）' })
  @ApiResponse({ status: 200, description: '申请已拒绝', type: SubscriptionRequestResponseDto })
  @ApiResponse({ status: 403, description: '权限不足' })
  @ApiResponse({ status: 404, description: '申请不存在' })
  @ApiResponse({ status: 400, description: '申请状态不允许拒绝' })
  async rejectRequest(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: RejectSubscriptionRequestDto,
  ) {
    return this.subscriptionRequestService.rejectRequest(req.user.id, id, dto);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: '取消自己的申请（申请人）' })
  @ApiResponse({ status: 200, description: '申请已取消', type: SubscriptionRequestResponseDto })
  @ApiResponse({ status: 403, description: '只能取消自己的申请' })
  @ApiResponse({ status: 404, description: '申请不存在' })
  @ApiResponse({ status: 400, description: '申请状态不允许取消' })
  async cancelRequest(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.subscriptionRequestService.cancelRequest(req.user.id, id);
  }
}
