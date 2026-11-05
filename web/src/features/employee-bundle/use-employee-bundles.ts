'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadForm } from '@/lib/api-client';
import type { EmployeeCopyDraftResponse } from 'shared/employee-copy.dto';

export type EmployeeBundleStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface EmployeeBundleItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeAvatar: string | null;
  employeeVersion: string;
  unitPrice: string;
  periodMonths: number;
  subtotal: string;
  includedComputeCNY: string;
}

export interface EmployeeBundle {
  id: string;
  code: string;
  name: string;
  description: string | null;
  cover: string | null;
  status: EmployeeBundleStatus;
  priceCNY: string;
  periodMonths: number;
  originalAmountCNY: string;
  discountCNY: string;
  totalComputeCNY: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: EmployeeBundleItem[];
}

export interface BundleItemInput {
  employeeId: string;
  periodMonths?: number;
  includedComputeCNY?: number | null;
}

export interface BundleInput {
  code: string;
  name: string;
  description?: string;
  cover?: string | null;
  priceCNY: number;
  periodMonths: number;
  items: BundleItemInput[];
}

export const bundleQueryKeys = {
  published: ['market', 'employee-bundles'] as const,
  admin: (status?: EmployeeBundleStatus) => ['admin', 'employee-bundles', status ?? 'all'] as const,
};

export function useGenerateBundleDescription() {
  return useMutation({
    mutationFn: (input: { name: string; employeeIds: string[] }) =>
      api.post<EmployeeCopyDraftResponse>('/admin/employee-bundles/copy-draft', input),
  });
}

export function useUploadBundleCover() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return uploadForm<{ cover: string }>('/admin/employee-bundles/cover', form);
    },
  });
}

export function usePublishedEmployeeBundles() {
  return useQuery({
    queryKey: bundleQueryKeys.published,
    queryFn: () => api.get<EmployeeBundle[]>('/market/bundles'),
  });
}

export function usePublishedEmployeeBundle(id: string | undefined) {
  return useQuery({
    queryKey: ['market', 'employee-bundles', id],
    queryFn: () => api.get<EmployeeBundle>(`/market/bundles/${id}`),
    enabled: Boolean(id),
  });
}

export function useAdminEmployeeBundles(status?: EmployeeBundleStatus) {
  return useQuery({
    queryKey: bundleQueryKeys.admin(status),
    queryFn: () => api.get<EmployeeBundle[]>(`/admin/employee-bundles${status ? `?status=${status}` : ''}`),
  });
}

export function useCreateEmployeeBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BundleInput) => api.post<EmployeeBundle>('/admin/employee-bundles', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'employee-bundles'] });
      queryClient.invalidateQueries({ queryKey: bundleQueryKeys.published });
    },
  });
}

export function useUpdateEmployeeBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<BundleInput> }) =>
      api.patch<EmployeeBundle>(`/admin/employee-bundles/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'employee-bundles'] });
      queryClient.invalidateQueries({ queryKey: bundleQueryKeys.published });
    },
  });
}

export function usePublishEmployeeBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<EmployeeBundle>(`/admin/employee-bundles/${id}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'employee-bundles'] });
      queryClient.invalidateQueries({ queryKey: bundleQueryKeys.published });
    },
  });
}

export function useArchiveEmployeeBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<EmployeeBundle>(`/admin/employee-bundles/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'employee-bundles'] });
      queryClient.invalidateQueries({ queryKey: bundleQueryKeys.published });
    },
  });
}
