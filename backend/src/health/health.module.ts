import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { KnowledgeModule } from '../modules/knowledge/knowledge.module';
import { TaskExecutionModule } from '../modules/task-execution/task-execution.module';
import { GatewayLifecycleModule } from '../common/lifecycle/gateway-lifecycle.module';
import { SettingModule } from '../modules/setting/setting.module';

@Module({ imports: [GatewayLifecycleModule, KnowledgeModule, TaskExecutionModule, SettingModule], controllers: [HealthController] })
export class HealthModule {}
