'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import { useEnterpriseInfo, useUploadEnterpriseLogo } from '@/features/enterprise/use-enterprise';
import { useEnterpriseSetting } from '@/features/enterprise-settings/use-enterprise-settings';
import { useAuthStore } from '@/lib/auth-store';
import { Avatar } from '@/components/ui/avatar';
import { ThemeLogo } from '@/components/ui/theme-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CenteredSpinner } from '@/components/ui/feedback';

export default function OrganizationPage() {
  const { data: enterprise, isLoading, isError } = useEnterpriseInfo();
  const upload = useUploadEnterpriseLogo();
  const { data: setting } = useEnterpriseSetting();
  const isAdmin = useAuthStore((s) => s.roleInEnterprise === 'ENTERPRISE_ADMIN');
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setSaved(false);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('请选择 PNG、JPG 或 WebP 图片');
      return;
    }
    if (!file.size || file.size > 2 * 1024 * 1024) {
      setError('图片不能为空，且不能超过 2 MB');
      return;
    }
    try {
      await upload.mutateAsync(file);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试');
    }
  }

  if (isLoading) return <CenteredSpinner label="加载中…" />;
  if (isError) return <p role="alert" className="p-6 text-destructive">企业信息加载失败，请刷新后重试</p>;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">企业信息</h1>
        <p className="mt-1 text-sm text-fg-muted">{isAdmin ? '管理企业标识与基本信息' : '查看企业标识与基本信息'}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>企业 Logo</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-5">
            {enterprise?.logo?.trim() ? (
              <Avatar name={enterprise.name} src={enterprise.logo} className="h-20 w-20 shrink-0 rounded-xl border border-border bg-background object-contain text-2xl" />
            ) : (
              <ThemeLogo width={80} height={80} className="rounded-xl border border-border bg-background" />
            )}
            <div className="space-y-2">
              {isAdmin ? (
                <>
                  <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择企业 Logo" className="hidden" disabled={upload.isPending} onChange={handleUpload} />
                  <Button variant="outline" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
                    <Upload className="mr-2 h-4 w-4" />
                    {upload.isPending ? '正在上传…' : enterprise?.logo ? '更换 Logo' : '上传 Logo'}
                  </Button>
                  <p className="text-sm text-fg-muted">支持 PNG、JPG、WebP，最大 2 MB，建议使用正方形图片。</p>
                  <p className="text-sm text-fg-muted">上传后自动保存，并同步显示在企业侧边栏。</p>
                </>
              ) : (
                <p className="text-sm text-fg-muted">企业 Logo 由企业管理员维护。</p>
              )}
            </div>
          </div>
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
          {saved && <p role="status" className="mt-3 text-sm text-emerald-600">企业 Logo 已更新</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>基本信息</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-2">
            <span className="w-28 shrink-0 text-fg-muted">企业名称</span>
            <span className="font-medium text-foreground">{enterprise?.name ?? '—'}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-28 shrink-0 text-fg-muted">企业 ID</span>
            <span className="font-mono text-xs text-foreground">{enterprise?.id ?? '—'}</span>
          </div>
          {setting?.updatedAt && new Date(setting.updatedAt).getTime() > 0 && (
            <div className="flex gap-2">
              <span className="w-28 shrink-0 text-fg-muted">设置更新于</span>
              <span className="text-foreground">{new Date(setting.updatedAt).toLocaleString('zh-CN')}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
