import { Module } from '@nestjs/common';
import { SettingModule } from '../setting/setting.module';
import { EnterpriseModelConfigModule } from '../enterprise-model-config/enterprise-model-config.module';
import { ConversationModule } from '../conversation/conversation.module';
import { TaskDeliverableService } from './task-deliverable.service';
import { TaskEventBus } from './task-event-bus';
import { TaskEventRecorder } from './task-event-recorder';
import { TaskExecutionController } from './task-execution.controller';
import { TaskExecutionService } from './task-execution.service';
import { TaskQueueService } from './task-queue.service';
import { TaskReconcileService } from './task-reconcile.service';
import { TaskRunnerService } from './task-runner.service';
import { TaskStepExecutor } from './task-step-executor.service';
import { GatewayPolicyModule } from '../gateway/gateway-policy.module';
import { ComputeCreditModule } from '../compute-credit/compute-credit.module';

/**
 * 任务执行引擎。
 *
 * 与 TaskModule（纯 CRUD）分开：一个管「计划长什么样」，一个管「怎么把它跑完」。
 * 混在一起的话，执行引擎的队列、心跳、SSE 会把一个本来很简单的 CRUD 服务
 * 拖成 800 行。
 */
@Module({
  imports: [
    ComputeCreditModule,
    ConversationModule,
    SettingModule,
    EnterpriseModelConfigModule,
    GatewayPolicyModule,
  ],
  controllers: [TaskExecutionController],
  providers: [
    TaskExecutionService,
    TaskRunnerService,
    TaskStepExecutor,
    TaskDeliverableService,
    TaskQueueService,
    TaskReconcileService,
    TaskEventBus,
    TaskEventRecorder,
  ],
  exports: [TaskExecutionService, TaskQueueService],
})
export class TaskExecutionModule {}
