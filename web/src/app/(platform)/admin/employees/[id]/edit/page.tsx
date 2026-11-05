'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi, type EmployeeDetail } from '@/features/admin/admin-api';
import { ApiError } from '@/lib/api-client';
import {
  useAvailableCapabilities,
  useEmployeeBindings,
  useSaveAdminEmployee,
  useDefaultEmployeeGiftCNY,
  useDefaultEmployeeGiftPercentage,
} from '@/features/admin/use-admin';
import { formatGiftInput, parseGiftInput } from '@/features/admin/employee-gift';
import { EmployeeCapabilityPicker } from '@/features/admin/employee-capability-picker';
import { toast } from '@/components/ui/toast';
import { ArrowLeft, Loader2 } from 'lucide-react';

export default function EditEmployeePage() {
  const router = useRouter();
  const params = useParams();
  const employeeId = params.id as string;

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generatingCopy, setGeneratingCopy] = useState<'description' | 'systemPrompt' | null>(null);
  const [copyDraftModel, setCopyDraftModel] = useState('');
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [capabilitySelection, setCapabilitySelection] = useState<{ employeeId: string; ids: string[] } | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    industry: '通用',
    position: '通用',
    systemPrompt: '',
    annualPriceCNY: 0,
  });

  // 赠送算力单独用字符串状态：空串表示「不填 → 用系统默认值」，
  // 而 '0' 表示「明确不赠送」。用 number 状态无法区分这两种意图。
  const [includedComputeInput, setIncludedComputeInput] = useState('');
  const { data: defaultGift } = useDefaultEmployeeGiftCNY();
  const { data: defaultGiftPercentage } = useDefaultEmployeeGiftPercentage();

  const { data: capabilities, isLoading: capabilitiesLoading, isError: capabilitiesError } =
    useAvailableCapabilities();
  const { data: bindings, isLoading: bindingsLoading, isError: bindingsError } = useEmployeeBindings(employeeId);
  const saveEmployee = useSaveAdminEmployee();
  const boundCapabilities = (bindings ?? [])
    .filter((binding) => binding.enabled && binding.capability.status === 'APPROVED')
    .map((binding) => binding.capability.id);
  const selectedCapabilities = capabilitySelection?.employeeId === employeeId
    ? capabilitySelection.ids
    : boundCapabilities;
  const capabilitiesChanged = selectedCapabilities.length !== boundCapabilities.length ||
    selectedCapabilities.some((id, index) => id !== boundCapabilities[index]);
  const handleCapabilitiesChange = (ids: string[]) => setCapabilitySelection({ employeeId, ids });

  const industries = [
    '通用',
    '电商',
    '金融',
    '医疗',
    '教育',
    '制造',
    '物流',
    '房地产',
    '零售',
    '科技',
  ];

  const positions = [
    '通用',
    '客服',
    '运营',
    '销售',
    '数据分析',
    '内容创作',
    '技术支持',
    '人力资源',
    '财务',
    '行政',
  ];

  useEffect(() => {
    let mounted = true;

    const loadEmployee = async () => {
      try {
        setIsLoading(true);
        const data = await adminApi.getEmployeeDetail(employeeId);
        if (!mounted) return;

        setEmployee(data);
        setFormData({
          name: data.name,
          description: data.description,
          industry: data.industry,
          position: data.position,
          systemPrompt: data.systemPrompt,
          annualPriceCNY: data.annualPriceCNY ? Number(data.annualPriceCNY) : 0,
        });
        // null 要还原成空串，不能落成 '0' —— 那会把「未配置」改写成「不赠送」
        setIncludedComputeInput(
          formatGiftInput(
            data.includedComputeCNY === null ? null : Number(data.includedComputeCNY),
          ),
        );

      } catch (error: any) {
        if (!mounted) return;
        toast.error(error.message || '加载员工信息失败');
        router.push('/admin/employees');
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    loadEmployee();
    return () => { mounted = false; };
  }, [employeeId, router]);

  const handleSubmit = async () => {
    if (bindingsLoading || bindingsError || !bindings) {
      toast.error('能力绑定尚未加载完成，请刷新后重试');
      return;
    }
    if (!formData.name.trim()) {
      toast.error('请输入员工名称');
      return;
    }

    if (capabilitiesChanged && selectedCapabilities.length === 0) {
      toast.error('请至少选择一个能力');
      return;
    }

    const gift = parseGiftInput(includedComputeInput);
    if (gift === 'invalid') {
      toast.error('订阅赠送算力需为非负数，最多两位小数');
      return;
    }

    try {
      setIsSubmitting(true);
      await saveEmployee.mutateAsync({
        id: employeeId,
        data: {
          ...formData,
          includedComputeCNY: gift,
          ...(capabilitiesChanged ? { capabilityIds: selectedCapabilities } : {}),
        },
      });
      toast.success('员工信息更新成功');
      router.push('/admin/employees');
    } catch (error: any) {
      const errors = error instanceof ApiError && typeof error.body === 'object' && error.body !== null
        ? (error.body as { errors?: Array<{ field: string; message: string }> }).errors
        : undefined;
      const details = errors?.map(({ field, message }) => `${field}: ${message}`).join('；');
      toast.error(details ? `请求参数校验失败：${details}` : error.message || '更新失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const generateCopyDraft = async (kind: 'description' | 'systemPrompt') => {
    if (!formData.name.trim()) {
      toast.error('请先填写员工名称');
      return;
    }
    setGeneratingCopy(kind);
    try {
      const result = await adminApi.generateEmployeeCopyDraft({
        kind,
        employee: {
          name: formData.name,
          industry: formData.industry,
          position: formData.position,
          capabilities: (capabilities ?? []).filter((capability) => selectedCapabilities.includes(capability.id))
            .map(({ name, description }) => ({ name, description: description ?? '' })),
        },
      });
      setFormData((current) => ({ ...current, [kind]: result.draft }));
      setCopyDraftModel(result.modelId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文案生成失败，请稍后重试');
    } finally {
      setGeneratingCopy(null);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto py-6 max-w-4xl">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 max-w-4xl">
      <div className="mb-6">
        <Button
          variant="ghost"
          onClick={() => router.back()}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          返回
        </Button>
        <h1 className="text-3xl font-bold">编辑员工</h1>
        <p className="text-muted-foreground mt-2">
          编辑员工信息 - {employee?.name}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">员工名称 *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="例如：智能客服助手"
            />
          </div>

          <p className="text-sm text-muted-foreground">员工头像由 <Link href="/admin/employees/avatar-styles" className="text-primary underline-offset-4 hover:underline">头像风格管理</Link> 统一配置。</p>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label htmlFor="description">员工简介</Label>
              <Button type="button" variant="outline" size="sm" disabled={generatingCopy !== null} loading={generatingCopy === 'description'} onClick={() => void generateCopyDraft('description')}>AI 生成简介</Button>
            </div>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="简要描述该员工的功能和用途"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">AI 生成内容仅作为草稿，可继续修改；也可以直接填写。{copyDraftModel ? `当前生成模型：${copyDraftModel}` : '使用平台当前可用的默认会话模型。'}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="industry">行业</Label>
              <Select
                value={formData.industry}
                onValueChange={(value) => setFormData({ ...formData, industry: value })}
              >
                <SelectTrigger id="industry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {industries.map((industry) => (
                    <SelectItem key={industry} value={industry}>
                      {industry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="position">岗位</Label>
              <Select
                value={formData.position}
                onValueChange={(value) => setFormData({ ...formData, position: value })}
              >
                <SelectTrigger id="position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {positions.map((position) => (
                    <SelectItem key={position} value={position}>
                      {position}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label htmlFor="systemPrompt">系统提示词</Label>
              <Button type="button" variant="outline" size="sm" disabled={generatingCopy !== null} loading={generatingCopy === 'systemPrompt'} onClick={() => void generateCopyDraft('systemPrompt')}>AI 生成提示词</Button>
            </div>
            <Textarea
              id="systemPrompt"
              value={formData.systemPrompt}
              onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
              placeholder="定义该员工的人设和行为规范"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">建议控制在 250 到 600 字，包含工作目标、可用能力和行为边界；生成后可继续修改。</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="annualPriceCNY">年费（元）*</Label>
              <Input
                id="annualPriceCNY"
                type="number"
                min={0}
                step={0.01}
                value={formData.annualPriceCNY}
                onChange={(e) =>
                  setFormData({ ...formData, annualPriceCNY: parseFloat(e.target.value) || 0 })
                }
                placeholder="5000"
              />
              <p className="text-xs text-muted-foreground">
                企业订阅此员工的年费
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="includedComputeCNY">订阅赠送算力（元）</Label>
              <Input
                id="includedComputeCNY"
                type="number"
                min={0}
                step={0.01}
                value={includedComputeInput}
                onChange={(e) => setIncludedComputeInput(e.target.value)}
                placeholder={
                  defaultGiftPercentage > 0
                    ? `留空按年费 × ${defaultGiftPercentage}% 计算`
                    : `留空使用系统默认值 ¥${defaultGift.toFixed(2)}`
                }
              />
              <p className="text-xs text-muted-foreground">
                企业订阅该员工后获得的一笔人民币算力余额，赠送余额用完后扣企业钱包。
                留空 = 按运营端默认规则计算；填 0 = 明确不赠送。当前默认：{defaultGiftPercentage > 0 ? `年费 × ${defaultGiftPercentage}%` : `¥${defaultGift.toFixed(2)}`}。改动只影响新订阅，不追溯已有订阅。
              </p>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t">
            <EmployeeCapabilityPicker capabilities={capabilities ?? []} selectedIds={selectedCapabilities} onChange={handleCapabilitiesChange} isLoading={capabilitiesLoading} isError={capabilitiesError} />
          </div>

          <div className="flex gap-4 pt-4">
            <Button
              onClick={() => router.back()}
              disabled={isSubmitting}
              variant="secondary"
              className="flex-1"
            >
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="flex-1"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              保存更新
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
