'use client';

import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { useEnterpriseComputeIntegration } from '@/features/compute-integration/use-compute-integration';
import { ConnectionStatus } from '@/features/compute-integration/connection-status';
import { CredentialRotationPanel } from '@/features/compute-integration/credential-rotation-panel';

export default function EnterpriseComputeConnectionPage() {
  const { roleInEnterprise } = useAuth();
  const allowed = roleInEnterprise === 'ENTERPRISE_ADMIN';
  const query = useEnterpriseComputeIntegration(allowed);
  const queries = useQueryClient();
  return <div className="min-w-0 p-4 pb-28 md:p-6"><header className="flex items-center justify-between gap-3 border-b pb-4"><h1 className="text-xl font-semibold">算力连接</h1>
    <Button size="icon" variant="outline" title="刷新" aria-label="刷新" disabled={!allowed || query.isFetching} onClick={() => {
      void query.refetch(); void queries.invalidateQueries({ queryKey: ['compute-credential-rotations'] });
    }}><RefreshCw className="h-4 w-4" /></Button>
  </header><div className="max-w-2xl py-4">{!allowed ? <p role="alert" className="text-sm text-muted-foreground">仅企业管理员可查看</p> : query.error ? <p role="alert" className="text-sm text-destructive">{query.error.message}</p> : query.isLoading ? <p role="status" className="text-sm text-muted-foreground">加载中...</p> : query.data ? <><CredentialRotationPanel value={query.data} /><ConnectionStatus value={query.data} showCredentials={false} /></> : null}</div></div>;
}
