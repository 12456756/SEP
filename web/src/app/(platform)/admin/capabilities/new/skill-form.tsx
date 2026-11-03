'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { Loader2 } from 'lucide-react';
import { api, ApiError, uploadForm } from '@/lib/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CapabilityUploadDtoSchema } from '../../../../../../../backend/src/shared';
import { SkillImportPanel } from '@/features/skill-import/skill-import-panel';
import type { SkillImportArtifact } from '@/features/skill-import/types';

const INDUSTRIES = ['电商', '跨境电商', '金融', '教育', '医疗', '通用'];
const POSITIONS = ['客服', '销售', '市场', '运营', '技术', '通用'];

const skillFormSchema = CapabilityUploadDtoSchema.pick({ name: true, description: true, industry: true, position: true }).extend({
  name: z.string().trim().pipe(CapabilityUploadDtoSchema.shape.name),
  description: z.string().trim().min(1, '描述不能为空')
    .max(CapabilityUploadDtoSchema.shape.description.maxLength ?? 2000),
});

type SkillFormValues = z.infer<typeof skillFormSchema>;

type UploadMetadata = {
  zipPath: string;
  sha256: string;
  fileCount: number;
  totalSize: number;
  filename: string;
  content: string;
  suggested?: { name: string | null; description: string | null };
  warnings?: Array<{ code: string; message: string; path?: string }>;
};

export function SkillForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [uploadMetadata, setUploadMetadata] = useState<UploadMetadata | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [createOutcomeUnknown, setCreateOutcomeUnknown] = useState(false);
  const uploadGeneration = useRef(0);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<SkillFormValues>({
    resolver: zodResolver(skillFormSchema),
    defaultValues: { name: '', description: '', industry: [], position: [] },
  });

  const applyArtifact = useCallback((artifact: SkillImportArtifact | null) => {
    uploadGeneration.current += 1;
    setUploadMetadata(artifact);
    setUploadError(null);
    if (!artifact) return;
    if (!getValues('name').trim() && artifact.suggested?.name) {
      setValue('name', artifact.suggested.name, { shouldValidate: true });
    }
    if (!getValues('description').trim() && artifact.suggested?.description) {
      setValue('description', artifact.suggested.description, { shouldValidate: true });
    }
  }, [getValues, setValue]);

  const createMutation = useMutation({
    retry: false,
    mutationFn: async (data: SkillFormValues & UploadMetadata) => {
      return api.post<{ id: string }>('/capabilities', {
          type: 'skill',
          name: data.name,
          description: data.description,
          industry: data.industry,
          position: data.position,
          inputSchema: {},
          outputSchema: {},
          metadata: {
            zipPath: data.zipPath,
            sha256: data.sha256,
            fileCount: data.fileCount,
            totalSize: data.totalSize,
            filename: data.filename,
          },
          skillConfig: { template: data.content, modelId: 'gpt-4o-mini', temperature: 0.7, maxTokens: 2000 },
      });
    },
    onSuccess: () => {
      toast.success('创建成功', '技能已进入平台待审，审核通过后才会公开');
      qc.invalidateQueries({ queryKey: ['capabilities'] });
      void qc.invalidateQueries({ queryKey: ['skill-versions'] });
      router.push('/admin/skills');
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status >= 500) setCreateOutcomeUnknown(true);
      toast.error('创建失败', err instanceof Error ? err.message : '请稍后重试');
    },
  });

  const uploadMutation = useMutation({
    retry: false,
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return uploadForm<UploadMetadata>('/admin/capabilities/upload-skill', formData);
    },
  });
  const handleFile = async (selectedFile: File) => {
    const generation = ++uploadGeneration.current;
    setUploadError(null);
    setUploadMetadata(null);
    try {
      const metadata = await uploadMutation.mutateAsync(selectedFile);
      if (generation !== uploadGeneration.current) return;
      setUploadMetadata(metadata);
      if (!getValues('name').trim() && metadata.suggested?.name) setValue('name', metadata.suggested.name, { shouldValidate: true });
      if (!getValues('description').trim() && metadata.suggested?.description) setValue('description', metadata.suggested.description, { shouldValidate: true });
      toast.success('上传成功', `已读取技能包，文件数: ${metadata.fileCount}`);
    } catch (err) {
      if (generation !== uploadGeneration.current) return;
      const message = err instanceof Error ? err.message : '请稍后重试';
      setUploadError(message);
      toast.error('上传失败', message);
    }
  };

  const onSubmit = (data: SkillFormValues) => {
    if (createOutcomeUnknown || createMutation.isPending) return;
    if (!uploadMetadata) {
      toast.error('请先导入技能包');
      return;
    }
    createMutation.mutate({
      ...data,
      zipPath: uploadMetadata.zipPath,
      sha256: uploadMetadata.sha256,
      fileCount: uploadMetadata.fileCount,
      totalSize: uploadMetadata.totalSize,
      filename: uploadMetadata.filename,
      content: uploadMetadata.content,
    });
  };

  const selectedIndustry = useWatch({ control, name: 'industry' }) || [];
  const selectedPosition = useWatch({ control, name: 'position' }) || [];

  const toggleIndustry = (ind: string) => {
    const current = selectedIndustry.includes(ind);
    setValue('industry', current ? selectedIndustry.filter((i) => i !== ind) : [...selectedIndustry, ind]);
  };

  const togglePosition = (pos: string) => {
    const current = selectedPosition.includes(pos);
    setValue('position', current ? selectedPosition.filter((p) => p !== pos) : [...selectedPosition, pos]);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <SkillImportPanel
        onArtifact={applyArtifact}
        onZipFile={(file) => void handleFile(file)}
        zipBusy={uploadMutation.isPending || createMutation.isPending}
        zipError={uploadError}
        zipArtifact={uploadMetadata}
      />

      {createOutcomeUnknown && <p role="alert" className="text-sm text-amber-700">创建结果尚未确认，请先到技能列表核对，避免重复创建。</p>}

      <Card>
        <CardHeader>
          <CardTitle>3. 能力信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">能力名称</Label>
            <Input id="name" maxLength={100} placeholder="例如：前端代码生成助手" {...register('name')} />
            {errors.name && <p className="text-sm text-red-600">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">能力描述</Label>
            <Textarea
              id="description"
              placeholder="详细描述该 SKILL 的功能和用途"
              rows={4}
              maxLength={2000}
              {...register('description')}
            />
            {errors.description && <p className="text-sm text-red-600">{errors.description.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>适用行业（可多选）</Label>
            <div className="flex flex-wrap gap-2">
              {INDUSTRIES.map((ind) => (
                <button
                  key={ind}
                  type="button"
                  onClick={() => toggleIndustry(ind)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    selectedIndustry.includes(ind)
                      ? 'bg-primary text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {ind}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>适用岗位（可多选）</Label>
            <div className="flex flex-wrap gap-2">
              {POSITIONS.map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => togglePosition(pos)}
                  className={`px-3 py-1 rounded-full text-sm transition-colors ${
                    selectedPosition.includes(pos)
                      ? 'bg-primary text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting || createMutation.isPending}>
          取消
        </Button>
        <Button type="submit" disabled={isSubmitting || uploadMutation.isPending || createMutation.isPending || createOutcomeUnknown || !uploadMetadata}>
          {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          创建并进入平台待审
        </Button>
      </div>
    </form>
  );
}
