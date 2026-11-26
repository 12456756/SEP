'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useSettings, useUpdateSettings } from './use-admin';

export function ChatModelConnection() {
  const settings = useSettings();
  const save = useUpdateSettings();
  const base = settings.data?.find((field) => field.key === 'SUB2API_BASE_URL');
  const key = settings.data?.find((field) => field.key === 'SUB2API_API_KEY');
  const [form, setForm] = useState({ baseUrl: '', apiKey: '' });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!dirty) setForm({ baseUrl: base?.value ?? '', apiKey: '' }); }, [base?.value, dirty]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await save.mutateAsync({ SUB2API_BASE_URL: form.baseUrl.trim(), ...(form.apiKey.trim() ? { SUB2API_API_KEY: form.apiKey.trim() } : {}) });
      setForm((current) => ({ ...current, apiKey: '' }));
      setDirty(false);
      toast.success('会话连接已保存，可同步上游模型');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '连接保存失败'); }
  };
  return <section aria-label="会话模型连接" className="space-y-4 rounded-lg border border-border p-4">
    <h2 className="text-base font-semibold">管理员模型连接</h2>
    <p className="text-xs text-fg-muted">用于平台管理操作。企业模型调用使用各企业凭证。</p>
    <form onSubmit={submit} className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">Base URL</span>
        <Input aria-label="Base URL" type="url" required disabled={save.isPending} value={form.baseUrl} onChange={(event) => { setDirty(true); setForm({ ...form, baseUrl: event.target.value }); }}/>
        {base && <span className="text-xs text-fg-muted">来源：{base.source === 'database' ? '后台保存' : base.source === 'environment' ? '环境变量' : '未配置'}</span>}</label>
      <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">API Key{key?.configured ? '（已保存，留空不修改）' : ''}</span>
        <Input type="password" autoComplete="new-password" disabled={save.isPending} value={form.apiKey} onChange={(event) => { setDirty(true); setForm({ ...form, apiKey: event.target.value }); }}/></label>
      <Button type="submit" loading={save.isPending}><Save className="h-4 w-4"/>保存连接</Button>
      {(error || settings.error) && <p role="alert" className="break-words text-sm text-danger sm:col-span-3">{error || '连接状态读取失败，可填写完整新连接后保存。'}</p>}
    </form>
  </section>;
}
