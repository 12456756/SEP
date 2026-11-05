'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FolderOpen, History, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { TaskObjectiveComposer } from '@/features/task/task-objective-composer';
import { TaskDependencyGraph } from '@/features/task/components/task-dependency-graph';
import { TaskHistoryDrawer } from '@/features/task/components/task-history-drawer';
import { TaskTemplateDrawer } from '@/features/task/components/task-template-drawer';
import { TeamReadinessBar } from '@/features/task/components/team-readiness-bar';
import { TaskFlowTheater, type FlowView } from '@/features/task/components/task-flow-theater';
import { StepConversationDialog } from '@/features/task/components/step-conversation-dialog';
import { useCreateTaskPlan } from '@/features/task/use-task-plan';
import {
  usePauseStep,
  useResumeStep,
  useRunTask,
  useStepConversation,
  useStopTask,
  useTaskExecution,
} from '@/features/task/use-task-execution';
import {
  useCreateTaskRun,
  useCreateTaskTemplate,
  useDeleteTaskRun,
  useDeleteTaskTemplate,
  useTaskRun,
  useInfiniteTaskRuns,
  useTaskTemplates,
  useUpdateTaskRun,
} from '@/features/task/use-task-runs';
import {
  resetSteps,
  toPlan,
  type GraphLayoutPayload,
  type TaskRunSummary,
  type TaskTemplate,
} from '@/features/task/task-run';
import { canUsePlanSnapshot, planToSnapshot } from '@/features/task/task-execution-view-model';
import { CenteredSpinner } from '@/components/ui/feedback';
import { useMyEmployees } from '@/features/enterprise/use-enterprise';
import { useAuthStore } from '@/lib/auth-store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ClientTaskMonitor } from '@/features/task/components/client-task-monitor';
import { nav } from '@/locales/zh-CN';
import type { TaskExecutionSnapshot } from '@/features/task/task-execution';
import type { TaskCandidateEmployee, TaskPlan, TaskPlanStep, TaskRunStatus } from '@/features/task/task-orchestration';
import type { MyEmployee } from '@/lib/types';

const VIEW_STORAGE_KEY = 'sep.tasks.view';

