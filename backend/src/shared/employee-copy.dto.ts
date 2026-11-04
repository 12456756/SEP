import { z } from 'zod';

const EmployeeCopyContextSchema = z.object({
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(100).optional().default('通用'),
  position: z.string().trim().max(100).optional().default('通用'),
  capabilities: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().default(''),
  }).strict()).max(25),
}).strict();

export const EmployeeCopyDraftDtoSchema = z.object({
  kind: z.enum(['description', 'systemPrompt']),
  employee: EmployeeCopyContextSchema,
}).strict().superRefine((value, context) => {
  const capabilityTextSize = value.employee.capabilities.reduce(
    (size, capability) => size + capability.name.length + capability.description.length,
    0,
  );
  if (capabilityTextSize > 12000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['employee', 'capabilities'], message: '能力说明总长度不能超过 12000 个字符' });
  }
});

export type EmployeeCopyDraftDto = z.infer<typeof EmployeeCopyDraftDtoSchema>;

export const EmployeeCopyDraftResponseSchema = z.object({
  draft: z.string().min(1),
  modelId: z.string().min(1),
  modelSource: z.literal('PLATFORM_DEFAULT'),
}).strict();

export type EmployeeCopyDraftResponse = z.infer<typeof EmployeeCopyDraftResponseSchema>;
