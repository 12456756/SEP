'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PaymentPreferenceSchema, type PaymentMode, type PaymentPreference } from 'shared/payment-preference.dto';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const key = ['compute-credit', 'payment-preference'] as const;
const modes: Array<{ value: PaymentMode; label: string }> = [
  { value: 'AUTO', label: '自动选择' },
  { value: 'ENTERPRISE_ONLY', label: '仅企业余额' },
  { value: 'PERSONAL_ONLY', label: '仅个人余额' },
];

export function usePaymentPreference() {
  return useQuery({
    queryKey: key,
    queryFn: async () => PaymentPreferenceSchema.parse(await api.get('/compute-credit/payment-preference')),
  });
}

export function PaymentPreferenceControl() {
  const qc = useQueryClient();
  const preference = usePaymentPreference();
  const save = useMutation({
    onMutate: async () => { await qc.cancelQueries({ queryKey: key }); },
    mutationFn: async (paymentMode: PaymentMode) => PaymentPreferenceSchema.parse(
      await api.patch<PaymentPreference>('/compute-credit/payment-preference', { paymentMode }),
    ),
    onSuccess: (value) => { qc.setQueryData(key, value); },
  });

  if (preference.isPending) return <p className="text-sm text-fg-muted">正在读取付款方式…</p>;
  if (!preference.data) return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
      <span>{preference.error instanceof Error ? preference.error.message : '付款方式读取失败'}</span>
      <Button size="sm" variant="outline" onClick={() => void preference.refetch()}>重试</Button>
    </div>
  );

  return (
    <fieldset className="min-w-0 space-y-2 border-b border-border pb-4" disabled={save.isPending}>
      <legend className="mb-2 text-sm font-medium text-foreground">付款方式</legend>
      <div className="grid w-full max-w-lg grid-cols-3 gap-1 rounded-md bg-muted p-1">
        {modes.map(mode => (
          <label key={mode.value} className={cn(
            'relative flex min-h-10 min-w-0 cursor-pointer items-center justify-center rounded px-1 py-2 text-center text-sm',
            preference.data.paymentMode === mode.value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-fg-muted',
            save.isPending && 'cursor-wait opacity-60',
          )}>
            <input type="radio" name="paymentMode" value={mode.value}
              className="peer sr-only" checked={preference.data.paymentMode === mode.value}
              onChange={() => { if (mode.value !== preference.data.paymentMode) save.mutate(mode.value); }} />
            <span className="break-words peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-primary">{mode.label}</span>
          </label>
        ))}
      </div>
      <p className="text-xs leading-5 text-fg-muted">
        {preference.data.paymentMode === 'AUTO' ? '优先企业资金，不足时使用个人余额。'
          : preference.data.paymentMode === 'ENTERPRISE_ONLY' ? '仅使用获授权的企业资金，不会自动扣个人余额。'
            : '仅使用个人余额，不扣企业资金或订阅赠送余额。'}
        切换仅影响新请求。
      </p>
      {save.isPending && <p role="status" className="flex items-center gap-1 text-xs text-fg-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在保存…</p>}
      {save.isError && <p role="alert" className="text-sm text-danger">{save.error instanceof Error ? save.error.message : '保存失败，请重试'}</p>}
    </fieldset>
  );
}