function toCandidateEmployee(item: MyEmployee): TaskCandidateEmployee {
  const capabilities = item.employee.bindings?.map((binding) => binding.capability) ?? [];
  return {
    id: item.employee.id,
    name: item.employee.name,
    avatar: item.employee.avatar,
    description: capabilities.map((capability) => capability.description).filter(Boolean).join('；'),
    // MyEmployee 的 employee 投影里没有 position/industry，保持空串（原实现亦然）
    position: '',
    industry: '',
    capabilities,
  };
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * 工作安排（原「任务中心」）。
 *
 * 页面只做三件事：写目标、改计划、看过程。执行发生在服务端 —— 改造前
 * `executePlan` 是一个前端 for 循环，关标签页任务当场死掉，只留一条永远 running
 * 的孤儿记录。
 *
 * 规划与执行共用 `TaskFlowTheater` 这一块舞台：确认执行不换页面，同一张卡原地
 * 亮起来。此前是两个组件互相替换，确认那一刻整屏跳变，看起来像跳到了另一个功能。
 */
export default function TasksPage() {
  return <Suspense fallback={<CenteredSpinner label="正在读取任务…" />}><TasksPageContent /></Suspense>;
}

function TasksPageContent() {
  const searchParams = useSearchParams();
  const urlTab = searchParams.get('tab');
  const taskId = searchParams.get('taskId') || undefined;
  const subscriptionId = searchParams.get('subscriptionId') || undefined;
  const enterprise = useAuthStore((state) => state.enterprise);

  const [historyKeyword, setHistoryKeyword] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'all' | TaskRunStatus>('all');
  const runsQuery = useInfiniteTaskRuns({ limit: 50, keyword: historyKeyword.trim() || undefined, status: historyStatus === 'all' ? undefined : [historyStatus] });
  const templatesQuery = useTaskTemplates();
  const createRun = useCreateTaskRun();
  const updateRun = useUpdateTaskRun();
  const deleteRun = useDeleteTaskRun();
  const createTemplate = useCreateTaskTemplate();
  const deleteTemplate = useDeleteTaskTemplate();
  const planner = useCreateTaskPlan();
  const { data: myEmployees = [] } = useMyEmployees();

  const [activeRunId, setActiveRunId] = useState<string>();
  const [objective, setObjective] = useState('');
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [layout, setLayout] = useState<GraphLayoutPayload | null>(null);
  const [expandedStepKey, setExpandedStepKey] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(urlTab === 'client' || urlTab === 'monitoring' ? 'monitoring' : 'workspace');
  useEffect(() => {
    if (urlTab === 'client' || urlTab === 'monitoring') setActiveTab('monitoring');
  }, [urlTab, taskId]);

  const layoutTimer = useRef<number | undefined>(undefined);

  const execution = useTaskExecution(activeRunId);
  const runTask = useRunTask(activeRunId);
  const stopTask = useStopTask(activeRunId);
  const pauseStep = usePauseStep(activeRunId);
  const resumeStep = useResumeStep(activeRunId);
  const stepConversation = useStepConversation(activeRunId);

  const runs = runsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const loadedRun = useTaskRun(activeRunId ?? '');

  const availableEmployees = useMemo(
    () => myEmployees.map(toCandidateEmployee).filter((employee) => employee.capabilities.length > 0),
    [myEmployees],
  );
  const teamMembers = useMemo(
    () => availableEmployees.map((employee) => ({ id: employee.id, name: employee.name, avatar: employee.avatar })),
    [availableEmployees],
  );

  // Initialize view from localStorage - use lazy initialization
  const [view, setView] = useState<FlowView>(() => {
    if (typeof window === 'undefined') return 'timeline';
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return (stored === 'timeline' || stored === 'graph') ? stored : 'timeline';
  });

  const changeView = (next: FlowView) => {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  // 选中某条运行 → 拉计划详情 → 载入为当前可编辑计划
  const [lastLoadedRunId, setLastLoadedRunId] = useState<string>();

  if (activeRunId && loadedRun.data && loadedRun.data.id === activeRunId && lastLoadedRunId !== activeRunId) {
    setPlan(toPlan(loadedRun.data));
    setLayout(loadedRun.data.layout);
    setObjective(loadedRun.data.objective);
    setLastLoadedRunId(activeRunId);
  }

  /**
   * 舞台上渲染的那份数据。
   *
   * 服务端快照是执行期唯一权威。计划快照只服务于待确认阶段，避免执行开始后
   * 用旧 JSON 里的 queued 覆盖真实的 running。
   */
  // 计划快照只用于待确认阶段。任务一旦开始执行，必须等服务端执行快照，
  // 否则旧 JSON 里的 queued 会把真实的「正在工作」覆盖掉。
  const snapshot: TaskExecutionSnapshot | null =
    execution.snapshot ?? (canUsePlanSnapshot(plan) && plan ? planToSnapshot(plan) : null);
  const started = Boolean(snapshot?.startedAt);
  const running = snapshot?.status === 'running';
  const busy = runTask.isPending || stopTask.isPending || pauseStep.isPending || resumeStep.isPending;

  /** 改计划结构（增删/连线/换人）→ 整份 steps 落库，然后重取执行快照 */
  const applyPlanEdit = useCallback(
    (updater: (current: TaskPlan) => TaskPlan) => {
      setPlan((current) => {
        if (!current) return current;
        const next = updater(current);
        if (next === current) return current;
        updateRun.mutate(
          { id: next.id, steps: next.steps, status: next.status },
          {
            // 步骤行的同步发生在服务端读执行视图时，不主动拉一次的话
            // 用户改完看到的还是旧的那张卡
            onSuccess: () => void execution.refresh(),
            onError: (error) => toast.error(errorMessage(error, '计划改动没能保存')),
          },
        );
        return next;
      });
    },
    [execution, updateRun],
  );

  const persistLayout = useCallback(
    (next: GraphLayoutPayload) => {
      setLayout(next);
      if (!plan) return;
      window.clearTimeout(layoutTimer.current);
      layoutTimer.current = window.setTimeout(() => {
        updateRun.mutate({ id: plan.id, layout: next });
      }, 800);
    },
    [plan, updateRun],
  );

  useEffect(() => () => window.clearTimeout(layoutTimer.current), []);

  const generatePlan = () => {
    planner.mutate(
      { objective },
      {
        onSuccess: (preview) => {
          createRun.mutate(
            {
              objective: preview.objective || objective,
              summary: preview.summary,
              steps: preview.steps,
              planner: preview.planner ?? null,
              status: 'awaiting_confirmation',
            },
            {
              onSuccess: (run) => {
                setActiveRunId(run.id);
                setPlan(toPlan(run));
                setLayout(run.layout);
                setExpandedStepKey(undefined);
              },
              onError: (error) => toast.error(errorMessage(error, '计划没能保存')),
            },
          );
        },
      },
    );
  };

  // ── 计划编辑（仅在还没开始跑时可用） ────────────────────────────────────────

  const addEmployeeStep = useCallback(() => {
    if (!plan || started) return;
    const employee = availableEmployees[0];
    const capability = employee?.capabilities[0];
    if (!employee || !capability) return;
    const stepId = `manual-${Date.now()}`;
    applyPlanEdit((current) => {
      const ordered = [...current.steps].sort((left, right) => left.order - right.order);
      const previous = ordered[ordered.length - 1];
      const nextStep: TaskPlanStep = {
        id: stepId,
        order: current.steps.length + 1,
        title: `调用 ${employee.name}`,
        description: capability.description || `由${employee.name}使用${capability.name}完成这一步。`,
        intent: capability.name,
        employee,
        capability,
        dependsOn: previous ? [previous.id] : [],
        rationale: '由你手动加入工作流，默认接在当前最后一步之后。',
        estimatedSeconds: 60,
        status: 'queued',
        progress: 0,
      };
      return { ...current, status: 'awaiting_confirmation', steps: [...current.steps, nextStep] };
    });
    setExpandedStepKey(stepId);
  }, [applyPlanEdit, availableEmployees, plan, started]);

  const connectSteps = useCallback(
    (sourceId: string, targetId: string) => {
      if (started || sourceId === targetId) return;
      applyPlanEdit((current) => {
        const source = current.steps.find((step) => step.id === sourceId);
        const target = current.steps.find((step) => step.id === targetId);
        if (!source || !target || source.order >= target.order || target.dependsOn.includes(sourceId)) return current;
        return {
          ...current,
          status: 'awaiting_confirmation',
          steps: current.steps.map((step) =>
            step.id === targetId ? { ...step, dependsOn: [...step.dependsOn, sourceId] } : step,
          ),
        };
      });
    },
    [applyPlanEdit, started],
  );

  const removeDependency = useCallback(
    (stepKey: string, dependencyKey: string) => {
      if (started) return;
      applyPlanEdit((current) => ({
        ...current,
        status: 'awaiting_confirmation',
        steps: current.steps.map((step) =>
          step.id === stepKey ? { ...step, dependsOn: step.dependsOn.filter((id) => id !== dependencyKey) } : step,
        ),
      }));
    },
    [applyPlanEdit, started],
  );

  const replaceStepEmployee = useCallback(
    (stepKey: string, employeeId: string) => {
      if (started) return;
      const employee = availableEmployees.find((candidate) => candidate.id === employeeId);
      if (!employee || employee.capabilities.length === 0) return;
      applyPlanEdit((current) => ({
        ...current,
        status: 'awaiting_confirmation',
        steps: current.steps.map((step) => {
          if (step.id !== stepKey) return step;
          const capability =
            employee.capabilities.find((candidate) => candidate.id === step.capability.id) ?? employee.capabilities[0];
          return {
            ...step,
            title: step.title.replace(/^调用 .*$/, `调用 ${employee.name}`),
            employee,
            capability,
            description: capability.description || step.description,
            status: 'queued',
            progress: 0,
            output: undefined,
            error: undefined,
          };
        }),
      }));
    },
    [applyPlanEdit, availableEmployees, started],
  );

  const deleteStep = useCallback(
    (stepKey: string) => {
      if (started) return;
      applyPlanEdit((current) => {
        const remaining = current.steps
          .filter((step) => step.id !== stepKey)
          .sort((left, right) => left.order - right.order);
        return {
          ...current,
          status: 'awaiting_confirmation',
          steps: remaining.map((step, index) => ({
            ...step,
            order: index + 1,
            dependsOn: step.dependsOn.filter((id) => id !== stepKey),
          })),
        };
      });
      setExpandedStepKey((current) => (current === stepKey ? undefined : current));
    },
    [applyPlanEdit, started],
  );

  // ── 执行指令 ────────────────────────────────────────────────────────────────

  const confirmAndRun = () => {
    if (!activeRunId) return;
    runTask.mutate(undefined, {
      onSuccess: (snapshot) => {
        if (snapshot && typeof snapshot === 'object' && 'status' in snapshot) {
          execution.refresh();
        }
      },
      onError: (error) => toast.error(errorMessage(error, '没能开始执行')),
    });
  };

  const stopExecution = () => {
    stopTask.mutate(undefined, { onError: (error) => toast.error(errorMessage(error, '停止请求没能送达')) });
  };

  const retryFromStep = (stepKey: string) => {
    runTask.mutate(
      { fromStepKey: stepKey },
      {
        onSuccess: () => void execution.refresh(),
        onError: (error) => toast.error(errorMessage(error, '重跑没能开始')),
      },
    );
  };

  const openConversation = (stepKey: string) => {
    setConversationOpen(true);
    stepConversation.mutate(stepKey, {
      onError: (error) => toast.error(errorMessage(error, '对话记录读取失败')),
    });
  };

  const toggleStep = (stepKey: string) =>
    setExpandedStepKey((current) => (current === stepKey ? undefined : stepKey));

  // ── 任务与模板 ──────────────────────────────────────────────────────────────

  const createNewTask = () => {
    setActiveRunId(undefined);
    setPlan(null);
    setLayout(null);
    setExpandedStepKey(undefined);
    setObjective('');
    planner.reset();
    setHistoryOpen(false);
  };

  const saveAsTemplate = () => {
    if (!plan) return;
    createTemplate.mutate(
      {
        name: plan.objective.slice(0, 32) || '未命名工作安排',
        objective: plan.objective,
        steps: resetSteps(plan.steps),
        layout,
      },
      {
        onSuccess: () => {
          toast.success('已存为模板');
          setTemplateOpen(true);
        },
        onError: (error) => toast.error(errorMessage(error, '模板没能保存')),
      },
    );
  };

  const loadTemplate = (template: TaskTemplate) => {
    createRun.mutate(
      {
        objective: template.objective,
        steps: resetSteps(template.steps),
        layout: template.layout,
        status: 'awaiting_confirmation',
      },
      {
        onSuccess: (run) => {
          setActiveRunId(run.id);
          setPlan(toPlan(run));
          setLayout(run.layout);
          setObjective(run.objective);
          setExpandedStepKey(undefined);
          setTemplateOpen(false);
        },
        onError: (error) => toast.error(errorMessage(error, '模板载入失败')),
      },
    );
  };

  const removeRun = (run: TaskRunSummary) => {
    deleteRun.mutate(run.id, {
      onSuccess: () => {
        if (activeRunId === run.id) createNewTask();
      },
      onError: (error) => toast.error(errorMessage(error, '删除失败')),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-gbg-canvas">
      {/* 页头与能力贡献中心（同为全高路由）对齐：eyebrow 定位、标题与描述同基线、
          动作右对齐。原先的 64px 工具条把标题压到 15px，和其他页面的页头不成比例。 */}
      <header className="shrink-0 border-b border-glassline bg-gbg-deep/45 px-5 py-4 backdrop-blur-glass-sm xl:px-7">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold tracking-normal text-gtext-primary">{nav.tasks}</h1>
              <p className="truncate text-sm text-gtext-muted">描述目标，我来安排员工完成并交付</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:shrink-0">
            <Button size="sm" variant="glass" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">工作记录</span>
              {runs.length > 0 && (
                <span className="grid h-4 min-w-4 place-items-center rounded-glass-pill bg-gbrand px-1 text-[9px] text-white">
                  {runs.length}
                </span>
              )}
            </Button>
            <Button size="sm" variant="glass" onClick={() => setTemplateOpen(true)}>
              <FolderOpen className="h-4 w-4" />
              <span className="hidden sm:inline">模板</span>
            </Button>
            {plan && !started && (
              <Button size="sm" variant="glass" onClick={saveAsTemplate} loading={createTemplate.isPending}>
                存为模板
              </Button>
            )}
            <Button size="sm" variant="glass-primary" onClick={createNewTask} disabled={!activeRunId}>
              <Plus className="h-4 w-4" />
              新建
            </Button>
          </div>
        </div>
      </header>

      {/* 会议要求：顶部突出显示当前可用的硅基员工数量，数字要明显。
          有任务在手时收成紧凑态，把竖向空间让给时间线。
          从通栏副条改成内容区卡片，与能力贡献中心顶部的汇总条同款。 */}
      <div className="shrink-0 px-5 pt-4 xl:px-7">
        <TeamReadinessBar
          enterpriseName={enterprise?.name}
          members={teamMembers}
          compact={Boolean(activeRunId)}
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col px-5 xl:px-7">
        <div className="shrink-0 py-3">
          <TabsList>
            <TabsTrigger value="workspace">我的工作安排</TabsTrigger>
            <TabsTrigger value="monitoring">客户端监控</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="workspace" className="m-0 flex min-h-0 flex-1 flex-col">
          {!activeRunId ? (
          <TaskObjectiveComposer
            objective={objective}
            planning={planner.isPending || createRun.isPending}
            error={planner.error instanceof Error ? planner.error.message : undefined}
            onObjectiveChange={(value) => {
              setObjective(value);
              if (planner.error) planner.reset();
            }}
            onGenerate={generatePlan}
          />
        ) : !snapshot ? (
          <CenteredSpinner label="正在读取员工执行状态…" />
        ) : (
          <TaskFlowTheater
            snapshot={snapshot}
            events={execution.events}
            liveText={execution.liveText}
            liveTools={execution.liveTools}
            connected={execution.connected}
            streamError={execution.error}
            editable={!started}
            busy={busy}
            expandedStepKey={expandedStepKey}
            availableEmployees={availableEmployees}
            view={view}
            graphSlot={
              plan ? (
                <TaskDependencyGraph
                  plan={{ ...plan, status: snapshot.status, steps: mergeExecutionIntoPlan(plan, snapshot) }}
                  layout={layout}
                  running={running}
                  pausedStepIds={snapshot.steps.filter((step) => step.status === 'paused').map((step) => step.stepKey)}
                  selectedStepId={expandedStepKey}
                  onLayoutChange={persistLayout}
                  onResetLayout={() => {
                    setLayout(null);
                    updateRun.mutate({ id: plan.id, layout: null });
                  }}
                  onSelectStep={(step) => toggleStep(step.id)}
                  onConnectSteps={connectSteps}
                  onViewOutput={() => changeView('timeline')}
                />
              ) : null
            }
            onViewChange={changeView}
            onToggleStep={toggleStep}
            onRun={confirmAndRun}
            onStop={stopExecution}
            onRetryStep={retryFromStep}
            onPauseStep={(stepKey) =>
              pauseStep.mutate(stepKey, { onError: (error) => toast.error(errorMessage(error, '暂停失败')) })
            }
            onResumeStep={(stepKey) =>
              resumeStep.mutate(stepKey, { onError: (error) => toast.error(errorMessage(error, '恢复失败')) })
            }
            onOpenConversation={openConversation}
            onReplaceEmployee={replaceStepEmployee}
            onRemoveDependency={removeDependency}
            onDeleteStep={deleteStep}
            onAddStep={addEmployeeStep}
          />
        )}
        </TabsContent>
        <TabsContent value="monitoring" className="m-0 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24 scroll-thin lg:pb-5">
          <ClientTaskMonitor taskId={taskId} subscriptionId={subscriptionId} />
        </TabsContent>
      </Tabs>

      <TaskHistoryDrawer
        open={historyOpen}
        runs={runs}
        loading={runsQuery.isLoading}
        activeRunId={activeRunId}
        running={running}
        onOpenChange={setHistoryOpen}
        onSelect={(run) => {
          setActiveRunId(run.id);
          setExpandedStepKey(undefined);
          setHistoryOpen(false);
        }}
        onDelete={removeRun}
        onNew={createNewTask}
        hasMore={Boolean(runsQuery.hasNextPage)}
        loadingMore={runsQuery.isFetchingNextPage}
        onLoadMore={() => void runsQuery.fetchNextPage()}
        keyword={historyKeyword}
        onKeywordChange={(value) => { setHistoryKeyword(value); }}
        status={historyStatus}
        onStatusChange={setHistoryStatus}
      />

      <TaskTemplateDrawer
        open={templateOpen}
        templates={templatesQuery.data ?? []}
        loading={templatesQuery.isLoading}
        busyId={createRun.isPending ? undefined : deleteTemplate.variables}
        onOpenChange={setTemplateOpen}
        onLoad={loadTemplate}
        onDelete={(template) =>
          deleteTemplate.mutate(template.id, {
            onError: (error) => toast.error(errorMessage(error, '删除失败')),
          })
        }
      />

      <StepConversationDialog
        open={conversationOpen}
        loading={stepConversation.isPending}
        error={stepConversation.error instanceof Error ? stepConversation.error.message : null}
        data={stepConversation.data ?? null}
        onOpenChange={setConversationOpen}
      />
    </div>
  );
}

/**
 * 把服务端的执行状态盖回计划步骤，供依赖图渲染。
 *
 * 依赖图吃的是 TaskPlanStep（规划期形状），执行状态在 TaskRunStep 里。
 * 与其为了一张图再造一套画布，不如在这里做一次形状映射。
 */
function mergeExecutionIntoPlan(plan: TaskPlan, snapshot: TaskExecutionSnapshot): TaskPlanStep[] {
  const byKey = new Map(snapshot.steps.map((step) => [step.stepKey, step]));
  return plan.steps.map((step) => {
    const executed = byKey.get(step.id);
    if (!executed) return step;
    return {
      ...step,
      // 画布不认识 paused，映射成 queued 并由 pausedStepIds 单独标注
      status: executed.status === 'paused' ? 'queued' : executed.status,
      progress: executed.status === 'completed' ? 100 : executed.status === 'running' ? 50 : 0,
      output: executed.output ?? undefined,
      error: executed.error ?? undefined,
      startedAt: executed.startedAt ?? undefined,
      completedAt: executed.completedAt ?? undefined,
      durationMs: executed.durationMs ?? undefined,
    };
  });
}
