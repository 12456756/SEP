'use client';

import { useState } from 'react';
import { Image, RefreshCw, ScanSearch, Save, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { MediaConnection, MediaProfile } from './use-media-config';
import type { MediaVideoProfile } from './use-video-config';
import type { UpdateMediaConnectionDto } from 'shared/media.dto';
import { effectiveImageLimits } from 'shared/media-runtime-parameters';
import { MediaProfileWorkflow } from './media-profile-workflow';

type ProfileStatus = MediaProfile | MediaVideoProfile;
interface DiscoveryModel { modelId: string; displayName: string; compatible: boolean; reason: string | null }
interface Props {
  kind: 'image' | 'video';
  connection: { data?: MediaConnection; isLoading: boolean; error: Error | null; refetch: () => Promise<unknown> };
  save: { isPending: boolean; mutateAsync: (dto: UpdateMediaConnectionDto) => Promise<unknown> };
  discovery: {
    data?: { checkedAt: string; models: DiscoveryModel[]; mock?: boolean };
    error: Error | null; isPending: boolean; reset: () => void; mutate: () => void;
  };
  profiles: { data?: ProfileStatus[]; isLoading: boolean; error: Error | null };
  updating: boolean;
  onDisable: (profile: ProfileStatus) => Promise<unknown>;
}
const errorText = (error: unknown) => error instanceof ApiError ? error.message : '请求失败，请稍后重试';
const sourceLabels = { database: '后台保存', environment: '环境变量', unconfigured: '未配置' };
const list = (values: readonly (string | number)[] | undefined) => values?.length ? values.join('、') : '未提供';
const yesNo = (value: boolean | undefined) => value === undefined ? '未提供' : value ? '支持' : '不支持';

function ProfileCapabilities({ profile }: { profile: ProfileStatus }) {
  if (profile.kind === 'image') {
    const { capabilities } = profile;
    const limits = effectiveImageLimits(capabilities);
    return <><p className="mt-3 text-xs text-fg-muted">尺寸、质量为配置声明的建议选项；数量为当前执行上限；未执行生成验证。</p><dl className="mt-2 grid min-w-0 gap-x-5 gap-y-1 text-xs sm:grid-cols-2">
      <div><dt className="inline text-fg-muted">操作：</dt><dd className="inline break-words">{list(profile.operations)}</dd></div>
      <div><dt className="inline text-fg-muted">尺寸：</dt><dd className="inline break-words">{list(capabilities.sizes)}</dd></div>
      <div><dt className="inline text-fg-muted">质量：</dt><dd className="inline break-words">{list(capabilities.qualities)}</dd></div>
      <div><dt className="inline text-fg-muted">最大输出数量：</dt><dd className="inline">{Math.min(1, limits.maxOutputs)}</dd></div>
      <div><dt className="inline text-fg-muted">参考图：</dt><dd className="inline">{yesNo(capabilities.supportsReferenceImage)}</dd></div>
      <div><dt className="inline text-fg-muted">最大参考图数量：</dt><dd className="inline">{Math.min(4, limits.maxReferenceCount)}</dd></div>
      <div><dt className="inline text-fg-muted">输出尺寸 / 字节上限：</dt><dd className="inline">未提供</dd></div>
    </dl></>;
  }
  const { capabilities } = profile;
  return <><p className="mt-3 text-xs text-fg-muted">能力提示来源：Profile 配置声明；更新时间：未知；验证程度：声明，未执行生成验证，不作为规格白名单。</p><dl className="mt-2 grid min-w-0 gap-x-5 gap-y-1 text-xs sm:grid-cols-2">
    <div><dt className="inline text-fg-muted">操作：</dt><dd className="inline break-words">{list(profile.operations)}</dd></div>
    <div><dt className="inline text-fg-muted">时长（秒）：</dt><dd className="inline break-words">{capabilities.durationRange
      ? `${capabilities.durationRange.minimum} 至 ${capabilities.durationRange.maximum}` : list(capabilities.durationsSeconds)}</dd></div>
    <div><dt className="inline text-fg-muted">画幅：</dt><dd className="inline break-words">{list(capabilities.aspectRatios)}</dd></div>
    <div><dt className="inline text-fg-muted">分辨率：</dt><dd className="inline break-words">{list(capabilities.resolutions)}</dd></div>
    <div><dt className="inline text-fg-muted">帧率：</dt><dd className="inline break-words">{list(capabilities.frameRates)}</dd></div>
    <div><dt className="inline text-fg-muted">音频：</dt><dd className="inline">{yesNo(capabilities.supportsAudio)}</dd></div>
    <div><dt className="inline text-fg-muted">任务查询：</dt><dd className="inline">{yesNo(capabilities.supportsTaskQuery)}</dd></div>
    <div><dt className="inline text-fg-muted">取消：</dt><dd className="inline">{yesNo(capabilities.supportsCancel)}</dd></div>
    <div><dt className="inline text-fg-muted">参考图数量：</dt><dd className="inline">{capabilities.maxReferenceCount}</dd></div>
    <div><dt className="inline text-fg-muted">参考输入字节上限：</dt><dd className="inline">{capabilities.maxInputBytes.toLocaleString()} 字节</dd></div>
    {capabilities.supportsVideoToVideo && <>
      <div><dt className="inline text-fg-muted">参考视频数量：</dt><dd className="inline">{capabilities.maxVideoReferenceCount}</dd></div>
      <div><dt className="inline text-fg-muted">参考视频上限：</dt><dd className="inline">{(capabilities.maxVideoReferenceBytes ?? 0) / 1024 / 1024} MiB / 个</dd></div>
      <div><dt className="inline text-fg-muted">参考视频格式：</dt><dd className="inline break-words">{list(capabilities.videoReferenceMimeTypes)}</dd></div>
    </>}
    <div><dt className="inline text-fg-muted">输出尺寸 / 字节上限：</dt><dd className="inline">未提供</dd></div>
    <div><dt className="inline text-fg-muted">输出格式：</dt><dd className="inline break-words">{list(capabilities.outputFormats)}</dd></div>
    <div><dt className="inline text-fg-muted">结果保留：</dt><dd className="inline">{capabilities.resultRetentionSeconds} 秒</dd></div>
    <div><dt className="inline text-fg-muted">音频模式：</dt><dd className="inline">未提供</dd></div>
  </dl></>;
}

export function MediaModelsPanelView({ kind, connection, save, discovery, profiles, updating, onDisable }: Props) {
  const name = kind === 'image' ? '图片' : '视频';
  const Icon = kind === 'image' ? Image : Video;
  const [draft, setDraft] = useState<{ baseUrl: string; apiKey: string } | null>(null);
  const form = draft ?? { baseUrl: connection.data?.baseUrl ?? '', apiKey: '' };
  const dirty = draft !== null;
  const [saveError, setSaveError] = useState('');
  const busy = save.isPending || discovery.isPending || updating;
  const edit = (field: 'baseUrl' | 'apiKey', value: string) => {
    setDraft({ ...form, [field]: value });
    discovery.reset();
    setSaveError('');
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setSaveError('');
    discovery.reset();
    try {
      await save.mutateAsync(form);
      setDraft(null);
      toast.success(`${name}连接已保存，请检测并同步模型`);
    } catch (error) { setSaveError(errorText(error)); }
  };
  const disable = async (profile: ProfileStatus) => {
    try { await onDisable(profile); toast.success(`${profile.displayName} 已停用`); }
    catch (error) { toast.error(errorText(error)); }
  };
  const saved = profiles.data ?? [];
  const found = discovery.data?.models;
  const candidates = (found ?? []).filter((model) => !saved.some((profile) => profile.modelId === model.modelId));

  return <section aria-labelledby={`${kind}-models-title`} className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-center gap-2">
      <Icon className="h-4 w-4"/><h2 id={`${kind}-models-title`} className="text-base font-semibold">{name}模型</h2>
      {connection.data && <><Badge variant={connection.data.configured ? 'default' : 'secondary'}>{connection.data.configured ? '已配置' : '未配置'}</Badge>
        <span className="text-xs text-fg-muted">来源：{sourceLabels[connection.data.source ?? 'unconfigured']}</span></>}
    </header>
    <form onSubmit={submit} className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">Base URL</span>
        <Input required type="url" disabled={busy} value={form.baseUrl} onChange={(event) => edit('baseUrl', event.target.value)}/></label>
      <label className="min-w-0 text-sm"><span className="mb-1 block font-medium">管理员校验 API Key {connection.data?.apiKeyConfigured && <span className="text-fg-muted">(已保存，留空不修改)</span>}</span>
        <Input type="password" autoComplete="new-password" disabled={busy} value={form.apiKey} onChange={(event) => edit('apiKey', event.target.value)}/></label>
      <Button type="submit" loading={save.isPending} disabled={busy}><Save className="h-4 w-4"/>保存连接</Button>
      {dirty && <p className="text-sm text-fg-muted sm:col-span-3">请先保存连接，再检测模型。</p>}
      {saveError && <p role="alert" className="break-words text-sm text-danger sm:col-span-3">{saveError}</p>}
      {connection.error && <div className="flex flex-wrap items-center gap-2 text-sm text-danger sm:col-span-3">
        <span role="alert">连接状态读取失败：{errorText(connection.error)}。可填写完整新连接后保存。</span>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void connection.refetch()}><RefreshCw className="h-4 w-4"/>重试</Button></div>}
      {connection.isLoading && <p role="status" className="text-sm text-fg-muted sm:col-span-3">正在读取连接状态</p>}
    </form>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">已同步模型</h3>
      <Button variant="outline" size="sm" loading={discovery.isPending} disabled={busy || dirty || !connection.data?.configured || !!connection.error}
        onClick={() => discovery.mutate()}><ScanSearch className="h-4 w-4"/>检测并同步</Button>
    </div>
    <p className="text-xs text-fg-muted">检测只发现目录候选，不执行生成、不自动验证或启用，也不自动授权企业。价格按实际请求规格报价。</p>
    {discovery.data && <p className="text-xs text-fg-muted">检测时间：{new Date(discovery.data.checkedAt).toLocaleString()}{discovery.data.mock ? ' · mock 检测' : ''} · 本次未验收真实生成</p>}
    {discovery.error && <p role="alert" className="break-words text-sm text-danger">{errorText(discovery.error)}</p>}
    {profiles.error && <p role="alert" className="break-words text-sm text-danger">模型状态读取失败：{errorText(profiles.error)}</p>}
    {found?.length === 0 && <p role="status" className="text-sm text-fg-muted">本次目录未发现{name}模型，历史配置仍保留。</p>}
    <ul className="divide-y divide-border border-y border-border">
      {saved.map((profile) => <li key={profile.profileId} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{profile.displayName}</p>
          <p className="break-all font-mono text-xs text-fg-muted">{profile.modelId}</p>
          {found && !found.some((model) => model.modelId === profile.modelId) && <p className="text-xs text-fg-muted">本次目录未发现此模型</p>}
          <p className="mt-1 break-all font-mono text-xs text-fg-muted">配置版本：{profile.configVersion}</p>
          <p className="mt-1 text-xs text-fg-muted">Profile 来源：{profile.profileId.startsWith('auto-') ? '适配器自动同步' : '人工配置'}</p>
          <p className="mt-1 text-xs text-fg-muted">后台适配标记：{profile.verified ? '已标记适配' : '未验证 / 不兼容'} · 真实生成验收：未提供</p>
          <p className="mt-1 text-xs text-fg-muted">具体目录、报价及真实生成验证记录：未提供</p>
          <details className="mt-2 text-xs">
            <summary className="w-fit cursor-pointer text-fg-muted hover:text-foreground">查看能力详情</summary>
            <ProfileCapabilities profile={profile} />
          </details>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{profile.verified ? '已适配' : '待重新检测 / 配置不兼容'}</Badge>
          <Badge variant={profile.enabled && profile.verified ? 'default' : 'secondary'}>{!profile.enabled ? '已停用' : profile.verified ? '启用中' : '暂不可用'}</Badge>
          {profile.enabled && <Button size="sm" variant="outline" disabled={busy} onClick={() => void disable(profile)}>紧急停用</Button>}
        </div>
        <MediaProfileWorkflow kind={kind} model={profile} profile={profile} />
      </li>)}
      {candidates.map((model) => <li key={`candidate:${model.modelId}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{model.displayName}</p>
          <p className="break-all font-mono text-xs text-fg-muted">{model.modelId}</p>
          {model.reason && <p className="break-words text-xs text-fg-muted">{model.reason}</p>}
        </div><Badge variant="secondary">{model.compatible ? '待配置校验' : '目录候选，尚未验证'}</Badge>
        <MediaProfileWorkflow kind={kind} model={model} />
      </li>)}
      {!saved.length && !candidates.length && <li className="py-6 text-sm text-fg-muted">{profiles.isLoading ? '正在读取已同步模型' : discovery.isPending ? '检测中' : '尚无同步模型'}</li>}
    </ul>
  </section>;
}
