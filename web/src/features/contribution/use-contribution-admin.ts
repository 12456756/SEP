"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import type { ContributionCapability } from "@/lib/types";

export type PlatformQueueStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED";
export type UnifiedReviewKind = "ALL" | "CAPABILITY" | "SKILL_VERSION";

export interface UnifiedReviewItem {
  kind: "CAPABILITY" | "SKILL_VERSION";
  id: string;
  capabilityId: string;
  capabilityName: string;
  name: string;
  type: string;
  version: string | null;
  status: string;
  submittedAt: string | null;
  enterprise: { id: string; name: string } | null;
  submittedBy: { id: string; name: string | null; email: string };
}

export interface UnifiedReviewQueue {
  items: UnifiedReviewItem[];
  total: number;
}

export type PlatformContribution = ContributionCapability & {
  platformSubmittedAt: string | null;
};

export type PlatformContributionDetail = PlatformContribution & {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  skillConfig: {
    id: string;
    scope: "PLATFORM" | "ENTERPRISE";
    template: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
  } | null;
  rpaVersions: Array<{
    id: string;
    version: string;
    packageFilename: string | null;
    packageFileCount: number;
    packageBytes: number;
    packageSha256: string;
    configDoc: string;
    status: string;
    validationResult: {
      valid?: boolean;
      checks?: Array<{ code: string; passed: boolean; message: string }>;
      issues?: Array<{ code: string; message: string; path?: string }>;
      warnings?: Array<{ code: string; message: string; path?: string }>;
    } | null;
    validatedAt: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  }>;
  skillVersions: Array<{
    id: string;
    version: string;
    content: string;
    changeSummary: string | null;
    status: string;
    validationResult: {
      valid?: boolean;
      checks?: Array<{ code: string; passed: boolean; message: string }>;
      issues?: Array<{ code: string; message: string; path?: string }>;
      warnings?: Array<{ code: string; message: string; path?: string }>;
    } | null;
    validatedAt: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  }>;
  enterpriseReviewedBy: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  platformSubmittedBy: {
    id: string;
    name: string | null;
    email: string;
  } | null;
};

export function usePlatformContributionQueue(
  status: PlatformQueueStatus,
  page = 1,
  pageSize = 20,
  keyword = "",
) {
  const normalizedKeyword = keyword.trim();
  const params = new URLSearchParams({
    status,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (normalizedKeyword) params.set("keyword", normalizedKeyword);
  return useQuery({
    queryKey: qk.contributionAdminQueue(status, page, pageSize, normalizedKeyword),
    queryFn: () =>
      api.get<{
        items: PlatformContribution[];
        total: number;
        page: number;
        pageSize: number;
        status: PlatformQueueStatus;
      }>(`/admin/contributions?${params.toString()}`),
  });
}

export function usePlatformContribution(id: string) {
  return useQuery({
    queryKey: qk.contributionAdmin(id),
    queryFn: () =>
      api.get<PlatformContributionDetail>(`/admin/contributions/${id}`),
    enabled: Boolean(id),
  });
}

export function usePlatformContributionReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      decision: "APPROVE" | "REJECT";
      comment?: string;
    }) =>
      api.post<PlatformContribution>(
        `/admin/contributions/${input.id}/review`,
        { decision: input.decision, comment: input.comment },
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "contributions"] });
      void queryClient.invalidateQueries({
        queryKey: qk.contributionAdmin(input.id),
      });
    },
  });
}

export function useUnifiedCapabilityReviewQueue(kind: UnifiedReviewKind) {
  return useQuery({
    queryKey: qk.contributionReviewQueue(kind),
    queryFn: () =>
      api.get<UnifiedReviewQueue>(`/admin/capability-review?kind=${kind}`),
  });
}
