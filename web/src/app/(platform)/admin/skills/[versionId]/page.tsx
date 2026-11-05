'use client';

import { Suspense, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RotateCcw, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CenteredSpinner } from '@/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { Markdown } from '@/features/chat/markdown';
import { SKILL_VERSION_STATUS } from '@/features/skill-version/status';
import { diffLines } from '@/features/capability-iteration/diff-lines';
import { useMonitorDetail, usePublishSkillVersion } from '../use-skill-monitor';
import { VERSION_TYPE_LABELS, canPublishVersion, creationMethodLabel, currentUsageLabel, enterpriseReviewLabel, monitorContextFilters, monitorContextSuffix, monitorValidation, platformProcessingLabel, promotedVersion, publishedSourceVersion, type MonitorDetail } from '../monitor';
import { EnterprisePublishedVersions, VersionAttribution } from '../version-attribution';
import { SkillPackageWarnings } from '../package-warnings';

export default function AdminSkillVersionDetailPage() {
  return <Suspense fallback={<CenteredSpinner label="加载版本详情..." />}><SkillVersionDetail /></Suspense>;
}

function SkillVersionDetail() {
  const { versionId = '' } = useParams<{ versionId: string }>();
  return <SkillVersionPreview key={versionId} versionId={versionId} />;
}

