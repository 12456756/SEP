'use client';

import { useState } from 'react';
import { ArrowLeft, Download, Eye, FileCode2, GitCompareArrows, History, LockKeyhole, Plus, Send, Trophy, UsersRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState } from '@/components/ui/feedback';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/lib/auth-store';
import { downloadFile } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { ContributionCapability, ContributionCapabilityDetail } from '@/lib/types';
import { TYPE_META, currentContributionState, toneClasses } from './contribution-status';
import { buildPipeline, pipelineStepLabel, pipelineWaitLabel, type PipelineModel, type StageAction } from './pipeline-model';
import { PipelineMiniTrack } from './components/pipeline-mini-track';
import { PipelineTimeline } from './components/pipeline-timeline';
import { RejectReasonDialog } from './components/reject-reason-dialog';
import { VersionPublishDialog } from './components/version-publish-dialog';
import { VersionEditDialog } from './components/version-edit-dialog';
import { useContribution, useContributionAction, useContributionUsage, useReviewContribution, useSubmitVersion, useVersionDiff } from './use-contributions';
import { SkillVersionPreviewDialog } from '@/features/skill-version/SkillVersionPreviewDialog';
import { SKILL_VERSION_STATUS } from '@/features/skill-version/status';

export function ContributionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const query = useContribution(id);
  if (query.isLoading) return <CenteredSpinner label="加载能力详情..." />;
  if (query.isError || !query.data) return <EmptyState title="详情加载失败" description="请稍后重试，或重新选择一个能力。" />;
  return <ContributionDetailContent contribution={query.data} onBack={onBack} />;
}

type DetailView = 'pipeline' | 'versions' | 'usage' | 'profile' | 'rewards';

