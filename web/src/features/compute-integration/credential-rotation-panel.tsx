'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCw } from 'lucide-react';
import type { ComputeIntegrationView } from 'shared/compute-integration.dto';
import type { ComputeCredentialRotationRequest } from 'shared/compute-credential-rotation.dto';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/auth-store';
import { kindLabels } from './connection-status';
import { useCredentialRotations, useRetryCredentialRotation, useRotateCredential } from './use-compute-integration';

const statusLabels = { PENDING: '正在更换', SWITCHED: '新 Key 已启用，等待确认', DRAINING: '新 Key 已启用，旧任务处理中',
  COMPLETED: '更换完成', BLOCKED: '更换需处理' };

export function CredentialRotationPanel({ value }: { value: ComputeIntegrationView }) {
  const rotations = useCredentialRotations(true), mutation = useRotateCredential(), queries = useQueryClient();
  const retry = useRetryCredentialRotation();
  const enterpriseId = useAuthStore(state => state.enterprise?.id);
  const requests = useRef<Partial<Record<ComputeCredentialRotationRequest['kind'], ComputeCredentialRotationRequest>>>({});
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const signature = rotations.data?.map(row => `${row.operationId}:${row.status}`).join('|');
  useEffect(() => {
    queries.invalidateQueries({ queryKey: ['enterprise-compute-integration', enterpriseId] });
    queries.invalidateQueries({ queryKey: ['enterprise', enterpriseId] });
  }, [signature, queries, enterpriseId]);

  async function rotate(kind: ComputeCredentialRotationRequest['kind'], version: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const previous = requests.current[kind];
    const request = previous?.expectedVersion === version ? previous : { operationId: crypto.randomUUID(), kind, expectedVersion: version };
    requests.current[kind] = request;
    try { await mutation.mutateAsync(request); delete requests.current[kind]; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '更换请求暂未确认，请重试原操作'); }
    finally { inFlight.current = false; }
  }

  return <section aria-label="凭证更换" className="border-b border-border pb-4">
    <h2 className="text-sm font-medium">企业 Key</h2>
    {rotations.error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{rotations.error.message}</p>}
    {error && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error}</p>}
    <div className="mt-2 divide-y divide-border">
      {value.credentials.map(key => {
        const current = rotations.data?.find(row => row.kind === key.kind);
        const busy = current && current.status !== 'COMPLETED';
        const disabled = !value.connected || value.mode !== 'ENTERPRISE' || !key.configured || !key.version
          || !!busy || rotations.isLoading || !!rotations.error || mutation.isPending;
        return <div key={key.kind} className="flex min-w-0 items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{kindLabels[key.kind]} Key <span className="text-muted-foreground">{key.maskedKey ?? '未配置'}{key.version ? ` · v${key.version}` : ''}</span></p>
            {current && <p role="status" className="mt-1 break-words text-xs text-muted-foreground">{statusLabels[current.status]}</p>}
            {current?.lastErrorMessage && <p className="mt-1 break-words text-xs text-amber-700">{current.lastErrorMessage}</p>}
          </div>
          {current?.status === 'BLOCKED' && <Button variant="outline" size="sm" disabled={retry.isPending}
            onClick={() => retry.mutate(current.operationId, { onError: reason => setError(reason.message) })}>
            <RotateCw className="h-4 w-4" />恢复原操作
          </Button>}
          <Button variant="outline" size="icon" title={`一键更换${kindLabels[key.kind]} Key`} aria-label={`一键更换${kindLabels[key.kind]} Key`}
            disabled={disabled} onClick={() => void rotate(key.kind, key.version!)}>
            {busy && current.status !== 'BLOCKED' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          </Button>
        </div>;
      })}
    </div>
  </section>;
}
