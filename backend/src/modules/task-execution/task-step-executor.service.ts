import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TASK_EVENT_TYPE, TASK_STEP_STATUS, type TaskRun, type TaskRunStep } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationStreamService } from '../conversation/conversation-stream.service';
import { TaskEventBus } from './task-event-bus';
import { TaskEventRecorder } from './task-event-recorder';
import { buildStepPrompt, type UpstreamOutput } from './task-prompt';
import { STEP_STATUS_FROM_DB } from './task-step-mapper';

export type StepOutcome = 'completed' | 'failed';

export interface StepExecutionResult {
  outcome: StepOutcome;
  output?: string;
  error?: string;
}

/**
 * 单步执行器。
 *
 * 刻意**复用对话链路**（ConversationService.create + ConversationStreamService）
 * 而不是另写一套模型调用：计费（chargeUsage）、企业模型策略、知识库检索、
 * 会话锁、余额闸门全都挂在那条链路上。另起一套等于把这些全部重新实现一遍，
 * 而且第一个漏掉的一定是计费。
 */
@Injectable()
export class TaskStepExecutor {
  private readonly logger = new Logger(TaskStepExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly stream: ConversationStreamService,
    private readonly bus: TaskEventBus,
    private readonly events: TaskEventRecorder,
  ) {}

