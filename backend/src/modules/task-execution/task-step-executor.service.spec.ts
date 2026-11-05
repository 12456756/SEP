import { TASK_STEP_STATUS } from '@prisma/client';
import { TaskStepExecutor } from './task-step-executor.service';

describe('TaskStepExecutor', () => {
  let prisma: any;
  let conversations: any;
  let stream: any;
  let bus: any;
  let events: any;
  let service: TaskStepExecutor;

  const run = {
    id: 'run-1',
    userId: 'user-1',
    objective: '分析销售数据',
  } as never;
  const step = {
    id: 'run-step-1',
    taskRunId: 'run-1',
    stepKey: 'step-1',
    order: 1,
    title: '分析数据',
    description: '识别趋势',
    employeeId: 'employee-1',
    employeeName: '数据分析师',
    employeeAvatar: null,
    capabilityId: 'capability-1',
    capabilityName: '销售分析',
    skillVersionId: null,
    dependsOn: [],
    rationale: '',
    estimatedSeconds: 60,
    status: TASK_STEP_STATUS.QUEUED,
    inputPrompt: null,
    handoff: null,
    output: null,
    error: null,
    sessionId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    attempt: 0,
    createdAt: new Date('2026-11-05T00:00:00Z'),
    updatedAt: new Date('2026-11-05T00:00:00Z'),
  } as never;

  beforeEach(() => {
    prisma = {
      employeeCapabilityBinding: { findFirst: jest.fn().mockResolvedValue(null) },
      taskRunStep: { update: jest.fn().mockResolvedValue(undefined) },
      conversationSession: { findUnique: jest.fn() },
    };
    conversations = { create: jest.fn() };
    stream = { streamConversation: jest.fn() };
    bus = { publish: jest.fn() };
    events = { record: jest.fn().mockResolvedValue(undefined) };
    service = new TaskStepExecutor(prisma, conversations, stream, bus, events);
  });

  it('fails before creating a session when the planned capability was archived', async () => {
    const result = await service.execute(run, step, [step]);

    expect(prisma.employeeCapabilityBinding.findFirst).toHaveBeenCalledWith({
      where: {
        employeeId: 'employee-1',
        capabilityId: 'capability-1',
        enabled: true,
        capability: { status: 'APPROVED' },
      },
      select: { id: true },
    });
    expect(result).toEqual({
      outcome: 'failed',
      error: '计划中的能力已下架或不再绑定该员工，请重新规划任务',
    });
    expect(prisma.taskRunStep.update).toHaveBeenLastCalledWith({
      where: { id: 'run-step-1' },
      data: expect.objectContaining({
        status: TASK_STEP_STATUS.FAILED,
        error: '计划中的能力已下架或不再绑定该员工，请重新规划任务',
      }),
    });
    expect(conversations.create).not.toHaveBeenCalled();
    expect(stream.streamConversation).not.toHaveBeenCalled();
  });

  it('continues execution when the planned capability is still available', async () => {
    prisma.employeeCapabilityBinding.findFirst.mockResolvedValue({ id: 'binding-1' });
    conversations.create.mockResolvedValue({ id: 'session-1' });
    stream.streamConversation.mockImplementation(async function* () {
      yield { event: 'text_delta', data: '分析结果' };
      yield { event: 'done', data: {} };
    });

    await expect(service.execute(run, step, [step])).resolves.toEqual({ outcome: 'completed', output: '分析结果' });

    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(stream.streamConversation).toHaveBeenCalledWith('session-1', expect.any(String), 'user-1', 'employee-1');
    expect(prisma.taskRunStep.update).toHaveBeenLastCalledWith({
      where: { id: 'run-step-1' },
      data: expect.objectContaining({ status: TASK_STEP_STATUS.COMPLETED, output: '分析结果' }),
    });
  });
});
