'use client';

import { useAuth } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api-client';
import { toast } from '@/components/ui/toast';
import { ModelConfigForm } from '@/features/enterprise-settings/model-config-form';
import {
  useModelConfig,
  useAvailableModels,
  useUpdateModelConfig,
} from '@/features/enterprise-settings/use-model-config';
import { Loader2 } from 'lucide-react';

export default function ModelsSettingsPage() {
  const { enterprise, roleInEnterprise } = useAuth();
  const enterpriseId = enterprise?.id ?? '';
  const isAdmin = roleInEnterprise === 'ENTERPRISE_ADMIN';

  const configQuery = useModelConfig(enterpriseId);
  const modelsQuery = useAvailableModels(enterpriseId);
  const updateMutation = useUpdateModelConfig(enterpriseId);

  const isLoading = configQuery.isLoading || modelsQuery.isLoading;
  const error = configQuery.error ?? modelsQuery.error;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-2xl font-bold">模型偏好</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          企业可用模型与当前默认模型
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-28 md:pb-6">
        <div className="mx-auto max-w-4xl">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
              {error instanceof ApiError ? error.message : '加载配置失败'}
            </div>
          ) : configQuery.data && modelsQuery.data ? (
            <>
              {!isAdmin && (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-200">
                  以下是企业管理员配置的模型策略，当前为只读视图。
                </div>
              )}
              {isAdmin && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                  <p className="font-medium">企业管理员权限</p>
                  <p className="mt-1">
                    修改后将影响本企业所有成员的模型使用权限。
                  </p>
                </div>
              )}
              <ModelConfigForm
                key={configQuery.data.updatedAt}
                config={configQuery.data}
                availableModels={modelsQuery.data}
                readOnly={!isAdmin}
                isSaving={updateMutation.isPending}
                onSave={(dto) => {
                  updateMutation.mutate(dto, {
                    onSuccess: () => toast.success('模型配置已更新'),
                    onError: (e) =>
                      toast.error(e instanceof ApiError ? e.message : '更新失败'),
                  });
                }}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
