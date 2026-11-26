'use client';

import { useState } from 'react';
import { Check, Plus, Power, Save, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MediaImageSpecV3Schema, MediaVideoSpecV3Schema } from 'shared/media-spec.dto';
import { MAX_MEDIA_REFERENCE_COUNT } from 'shared/media-reference.dto';
import { IMAGE_REFERENCE_DEFAULT_COUNT, VIDEO_INPUT_MAX_COUNT, VIDEO_INPUT_MAX_BYTES, VIDEO_INPUT_MIME_TYPES } from 'shared/media-runtime-parameters';
import { CreateMediaProfileDtoSchema } from 'shared/media.dto';
import { CreateMediaVideoProfileDtoSchema } from 'shared/media-video-config.dto';
import { MediaVideoDurationRangeSchema } from 'shared/media-video.dto';
import { useCreateMediaProfile, useUpdateMediaProfile, useVerifyMediaProfile, type MediaProfile } from './use-media-config';
import { useCreateVideoProfile, useUpdateVideoProfile, useVerifyVideoProfile, type MediaVideoProfile } from './use-video-config';

interface Props {
  kind: 'image' | 'video';
  model: { modelId: string; displayName: string };
  profile?: MediaProfile | MediaVideoProfile;
}

type Operation = 'generate' | 'edit' | 'text-to-video' | 'image-to-video' | 'video-to-video';
const splitValues = (value: string) => [...new Set(value.split(/[\s,，、;；]+/).map(item => item.trim()).filter(Boolean))];
const listValue = (values: readonly (string | number)[] | undefined) => values?.join(', ') ?? '';

