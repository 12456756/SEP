'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadForm } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { ContributionCapabilityCreateDtoSchema, type RpaPackageParseResult } from '../../../../backend/src/shared';
import type { CapabilityType, ContributionCapability, ContributionCapabilityDetail, ContributionOverview, ContributionRewardEvent, ContributionUsage, ContributionVersionDiff } from '@/lib/types';

/** 作者版本详情 = 列表里的版本摘要 + 正文。 */
export type AuthorVersionDetail = ContributionCapabilityDetail['skillVersions'][number] & {
  content: string;
  capability: { id: string; name: string; description: string; visibility: string };
};

export function useContributionOverview() {
  return useQuery({ queryKey: qk.contributionOverview, queryFn: () => api.get<ContributionOverview>('/contributions/overview') });
}

export function useMyContributions() {
  return useQuery({ queryKey: qk.contributionMine, queryFn: () => api.get<ContributionCapability[]>('/contributions/mine') });
}

export function useContribution(id: string) {
  return useQuery({ queryKey: qk.contribution(id), queryFn: () => api.get<ContributionCapabilityDetail>(`/contributions/${id}`), enabled: Boolean(id) });
}

export function useContributionRewards() {
  return useQuery({ queryKey: qk.contributionRewards, queryFn: () => api.get<ContributionRewardEvent[]>('/contributions/rewards') });
}

export function useContributionUsage(id: string) {
  return useQuery({ queryKey: [...qk.contribution(id), 'usage'], queryFn: () => api.get<ContributionUsage>(`/contributions/${id}/usage`), enabled: Boolean(id) });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qk.contributions });
}

export function useCreateContribution(options?: { submitToPlatformReview?: boolean }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (String(body.type).toUpperCase() === 'SKILL') throw new Error('SKILL 首次创建仅在运营后台提供');
      const payload = ContributionCapabilityCreateDtoSchema.parse(body);
      const endpoint = options?.submitToPlatformReview ? '/admin/contributions/rpa' : '/contributions';
      return api.post<ContributionCapability>(endpoint, payload);
    },
    onSuccess: () => {
      invalidate(qc);
      if (options?.submitToPlatformReview) {
        void qc.invalidateQueries({ queryKey: ['capabilities'] });
        void qc.invalidateQueries({ queryKey: ['admin', 'contributions'] });
      }
    },
  });
}

/** RPA 仍沿用服务端 ZIP 校验与贡献流程。 */
export function useUploadRpaPackage() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return uploadForm<RpaPackageParseResult>('/contributions/rpa-package', form);
    },
  });
}

export function useUploadSkillPackage() {
  return useMutation({
    mutationFn: async (_file: File) => { throw new Error('已有 SKILL 包请通过客户端上传'); },
  });
}

/** 旧入口兼容：SKILL Web 写入已关闭。 */
export function useCreateVersion(capabilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_body: {
      changeSummary: string;
      parentVersionId?: string;
      content?: string;
      packageSha256?: string;
      packageFilename?: string;
    }) => { throw new Error('SKILL 新版本请通过客户端上传'); },
    onSuccess: () => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: qk.contribution(capabilityId) });
    },
  });
}

/** 旧 SKILL 投稿 hook 保留类型兼容，但不发送请求。 */
export function useSubmitVersion(capabilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_versionId: string) => { throw new Error('SKILL 版本请通过客户端提交企业审核'); },
    onSuccess: () => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: qk.contribution(capabilityId) });
    },
  });
}

/** 作者、企业管理员和平台审核人查看某个 Skill 版本相对父版本的差异与审核历史。 */
export function useVersionDiff(versionId: string) {
  return useQuery({
    queryKey: ['skill-versions', 'diff', versionId] as const,
    queryFn: () => api.get<ContributionVersionDiff>(`/contributions/versions/${versionId}/diff`),
    enabled: Boolean(versionId),
  });
}

/** 作者视角的版本正文。企业侧那个 preview 要求订阅授权，贡献场景拿不到。 */
export function useAuthorVersion(versionId: string) {
  return useQuery({
    queryKey: ['skill-versions', 'preview', 'author', versionId] as const,
    queryFn: () => api.get<AuthorVersionDetail>(`/contributions/versions/${versionId}`),
    enabled: Boolean(versionId),
  });
}

/** 旧编辑 hook 只返回客户端维护提示，不写正文。 */
export function useUpdateVersion(capabilityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_data: { versionId: string; content: string; changeSummary?: string }) => {
      throw new Error('已有 SKILL 正文请通过客户端修改');
    },
    onSuccess: (_data, variables) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: qk.contribution(capabilityId) });
      void qc.invalidateQueries({
        queryKey: ['skill-versions', 'preview', 'author', variables.versionId],
      });
    },
  });
}

export function useContributionAction(action: 'submit-enterprise-review' | 'request-platform-review' | 'authorize-platform-submission', type: CapabilityType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (type === 'SKILL') throw new Error('SKILL 不再通过贡献中心投稿或授权');
      return api.post<ContributionCapability>(`/contributions/${id}/${action}`);
    },
    onSuccess: (_data, id) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: qk.contribution(id) });
    },
  });
}

export function useReviewContribution(stage: 'enterprise' | 'platform', type: CapabilityType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; decision: 'APPROVE' | 'REJECT'; comment?: string }) => {
      if (type === 'SKILL') throw new Error('SKILL 请在技能版本审核中处理');
      return api.post<ContributionCapability>(`/contributions/${data.id}/${stage}-review`, { decision: data.decision, comment: data.comment });
    },
    onSuccess: (_data, variables) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: qk.contribution(variables.id) });
    },
  });
}
