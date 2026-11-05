import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TasksPage from './page';

const mocks = vi.hoisted(() => ({ search: '', monitor: vi.fn(), mutation: { mutate: vi.fn(), reset: vi.fn() } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock('@/lib/auth-store', () => ({ useAuthStore: () => undefined }));
vi.mock('@/features/enterprise/use-enterprise', () => ({ useMyEmployees: () => ({ data: [] }) }));
vi.mock('@/features/task/use-task-plan', () => ({ useCreateTaskPlan: () => mocks.mutation }));
vi.mock('@/features/task/use-task-execution', () => ({
  useTaskExecution: () => ({ snapshot: null }),
  useRunTask: () => mocks.mutation,
  useStopTask: () => mocks.mutation,
  usePauseStep: () => mocks.mutation,
  useResumeStep: () => mocks.mutation,
  useStepConversation: () => mocks.mutation,
}));
vi.mock('@/features/task/use-task-runs', () => ({
  useInfiniteTaskRuns: () => ({ data: { pages: [{ items: [], nextCursor: null }] }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }),
  useTaskRun: () => ({}),
  useTaskTemplates: () => ({ data: [] }),
  useCreateTaskRun: () => mocks.mutation,
  useUpdateTaskRun: () => mocks.mutation,
  useDeleteTaskRun: () => mocks.mutation,
  useCreateTaskTemplate: () => mocks.mutation,
  useDeleteTaskTemplate: () => mocks.mutation,
}));
vi.mock('@/features/task/components/client-task-monitor', () => ({
  ClientTaskMonitor: (props: { taskId?: string; subscriptionId?: string }) => {
    mocks.monitor(props);
    return <div data-testid="client-monitor" />;
  },
}));
vi.mock('@/features/task/task-objective-composer', () => ({ TaskObjectiveComposer: () => <div data-testid="workspace" /> }));
vi.mock('@/features/task/components/task-dependency-graph', () => ({ TaskDependencyGraph: () => null }));
vi.mock('@/features/task/components/task-history-drawer', () => ({ TaskHistoryDrawer: () => null }));
vi.mock('@/features/task/components/task-template-drawer', () => ({ TaskTemplateDrawer: () => null }));
vi.mock('@/features/task/components/team-readiness-bar', () => ({ TeamReadinessBar: () => null }));
vi.mock('@/features/task/components/task-flow-theater', () => ({ TaskFlowTheater: () => null }));
vi.mock('@/features/task/components/step-conversation-dialog', () => ({ StepConversationDialog: () => null }));

beforeEach(() => { vi.clearAllMocks(); mocks.search = ''; });
afterEach(cleanup);

describe('tasks page client monitor navigation', () => {
  it.each(['client', 'monitoring'])('opens the %s deep link and passes the mirror ID and subscription', (tab) => {
    mocks.search = `tab=${tab}&taskId=mirror-off-page&subscriptionId=sub-1`;
    render(<TasksPage />);
    expect(screen.getByRole('tab', { name: '客户端监控' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('client-monitor')).toBeInTheDocument();
    expect(mocks.monitor).toHaveBeenLastCalledWith({ taskId: 'mirror-off-page', subscriptionId: 'sub-1' });
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('keeps ordinary navigation on the workspace and supports manual monitor selection', () => {
    render(<TasksPage />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(mocks.monitor).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '客户端监控' }));
    expect(mocks.monitor).toHaveBeenLastCalledWith({ taskId: undefined, subscriptionId: undefined });
  });

  it('opens a new deep link after client-side navigation without a page remount', () => {
    const { rerender } = render(<TasksPage />);
    mocks.search = 'tab=client&taskId=mirror-1';
    rerender(<TasksPage />);
    expect(mocks.monitor).toHaveBeenLastCalledWith({ taskId: 'mirror-1', subscriptionId: undefined });
    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的工作安排' }));
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    mocks.search = 'tab=client&taskId=mirror-2&subscriptionId=sub-2';
    rerender(<TasksPage />);
    expect(screen.getByRole('tab', { name: '客户端监控' })).toHaveAttribute('aria-selected', 'true');
    expect(mocks.monitor).toHaveBeenLastCalledWith({ taskId: 'mirror-2', subscriptionId: 'sub-2' });
  });
});