export function MediaProfileWorkflow({ kind, model, profile }: Props) {
  const imageCreate = useCreateMediaProfile();
  const imageVerify = useVerifyMediaProfile();
  const imageUpdate = useUpdateMediaProfile();
  const videoCreate = useCreateVideoProfile();
  const videoVerify = useVerifyVideoProfile();
  const videoUpdate = useUpdateVideoProfile();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'configure' | 'quote'>('configure');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const autoProfile = profile?.profileId.startsWith('auto-') ?? false;
  const busy = [imageCreate, imageVerify, imageUpdate, videoCreate, videoVerify, videoUpdate].some(mutation => mutation.isPending);
  const edit = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : '操作失败');
  const setForm = (nextMode: typeof mode) => {
    setError(null);
    setMode(nextMode);
    if (!profile || nextMode === 'quote') { setDraft(nextMode === 'configure' ? {
      maxReferenceCount: kind === 'image' ? String(IMAGE_REFERENCE_DEFAULT_COUNT) : '1',
      ...(kind === 'video' ? { maxVideoReferenceCount: '1', maxVideoReferenceMiB: '90', videoReferenceMimeTypes: VIDEO_INPUT_MIME_TYPES.join(',') } : {}),
    } : {}); return; }
    if (kind === 'image' && profile.kind === 'image') {
      setDraft({ operations: profile.operations.join(','), sizes: listValue(profile.capabilities.sizes),
        maxOutputs: '1', supportsReferenceImage: String(profile.capabilities.supportsReferenceImage),
        qualities: listValue(profile.capabilities.qualities), maxReferenceCount: String(Math.min(4, profile.capabilities.maxReferenceCount || IMAGE_REFERENCE_DEFAULT_COUNT)) });
    } else if (kind === 'video' && profile.kind === 'video') {
      const c = profile.capabilities;
      setDraft({ operations: profile.operations.join(','),
        minDurationSeconds: String(c.durationRange?.minimum ?? Math.min(...c.durationsSeconds)),
        maxDurationSeconds: String(c.durationRange?.maximum ?? Math.max(...c.durationsSeconds)),
        resolutions: listValue(c.resolutions), aspectRatios: listValue(c.aspectRatios), frameRates: listValue(c.frameRates),
        outputFormats: listValue(c.outputFormats), supportsAudio: String(c.supportsAudio), maxReferenceCount: String(c.maxReferenceCount || 1),
        maxVideoReferenceCount: String(c.maxVideoReferenceCount || 1), maxVideoReferenceMiB: String((c.maxVideoReferenceBytes ?? VIDEO_INPUT_MAX_BYTES) / 1024 / 1024),
        videoReferenceMimeTypes: listValue(c.videoReferenceMimeTypes ?? VIDEO_INPUT_MIME_TYPES) });
    }
  };
  const toggleForm = (nextMode: typeof mode) => {
    if (open && mode === nextMode) { setOpen(false); return; }
    setForm(nextMode);
    setOpen(true);
  };
  const selected = (operation: Operation) => (draft.operations ?? '').split(',').includes(operation);
  const toggleOperation = (operation: Operation) => {
    const operations = new Set((draft.operations ?? '').split(',').filter(Boolean));
    if (operations.has(operation)) operations.delete(operation); else operations.add(operation);
    edit('operations', [...operations].join(','));
  };
  const enable = async () => {
    if (!profile) return;
    setError(null);
    try {
      const input = { profileId: profile.profileId, dto: { expectedConfigVersion: profile.configVersion, enabled: true } };
      if (kind === 'image') await imageUpdate.mutateAsync(input);
      else await videoUpdate.mutateAsync(input);
    } catch (failure) { fail(failure); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (mode === 'quote') {
        if (kind === 'image') {
          const spec = MediaImageSpecV3Schema.parse({ size: draft.size, count: Number(draft.count), quality: draft.quality });
          if (spec.count !== 1) throw new Error('异步图片每次输出 1 张');
          await imageVerify.mutateAsync({ profileId: profile!.profileId,
            dto: { expectedConfigVersion: profile!.configVersion, verificationSpec: spec } });
        } else {
          const spec = MediaVideoSpecV3Schema.parse({ durationSeconds: Number(draft.durationSeconds), resolution: draft.resolution,
            ...(draft.aspectRatio ? { aspectRatio: draft.aspectRatio } : {}), ...(draft.frameRate ? { frameRate: Number(draft.frameRate) } : {}),
            ...(draft.audio ? { audio: draft.audio === 'true' } : {}), ...(draft.outputFormat ? { outputFormat: draft.outputFormat } : {}) });
          await videoVerify.mutateAsync({ profileId: profile!.profileId,
            dto: { expectedConfigVersion: profile!.configVersion, verificationSpec: spec } });
        }
      } else if (kind === 'image') {
        const operations = (draft.operations ?? '').split(',').filter(Boolean);
        const capabilities = { sizes: splitValues(draft.sizes), maxOutputs: Number(draft.maxOutputs),
          supportsReferenceImage: draft.supportsReferenceImage === 'true',
          ...((draft.qualities?.trim() || profile?.kind === 'image' && profile.capabilities.qualities !== undefined)
            ? { qualities: splitValues(draft.qualities ?? '') } : {}),
          maxReferenceCount: draft.supportsReferenceImage === 'true' ? Number(draft.maxReferenceCount) : 0 };
        if (capabilities.maxOutputs !== 1 || capabilities.maxReferenceCount > 4) throw new Error('异步图片每次输出 1 张，最多支持 4 张参考图');
        if (profile) await imageUpdate.mutateAsync({ profileId: profile.profileId,
          dto: { expectedConfigVersion: profile.configVersion,
            ...(!autoProfile ? { operations: operations as ('generate' | 'edit')[] } : {}), capabilities } });
        else await imageCreate.mutateAsync(CreateMediaProfileDtoSchema.parse({ profileId: draft.profileId, displayName: draft.displayName,
          kind: 'image', modelId: model.modelId, executionMode: 'async-query', enabled: false,
          operations, capabilities }));
      } else {
        const operations = (draft.operations ?? '').split(',').filter(Boolean);
        const durationRange = MediaVideoDurationRangeSchema.parse({ minimum: Number(draft.minDurationSeconds), maximum: Number(draft.maxDurationSeconds) });
        const capabilities = { supportsTextToVideo: operations.includes('text-to-video'), supportsImageToVideo: operations.includes('image-to-video'),
          supportsVideoToVideo: operations.includes('video-to-video'),
          maxVideoReferenceCount: operations.includes('video-to-video') ? Number(draft.maxVideoReferenceCount) : 0,
          ...(operations.includes('video-to-video') ? { maxVideoReferenceBytes: Number(draft.maxVideoReferenceMiB) * 1024 * 1024,
            videoReferenceMimeTypes: splitValues(draft.videoReferenceMimeTypes) as (typeof VIDEO_INPUT_MIME_TYPES[number])[] } : {}),
          supportsAudio: draft.supportsAudio === 'true', durationRange,
          durationsSeconds: [...new Set([durationRange.minimum, durationRange.maximum])],
          aspectRatios: splitValues(draft.aspectRatios), resolutions: splitValues(draft.resolutions),
          frameRates: splitValues(draft.frameRates).map(Number), outputFormats: splitValues(draft.outputFormats) as ('video/mp4' | 'video/webm')[],
          maxInputBytes: profile?.kind === 'video' ? profile.capabilities.maxInputBytes : 10 * 1024 * 1024,
          maxReferenceCount: operations.includes('image-to-video') ? Number(draft.maxReferenceCount) : 0,
          supportsTaskQuery: true as const, supportsCancel: profile?.kind === 'video' ? profile.capabilities.supportsCancel : false,
          resultRetentionSeconds: profile?.kind === 'video' ? profile.capabilities.resultRetentionSeconds : 86400 };
        if (profile) await videoUpdate.mutateAsync({ profileId: profile.profileId,
          dto: { expectedConfigVersion: profile.configVersion,
            ...(!autoProfile ? { operations: operations as ('text-to-video' | 'image-to-video' | 'video-to-video')[] } : {}), capabilities } });
        else await videoCreate.mutateAsync(CreateMediaVideoProfileDtoSchema.parse({ profileId: draft.profileId, displayName: draft.displayName,
          kind: 'video', modelId: model.modelId, executionMode: 'async-query', enabled: false, operations, capabilities }));
      }
      setOpen(false);
    } catch (failure) { fail(failure); }
  };
  const field = (key: string, label: string, numeric = false, required = true, maximum?: number, integer = false) => <label key={key} className="min-w-0 text-xs">{label}
    <Input required={required} type={numeric ? 'number' : 'text'} min={numeric ? 1 : undefined} max={maximum} step={numeric ? maximum || integer ? 1 : 'any' : undefined}
      value={draft[key] ?? ''} disabled={busy} onChange={event => edit(key, event.target.value)} /></label>;
  const referenceCountField = <label className="min-w-0 text-xs">最多参考图数量
    <Input aria-label="最多参考图数量" required type="number" min={1} max={kind === 'image' ? 4 : MAX_MEDIA_REFERENCE_COUNT} step={1}
      value={draft.maxReferenceCount ?? ''} disabled={busy} onChange={event => edit('maxReferenceCount', event.target.value)} />
  </label>;
  const multiField = (key: string, label: string, limits: string, required = true) => <label key={key} className="min-w-0 text-xs">{label}
    <Textarea required={required} rows={2} placeholder="逗号或换行分隔" aria-label={label} aria-describedby={`${key}-limits`}
      value={draft[key] ?? ''} disabled={busy} onChange={event => edit(key, event.target.value)} />
    <span id={`${key}-limits`} className="mt-1 block text-[11px] text-fg-muted">可用逗号或换行输入多项；{limits}</span></label>;
  const operationChoices: Operation[] = kind === 'image' ? ['generate', 'edit'] : ['text-to-video', 'image-to-video', 'video-to-video'];
  const operationLabels: Record<Operation, string> = { generate: '文生图', edit: '图片编辑', 'text-to-video': '文生视频', 'image-to-video': '图生视频', 'video-to-video': '视频生视频' };
  const operationsControl = <fieldset className="sm:col-span-2"><legend className="text-xs">操作</legend><div className="mt-1 flex flex-wrap gap-4">
    {operationChoices.map(operation => <label key={operation} className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy}
      checked={selected(operation)} onChange={() => toggleOperation(operation)} />{operationLabels[operation]}</label>)}
  </div></fieldset>;
  const quoteFields = kind === 'image' ? <>{field('size', '尺寸 size')}{field('count', '输出数量', true, true, 1)}{field('quality', '质量 quality')}</>
    : <>{field('durationSeconds', '时长（秒）', true)}{field('resolution', '分辨率')}{field('aspectRatio', '画幅比例', false, false)}
      {field('frameRate', '帧率', true, false)}<label className="text-xs">音频<select value={draft.audio ?? ''} onChange={event => edit('audio', event.target.value)} className="mt-1 block w-full border border-border bg-background p-2">
        <option value="">不指定</option><option value="true">有音频</option><option value="false">无音频</option></select></label>
      {field('outputFormat', '输出格式', false, false)}</>;
  const configurationFields = <>{!profile && <>{field('profileId', 'Profile ID')}{field('displayName', '显示名称')}</>}{!autoProfile && operationsControl}
    {kind === 'image' ? <>{multiField('sizes', '支持尺寸', '最多 32 项，格式如 1024x1024')}
      {multiField('qualities', '质量选项', '最多 128 项，每项最多 128 字符；留空表示未确认', false)}
      {field('maxOutputs', '最大输出数量', true, true, 1)}
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.supportsReferenceImage === 'true'} disabled={busy || autoProfile && selected('edit')}
        onChange={event => edit('supportsReferenceImage', String(event.target.checked))} />支持参考图编辑</label>
      {draft.supportsReferenceImage === 'true' && referenceCountField}</>
      : <>{field('minDurationSeconds', '最短时长（秒）', true, true, undefined, true)}{field('maxDurationSeconds', '最长时长（秒）', true, true, undefined, true)}
        {multiField('aspectRatios', '支持画幅比例', '最多 16 项，如 16:9')}
        {multiField('resolutions', '支持分辨率', '最多 8 项，如 720p')}{multiField('frameRates', '支持帧率', '最多 8 项，正数')}
        {multiField('outputFormats', '支持输出格式', '最多 4 项：video/mp4、video/webm')}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.supportsAudio === 'true'} disabled={busy}
          onChange={event => edit('supportsAudio', String(event.target.checked))} />支持音频</label>
        {selected('image-to-video') && referenceCountField}
        {selected('video-to-video') && <>
          {field('maxVideoReferenceCount', '最多参考视频数量', true, true, VIDEO_INPUT_MAX_COUNT, true)}
          {field('maxVideoReferenceMiB', '单个参考视频上限（MiB）', true, true, VIDEO_INPUT_MAX_BYTES / 1024 / 1024, true)}
          <fieldset className="min-w-0 text-xs sm:col-span-2"><legend>参考视频格式</legend><div className="mt-1 flex flex-wrap gap-4">
            {VIDEO_INPUT_MIME_TYPES.map(mime => <label key={mime} className="flex items-center gap-2"><input type="checkbox" disabled={busy}
              checked={splitValues(draft.videoReferenceMimeTypes ?? '').includes(mime)} onChange={event => {
                const formats = new Set(splitValues(draft.videoReferenceMimeTypes ?? ''));
                if (event.target.checked) formats.add(mime); else formats.delete(mime);
                edit('videoReferenceMimeTypes', [...formats].join(','));
              }} />{mime === 'video/mp4' ? 'MP4' : 'MOV'}</label>)}
          </div></fieldset>
        </>}</>}</>;
  return <div className="min-w-0 w-full space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => toggleForm('configure')}>
        {profile ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{profile ? '编辑能力配置' : '配置通用 Profile'}</Button>
      {profile && <Button size="sm" variant="outline" disabled={busy} onClick={() => toggleForm('quote')}><ShieldCheck className="h-4 w-4" />报价校验</Button>}
      {profile?.verified && !profile.enabled && <Button size="sm" variant="outline" disabled={busy} onClick={() => void enable()}><Power className="h-4 w-4" />启用</Button>}
    </div>
    {open && <form onSubmit={submit} aria-label={mode === 'quote' ? '报价校验配置' : profile ? '编辑能力配置' : '创建通用 Profile'}
      className="grid min-w-0 gap-3 border-t border-border pt-3 sm:grid-cols-2">
      <p className="break-all text-xs text-fg-muted sm:col-span-2">模型：{model.modelId} · {mode === 'quote' ? '只读报价校验，不执行生成' : '能力声明需通过报价校验后方可启用'}</p>
      {mode === 'quote' ? quoteFields : configurationFields}
      <Button size="sm" type="submit" disabled={busy}><Check className="h-4 w-4" />{mode === 'quote' ? '校验报价合同' : profile ? '保存能力配置' : '创建停用 Profile'}</Button>
    </form>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
  </div>;
}
