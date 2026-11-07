import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { enterpriseDeletionApi } from './enterprise-deletion-api';

export const enterpriseDeletionKeys = {
  preview: (id: string) => ['admin', 'enterprise-deletion', 'preview', id] as const,
  current: (id: string) => ['admin', 'enterprise-deletion', 'current', id] as const,
  job: (id: string) => ['admin', 'enterprise-deletion', 'job', id] as const,
};

export function useEnterpriseDeletionPreview(enterpriseId: string, open: boolean) {
  return useQuery({
    queryKey: enterpriseDeletionKeys.preview(enterpriseId),
    queryFn: () => enterpriseDeletionApi.preview(enterpriseId),
    enabled: open && Boolean(enterpriseId),
    staleTime: 15_000,
  });
}

export function useCurrentEnterpriseDeletion(enterpriseId: string, open: boolean) {
  return useQuery({
    queryKey: enterpriseDeletionKeys.current(enterpriseId),
    queryFn: () => enterpriseDeletionApi.current(enterpriseId),
    enabled: open && Boolean(enterpriseId),
    staleTime: 0,
  });
}

export function useEnterpriseDeletionJob(jobId: string | null, open: boolean) {
  return useQuery({
    queryKey: enterpriseDeletionKeys.job(jobId ?? ''),
    queryFn: () => enterpriseDeletionApi.getJob(jobId as string),
    enabled: open && Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'COMPLETED' || status === 'FAILED' ? false : 2_000;
    },
  });
}

export function useStartEnterpriseDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ enterpriseId, confirmName }: { enterpriseId: string; confirmName: string }) => enterpriseDeletionApi.start(enterpriseId, confirmName),
    onSuccess: (job, { enterpriseId }) => {
      qc.setQueryData(enterpriseDeletionKeys.current(enterpriseId), job);
      qc.setQueryData(enterpriseDeletionKeys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: ['admin', 'enterprises', 'list'] });
    },
  });
}

export function useRetryEnterpriseDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => enterpriseDeletionApi.retry(jobId),
    onSuccess: (job) => {
      qc.setQueryData(enterpriseDeletionKeys.job(job.id), job);
      qc.setQueryData(enterpriseDeletionKeys.current(job.enterpriseId), job);
    },
  });
}