function ContributionDetailContent({ contribution, onBack }: { contribution: ContributionCapabilityDetail; onBack: () => void }) {
  const [view, setView] = useState<DetailView>('pipeline');
  const [previewVersionId, setPreviewVersionId] = useState('');
  const [editVersionId, setEditVersionId] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rpaDownloading, setRpaDownloading] = useState(false);
  const usage = useContributionUsage(contribution.id);
  const isEnterpriseAdmin = useAuthStore((s) => s.roleInEnterprise) === 'ENTERPRISE_ADMIN';
  const hasEnterprise = Boolean(useAuthStore((s) => s.enterprise));
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isContributor = currentUserId === contribution.contributor.id;
  const canWriteSkill = contribution.type !== 'SKILL';
  const submitEnterprise = useContributionAction('submit-enterprise-review', contribution.type);
  const requestPlatform = useContributionAction('request-platform-review', contribution.type);
  const authorizePlatform = useContributionAction('authorize-platform-submission', contribution.type);
  const enterpriseReview = useReviewContribution('enterprise', contribution.type);
  const state = currentContributionState(contribution);
  const loading = submitEnterprise.isPending || requestPlatform.isPending || authorizePlatform.isPending || enterpriseReview.isPending;

  const downloadRpa = async () => {
    setRpaDownloading(true);
    try {
      const versionId = contribution.rpaVersions?.[0]?.id;
      if (!versionId) throw new Error('暂无可下载的 RPA 审核版本');
      const result = await downloadFile(`/contributions/${contribution.id}/rpa-package?versionId=${encodeURIComponent(versionId)}`);
      toast.success('RPA 包下载成功', result.sha256 ? `SHA-256：${result.sha256}` : undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败，请稍后重试');
    } finally {
      setRpaDownloading(false);
    }
  };

  const model = buildPipeline(contribution, { hasEnterprise, isContributor, isEnterpriseAdmin });

  const run = (
    fn: { mutate: (id: string, options: { onSuccess: () => void; onError: (error: unknown) => void }) => void },
    message: string,
  ) => {
    fn.mutate(contribution.id, {
      onSuccess: () => toast.success(message),
      onError: (error) => toast.error(error instanceof Error ? error.message : '操作失败'),
    });
  };

  const approve = () => {
    enterpriseReview.mutate({ id: contribution.id, decision: 'APPROVE' }, {
      onSuccess: () => toast.success('企业审核已通过'),
      onError: (error) => toast.error(error instanceof Error ? error.message : '审核失败'),
    });
  };

  const reject = (comment: string) => {
    enterpriseReview.mutate({ id: contribution.id, decision: 'REJECT', comment }, {
      onSuccess: () => { setRejectOpen(false); toast.success('企业审核已驳回'); },
      onError: (error) => toast.error(error instanceof Error ? error.message : '审核失败'),
    });
  };

  const onStageAction = (action: StageAction) => {
    if (contribution.type === 'SKILL') return;
    if (action === 'submit-enterprise') return run(submitEnterprise, '已提交企业审核');
    if (action === 'request-platform') return run(requestPlatform, hasEnterprise ? '已申请公开投稿，等待企业管理员授权' : '已提交平台审核');
    if (action === 'authorize-platform') return run(authorizePlatform, '已授权提交平台审核');
    if (action === 'approve') return approve();
    if (action === 'reject') return setRejectOpen(true);
  };

  return <div className="flex h-full min-h-0 flex-col bg-gbg-canvas">
    <header className="shrink-0 border-b border-glassline px-6 py-5 xl:px-10">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-2 text-xs text-gtext-muted transition-colors hover:text-gtext-primary"><ArrowLeft className="h-3.5 w-3.5" />返回能力资产总览</button>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><TypeBadge item={contribution} /><Badge className={cn('rounded-glass-pill border', toneClasses[state.tone])}>{state.label}</Badge><span className="text-xs text-gtext-muted">更新于 {new Date(contribution.updatedAt).toLocaleDateString('zh-CN')}</span></div><h2 className="mt-2 truncate text-2xl font-semibold text-gtext-primary">{contribution.name}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-gtext-secondary">{contribution.description}</p></div>
        <ProgressSummary model={model} />
      </div>
      <nav aria-label="能力详情视图" className="mt-6 flex gap-6 border-b border-glassline"><DetailTab active={view === 'pipeline'} onClick={() => setView('pipeline')}>发布流程</DetailTab>{contribution.type === 'SKILL' && <DetailTab active={view === 'versions'} onClick={() => setView('versions')}>版本迭代</DetailTab>}<DetailTab active={view === 'usage'} onClick={() => setView('usage')}>使用情况</DetailTab><DetailTab active={view === 'profile'} onClick={() => setView('profile')}>能力档案</DetailTab><DetailTab active={view === 'rewards'} onClick={() => setView('rewards')}>贡献奖励</DetailTab></nav>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto scroll-thin px-6 py-7 xl:px-10"><div className="mx-auto max-w-5xl">
      {view === 'pipeline' && <PipelineView model={model} loading={loading} onAction={onStageAction} />}
      {view === 'versions' && <VersionView contribution={contribution} isContributor={isContributor} canWrite={canWriteSkill} onPreview={setPreviewVersionId} onEdit={setEditVersionId} onPublish={() => setPublishOpen(true)} />}
      {view === 'usage' && <UsageView query={usage} />}
      {view === 'profile' && <ProfileView contribution={contribution} onDownloadRpa={downloadRpa} rpaDownloading={rpaDownloading} />}
      {view === 'rewards' && <RewardsView contribution={contribution} />}
    </div></main>
    {/* source='author'：贡献中心按 contributorId 授权。走企业侧那条会必然 403 ——
        刚贡献的能力没有员工绑定，assertCapabilityGrant 找不到授权订阅。 */}
    <SkillVersionPreviewDialog source="author" versionId={previewVersionId} open={Boolean(previewVersionId)} onOpenChange={(open) => !open && setPreviewVersionId('')} />
    <VersionPublishDialog capabilityId={contribution.id} open={publishOpen} onOpenChange={setPublishOpen} />
    <VersionEditDialog capabilityId={contribution.id} versionId={editVersionId} onOpenChange={setEditVersionId} />
    <RejectReasonDialog open={rejectOpen} capabilityName={contribution.name} loading={enterpriseReview.isPending} onOpenChange={setRejectOpen} onConfirm={reject} />
  </div>;
}

/** header 右侧的进度摘要：第 N/M 步 + 谁在处理，取代原来的百分比与 ActionBar */
function ProgressSummary({ model }: { model: PipelineModel }) {
  const wait = pipelineWaitLabel(model);
  return (
    <div className={cn('shrink-0 rounded-glass-lg border bg-glass-1 px-4 py-3 shadow-glass-sm', model.ballInCourt ? 'border-glassline-brand' : 'border-glassline')}>
      <p className="text-xs font-medium text-gtext-primary">{pipelineStepLabel(model)}</p>
      {wait && <p className={cn('mt-1 text-[11px]', model.ballInCourt ? 'text-gbrand-text' : 'text-gtext-muted')}>{wait}</p>}
      <PipelineMiniTrack model={model} showLabels={false} className="mt-2.5 w-[180px]" />
    </div>
  );
}

function DetailTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className={cn('relative pb-3 text-sm transition-colors', active ? 'font-semibold text-gtext-primary after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-gbrand' : 'text-gtext-muted hover:text-gtext-secondary')}>{children}</button>; }

function PipelineView({ model, loading, onAction }: { model: PipelineModel; loading: boolean; onAction: (action: StageAction) => void }) {
  return (
    <section className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text">Release pipeline</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-lg font-semibold text-gtext-primary">发布流程</h3>
        <span className="text-sm text-gtext-muted">{pipelineStepLabel(model)}</span>
      </div>
      <p className="mt-1 text-sm text-gtext-secondary">每一步由谁处理都会记录下来；轮到你的时候，按钮就在对应节点上。</p>
      <PipelineTimeline model={model} loading={loading} onAction={onAction} />
    </section>
  );
}

function ProfileView({ contribution, onDownloadRpa, rpaDownloading }: { contribution: ContributionCapabilityDetail; onDownloadRpa: () => void; rpaDownloading: boolean }) {
  const version = contribution.skillVersions[0];
  const rpaVersion = contribution.rpaVersions?.[0];
  return <section className="max-w-3xl"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text">Capability profile</p><h3 className="mt-1 text-lg font-semibold text-gtext-primary">能力档案</h3><p className="mt-1 text-sm text-gtext-secondary">能力的归属、版本和可见范围。</p><div className="mt-6 divide-y divide-glassline border-y border-glassline"><ProfileRow label="贡献者" value={contribution.contributor.name || contribution.contributor.email} /><ProfileRow label="归属工作区" value={contribution.enterprise?.name || '个人贡献'} /><ProfileRow label="当前版本" value={contribution.type === 'RPA' ? rpaVersion ? `v${rpaVersion.version}` : '暂无版本' : version ? `v${version.version}` : '暂无版本'} /><ProfileRow label="可见范围" value={contribution.visibility === 'MARKET_PUBLIC' ? '元机AI人才市场' : '企业私有'} /><ProfileRow label="累计调用" value={`${contribution.usageCount} 次`} /><ProfileRow label="绑定员工" value={`${contribution._count.bindings} 个`} /></div>{contribution.type === 'RPA' && contribution.rpaConfig && <div className="mt-6 rounded-glass-lg border border-glassline bg-glass-1 p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold text-gtext-primary">RPA 下载包</p><p className="mt-1 text-xs text-gtext-muted">{contribution.rpaConfig.platform === 'SHIZAI' ? '实在智能' : '影刀'} · 仅下载模式 · 审核通过后可用</p></div><Button type="button" variant="glass" size="sm" loading={rpaDownloading} loadingText="下载中…" onClick={onDownloadRpa}><Download className="h-4 w-4" />下载 ZIP</Button></div><p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-gtext-secondary">{contribution.rpaConfig.configDoc || '暂无使用说明'}</p></div>}</section>;
}

function ProfileRow({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-6 py-4 text-sm"><span className="text-gtext-muted">{label}</span><span className="font-medium text-gtext-primary">{value}</span></div>; }

function RewardsView({ contribution }: { contribution: ContributionCapabilityDetail }) { const points = contribution.contributionRewards.reduce((sum, item) => sum + item.points, 0); return <section className="max-w-3xl"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text">Contribution reward</p><h3 className="mt-1 text-lg font-semibold text-gtext-primary">贡献奖励</h3><p className="mt-1 text-sm text-gtext-secondary">奖励将在审核与市场采用节点达成后持续累积。</p><div className="mt-6 flex items-end justify-between rounded-glass-lg border border-gwarning/25 bg-gwarning/[0.08] px-5 py-6"><div><p className="text-4xl font-semibold text-gtext-primary">{points}</p><p className="mt-2 text-sm text-gtext-muted">累计待确认积分</p></div><Trophy className="h-7 w-7 text-gwarning" /></div><div className="mt-6 divide-y divide-glassline border-y border-glassline">{contribution.contributionRewards.length ? contribution.contributionRewards.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 py-4"><div><p className="text-sm font-medium text-gtext-primary">{item.eventType}</p><p className="mt-1 text-xs text-gtext-muted">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</p></div><span className="font-semibold text-gsuccess">+{item.points} 积分</span></div>) : <div className="flex items-center gap-2 py-6 text-sm text-gtext-muted"><LockKeyhole className="h-4 w-4" />审核通过后记录奖励事件</div>}</div></section>; }

