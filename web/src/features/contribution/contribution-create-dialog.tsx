'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Plus, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/lib/auth-store';
import { cn } from '@/lib/utils';
import { RpaPackageUpload } from './components/rpa-package-upload';
import { useCreateContribution } from './use-contributions';
import { ContributionCapabilityCreateDtoSchema, type RpaPackageParseResult } from '../../../../backend/src/shared';
import { z } from 'zod';

const contributionFormSchema = ContributionCapabilityCreateDtoSchema.innerType().pick({
  name: true, description: true, type: true, industry: true, position: true,
  inputSchema: true, outputSchema: true, rpaConfig: true,
}).extend({
  description: z.string().trim().min(1, '请填写能力说明')
    .max(ContributionCapabilityCreateDtoSchema.innerType().shape.description.maxLength ?? 2000),
});

type ContributionType = 'rpa';
type Step = 1 | 2 | 3;

export function ContributionCreateDialog({
  open,
  onOpenChange,
  mode = 'draft',
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'draft' | 'platform-review';
  onSuccess?: (capability: { id: string }) => void;
}) {
  const hasEnterprise = Boolean(useAuthStore((state) => state.enterprise));
  const create = useCreateContribution({ submitToPlatformReview: mode === 'platform-review' });
  const [step, setStep] = useState<Step>(1);
  const [type, setType] = useState<ContributionType>('rpa');
  const [rpaPkg, setRpaPkg] = useState<RpaPackageParseResult | null>(null);
  const [rpaPlatform, setRpaPlatform] = useState<'shizai' | 'yingdao'>('shizai');
  const [rpaDoc, setRpaDoc] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [industry, setIndustry] = useState('');
  const [position, setPosition] = useState('');

  const reset = () => {
    setStep(1); setType('rpa'); setRpaPkg(null); setRpaPlatform('shizai'); setRpaDoc('');
    setName(''); setDescription(''); setIndustry(''); setPosition('');
  };
  const close = (value: boolean) => { if (!value) reset(); onOpenChange(value); };

  const configReady = Boolean(rpaPkg && rpaDoc.trim().length >= 10);
  const canContinue = step === 1 || (step === 2 && configReady);

  const next = () => {
    if (step === 2 && !configReady) {
      toast.error(!rpaPkg ? '请先上传 RPA ZIP 包' : '使用与环境说明至少需要 10 个字');
      return;
    }
    setStep((current) => Math.min(3, current + 1) as Step);
  };

  const submit = () => {
    if (!configReady) { toast.error('请先上传 RPA ZIP 包并填写使用说明'); return; }
    if (!name.trim()) { toast.error('请填写能力名称'); return; }
    if (!description.trim()) { toast.error('请填写能力说明'); return; }
    const validated = contributionFormSchema.safeParse({
      name: name.trim(), description: description.trim(), type, industry: splitTags(industry), position: splitTags(position),
      rpaConfig: { platform: rpaPlatform, executionMode: 'download' as const, packageSha256: rpaPkg!.sha256, packageFilename: rpaPkg!.filename, configDoc: rpaDoc.trim() },
    });
    if (!validated.success) { toast.error(validated.error.issues[0]?.message || '请检查能力信息'); return; }
    create.mutate(validated.data, {
      onSuccess: (capability) => {
        if (mode === 'platform-review') {
          toast.success('RPA 已提交平台审核', '可在投稿审核队列中继续处理');
        } else {
          toast.success('能力草稿已创建', '接下来可以提交企业审核');
        }
        close(false);
        onSuccess?.(capability);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : '创建失败，请稍后重试'),
    });
  };

  return <Dialog open={open} onOpenChange={close}>
    <DialogContent glass className="max-w-3xl overflow-hidden p-0">
      <DialogHeader className="border-b border-glassline px-6 py-5">
        <div className="flex items-start justify-between gap-4"><div><DialogTitle className="text-gtext-primary">创建能力贡献</DialogTitle><DialogDescription className="mt-1 max-w-xl text-gtext-muted">{mode === 'platform-review' ? '创建平台 RPA 投稿并直接送入审核队列。' : hasEnterprise ? '先保存为企业私有草稿，企业管理员通过后才可申请进入平台审核。' : '先保存为个人草稿，自动校验通过后可直接进入平台审核。'}</DialogDescription></div><span className="rounded-full border border-glassline bg-glass-1 px-2.5 py-1 text-[11px] text-gtext-muted">{mode === 'platform-review' ? '平台投稿' : '草稿模式'}</span></div>
        <div className="mt-5 flex items-center gap-2" aria-label="创建步骤"><StepIndicator step={1} current={step} label="选择类型" /><StepLine active={step > 1} /><StepIndicator step={2} current={step} label="能力内容" /><StepLine active={step > 2} /><StepIndicator step={3} current={step} label="能力信息" /></div>
      </DialogHeader>
      <div className="max-h-[min(560px,calc(100vh-230px))] overflow-y-auto px-6 py-5 scroll-thin">
        {step === 1 && <TypeStep type={type} onTypeChange={setType} />}
        {step === 2 && <ConfigStep rpaPkg={rpaPkg} rpaPlatform={rpaPlatform} rpaDoc={rpaDoc} onRpaPackageChange={setRpaPkg} onRpaPlatformChange={setRpaPlatform} onRpaDocChange={setRpaDoc} />}
        {step === 3 && <InfoStep prefilled={false} name={name} description={description} industry={industry} position={position} onNameChange={setName} onDescriptionChange={setDescription} onIndustryChange={setIndustry} onPositionChange={setPosition} />}
      </div>
      <DialogFooter className="border-t border-glassline bg-glass-1/40 px-6 py-4"><Button variant="glass" onClick={() => step === 1 ? close(false) : setStep((current) => Math.max(1, current - 1) as Step)}>{step === 1 ? '取消' : <><ArrowLeft className="h-4 w-4" />上一步</>}</Button>{step < 3 ? <Button variant="glass-primary" disabled={!canContinue} onClick={next}>下一步<ArrowRight className="h-4 w-4" /></Button> : <Button variant="glass-primary" loading={create.isPending} onClick={submit}><Plus className="h-4 w-4" />{mode === 'platform-review' ? '提交平台审核' : '创建草稿'}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}

function StepIndicator({ step, current, label }: { step: Step; current: Step; label: string }) { const complete = current > step; const active = current === step; return <div className="flex min-w-0 items-center gap-2"><span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold transition-colors', complete ? 'border-gsuccess bg-gsuccess/15 text-gsuccess' : active ? 'border-gbrand-ring bg-gbrand/15 text-gbrand-text' : 'border-glassline bg-glass-1 text-gtext-muted')}>{complete ? <Check className="h-3.5 w-3.5" /> : step}</span><span className={cn('truncate text-xs', active || complete ? 'text-gtext-primary' : 'text-gtext-muted')}>{label}</span></div>; }
function StepLine({ active }: { active: boolean }) { return <span className={cn('h-px min-w-4 flex-1 transition-colors', active ? 'bg-gbrand' : 'bg-glassline')} />; }
function TypeStep({ type, onTypeChange }: { type: ContributionType; onTypeChange: (type: ContributionType) => void }) { return <div><SectionIntro eyebrow="01 / 类型" title="创建 RPA 能力" description="SKILL 正文和版本由客户端上传；贡献中心保留 RPA 的创建与审核流程。" /><div className="mt-6 grid gap-3"><TypeChoice active={type === 'rpa'} onClick={() => onTypeChange('rpa')} icon={<Workflow className="h-5 w-5" />} title="RPA" desc="上传 ZIP，审核通过后授权用户下载" /></div></div>; }

function ConfigStep({ rpaPkg, rpaPlatform, rpaDoc, onRpaPackageChange, onRpaPlatformChange, onRpaDocChange }: { rpaPkg: RpaPackageParseResult | null; rpaPlatform: 'shizai' | 'yingdao'; rpaDoc: string; onRpaPackageChange: (result: RpaPackageParseResult | null) => void; onRpaPlatformChange: (platform: 'shizai' | 'yingdao') => void; onRpaDocChange: (value: string) => void }) {
  return <div><SectionIntro eyebrow="02 / RPA 配置" title="上传可复用的自动化流程" description="平台只做 ZIP 结构与元数据检查，不执行其中的脚本或流程。审核通过后，授权用户可以下载并在本地导入。" /><div className="mt-5 grid gap-4"><RpaPackageUpload value={rpaPkg} onChange={onRpaPackageChange} /><label className="block text-sm text-gtext-secondary">RPA 平台<select value={rpaPlatform} onChange={(event) => onRpaPlatformChange(event.target.value as 'shizai' | 'yingdao')} className="mt-1.5 h-10 w-full rounded-glass-md border border-glassline bg-glass-2 px-3 text-sm text-gtext-primary outline-none focus:border-glassline-brand"><option value="shizai">实在智能</option><option value="yingdao">影刀</option></select></label><label className="block text-sm text-gtext-secondary">使用与环境说明<Textarea glass value={rpaDoc} onChange={(event) => onRpaDocChange(event.target.value)} placeholder="说明适用平台版本、导入步骤、账号/环境要求和注意事项（至少 10 个字）" className="mt-1.5 min-h-28 resize-y" /><span className="mt-2 block text-[11px] text-gtext-muted">{rpaDoc.trim().length} / 至少 10 个字符 · 不要填写密码、Token 等敏感信息</span></label></div></div>;
}

function InfoStep({ prefilled, name, description, industry, position, onNameChange, onDescriptionChange, onIndustryChange, onPositionChange }: { prefilled: boolean; name: string; description: string; industry: string; position: string; onNameChange: (value: string) => void; onDescriptionChange: (value: string) => void; onIndustryChange: (value: string) => void; onPositionChange: (value: string) => void }) { return <div><SectionIntro eyebrow="03 / 信息" title="补充能力信息" description="信息会进入审核队列和能力目录；不要填写密码、Token、Cookie 或其他敏感信息。" />{prefilled && <p className="mt-4 rounded-glass-md border border-gsuccess/30 bg-gsuccess/10 p-3 text-xs text-gsuccess">已从上传的 SKILL.md frontmatter 预填名称与说明，你仍可在这里修改。</p>}<div className="mt-5 grid gap-4"><label className="block text-sm text-gtext-secondary">能力名称<Input glass maxLength={100} value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：竞品周报生成器" className="mt-1.5" /></label><label className="block text-sm text-gtext-secondary">能力说明<Textarea glass maxLength={2000} value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder="说明它解决什么问题、输入输出是什么" className="mt-1.5 min-h-24 resize-y" /><span className="mt-2 block text-[11px] text-gtext-muted">{description.trim().length} / 2000 个字符 · 建议至少 10 个字</span></label><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm text-gtext-secondary">适用行业<Input glass value={industry} onChange={(event) => onIndustryChange(event.target.value)} placeholder="多个标签用逗号分隔" className="mt-1.5" /></label><label className="block text-sm text-gtext-secondary">适用岗位<Input glass value={position} onChange={(event) => onPositionChange(event.target.value)} placeholder="多个标签用逗号分隔" className="mt-1.5" /></label></div></div></div>; }
function SourceTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} aria-pressed={active} className={cn('h-7 rounded-glass-pill px-3 text-xs transition-all duration-200', active ? 'bg-gbg-raised text-gtext-primary shadow-glass-sm' : 'text-gtext-muted hover:bg-glass-3 hover:text-gtext-secondary')}>{children}</button>; }
function SectionIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gbrand-text">{eyebrow}</p><h3 className="mt-2 text-lg font-semibold text-gtext-primary">{title}</h3><p className="mt-1 max-w-xl text-sm leading-6 text-gtext-muted">{description}</p></div>; }
function TypeChoice({ active, onClick, icon, title, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) { return <button type="button" onClick={onClick} aria-pressed={active} className={cn('group flex min-h-28 items-start gap-3 rounded-glass-lg border p-4 text-left transition-all duration-150', active ? 'border-glassline-brand bg-gbrand/10 shadow-glass-sm' : 'border-glassline bg-glass-1 hover:border-glassline-brand/60 hover:bg-glass-2')}><span className={cn('mt-0.5 transition-colors', active ? 'text-gbrand-text' : 'text-gtext-muted group-hover:text-gbrand-text')}>{icon}</span><span><span className="flex items-center gap-2 text-sm font-semibold text-gtext-primary">{title}{active && <Check className="h-3.5 w-3.5 text-gbrand-text" />}</span><span className="mt-1 block text-xs leading-5 text-gtext-muted">{desc}</span></span></button>; }
function splitTags(value: string) { return value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean); }