function SkillVersionPreview({ versionId }: { versionId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const contextSuffix = monitorContextSuffix(monitorContextFilters(params));
  const query = useMonitorDetail(versionId);
  const publish = usePublishSkillVersion();
  const [changeSummary, setChangeSummary] = useState('');
  const [confirmation, setConfirmation] = useState<{ version: MonitorDetail; changeSummary?: string } | null>(null);
  const [tab, setTab] = useState('rendered');
  const [publishError, setPublishError] = useState('');

  if (query.isLoading) return <CenteredSpinner label="加载版本详情..." />;
  if (query.isError) return <div role="alert" className="space-y-3 p-6 text-sm text-gdanger">加载失败：{query.error instanceof Error ? query.error.message : '请稍后重试'}<Button variant="glass" onClick={() => void query.refetch()}>重试</Button></div>;
  if (!query.data) return <div className="p-6 text-sm text-gdanger">技能版本不存在。</div>;
  const version = query.data;
  const status = SKILL_VERSION_STATUS[version.status];
  const publishedSource = publishedSourceVersion(version);
  const promoted = publishedSource ?? promotedVersion(version);
  const publishable = canPublishVersion(version);
  const validation = monitorValidation(version.validationResult);
  const baseline = version.currentPlatformVersion;
  const runPublish = () => {
    if (!confirmation || publish.isPending || confirmation.version.currentPlatformVersion === undefined) return;
    setPublishError('');
    publish.mutate(
      { id: confirmation.version.id, expectedUpdatedAt: confirmation.version.updatedAt,
        expectedPlatformVersionId: confirmation.version.currentPlatformVersion?.id ?? null,
        changeSummary: confirmation.changeSummary },
      {
        onSuccess: (created) => {
          setPublishError(''); setConfirmation(null);
          toast.success(`已发布为平台版本 v${created.version}`);
          router.push(`/admin/skills/${encodeURIComponent(created.id)}${contextSuffix}`);
        },
        onError: (error) => {
          const message = error instanceof Error && error.message.trim() ? error.message : '发布失败';
          setPublishError(message); setConfirmation(null); toast.error(message);
        },
      },
    );
  };

  return (
    <div className="w-full min-w-0 space-y-5 p-4 sm:p-6">
      <button
        onClick={() => router.push(`/admin/skills${contextSuffix}`)}
        className="inline-flex items-center gap-2 text-sm text-gtext-secondary hover:text-gtext-primary"
      >
        <ArrowLeft className="h-4 w-4" /> 返回技能监控
      </button>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-2xl font-semibold text-gtext-primary">{version.capability.name}</h1>
            {!version.parentVersionId && !version.sourceVersionId && (
              <Badge variant="glass-info">原始版本</Badge>
            )}
            <Badge className={status.className}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-gtext-muted">
            版本 v{version.version} · {VERSION_TYPE_LABELS[version.scope]}
            {version.enterprise ? ` · 来源企业：${version.enterprise.name}` : ''}
          </p>
        </div>
        <Button variant="glass" disabled={query.isFetching || publish.isPending} onClick={() => void query.refetch()}><RotateCcw className="h-4 w-4" />刷新预览</Button>
      </header>
      {publishError && <div role="alert" className="space-y-2 whitespace-pre-wrap break-words border-l-2 border-gdanger pl-3 text-sm text-gdanger">
        <p>发布失败：{publishError}</p><p>请刷新预览，核对来源与当前平台版本后重试。</p>
      </div>}
      <section aria-label="版本分类" className="grid gap-3 border-y border-glassline py-4 text-sm text-gtext-secondary sm:grid-cols-3"><p>版本类型：{VERSION_TYPE_LABELS[version.scope]}<br />产生方式：{creationMethodLabel(version)}</p><p>企业审核：{enterpriseReviewLabel(version)}<br />平台处理：{platformProcessingLabel(version)}</p><p>当前使用：{currentUsageLabel(version)}</p></section>
      <section aria-label="版本归属" className="grid min-w-0 gap-4 border-b border-glassline pb-4 sm:grid-cols-3">
        <VersionAttribution version={version} />
        <div><h2 className="mb-2 text-xs text-gtext-muted">对应企业版本</h2><EnterprisePublishedVersions version={version} /></div>
        <div className="min-w-0 break-all text-xs text-gtext-muted"><p>技能 ID：{version.capabilityId}</p><p className="mt-2">版本 ID：{version.id}</p></div>
      </section>
      <section aria-label="当前平台版本" className="min-w-0 space-y-2 border-b border-glassline pb-4 text-sm text-gtext-secondary">
        <h2 className="font-medium text-gtext-primary">当前平台版本</h2>
        {baseline ? <><Link href={`/admin/skills/${encodeURIComponent(baseline.id)}${contextSuffix}`} className="text-gbrand-text hover:underline">平台版 v{baseline.version}</Link>
          <p className="break-all text-xs text-gtext-muted">平台技能 ID：{baseline.capabilityId} · 版本 ID：{baseline.id}</p>
          <p className="text-xs text-gtext-muted">更新于 {new Date(baseline.updatedAt).toLocaleString('zh-CN')}</p></>
          : <p>{baseline === null ? '尚无已发布平台版本，无平台基线（首次发布）' : '缺少平台基线信息，请刷新预览后再发布'}</p>}
      </section>
      <section aria-label="已存校验结果" className="min-w-0 space-y-3 border-b border-glassline pb-4 text-sm">
        <h2 className="font-medium text-gtext-primary">{validation.label}</h2>
        {validation.issues.length > 0 && <ul aria-label="校验问题" className="list-inside list-disc space-y-1 whitespace-pre-wrap break-words text-gdanger">{validation.issues.map((message, index) => <li key={index}>{message}</li>)}</ul>}
        {validation.warnings.length > 0 && <div><h3 className="mb-1 font-medium text-gtext-secondary">校验提醒</h3><ul aria-label="校验提醒" className="list-inside list-disc space-y-1 whitespace-pre-wrap break-words text-gtext-secondary">{validation.warnings.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      </section>
      <SkillPackageWarnings warnings={version.packageWarnings} />
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="只读正文" className="min-h-[70vh] min-w-0">
          <Tabs value={tab} onValueChange={setTab} className="min-w-0">
            <TabsList className="bg-glass-1">
              <TabsTrigger value="rendered">渲染视图</TabsTrigger>
              <TabsTrigger value="source">Markdown</TabsTrigger>
              <TabsTrigger value="diff">差异预览</TabsTrigger>
            </TabsList>
            <TabsContent value="rendered" className="mt-4 min-w-0">
              <Markdown content={version.content} />
            </TabsContent>
            <TabsContent value="diff" className="mt-4 min-w-0">
              {baseline ? <><p className="mb-3 text-sm text-gtext-muted">当前平台版 v{baseline.version} → 所选{VERSION_TYPE_LABELS[version.scope]} v{version.version}</p>
                <PlatformDiff baseline={baseline.content} content={version.content} /></>
                : <p className="text-sm text-gtext-muted">{baseline === null ? '首次发布，无平台基线；所选正文将作为首个平台版本。' : '平台基线信息缺失，暂不能预览差异。'}</p>}
            </TabsContent>
            <TabsContent value="source" className="mt-4 min-w-0">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-gtext-secondary">
                {version.content}
              </pre>
            </TabsContent>
          </Tabs>
        </section>
        <aside className="min-w-0 space-y-4">
          <Card className="p-5">
            <h2 className="font-medium text-gtext-primary">版本信息</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-gtext-muted">变更说明</dt>
                <dd className="mt-1 text-gtext-secondary">
                  {version.changeSummary ||
                    (!version.parentVersionId && !version.sourceVersionId ? '原始正文' : '未填写')}
                </dd>
              </div>
              {version.parentVersionId && (
                <div>
                  <dt className="text-gtext-muted">版本关系</dt>
                  <dd className="mt-1 text-gtext-secondary">
                    基于父版本派生，需核对本次变更说明与正文是否一致。
                  </dd>
                </div>
              )}
              {version.sourceVersion && <div><dt className="text-gtext-muted">原始来源版本</dt><dd className="mt-1 break-all"><Link href={`/admin/skills/${version.sourceVersion.id}`} className="text-gbrand-text hover:underline">{VERSION_TYPE_LABELS[version.sourceVersion.scope]} v{version.sourceVersion.version}</Link><p className="mt-1 text-xs text-gtext-muted">技能 ID：{version.sourceVersion.capabilityId}</p><p className="mt-1 text-xs text-gtext-muted">版本 ID：{version.sourceVersion.id}</p></dd></div>}
              <div><dt className="text-gtext-muted">包信息</dt><dd className="mt-1 break-all text-gtext-secondary">{version.packageKey ? <><p>{version.packageFilename || version.packageKey}</p><p>文件数：{version.packageFileCount ?? '未标注'}</p><p className="mt-1 font-mono text-xs">SHA256：{version.packageSha256 || '未标注'}</p></> : '无包记录'}</dd></div>
              {version.enterpriseDefaultCount !== undefined && <div><dt className="text-gtext-muted">启用与市场绑定</dt><dd className="mt-1 text-gtext-secondary">企业启用：{version.enterpriseDefaultCount} 家<br />版本绑定：{version.defaultBindingCount ?? 0} 个<br />市场员工绑定：{version.marketBindingCount ?? 0} 个</dd></div>}
              {version.rejectionReason && <div><dt className="text-gtext-muted">驳回原因</dt><dd className="mt-1 break-words text-gdanger">{version.rejectionReason}</dd></div>}
              <div>
                <dt className="text-gtext-muted">更新时间</dt>
                <dd className="mt-1 text-gtext-secondary">
                  {new Date(version.updatedAt).toLocaleString('zh-CN')}
                </dd>
              </div>
            </dl>
          </Card>
          {Boolean(version.reviews?.length) && <section aria-label="审核历史" className="border-y border-glassline py-4"><h2 className="font-medium text-gtext-primary">审核历史</h2><ol className="mt-3 space-y-4 text-sm text-gtext-secondary">{version.reviews?.map((entry) => <li key={entry.id}><p>{entry.actorType === 'PLATFORM' ? '平台' : '企业'} · {entry.decision === 'APPROVE' ? '通过' : '驳回'} · {entry.reviewer.name || entry.reviewer.id}</p><p className="mt-1 text-xs text-gtext-muted">{new Date(entry.createdAt).toLocaleString('zh-CN')}</p>{entry.comment && <p className="mt-1 whitespace-pre-wrap break-words">{entry.comment}</p>}</li>)}</ol></section>}

          {promoted && (
            <Card className="p-5">
              <h2 className="font-medium text-gtext-primary">{publishedSource ? '来源已发布' : '历史平台处理记录'}</h2>
              <p className="mt-2 text-sm text-gtext-secondary">
                平台版 v{promoted.version} · {SKILL_VERSION_STATUS[promoted.status].label}
              </p>
              <Link
                href={`/admin/skills/${promoted.id}`}
                className="mt-3 inline-block text-sm text-gbrand-text hover:underline"
              >
                查看平台版本 →
              </Link>
            </Card>
          )}

          {publishable && (
            <section aria-label="平台发布" className="space-y-3 border-y border-glassline py-4">
              <label htmlFor="skill-publish-summary" className="text-sm text-gtext-secondary">发布说明（可选）</label>
              <textarea
                id="skill-publish-summary"
                value={changeSummary}
                onChange={(event) => setChangeSummary(event.target.value)}
                maxLength={2000}
                disabled={publish.isPending}
                rows={4}
                placeholder="本次平台发布的变更说明"
                className="mt-3 w-full resize-none rounded-md border border-glassline bg-glass-1 p-3 text-sm text-gtext-primary focus:outline-none focus:ring-2 focus:ring-gbrand-ring"
              />
              <p className="text-xs leading-5 text-gtext-muted">缺少结构段落仅作提示；发布时将重新检查正文、敏感凭据与能力包一致性，硬错误会阻止发布。</p>
              {!version.content.trim() && <p className="text-sm text-gdanger">技能正文不能为空，不能发布。</p>}
              <Button variant="glass-primary" className="w-full" disabled={publish.isPending || query.isFetching || baseline === undefined || !version.content.trim()}
                onClick={() => setConfirmation({ version, changeSummary: changeSummary.trim() || undefined })}>
                <Upload className="h-4 w-4" />发布为平台版本
              </Button>
            </section>
          )}
        </aside>
      </div>
      <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !publish.isPending) setConfirmation(null); }}>
        <DialogContent glass className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto">
          <DialogHeader><DialogTitle>发布为平台版本</DialogTitle><DialogDescription>确认发布所选精确版本？</DialogDescription></DialogHeader>
          {confirmation && <div className="min-w-0 space-y-3 text-sm text-gtext-secondary">
            <p className="break-words">来源：{confirmation.version.capability.name} · {VERSION_TYPE_LABELS[confirmation.version.scope]} v{confirmation.version.version}</p>
            <p className="break-words">来源企业：{confirmation.version.enterprise?.name ?? '无企业归属'}</p>
            <p className="break-all text-xs text-gtext-muted">来源版本 ID：{confirmation.version.id}</p>
            <p>当前平台版本：{confirmation.version.currentPlatformVersion ? `v${confirmation.version.currentPlatformVersion.version}` : '无（首次发布）'}</p>
            <p className="leading-6">发布后将更新平台执行正文和原本使用平台版本的员工模板绑定。私有来源将发布到独立的平台能力，企业原能力不会公开；企业审核状态、企业默认版本与企业订阅选版保持不变。</p>
            {confirmation.changeSummary && <p className="whitespace-pre-wrap break-words">发布说明：{confirmation.changeSummary}</p>}
          </div>}
          <DialogFooter><Button variant="glass" disabled={publish.isPending} onClick={() => setConfirmation(null)}>取消</Button>
            <Button variant="glass-primary" loading={publish.isPending} disabled={publish.isPending} onClick={runPublish}><Upload className="h-4 w-4" />确认发布</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlatformDiff({ baseline, content }: { baseline: string; content: string }) {
  const rows = useMemo(() => diffLines(baseline, content), [baseline, content]);
  if (baseline === content) return <p className="text-sm text-gtext-muted">与当前平台版本正文相同</p>;
  return <section aria-label="正文差异" className="max-h-[60dvh] min-w-0 overflow-auto bg-glass-1 font-mono text-xs leading-6">
    {rows.map((row, index) => <div key={`${index}-${row.type}`} className={`whitespace-pre-wrap break-words px-3 ${row.type === 'added' ? 'bg-gsuccess/10 text-gsuccess' : row.type === 'removed' ? 'bg-gdanger/10 text-gdanger' : 'text-gtext-muted'}`}>
      {row.type === 'gap' ? '...' : `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${row.text}`}
    </div>)}
  </section>;
}
