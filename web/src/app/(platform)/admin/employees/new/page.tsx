'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Badge } from '@/components/ui/badge';
import { adminApi } from '@/features/admin/admin-api';
import {
  useAvailableCapabilities,
  useBindCapabilities,
  useDefaultEmployeeGiftCNY,
  useDefaultEmployeeGiftPercentage,
} from '@/features/admin/use-admin';
import { useEnabledModels } from '@/features/admin/use-models';
import { parseGiftInput } from '@/features/admin/employee-gift';
import { toast } from '@/components/ui/toast';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DigitalEmployeeCreateDtoSchema } from '../../../../../../../backend/src/shared';
import { z } from 'zod';

const employeeFormSchema = DigitalEmployeeCreateDtoSchema.pick({
  name: true,
  description: true,
  avatar: true,
  annualPriceCNY: true,
  includedComputeCNY: true,
}).extend({
  description: z.string().trim().min(1, '描述不能为空')
    .max(DigitalEmployeeCreateDtoSchema.shape.description.maxLength ?? 2000).optional(),
});

export default function NewEmployeePage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    industry: '通用',
    position: '通用',
    avatar: '',
    systemPrompt: '你是一位专业的硅基员工，随时准备协助用户完成各项任务。',
    modelId: 'gpt-4o',
    annualPriceCNY: 0,
  });

  // 赠送算力单独用字符串状态：空串表示「不填 → 用系统默认值」，
  // 而 '0' 表示「明确不赠送」。用 number 状态无法区分这两种意图。
  const [includedComputeInput, setIncludedComputeInput] = useState('');
  const { data: defaultGift } = useDefaultEmployeeGiftCNY();
  const { data: defaultGiftPercentage } = useDefaultEmployeeGiftPercentage();

  const { data: capabilitiesData, isLoading: capabilitiesLoading } = useAvailableCapabilities();

  // Hook 已经提取了 items 数组，添加防御性检查
  const capabilities = Array.isArray(capabilitiesData) ? capabilitiesData : [];
  const bindCapabilitiesMutation = useBindCapabilities();
  const { data: enabledModels, isLoading: modelsLoading } = useEnabledModels();

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

  const handleSubmit = async (submitForReview: boolean) => {
    if (!formData.name.trim()) {
      toast.error('请输入员工名称');
      return;
    }

    if (selectedCapabilities.length === 0) {
      toast.error('请至少选择一个能力');
      return;
    }

    const gift = parseGiftInput(includedComputeInput);
    if (gift === 'invalid') {
      toast.error('订阅赠送算力需为非负数，最多两位小数');
      return;
    }

    const { avatar, description, ...rest } = formData;
    const payload = {
      ...rest,
      ...(avatar.trim() ? { avatar: avatar.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      includedComputeCNY: gift,
    };
    const validated = employeeFormSchema.safeParse(payload);
    if (!validated.success) {
      toast.error(validated.error.issues[0]?.message || '请检查员工信息');
      return;
    }

    try {
      setIsSubmitting(true);
      const employee = await adminApi.createEmployee({
        ...payload,
        ...validated.data,
      });

      // Bind capabilities
      await bindCapabilitiesMutation.mutateAsync({
        employeeId: employee.id,
        capabilityIds: selectedCapabilities,
      });

      if (submitForReview) {
        await adminApi.submitEmployeeForReview(employee.id);
        toast.success('员工创建并提交审核成功');
      } else {
        toast.success('员工草稿保存成功');
      }

      router.push('/admin/employees');
    } catch (error: any) {
      toast.error(error.message || '操作失败');
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <h1 className="text-3xl font-bold">新建员工</h1>
        <p className="text-muted-foreground mt-2">
          创建一个新的硅基员工模板
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

          <div className="space-y-2">
            <Label htmlFor="description">描述</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="简要描述该员工的功能和用途"
              maxLength={2000}
              rows={4}
            />
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
            <Label htmlFor="avatar">头像地址</Label>
            <Input
              id="avatar"
              type="text"
              value={formData.avatar}
              onChange={(e) => setFormData({ ...formData, avatar: e.target.value })}
              placeholder="/assets/employees/silicon/frontend-engineer.webp"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="systemPrompt">系统提示词</Label>
            <Textarea
              id="systemPrompt"
              value={formData.systemPrompt}
              onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
              placeholder="定义该员工的人设和行为规范"
              rows={6}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="modelId">模型</Label>
            <Select
              value={formData.modelId}
              onValueChange={(value) => setFormData({ ...formData, modelId: value })}
              disabled={modelsLoading}
            >
              <SelectTrigger id="modelId">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelsLoading ? (
                  <div className="p-2 text-center text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin mx-auto" />
                  </div>
                ) : !enabledModels || enabledModels.length === 0 ? (
                  <div className="p-2 text-center text-sm text-muted-foreground">
                    暂无可用模型
                  </div>
                ) : (
                  enabledModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
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
                留空 = 按运营端默认规则计算；填 0 = 明确不赠送。当前默认：{defaultGiftPercentage > 0 ? `年费 × ${defaultGiftPercentage}%` : `¥${defaultGift.toFixed(2)}`}。
              </p>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t">
            <div>
              <Label>绑定能力 *</Label>
              <p className="text-sm text-muted-foreground mb-3">
                选择此员工可以使用的能力（至少选择一个）
              </p>
            </div>

            <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <p className="text-sm text-blue-800 dark:text-blue-300">
                💡 <strong>提示：</strong>选择的能力会按顺序设置优先级，可以在「高级管理」中调整。
              </p>
            </div>

            {capabilitiesLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                加载能力列表...
              </div>
            ) : !capabilities || capabilities.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>暂无可用能力</p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {capabilities.map((cap: any) => (
                  <label
                    key={cap.id}
                    className={cn(
                      'flex items-start gap-3 p-4 border rounded-lg cursor-pointer transition-colors',
                      selectedCapabilities.includes(cap.id)
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedCapabilities.includes(cap.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedCapabilities([...selectedCapabilities, cap.id]);
                        } else {
                          setSelectedCapabilities(
                            selectedCapabilities.filter((id) => id !== cap.id)
                          );
                        }
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{cap.name}</p>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {cap.description}
                      </p>
                      <Badge variant="secondary" className="mt-2">
                        {cap.type}
                      </Badge>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {selectedCapabilities.length === 0 && (
              <p className="text-sm text-gdanger">* 请至少选择一个能力</p>
            )}
          </div>

          <div className="flex gap-4 pt-4">
            <Button
              onClick={() => handleSubmit(false)}
              disabled={isSubmitting}
              variant="secondary"
              className="flex-1"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              保存为草稿
            </Button>
            <Button
              onClick={() => handleSubmit(true)}
              disabled={isSubmitting}
              className="flex-1"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              创建并提交审核
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
