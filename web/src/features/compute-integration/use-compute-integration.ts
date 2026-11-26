'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';
import type { ComputeCredentialRotationRequest, ComputeCredentialRotationView } from 'shared/compute-credential-rotation.dto';

export interface IntegrationRecords {
  passwordSync?: { status: string; version: number; attempts: number; lastErrorCode: string | null; lastErrorMessage: string | null } | null;
  jobs: Array<{ id: string; businessId: string; kind: string; status: string; attempts: number; lastErrorCode: string | null; updatedAt: string }>;
  settlements: Array<{ id: string; executionId: string; grossCny: string; freeCny: string; paidCny: string; unpaidCny: string; status: string }>;
  transfers: Array<{ id: string; businessId: string; direction: string; amountCny: string; status: string }>;
  executions: Array<{ id: string; sourceRef: string; feeStatus: string; grossCny: string | null; computeRequestId: string | null }>;
  reconciliations: Array<{ id: string; businessId: string; sequence: string; status: string; differenceCny: string }>;
}

export function useComputeIntegrations(page: number, keyword: string) {
  return useQuery({ queryKey: ['compute-integrations', page, keyword], queryFn: () => api.get<{
    items: ComputeIntegrationView[]; total: number; page: number; pageSize: number;
  }>(`/admin/compute-integrations?${new URLSearchParams({ page: String(page), pageSize: '20', keyword })}`),
    refetchInterval: query => query.state.data?.items.some(item => item.status === 'PENDING' || item.status === 'READY' && item.mode !== 'ENTERPRISE') ? 5000 : false });
}

export function useEnterpriseComputeIntegration(enabled: boolean) {
  const enterpriseId = useAuthStore(state => state.enterprise?.id);
  return useQuery({ queryKey: ['enterprise-compute-integration', enterpriseId], enabled: enabled && !!enterpriseId,
    queryFn: () => api.get<ComputeIntegrationView>('/enterprise/compute-integration'),
    refetchInterval: query => query.state.data?.status === 'PENDING' || query.state.data?.status === 'READY' && query.state.data.mode !== 'ENTERPRISE' ? 5000 : false });
}

export function useComputeIntegrationRecords(enterpriseId: string | null, keyword = '', status = 'ALL') {
  return useQuery({ queryKey: ['compute-integration-records', enterpriseId, keyword, status], enabled: !!enterpriseId,
    queryFn: () => api.get<IntegrationRecords>(`/admin/compute-integrations/${enterpriseId}/records?${new URLSearchParams({ keyword, status })}`),
    refetchInterval: query => query.state.data?.passwordSync?.status === 'PENDING' ? 5000 : false });
}

export function useRetryComputeIntegration() {
  const queries = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.post(`/admin/compute-integrations/jobs/${id}/retry`),
    onSuccess: () => { queries.invalidateQueries({ queryKey: ['compute-integrations'] }); queries.invalidateQueries({ queryKey: ['compute-integration-records'] }); } });
}

export function usePrepareComputeIntegration() {
  const queries = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.post<ComputeIntegrationView>(`/admin/compute-integrations/${id}/prepare`),
    onSuccess: () => { queries.invalidateQueries({ queryKey: ['compute-integrations'] }); queries.invalidateQueries({ queryKey: ['compute-integration-records'] }); } });
}

export function useCredentialRotations(enabled: boolean) {
  const enterpriseId = useAuthStore(state => state.enterprise?.id);
  return useQuery({ queryKey: ['compute-credential-rotations', enterpriseId], enabled: enabled && !!enterpriseId,
    queryFn: () => api.get<ComputeCredentialRotationView[]>('/enterprise/compute-integration/credential-rotations'),
    refetchInterval: query => query.state.data?.some(row => !['COMPLETED', 'BLOCKED'].includes(row.status)) ? 3000 : false });
}

export function useRotateCredential() {
  const queries = useQueryClient();
  return useMutation({ mutationFn: (request: ComputeCredentialRotationRequest) => api.post<ComputeCredentialRotationView>(
    '/enterprise/compute-integration/credential-rotations', request),
    onSettled: () => { queries.invalidateQueries({ queryKey: ['compute-credential-rotations'] });
      queries.invalidateQueries({ queryKey: ['enterprise-compute-integration'] }); } });
}

export function useRetryCredentialRotation() {
  const queries = useQueryClient();
  return useMutation({ mutationFn: (operationId: string) => api.post<ComputeCredentialRotationView>(
    `/enterprise/compute-integration/credential-rotations/${encodeURIComponent(operationId)}/retry`),
    onSettled: () => queries.invalidateQueries({ queryKey: ['compute-credential-rotations'] }) });
}
