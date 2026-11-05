import { z } from 'zod';
import { EmployeeBundleStatus } from '@prisma/client';
export {
  BundleCopyDraftDtoSchema,
  BundleItemDtoSchema,
  CreateEmployeeBundleDtoSchema,
  EmployeeBundleCoverSchema,
  UpdateEmployeeBundleDtoSchema,
  type BundleCopyDraftDto,
  type CreateEmployeeBundleDto,
  type UpdateEmployeeBundleDto,
} from '../../shared/employee-bundle.dto';

export const GetEmployeeBundlesQuerySchema = z.object({
  status: z.nativeEnum(EmployeeBundleStatus).optional(),
});

export type GetEmployeeBundlesQuery = z.infer<typeof GetEmployeeBundlesQuerySchema>;
