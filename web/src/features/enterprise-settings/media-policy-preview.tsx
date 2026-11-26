import { MediaRuntimeProfileSchema, MediaRuntimeV2ProfileSchema, type MediaPolicyPreview as ImagePolicyPreview } from 'shared/media.dto';
import type { MediaVideoPolicyPreview } from 'shared/media-video-config.dto';
import { MediaVideoRuntimeProfileSchema, MediaVideoRuntimeV2ProfileSchema } from 'shared/media-video.dto';
import { MediaRuntimeV3ProfileSchema } from 'shared/media-spec.dto';

type Preview = ImagePolicyPreview | MediaVideoPolicyPreview;
const reasons: Record<Preview['profiles'][number]['reasons'][number], string> = {
  'not-authorized': '未在本次授权列表中',
  'profile-missing': '平台已不存在此 Profile',
  disabled: '平台已停用',
  unverified: '平台尚未完成适配校验',
  'connection-unconfigured': '本企业算力 Key 尚未就绪',
  'enterprise-model-unavailable': '本企业算力 Key 没有此模型权限',
  'settlement-not-connected': '企业算力结算尚未接通',
  'adapter-unsupported': '当前执行通道尚未适配',
  'operation-filtered': '授权操作与当前能力没有交集',
  'size-intersection-empty': '授权宽高内没有当前支持的尺寸',
  'duration-intersection-empty': '授权时长内没有当前支持的规格',
  'aspect-ratio-intersection-empty': '授权画幅与当前能力没有交集',
  'resolution-intersection-empty': '授权分辨率与当前能力没有交集',
  'protocol-unsupported': '目标协议暂不能表达当前能力',
  'execution-disabled': '平台尚未开放执行',
  'unknown-capability': '当前通道无法确认此授权规格',
};

function effectiveSpecs(value: unknown, protocolVersion: 1 | 2 | 3) {
  if (protocolVersion === 3) {
    const profile = MediaRuntimeV3ProfileSchema.safeParse(value);
    if (!profile.success) return 'V3 Profile 信息无效';
    const hints = Object.entries(profile.data.parameters).map(([field, parameter]) => {
      const observedAt = parameter.observedAt ? new Date(parameter.observedAt).toLocaleString() : '未验证';
      const values = parameter.support === 'unsupported' ? '不支持' : parameter.values?.join(' / ')
        || (parameter.minimum !== undefined || parameter.maximum !== undefined ? `${parameter.minimum ?? '未知'} ~ ${parameter.maximum ?? '未知'}` : '未知');
      return `${field}: ${values}（${parameter.confidence}；来源 ${parameter.source}；更新时间 ${observedAt}）`;
    });
    const adapter = profile.data.adapter.available ? `适配器 ${profile.data.adapter.id} 已就绪`
      : `适配器未就绪：${profile.data.adapter.reason ?? profile.data.unavailableReason ?? '原因未知'}`;
    return `${profile.data.operations.join(' / ')} · ${adapter}${hints.length ? ` · 能力提示 ${hints.join('；')}` : ' · 能力提示未知'} · 价格将在请求规格确定后、执行前核验`;
  }
  const image = (protocolVersion === 2 ? MediaRuntimeV2ProfileSchema : MediaRuntimeProfileSchema).safeParse(value);
  if (image.success) {
    const { capabilities: c } = image.data;
    return `${image.data.operations.join(' / ')} · ${c.sizes.join(' / ')} · 最多 ${c.maxOutputs} 张`;
  }
  const video = (protocolVersion === 2 ? MediaVideoRuntimeV2ProfileSchema : MediaVideoRuntimeProfileSchema).safeParse(value);
  if (video.success) {
    const { capabilities: c } = video.data;
    return `${video.data.operations.join(' / ')} · ${c.durationsSeconds.join(' / ')} 秒 · ${c.aspectRatios.join(' / ')} · ${c.resolutions.join(' / ')}`;
  }
  return '当前协议未提供可识别的规格详情';
}

export function MediaPolicyPreview({ preview }: { preview: Preview }) {
  const mode = { real: '真实执行', mock: 'Mock，不计费', disabled: '执行未开放' }[preview.executionMode];
  return <section aria-label="授权预览结果" className="min-w-0 space-y-3 border-t border-border pt-4 text-sm">
    <div role="status"><p className="font-medium">{preview.executionAvailable ? '当前授权有可执行的 Profile' : '当前授权没有可执行的 Profile'}</p><p className="mt-1 text-xs text-fg-muted">{mode} · 协议 v{preview.protocolVersion} · 仍可保存授权，具体请求在执行前复核。</p></div>
    {preview.defaultProfileId && !preview.defaultProfileValid && <p className="break-all text-amber-800">默认 Profile {preview.defaultProfileId} 当前不可执行。</p>}
    <ul className="divide-y divide-border">{preview.profiles.map((profile) => <li key={profile.profileId} className="min-w-0 py-2">
      <p className="break-all font-medium">{profile.profileId}<span className="ml-2 text-xs font-normal text-fg-muted">版本：{profile.configVersion ?? '未知'}</span></p>
      <p className="mt-1 break-words text-xs text-fg-muted">{profile.status === 'effective' ? effectiveSpecs(profile.effectiveProfile, preview.protocolVersion) : profile.reasons.map((reason) => reasons[reason]).join('；') || '当前不可用'}</p>
    </li>)}</ul>
  </section>;
}
