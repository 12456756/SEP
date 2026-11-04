import { z } from "zod";

export const EMPLOYEE_GRANT_BATCH_LIMIT = 100;

const targetIds = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(EMPLOYEE_GRANT_BATCH_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, "授权对象不能重复");

export const GrantBatchCreateDtoSchema = z
  .object({
    memberIds: targetIds.optional(),
    departmentIds: targetIds.optional(),
    expiresAt: z.string().datetime().optional(),
    renewExpired: z.boolean().default(false),
  })
  .strict()
  .refine(
    (data) => Boolean(data.memberIds) !== Boolean(data.departmentIds),
    "请选择成员或部门，不能同时指定或都不指定",
  );

export type GrantBatchCreateDto = z.infer<typeof GrantBatchCreateDtoSchema>;

export interface GrantBatchResult {
  target: "member" | "department";
  createdIds: string[];
  renewedIds: string[];
  skippedIds: string[];
}

/** 成员中心按碳基员工维度批量授权的请求。 */
export const MemberGrantBatchCreateDtoSchema = z
  .object({
    subscriptionIds: targetIds,
    expiresAt: z.string().datetime().optional(),
    renewExpired: z.boolean().default(false),
  })
  .strict();

export type MemberGrantBatchCreateDto = z.infer<
  typeof MemberGrantBatchCreateDtoSchema
>;

export const MemberGrantCandidateQuerySchema = z
  .object({
    keyword: z.string().trim().max(100).optional(),
    status: z
      .enum(["all", "grantable", "granted", "history"])
      .default("grantable"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type MemberGrantCandidateQuery = z.infer<
  typeof MemberGrantCandidateQuerySchema
>;

export interface MemberGrantBatchResult {
  memberId: string;
  createdIds: string[];
  renewedSubscriptionIds: string[];
  skippedSubscriptionIds: string[];
}

export interface MemberEmployeeGrantCandidate {
  subscriptionId: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "EXPIRED" | "TERMINATED";
  endDate: string | null;
  employee: {
    id: string;
    name: string;
    avatar: string | null;
    position: string;
  };
  directGrant: {
    id: string;
    expiresAt: string | null;
    expired: boolean;
  } | null;
  coveredByDepartment: boolean;
}

export interface MemberEmployeeGrantCandidatesResponse {
  items: MemberEmployeeGrantCandidate[];
  page: number;
  pageSize: number;
  total: number;
}