function VersionView({ contribution, isContributor, canWrite, onPreview, onEdit, onPublish }: { contribution: ContributionCapabilityDetail; isContributor: boolean; canWrite: boolean; onPreview: (id: string) => void; onEdit: (id: string) => void; onPublish: () => void }) {
  const versions = contribution.skillVersions;
  const submit = useSubmitVersion(contribution.id);
  const [submittingId, setSubmittingId] = useState('');
  const [downloadingId, setDownloadingId] = useState('');
  const [diffVersionId, setDiffVersionId] = useState('');
  const diffQuery = useVersionDiff(diffVersionId);

  const downloadVersion = async (versionId: string) => {
    setDownloadingId(versionId);
    try {
      const result = await downloadFile(`/contributions/versions/${versionId}/package`);
      toast.success('Skill 包下载成功', result.sha256 ? `SHA-256：${result.sha256}` : undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败，请稍后重试');
    } finally {
      setDownloadingId('');
    }
  };

  const submitVersion = (versionId: string) => {
    setSubmittingId(versionId);
    submit.mutate(versionId, {
      onSuccess: () => toast.success('已提交审核', '进度会在发布流程里更新'),
      onError: (error) => toast.error(error instanceof Error ? error.message : '提交失败，请稍后重试'),
      onSettled: () => setSubmittingId(''),
    });
  };

  return (
    <section className="max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text">Skill versions</p>
          <h3 className="mt-1 text-lg font-semibold text-gtext-primary">版本迭代</h3>
          <p className="mt-1 text-sm text-gtext-secondary">
            {contribution.type === 'SKILL' ? 'SKILL 正文与版本由客户端维护；这里仅查看已上传记录、差异和审核状态。' : contribution.visibility === 'MARKET_PUBLIC'
              ? '能力已公开。继续迭代会派生新版本，审核通过后替换当前公开版本。'
              : '在这里查看 Skill 的版本路线、审核状态和正文。'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gtext-muted">{versions.length} 个版本</span>
          {isContributor && canWrite && (
            <Button variant="glass-primary" size="sm" onClick={onPublish}>
              <Plus className="h-4 w-4" />
              发布新版本
            </Button>
          )}
        </div>
      </div>
      {versions.length ? (
        <div className="mt-6 space-y-3">
          {versions.map((version, index) => (
            <VersionCard
              key={version.id}
              version={version}
              latest={index === 0}
              isContributor={isContributor && canWrite}
              submitting={submittingId === version.id}
              downloading={downloadingId === version.id}
              onDownload={() => downloadVersion(version.id)}
              onPreview={() => onPreview(version.id)}
              onEdit={() => onEdit(version.id)}
              onSubmit={() => submitVersion(version.id)}
              showingDiff={diffVersionId === version.id}
              onDiff={() => setDiffVersionId((current) => current === version.id ? '' : version.id)}
            />
          ))}
          {diffVersionId && (
            <VersionDiffPanel query={diffQuery} />
          )}
        </div>
      ) : (
        <div className="mt-6 rounded-glass-lg border border-dashed border-glassline px-5 py-10 text-center text-sm text-gtext-muted">
          还没有 Skill 版本
        </div>
      )}
    </section>
  );
}

type DetailVersion = ContributionCapabilityDetail['skillVersions'][number];

function VersionCard({ version, latest, isContributor, submitting, downloading, showingDiff, onDownload, onPreview, onEdit, onSubmit, onDiff }: { version: DetailVersion; latest: boolean; isContributor: boolean; submitting: boolean; downloading: boolean; showingDiff: boolean; onDownload: () => void; onPreview: () => void; onEdit: () => void; onSubmit: () => void; onDiff: () => void }) {
  const meta = SKILL_VERSION_STATUS[version.status];
  // 草稿与被驳回都可以再动。PLATFORM_REJECTED 以前漏了 —— 平台驳回后个人贡献者无路可走。
  const reworkable = version.status === 'DRAFT' || version.status === 'ENTERPRISE_REJECTED' || version.status === 'PLATFORM_REJECTED';
  // 正文来自包的版本不给行内编辑：包才是它的正文来源，要改就发新版本。
  const inlineEditable = reworkable && !version.packageKey;
  const original = !version.parentVersionId && !version.sourceVersionId;

  return (
    <article className={cn('relative rounded-glass-lg border p-4 shadow-glass-sm transition-colors duration-200', latest ? 'border-glassline-brand bg-glass-accent-2' : 'border-glassline bg-glass-1')}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gtext-primary">v{version.version}</span>
            {latest && <Badge className="rounded-glass-pill border border-glassline-brand bg-gbrand/10 text-gbrand-text">最新</Badge>}
            {original && <Badge variant="glass-info">原始版本</Badge>}
            <Badge className={meta.className}>{meta.label}</Badge>
            {version.packageKey && <Badge variant="glass-info">SKILL 包</Badge>}
          </div>
          <p className="mt-2 text-sm text-gtext-secondary">
            {version.changeSummary || (original ? '技能原始正文，后续版本从此版本派生。' : '未填写变更说明。')}
          </p>
          <p className="mt-2 text-xs text-gtext-muted">
            {version.scope === 'PLATFORM' ? '平台版本' : '企业版本'}
            {version.packageFilename ? ` · ${version.packageFilename}` : ''}
            {version.packageFileCount ? ` · ${version.packageFileCount} 个文件` : ''}
            {' · 更新于 '}{new Date(version.updatedAt).toLocaleDateString('zh-CN')}
          </p>
          {version.rejectionReason && (
            <div className="mt-2 rounded-glass-md border border-gdanger/28 bg-gdanger/10 px-3 py-2 text-xs leading-5 text-gtext-primary">
              <p>驳回原因：{version.rejectionReason}</p>
              {isContributor && reworkable && <p className="mt-1 text-gtext-secondary">修正正文或上传新包后，可从此版本重新提交审核。</p>}
            </div>
          )}
          {version.packageKey && isContributor && reworkable && (
            <p className="mt-2 text-xs text-gtext-muted">上传包版本不可原地修改；上传新包会创建一个新的修订版本。</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="glass" size="sm" onClick={onDiff}>
            <GitCompareArrows className="h-4 w-4" />{showingDiff ? '收起变更' : '查看变更'}
          </Button>
          <Button variant="glass" size="sm" onClick={onPreview}><Eye className="h-4 w-4" />预览</Button>
          {version.packageKey && (
            <Button variant="glass" size="sm" loading={downloading} onClick={onDownload}>
              <Download className="h-4 w-4" />
              下载包
            </Button>
          )}
          {isContributor && inlineEditable && (
            <Button variant="glass" size="sm" onClick={onEdit}>
              <FileCode2 className="h-4 w-4" />
              编辑
            </Button>
          )}
          {isContributor && reworkable && (
            <Button variant="glass-primary" size="sm" loading={submitting} onClick={onSubmit}>
              <Send className="h-4 w-4" />
              提交审核
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}


function VersionDiffPanel({ query }: { query: ReturnType<typeof useVersionDiff> }) {
  if (query.isLoading) return <div className="rounded-glass-lg border border-glassline bg-glass-1 px-5 py-8 text-center text-sm text-gtext-muted">正在加载版本变更...</div>;
  if (query.isError || !query.data) return <div className="rounded-glass-lg border border-gdanger/25 bg-gdanger/10 px-5 py-5 text-sm text-gdanger">版本变更暂时无法加载，请稍后重试。</div>;
  const diff = query.data;
  return (
    <section className="rounded-glass-lg border border-glassline-brand bg-glass-accent-2 p-5" aria-label="版本变更与审核历史">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text"><GitCompareArrows className="h-4 w-4" />Version diff</p>
          <h4 className="mt-1 text-base font-semibold text-gtext-primary">v{diff.version.version} 变更与审核历史</h4>
          {diff.version.changeSummary && <p className="mt-1 text-sm text-gtext-secondary">{diff.version.changeSummary}</p>}
        </div>
        <Badge className={diff.changed ? 'border-gwarning/30 bg-gwarning/10 text-gwarning' : 'border-gsuccess/30 bg-gsuccess/10 text-gsuccess'}>{diff.changed ? '内容已变化' : '内容未变化'}</Badge>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <DiffContent title={diff.parent ? `父版本 v${diff.parent.version}` : '无父版本'} content={diff.parent?.content || '这是首个版本，没有可对比的父版本。'} muted={!diff.parent} />
        <DiffContent title={`当前版本 v${diff.current.version}`} content={diff.current.content} />
      </div>
      {diff.version.rejectionReason && <div className="mt-4 rounded-glass-md border border-gdanger/25 bg-gdanger/10 px-3 py-2 text-sm text-gtext-primary"><strong>当前驳回原因：</strong>{diff.version.rejectionReason}</div>}
      <div className="mt-5 border-t border-glassline pt-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-gtext-primary"><History className="h-4 w-4 text-gbrand-text" />审核历史</p>
        {diff.reviews.length ? <div className="mt-3 space-y-2">{diff.reviews.map((review) => <div key={review.id} className="flex flex-wrap items-center justify-between gap-2 rounded-glass-md border border-glassline bg-glass-1 px-3 py-2 text-xs"><span className="font-medium text-gtext-primary">{review.actorType === 'ENTERPRISE' ? '企业审核' : '平台审核'} · {review.decision === 'APPROVE' ? '通过' : '驳回'}</span><span className="text-gtext-muted">{review.reviewer?.name || review.reviewer?.email || review.reviewerId} · {new Date(review.createdAt).toLocaleString('zh-CN')}</span>{review.comment && <p className="basis-full text-gtext-secondary">{review.comment}</p>}</div>)}</div> : <p className="mt-3 text-xs text-gtext-muted">暂无版本级审核记录。</p>}
      </div>
    </section>
  );
}

function DiffContent({ title, content, muted = false }: { title: string; content: string; muted?: boolean }) {
  return <div className="min-w-0 rounded-glass-md border border-glassline bg-glass-1 p-3"><p className="text-xs font-semibold text-gtext-secondary">{title}</p><pre className={cn('mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-glass-sm bg-black/10 p-3 text-xs leading-5', muted ? 'text-gtext-muted' : 'text-gtext-primary')}>{content}</pre></div>;
}

function UsageView({ query }: { query: ReturnType<typeof useContributionUsage> }) {
  if (query.isLoading) return <div className="flex min-h-56 items-center justify-center text-sm text-gtext-muted">正在读取能力使用情况...</div>;
  if (query.isError || !query.data) return <div className="rounded-glass-lg border border-dashed border-glassline px-5 py-10 text-center text-sm text-gdanger">使用情况暂时无法加载，请稍后重试。</div>;
  const { employees } = query.data;
  return <section className="max-w-5xl"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-gbrand-text">Runtime adoption</p><h3 className="mt-1 text-lg font-semibold text-gtext-primary">使用情况</h3><p className="mt-1 text-sm text-gtext-secondary">查看哪些硅基员工正在使用这项能力，以及实际生效的版本。</p></div><span className="text-sm text-gtext-muted">{query.data.totalBindings} 个员工</span></div>{employees.length ? <div className="mt-6 divide-y divide-glassline border-y border-glassline">{employees.map((employee) => <div key={employee.employeeId} className="grid gap-3 py-4 md:grid-cols-[minmax(180px,1fr)_170px_150px_120px] md:items-center"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-glass-md border border-glassline bg-glass-1 text-gbrand-text"><UsersRound className="h-4 w-4" /></span><div><p className="text-sm font-medium text-gtext-primary">{employee.employeeName}</p><p className="mt-1 text-xs text-gtext-muted">{employee.usageCount} 次能力调用</p></div></div><VersionCell label="选定版本" version={employee.selectedVersion?.version ? `v${employee.selectedVersion.version}` : '跟随默认'} /><VersionCell label="实际生效" version={employee.effectiveVersion?.version ? `v${employee.effectiveVersion.version}` : '暂无可用版本'} /><div className="text-left md:text-right"><p className="text-xs text-gtext-muted">最近使用</p><p className="mt-1 text-xs text-gtext-secondary">{employee.lastUsedAt ? new Date(employee.lastUsedAt).toLocaleDateString('zh-CN') : '尚未使用'}</p></div></div>)}</div> : <div className="mt-6 rounded-glass-lg border border-dashed border-glassline px-5 py-12 text-center"><UsersRound className="mx-auto h-6 w-6 text-gtext-muted" /><p className="mt-3 text-sm font-medium text-gtext-primary">尚未被硅基员工使用</p><p className="mt-1 text-xs text-gtext-muted">能力通过审核并绑定到员工后，会在这里看到运行情况。</p></div>}</section>;
}

function VersionCell({ label, version }: { label: string; version: string }) { return <div><p className="text-xs text-gtext-muted">{label}</p><p className="mt-1 text-sm font-medium text-gtext-primary">{version}</p></div>; }

function TypeBadge({ item }: { item: ContributionCapability }) { return <Badge variant="glass-info">{TYPE_META[item.type].label}</Badge>; }
