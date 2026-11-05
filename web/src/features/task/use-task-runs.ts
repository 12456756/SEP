'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type { TaskPlanStep, TaskRunStatus } from './task-orchestration';
import type {
  GraphLayoutPayload,
  TaskRun,
  TaskRunEvent,
  TaskRunListResponse,
  TaskTemplate,
} from './task-run';

interface ListParams {
  scope?: 'mine' | 'enterprise';
  status?: TaskRunStatus[];
  limit?: number;
  cursor?: string;
  keyword?: string;
}

function listQuery(params: ListParams): string {
  const search = new URLSearchParams();
  if (params.scope) search.set('scope', params.scope);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.keyword?.trim()) search.set('keyword', params.keyword.trim());
  for (const status of params.status ?? []) search.append('status', status);
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function useTaskRuns(params: ListParams = {}) {
  return useQuery({
    queryKey: qk.taskRunList(params as Record<string, unknown>),
    queryFn: () => api.get<TaskRunListResponse>(`/tasks${listQuery(params)}`),
  });
}

/** 工作记录抽屉使用 cursor 分页，避免一次加载全部历史记录。 */
export function useInfiniteTaskRuns(params: Omit<ListParams, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.taskRunList(params as Record<string, unknown>),
    queryFn: ({ pageParam, signal }) =>
      api.get<TaskRunListResponse>(`/tasks${listQuery({ ...params, cursor: pageParam ?? undefined })}`, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useTaskRun(id: string) {
  return useQuery({
    queryKey: qk.taskRun(id),
    queryFn: () => api.get<TaskRun>(`/tasks/${id}`),
    enabled: Boolean(id),
  });
}

export function useTaskRunEvents(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.taskRunEvents(id),
    queryFn: () => api.get<TaskRunEvent[]>(`/tasks/${id}/events`),
    enabled: Boolean(id) && enabled,
  });
}

function invalidateRuns(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qk.taskRuns });
}

export interface CreateTaskRunInput {
  objective: string;
  summary?: string;
  steps: TaskPlanStep[];
  layout?: GraphLayoutPayload | null;
  planner?: { type: 'llm'; model: string } | null;
  status?: TaskRunStatus;
}

export function useCreateTaskRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskRunInput) => api.post<TaskRun>('/tasks', input),
    onSuccess: (run) => {
      qc.setQueryData(qk.taskRun(run.id), run);
      invalidateRuns(qc);
    },
  });
}

export interface UpdateTaskRunInput {
  id: string;
  status?: TaskRunStatus;
  steps?: TaskPlanStep[];
  layout?: GraphLayoutPayload | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export function useUpdateTaskRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateTaskRunInput) => api.patch<TaskRun>(`/tasks/${id}`, body),
    onSuccess: (run) => {
      qc.setQueryData<TaskRun>(qk.taskRun(run.id), (current) => (current ? { ...current, ...run } : run));
      invalidateRuns(qc);
    },
  });
}

export interface UpdateTaskStepInput {
  id: string;
  stepId: string;
  status?: TaskPlanStep['status'];
  progress?: number;
  output?: string;
  error?: string | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** 窄接口：只改一个步骤，避免整份 steps 覆盖（载荷小、不会被另一个标签页清掉） */
export function useUpdateTaskStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stepId, ...body }: UpdateTaskStepInput) =>
      api.patch<TaskRun>(`/tasks/${id}/steps/${stepId}`, body),
    onSuccess: (run) => {
      // 合并而不是覆盖：步骤级 PATCH 的响应不保证带齐 stepCount /
      // completedStepCount / employeeNames 这些派生字段，直接 setQueryData
      // 会把缓存里已有的值抹成 undefined。
      qc.setQueryData<TaskRun>(qk.taskRun(run.id), (current) => (current ? { ...current, ...run } : run));
      void qc.invalidateQueries({ queryKey: qk.taskRunEvents(run.id) });
      invalidateRuns(qc);
    },
  });
}

export function useDeleteTaskRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ success: boolean }>(`/tasks/${id}`),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: qk.taskRun(id) });
      invalidateRuns(qc);
    },
  });
}

/**
 * 手动回收一条卡住的运行。
 *
 * 常规路径已经不需要它了 —— 服务端 TaskReconcileService 每分钟自动接回或收口
 * 失联的运行。保留这个 hook 是给「自动回收也没救回来」留一个人工兜底入口，
 * 目前界面上没有挂它。
 */
export function useReconcileTaskRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TaskRun>(`/tasks/${id}/reconcile`),
    onSuccess: (run) => {
      qc.setQueryData(qk.taskRun(run.id), run);
      invalidateRuns(qc);
    },
  });
}

export function useTaskTemplates() {
  return useQuery({
    queryKey: qk.taskTemplates,
    queryFn: () => api.get<TaskTemplate[]>('/tasks/templates'),
  });
}

export function useCreateTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; objective: string; steps: TaskPlanStep[]; layout?: GraphLayoutPayload | null }) =>
      api.post<TaskTemplate>('/tasks/templates', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.taskTemplates }),
  });
}

export function useDeleteTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ success: boolean }>(`/tasks/templates/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.taskTemplates }),
  });
}
