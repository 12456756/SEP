'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  FlaskConical,
  KeyRound,
  Mail,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TestTube2,
  UsersRound,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner } from '@/components/ui/feedback';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import {
  useSendTestMail,
  useSettings,
  useTestMailConnection,
  useTestOAuthProvider,
  useUpdateSettings,
  type OAuthConfigCheckResult,
  type OAuthProviderName,
  type SettingView,
} from '@/features/admin/use-admin';
import ModelRuntimePolicySettings from './ModelRuntimePolicySettings';
import { isDedicatedPolicySetting, isLegacyPolicySetting } from './model-runtime-policy-form';
import Link from 'next/link';
import { Image } from 'lucide-react';

const CATEGORY_ORDER = ['overview', 'platform', 'auth', 'ai', 'model-runtime-policy', 'billing', 'payments', 'users', 'security', 'notifications', 'runtime', 'general'];
const CATEGORY_META: Record<string, { label: string; description: string; icon: typeof ShieldCheck }> = {
  overview: { label: '概览', description: '查看配置健康度与生效来源', icon: Sparkles },
  platform: { label: '平台信息', description: '品牌、客服与备案信息', icon: SlidersHorizontal },
  auth: { label: '认证与安全', description: '邮件、钉钉、微信、QQ 登录与登录风控', icon: ShieldCheck },
  ai: { label: 'AI 服务', description: '上游渠道、默认模型与响应策略', icon: Sparkles },
  'model-runtime-policy': { label: '模型运行策略', description: '模型超时、业务请求频率、并发与资源预留', icon: SlidersHorizontal },
  billing: { label: '计费与额度', description: '算力赠送规则', icon: Database },
  payments: { label: '支付与收款', description: '支付渠道和平台收款配置', icon: Database },
  users: { label: '用户与企业', description: '注册、审核与使用限制', icon: UsersRound },
  security: { label: '安全与数据', description: '内容过滤、IP 与数据留存', icon: ShieldCheck },
  notifications: { label: '通知与告警', description: '管理员通知和异常使用告警', icon: CircleAlert },
  runtime: { label: '运行环境', description: '缓存和性能参数（部署级配置只读）', icon: Database },
  general: { label: '其他设置', description: '尚未归类的系统参数', icon: SlidersHorizontal },
};

function categoryFor(setting: SettingView): string {
  if (setting.category) return setting.category;
  if (/^(MAIL_|WECHAT_|QQ_|DINGTALK_|AUTH_|OAUTH_)/.test(setting.key)) return 'auth';
  if (/^SUB2API_|MODEL_/.test(setting.key)) return 'ai';
  if (/PRICE|CNY|BALANCE|USD/.test(setting.key)) return 'billing';
  if (/ALIPAY|WECHAT_PAY|PAYMENT|PAY_/.test(setting.key)) return 'payments';
  if (/ENTERPRISE|WELCOME|MAX_CONCURRENT/.test(setting.key)) return 'users';
  if (/RETENTION|FILTER|IP_WHITELIST/.test(setting.key)) return 'security';
  if (/NOTIFICATION|ABNORMAL/.test(setting.key)) return 'notifications';
  if (/REDIS|CACHE|TIMEOUT/.test(setting.key)) return 'runtime';
  if (/PLATFORM|SUPPORT|ICP/.test(setting.key)) return 'platform';
  return 'general';
}

function sourceLabel(source?: string) {
  if (source === 'database') return '数据库覆盖';
  if (source === 'environment') return '环境变量';
  if (source === 'default') return '系统默认';
  return '未配置';
}

function inputType(setting: SettingView): 'text' | 'number' | 'email' | 'url' | 'switch' {
  if (setting.type === 'boolean') return 'switch';
  if (setting.type === 'number' || setting.type === 'integer') return 'number';
  if (setting.type === 'email') return 'email';
  if (setting.type === 'url') return 'url';
  return 'text';
}

