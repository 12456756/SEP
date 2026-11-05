import { z } from 'zod';
import { CnyAmountSchema } from './index';

export const MAX_BUNDLE_COVER_SIZE = 5 * 1024 * 1024;

export const EmployeeBundleCoverSchema = z.union([
  z.string().trim().url(),
  z.string().trim().regex(
    /^\/api\/market\/bundles\/covers\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|jpeg|webp)$/,
    '套餐封面地址无效',
  ),
]).nullable();

export const BundleItemDtoSchema = z.object({
  employeeId: z.string().trim().min(1),
  periodMonths: z.number().int().min(1).max(36).optional(),
  includedComputeCNY: CnyAmountSchema.nullable().optional(),
});

export const CreateEmployeeBundleDtoSchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).optional(),
  cover: EmployeeBundleCoverSchema.optional(),
  priceCNY: CnyAmountSchema,
  periodMonths: z.number().int().min(1).max(36).default(12),
  items: z.array(BundleItemDtoSchema).min(1).max(100),
});

export const UpdateEmployeeBundleDtoSchema = CreateEmployeeBundleDtoSchema.partial();

export const BundleCopyDraftDtoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  employeeIds: z.array(z.string().trim().min(1)).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.employeeIds).size !== value.employeeIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['employeeIds'],
      message: '套餐员工不能重复',
    });
  }
});

export const BundleCopyDraftResponseSchema = z.object({
  draft: z.string().min(1),
  modelId: z.string().min(1),
  modelSource: z.literal('PLATFORM_DEFAULT'),
}).strict();

export const EmployeeBundleCoverResponseSchema = z.object({
  cover: EmployeeBundleCoverSchema.unwrap(),
}).strict();

export type CreateEmployeeBundleDto = z.infer<typeof CreateEmployeeBundleDtoSchema>;
export type UpdateEmployeeBundleDto = z.infer<typeof UpdateEmployeeBundleDtoSchema>;
export type BundleCopyDraftDto = z.infer<typeof BundleCopyDraftDtoSchema>;
export type BundleCopyDraftResponse = z.infer<typeof BundleCopyDraftResponseSchema>;
export type EmployeeBundleCoverResponse = z.infer<typeof EmployeeBundleCoverResponseSchema>;