  async execute(run: TaskRun, step: TaskRunStep, allSteps: TaskRunStep[]): Promise<StepExecutionResult> {
    const startedAt = new Date();

    const upstream: UpstreamOutput[] = step.dependsOn.flatMap((key) => {
      const source = allSteps.find((candidate) => candidate.stepKey === key);
      if (!source) return [];
      return [
        {
          stepKey: source.stepKey,
          stepTitle: source.title,
          employeeName: source.employeeName,
          output: source.output,
        },
      ];
    });

    const { prompt, handoff } = buildStepPrompt({
      objective: run.objective,
      stepTitle: step.title,
      stepDescription: step.description,
      upstream,
    });

    // 输入与交接先落库再开跑：中途进程被杀时，「它接到了什么活」这个信息
    // 必须已经在库里，否则失败的步骤永远解释不清。
    await this.prisma.taskRunStep.update({
      where: { id: step.id },
      data: {
        status: TASK_STEP_STATUS.RUNNING,
        inputPrompt: prompt,
        handoff,
        startedAt,
        completedAt: null,
        durationMs: null,
        error: null,
        output: null,
        attempt: { increment: 1 },
      },
    });

    this.bus.publish(run.id, {
      type: 'step_status',
      stepKey: step.stepKey,
      status: 'running',
      startedAt: startedAt.toISOString(),
      attempt: step.attempt + 1,
    });
    this.bus.publish(run.id, { type: 'step_input', stepKey: step.stepKey, inputPrompt: prompt, handoff });

    await this.events.record({
      taskRunId: run.id,
      type: TASK_EVENT_TYPE.STEP_STARTED,
      stepId: step.stepKey,
      stepTitle: step.title,
      employeeName: step.employeeName,
      message: `${step.employeeName} 开始${step.title}`,
    });

    for (const entry of handoff) {
      await this.events.record({
        taskRunId: run.id,
        type: TASK_EVENT_TYPE.STEP_HANDOFF,
        stepId: step.stepKey,
        stepTitle: step.title,
        employeeName: step.employeeName,
        message: `${entry.fromEmployeeName} 把「${entry.fromStepTitle}」的产出交给了 ${step.employeeName}`,
        payload: {
          fromStepKey: entry.fromStepKey,
          fromEmployeeName: entry.fromEmployeeName,
          chars: entry.chars,
        },
      });
    }

    try {
      await this.assertCapabilityAvailable(step);
      const sessionId = await this.ensureSession(run, step);
      const output = await this.runOnce(run, step, sessionId, prompt);
      const completedAt = new Date();

      await this.prisma.taskRunStep.update({
        where: { id: step.id },
        data: {
          status: TASK_STEP_STATUS.COMPLETED,
          output,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
      });

      this.bus.publish(run.id, { type: 'step_output', stepKey: step.stepKey, output });
      this.bus.publish(run.id, {
        type: 'step_status',
        stepKey: step.stepKey,
        status: 'completed',
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      });
      await this.events.record({
        taskRunId: run.id,
        type: TASK_EVENT_TYPE.STEP_COMPLETED,
        stepId: step.stepKey,
        stepTitle: step.title,
        employeeName: step.employeeName,
        message: output
          ? `${step.employeeName} 交付了结果（${output.length} 字）`
          : `${step.employeeName} 完成了这一步，但没有返回文本`,
        payload: { chars: output.length },
      });

      return { outcome: 'completed', output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = new Date();

      await this.prisma.taskRunStep.update({
        where: { id: step.id },
        data: {
          status: TASK_STEP_STATUS.FAILED,
          error: message.slice(0, 2000),
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        },
      });

      this.bus.publish(run.id, {
        type: 'step_status',
        stepKey: step.stepKey,
        status: 'failed',
        completedAt: completedAt.toISOString(),
        error: message,
      });
      await this.events.record({
        taskRunId: run.id,
        type: TASK_EVENT_TYPE.STEP_FAILED,
        stepId: step.stepKey,
        stepTitle: step.title,
        employeeName: step.employeeName,
        message: `${step.employeeName} 没能完成这一步：${message}`,
      });

      this.logger.warn(`Step ${step.stepKey} of run ${run.id} failed: ${message}`);
      return { outcome: 'failed', error: message };
    }
  }

  private async assertCapabilityAvailable(step: TaskRunStep): Promise<void> {
    const binding = await this.prisma.employeeCapabilityBinding.findFirst({
      where: {
        employeeId: step.employeeId,
        capabilityId: step.capabilityId,
        enabled: true,
        capability: { status: 'APPROVED' },
      },
      select: { id: true },
    });
    if (!binding) {
      throw new BadRequestException('计划中的能力已下架或不再绑定该员工，请重新规划任务');
    }
  }

  /**
   * 复用步骤已有的任务会话，没有才新建。
   *
   * 重试同一步骤时沿用同一个会话，这样「这一步到底聊了几轮」在会话里是完整的；
   * 每次重试都新建会话会把同一步的历史切碎在多个会话里。
   */
  private async ensureSession(run: TaskRun, step: TaskRunStep): Promise<string> {
    if (step.sessionId) {
      const existing = await this.prisma.conversationSession.findUnique({
        where: { id: step.sessionId },
        select: { id: true },
      });
      if (existing) return existing.id;
    }

    const session = await this.conversations.create(run.userId, {
      employeeId: step.employeeId,
      title: run.objective.slice(0, 60),
      source: 'TASK',
      taskPlanId: run.id,
      taskStepId: step.stepKey,
    });

    await this.prisma.taskRunStep.update({
      where: { id: step.id },
      data: { sessionId: session.id },
    });
    this.bus.publish(run.id, {
      type: 'step_status',
      stepKey: step.stepKey,
      status: STEP_STATUS_FROM_DB[TASK_STEP_STATUS.RUNNING],
      sessionId: session.id,
    });

    return session.id;
  }

  /**
   * 消费对话流，边转发增量边累加全文。
   *
   * `done` 之后不 break 会一直等生成器结束；`error` 帧要转成异常，否则一个失败的
   * 步骤会带着空产出被标成「已交付」—— 这正是会议说的「不能只展示过程」。
   */
  private async runOnce(
    run: TaskRun,
    step: TaskRunStep,
    sessionId: string,
    prompt: string,
  ): Promise<string> {
    let accumulated = '';
    let failure: string | null = null;
    let finished = false;

    for await (const frame of this.stream.streamConversation(
      sessionId,
      prompt,
      run.userId,
      step.employeeId,
    )) {
      switch (frame.event) {
        case 'text_delta': {
          const delta = typeof frame.data === 'string' ? frame.data : '';
          if (!delta) break;
          accumulated += delta;
          this.bus.publish(run.id, { type: 'step_delta', stepKey: step.stepKey, delta });
          break;
        }
        case 'tool_start': {
          const data = frame.data as { name?: string };
          this.bus.publish(run.id, {
            type: 'tool',
            stepKey: step.stepKey,
            name: data?.name ?? '未知工具',
            phase: 'start',
          });
          break;
        }
        case 'tool_end': {
          const data = frame.data as { name?: string; success?: boolean; durationMs?: number };
          this.bus.publish(run.id, {
            type: 'tool',
            stepKey: step.stepKey,
            name: data?.name ?? '未知工具',
            phase: 'end',
            success: data?.success,
            durationMs: data?.durationMs,
          });
          break;
        }
        case 'error': {
          const data = frame.data as { message?: string };
          failure = data?.message ?? '执行失败';
          break;
        }
        case 'done':
          finished = true;
          break;
        default:
          break;
      }
    }

    if (failure) throw new Error(failure);
    if (!finished) throw new Error('执行连接中断');
    return accumulated.trim();
  }
}