export default function SettingsCenter() {
  const { data: settings, isLoading, error } = useSettings();
  const update = useUpdateSettings();
  const [activeCategory, setActiveCategory] = useState('overview');
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings) return;
    setEdits(Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? '' : setting.value ?? ''])));
  }, [settings]);

  const grouped = useMemo(() => {
    const map = new Map<string, SettingView[]>();
    for (const setting of settings ?? []) {
      if (isMediaConnectionSetting(setting.key)) continue;
      if (isSessionModelSetting(setting.key)) continue;
      if (isDedicatedPolicySetting(setting.key)) continue;
      const category = categoryFor(setting);
      map.set(category, [...(map.get(category) ?? []), setting]);
    }
    return map;
  }, [settings]);

  const categories = useMemo(() => CATEGORY_ORDER.filter((key) => key === 'overview' || key === 'model-runtime-policy' || grouped.has(key)), [grouped]);
  const visibleSettings = (settings ?? []).filter((setting) => !isMediaConnectionSetting(setting.key) && !isSessionModelSetting(setting.key));
  const configuredCount = visibleSettings.filter((setting) => setting.configured).length;
  const saveCategory = async (category: string) => {
    const fields = grouped.get(category) ?? [];
    const payload: Record<string, string> = {};
    for (const setting of fields) {
      if (setting.editable === false || isLegacyPolicySetting(setting.key) || isDedicatedPolicySetting(setting.key)) continue;
      const value = edits[setting.key] ?? '';
      if (setting.secret && !value.trim()) continue;
      payload[setting.key] = value.trim();
    }
    try {
      await update.mutateAsync(payload);
      toast.success('本分类配置已保存', '配置已写入；标记需重启的项目仍需重启服务。敏感字段不会回显。');
    } catch (saveError) {
      toast.error(`保存失败：${(saveError as Error).message}`);
    }
  };

  if (isLoading) return <CenteredSpinner label="加载配置中心…" />;
  if (error) return <Card><CardContent className="p-6 text-danger">配置加载失败：{(error as Error).message}</CardContent></Card>;

  return (
    <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader><CardTitle className="text-sm">配置中心</CardTitle><CardDescription>按业务域管理运行时配置</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {categories.map((key) => {
            const meta = CATEGORY_META[key] ?? CATEGORY_META.general;
            const Icon = meta.icon;
            const count = key === 'overview' ? configuredCount : (grouped.get(key)?.filter((item) => item.configured).length ?? 0);
            return <button key={key} onClick={() => setActiveCategory(key)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${activeCategory === key ? 'bg-primary/10 text-primary' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg-base'}`}>
              <Icon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{meta.label}</span>{key !== 'model-runtime-policy' && <span className="text-xs text-fg-subtle">{key === 'overview' ? `${count}/${settings?.length ?? 0}` : count}</span>}<ChevronRight className="h-3.5 w-3.5" />
            </button>;
          })}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-6">
        <div hidden={activeCategory !== 'model-runtime-policy'}><ModelRuntimePolicySettings /></div>
        {activeCategory === 'overview' ? <><div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-fg-muted">模型连接与会话模型统一管理</span><Link className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline" href="/admin/settings?tab=models"><Image className="h-4 w-4"/>模型管理</Link></div><Overview settings={visibleSettings.filter((setting) => !isDedicatedPolicySetting(setting.key))} onNavigate={setActiveCategory} /></> : activeCategory !== 'model-runtime-policy' && <CategoryPanel category={activeCategory} fields={grouped.get(activeCategory) ?? []} edits={edits} setEdits={setEdits} onSave={() => saveCategory(activeCategory)} saving={update.isPending} />}
      </div>
    </div>
  );
}

function isMediaConnectionSetting(key: string) {
  return /^MEDIA_/.test(key);
}

function isSessionModelSetting(key: string) {
  return key === 'SUB2API_BASE_URL' || key === 'SUB2API_API_KEY';
}

function Overview({ settings, onNavigate }: { settings: SettingView[]; onNavigate: (category: string) => void }) {
  const configured = settings.filter((setting) => setting.configured).length;
  const secret = settings.filter((setting) => setting.secret);
  const incomplete = settings.filter((setting) => !setting.configured && setting.editable !== false && !isLegacyPolicySetting(setting.key));
  return <>
    <div><p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">运营配置</p><h2 className="mt-2 text-xl font-semibold">系统配置概览</h2><p className="mt-1 text-sm text-fg-muted">配置优先级为数据库覆盖 → 环境变量 → 系统默认。密钥仅展示配置状态，不回传明文。</p></div>
    <div className="grid gap-4 sm:grid-cols-3">
      <Metric label="已配置项目" value={`${configured}/${settings.length}`} icon={<CheckCircle2 className="h-5 w-5 text-success" />} />
      <Metric label="待完善项目" value={String(incomplete.length)} icon={<CircleAlert className="h-5 w-5 text-warning" />} />
      <Metric label="敏感配置" value={`${secret.filter((item) => item.configured).length}/${secret.length}`} icon={<KeyRound className="h-5 w-5 text-primary" />} />
    </div>
    <Card><CardHeader><CardTitle>需要关注</CardTitle><CardDescription>优先完成启用功能所需的配置，部署级密钥仍请在环境变量或 Secret Manager 中维护。</CardDescription></CardHeader><CardContent className="space-y-3">
      {incomplete.length === 0 ? <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />当前没有未配置的可编辑项</div> : incomplete.slice(0, 8).map((setting) => <button key={setting.key} onClick={() => onNavigate(categoryFor(setting))} className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left hover:bg-bg-subtle"><CircleAlert className="h-4 w-4 shrink-0 text-warning" /><span className="flex-1"><span className="block text-sm font-medium">{setting.label}</span><span className="block text-xs text-fg-muted">{setting.description ?? '建议完成配置后再开启对应功能'}</span></span><ChevronRight className="h-4 w-4 text-fg-subtle" /></button>)}
    </CardContent></Card>
  </>;
}

function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <Card><CardContent className="flex items-center gap-3 p-4"><div className="rounded-md bg-bg-subtle p-2">{icon}</div><div><p className="text-xs text-fg-muted">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div></CardContent></Card>; }

function CategoryPanel({ category, fields, edits, setEdits, onSave, saving }: { category: string; fields: SettingView[]; edits: Record<string, string>; setEdits: Dispatch<SetStateAction<Record<string, string>>>; onSave: () => void; saving: boolean }) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.general;
  const Icon = meta.icon;
  return <>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="flex items-center gap-2 text-primary"><Icon className="h-4 w-4" /><span className="text-xs font-medium uppercase tracking-[0.18em]">设置分类</span></div><h2 className="mt-2 text-xl font-semibold">{meta.label}</h2><p className="mt-1 text-sm text-fg-muted">{meta.description}</p></div><Button onClick={onSave} loading={saving} loadingText="保存中…"><Save className="mr-2 h-4 w-4" />保存本分类</Button></div>
    {category === 'auth' ? <AuthSettings fields={fields} edits={edits} setEdits={setEdits} /> : <Card><CardContent className="grid gap-x-6 gap-y-6 p-6 md:grid-cols-2">{fields.map((setting) => <SettingField key={setting.key} setting={setting} value={edits[setting.key] ?? ''} onChange={(value) => setEdits((current) => ({ ...current, [setting.key]: value }))} />)}</CardContent></Card>}
    <p className="flex items-center gap-2 text-xs text-fg-muted"><Database className="h-3.5 w-3.5" />修改会立即写入运行时配置；标记“需重启”的项目仍需重启服务后完全生效。</p>
  </>;
}

function AuthSettings({ fields, edits, setEdits }: { fields: SettingView[]; edits: Record<string, string>; setEdits: Dispatch<SetStateAction<Record<string, string>>> }) {
  const mailFields = fields.filter((field) => field.key.startsWith('MAIL_'));
  const wechatFields = fields.filter((field) => field.key.startsWith('WECHAT_'));
  const qqFields = fields.filter((field) => field.key.startsWith('QQ_'));
  const dingtalkFields = fields.filter((field) => field.key.startsWith('DINGTALK_'));
  const riskFields = fields.filter((field) => field.key.startsWith('AUTH_') || field.key.startsWith('OAUTH_'));
  const renderFields = (items: SettingView[]) => <div className="grid gap-x-6 gap-y-6 p-6 md:grid-cols-2">{items.map((setting) => <SettingField key={setting.key} setting={setting} value={edits[setting.key] ?? ''} onChange={(value) => setEdits((current) => ({ ...current, [setting.key]: value }))} />)}</div>;
  return <div className="space-y-5">
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Mail className="h-4 w-4 text-primary" />邮件与密码找回</CardTitle><CardDescription>密码重置、邮箱验证和安全通知依赖 SMTP。保存后可以直接测试连接和发送测试邮件。</CardDescription></CardHeader>{renderFields(mailFields)}<MailTesting /></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" />钉钉主登录</CardTitle><CardDescription>钉钉是当前国内企业用户的主登录方式。请先在钉钉开放平台完成应用创建、回调地址配置和权限申请，再保存并检查配置。</CardDescription></CardHeader><div className="p-6"><OAuthTesting provider="dingtalk" label="钉钉登录" fields={dingtalkFields} edits={edits} setEdits={setEdits} /></div></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" />其他第三方登录</CardTitle><CardDescription>微信和 QQ 作为补充登录方式。启用前请先完成对应开放平台的网站应用审核，并确保回调地址与平台后台完全一致。</CardDescription></CardHeader><div className="grid gap-5 p-6 md:grid-cols-2"><OAuthTesting provider="wechat" label="微信登录" fields={wechatFields} edits={edits} setEdits={setEdits} /><OAuthTesting provider="qq" label="QQ 登录" fields={qqFields} edits={edits} setEdits={setEdits} /></div></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" />登录风控与限流</CardTitle><CardDescription>用于降低撞库、暴力破解和 OAuth 回调滥用风险；窗口单位为秒，次数单位为窗口内允许次数。</CardDescription></CardHeader>{renderFields(riskFields)}</Card>
  </div>;
}

function MailTesting() {
  const connection = useTestMailConnection();
  const delivery = useSendTestMail();
  const [to, setTo] = useState('');
  const [result, setResult] = useState<string>();
  const runConnectionTest = async () => {
    try {
      const data = await connection.mutateAsync();
      setResult(data.message);
      if (data.verified) toast.success('SMTP 连接测试通过', data.message);
      else toast.warning('SMTP 尚未就绪', data.message);
    } catch (error) {
      toast.error('SMTP 连接测试失败', (error as Error).message);
    }
  };
  const sendTest = async () => {
    if (!/^\S+@\S+\.\S+$/.test(to.trim())) {
      toast.error('请输入有效的测试收件邮箱');
      return;
    }
    try {
      await delivery.mutateAsync(to.trim());
      toast.success('测试邮件已发送', `请检查 ${to.trim()} 的收件箱。`);
    } catch (error) {
      toast.error('测试邮件发送失败', (error as Error).message);
    }
  };
  return <div className="border-t border-border bg-bg-subtle/40 p-6"><div className="flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" onClick={runConnectionTest} loading={connection.isPending} loadingText="测试中…"><TestTube2 className="h-4 w-4" />测试 SMTP 连接</Button><span className="text-xs text-fg-muted">只验证 SMTP 握手，不发送邮件。</span>{result && <Badge variant="secondary">{result}</Badge>}</div><div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-sm"><span className="mb-2 block font-medium">测试收件地址</span><Input type="email" value={to} placeholder="your@example.com" onChange={(event) => setTo(event.target.value)} /></label><Button size="sm" onClick={sendTest} loading={delivery.isPending} loadingText="发送中…"><Send className="h-4 w-4" />发送测试邮件</Button></div></div>;
}

function OAuthTesting({ provider, label, fields, edits, setEdits }: { provider: OAuthProviderName; label: string; fields: SettingView[]; edits: Record<string, string>; setEdits: Dispatch<SetStateAction<Record<string, string>>> }) {
  const test = useTestOAuthProvider();
  const [result, setResult] = useState<OAuthConfigCheckResult>();
  const enabled = edits[fields.find((field) => field.key.endsWith('_OAUTH_ENABLED'))?.key ?? ''] === 'true';
  const onChange = (setting: SettingView, value: string) => setEdits((current) => ({ ...current, [setting.key]: value }));
  const run = async () => {
    try {
      const data = await test.mutateAsync(provider);
      setResult(data);
      if (data.valid) toast.success(`${label}配置检查通过`, data.message);
      else toast.warning(`${label}配置尚未完成`, data.message);
    } catch (error) {
      toast.error(`${label}配置检查失败`, (error as Error).message);
    }
  };
  return <div className="rounded-md border border-border p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{label}</p><p className="mt-1 text-xs text-fg-muted">{enabled ? '当前已启用，建议检查完整配置' : '当前未启用；填写并保存后再开启'}</p></div><Button variant="outline" size="sm" onClick={run} loading={test.isPending} loadingText="检查中…"><FlaskConical className="h-4 w-4" />检查配置</Button></div><div className="mt-4 grid gap-4">{fields.map((setting) => <SettingField key={setting.key} setting={setting} value={edits[setting.key] ?? ''} onChange={(value) => onChange(setting, value)} />)}</div>{result && <div className="mt-4 space-y-2 border-t border-border pt-4 text-xs"><div className={result.valid ? 'text-success' : 'text-warning'}>{result.valid ? '✓' : '!' } {result.message}</div><div className="grid grid-cols-2 gap-2 text-fg-muted"><span>启用状态：{result.checks.enabled ? '通过' : '未启用'}</span><span>{provider === 'dingtalk' ? 'Client ID' : 'AppID'}：{result.checks.appId ? '已配置' : '缺失'}</span><span>密钥：{result.checks.secret ? '已配置' : '缺失'}</span><span>回调地址：{result.checks.redirectUri ? '通过' : '缺失或非 HTTPS'}</span></div></div>}</div>;
}

function SettingField({ setting, value, onChange }: { setting: SettingView; value: string; onChange: (value: string) => void }) {
  const type = inputType(setting);
  const disabled = setting.editable === false || isLegacyPolicySetting(setting.key) || isDedicatedPolicySetting(setting.key);
  const source = sourceLabel(setting.source);
  if (type === 'switch') return <div className="rounded-md border border-border p-4 md:col-span-2"><div className="flex items-center justify-between gap-4"><div><div className="flex items-center gap-2"><span className="text-sm font-medium">{setting.label}</span>{setting.configured && <Badge variant="secondary">已配置</Badge>}</div><p className="mt-1 text-xs text-fg-muted">{setting.description ?? ''}</p></div><Switch checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')} /></div><FieldMeta setting={setting} source={source} /></div>;
  return <div className="space-y-2"><div className="flex items-start justify-between gap-3"><div><label className="text-sm font-medium">{setting.label}</label><p className="mt-1 text-xs text-fg-muted">{setting.description ?? ''}</p></div>{setting.secret && <KeyRound className="h-4 w-4 shrink-0 text-warning" />}</div><Input type={type} value={value} disabled={disabled} placeholder={setting.secret ? (setting.configured ? '已配置，留空保持不变' : setting.placeholder ?? '请输入密钥') : setting.placeholder} onChange={(event) => onChange(event.target.value)} /><FieldMeta setting={setting} source={source} /></div>;
}

function FieldMeta({ setting, source }: { setting: SettingView; source: string }) { return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-subtle"><span className="inline-flex items-center gap-1"><Database className="h-3 w-3" />{source}</span>{isLegacyPolicySetting(setting.key) && <span className="text-warning">未接入执行，旧值仅供审查；请使用模型运行策略。</span>}{setting.unit && <span>单位：{setting.unit}</span>}{setting.restartRequired && <span className="inline-flex items-center gap-1 text-warning"><RotateCcw className="h-3 w-3" />需重启</span>}{setting.testable && <span className="inline-flex items-center gap-1 text-primary"><FlaskConical className="h-3 w-3" />可测试</span>}</div>; }
