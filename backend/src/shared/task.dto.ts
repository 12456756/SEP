import { z } from 'zod';

export const TaskRunStatusSchema = z.enum(['draft','awaiting_confirmation','running','completed','failed','stopped']);
export const TaskStepStatusSchema = z.enum(['queued','running','completed','failed','skipped']);
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type TaskStepStatus = z.infer<typeof TaskStepStatusSchema>;
export const CapabilityTypeSchema = z.enum(['AGENT','RPA','SKILL','AI_APP']);
const EmployeeSchema = z.object({ id:z.string(), name:z.string(), description:z.string(), position:z.string(), industry:z.string(), avatar:z.string().nullable(), capabilities:z.array(z.object({id:z.string(),name:z.string(),description:z.string(),type:CapabilityTypeSchema})) });
export const TaskStepSchema = z.object({ id:z.string().min(1), order:z.number().int(), title:z.string(), description:z.string(), intent:z.string(), employee:EmployeeSchema, capability:z.object({id:z.string(),name:z.string(),description:z.string(),type:CapabilityTypeSchema}), dependsOn:z.array(z.string()), rationale:z.string(), estimatedSeconds:z.number(), status:TaskStepStatusSchema, progress:z.number().min(0).max(100), output:z.string().max(200000).optional(), error:z.string().optional(), startedAt:z.string().datetime().optional(), completedAt:z.string().datetime().optional(), durationMs:z.number().nonnegative().optional() });
export const StepsSchema = z.array(TaskStepSchema).min(1).max(50).superRefine((steps,ctx)=>{ const ids=new Set(steps.map(s=>s.id)); steps.forEach((s,i)=>s.dependsOn.forEach(d=>{if(!ids.has(d))ctx.addIssue({code:z.ZodIssueCode.custom,path:[i,'dependsOn'],message:`unknown dependency ${d}`});})); }).refine(v=>JSON.stringify(v).length<=2*1024*1024,'steps payload exceeds 2MB');
const CoordinateSchema = z.object({x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000)}).strict();
export const LayoutSchema = z.object({nodes:z.record(CoordinateSchema).default({}),endpoints:z.object({input:CoordinateSchema.optional(),output:CoordinateSchema.optional()}).strict().optional()}).strict();
export const PlannerSchema = z.object({type:z.string(),model:z.string()}).passthrough();
export const CreateTaskDtoSchema = z.object({objective:z.string().trim().min(1).max(4000),summary:z.string().optional(),steps:StepsSchema,layout:LayoutSchema.nullable().optional(),planner:PlannerSchema.optional(),status:TaskRunStatusSchema.optional()}).strict();
export const UpdateTaskDtoSchema = z.object({status:TaskRunStatusSchema.optional(),steps:StepsSchema.optional(),layout:LayoutSchema.nullable().optional(),startedAt:z.string().datetime().nullable().optional(),completedAt:z.string().datetime().nullable().optional(),expectedUpdatedAt:z.string().datetime().optional()}).strict();
export const StepPatchDtoSchema = z.object({status:TaskStepStatusSchema.optional(),progress:z.number().min(0).max(100).optional(),output:z.string().max(200000).optional(),error:z.string().optional(),startedAt:z.string().datetime().nullable().optional(),completedAt:z.string().datetime().nullable().optional(),durationMs:z.number().nonnegative().optional(),expectedUpdatedAt:z.string().datetime().optional()}).strict();
export const CreateTemplateDtoSchema = z.object({name:z.string().trim().min(1).max(64),objective:z.string().trim().min(1).max(4000),steps:StepsSchema,layout:LayoutSchema.nullable().optional()}).strict();
export const TaskQuerySchema = z.object({limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().optional(),scope:z.enum(['mine','enterprise']).default('mine'),status:z.union([TaskRunStatusSchema,z.array(TaskRunStatusSchema)]).optional(),keyword:z.string().trim().max(200).optional()});
export type CreateTaskDto=z.infer<typeof CreateTaskDtoSchema>; export type UpdateTaskDto=z.infer<typeof UpdateTaskDtoSchema>; export type StepPatchDto=z.infer<typeof StepPatchDtoSchema>; export type CreateTemplateDto=z.infer<typeof CreateTemplateDtoSchema>; export type TaskQuery=z.infer<typeof TaskQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 服务端执行引擎契约（阶段一 T1.4–T1.6）
//
// 执行原先跑在浏览器的 for 循环里，关标签页任务就死。搬到服务端后前端只
// 「下令 + 订阅」，不再持有执行状态。下面这组类型是前后端唯一的约定来源。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条交接记录：某个上游步骤把它的产出交给了当前步骤 */
export const TaskHandoffEntrySchema = z.object({
  fromStepKey: z.string(),
  fromStepTitle: z.string(),
  fromEmployeeName: z.string(),
  /** 交接内容摘要（前 400 字），全文在上游步骤的 output 里 */
  excerpt: z.string(),
  /** 交接内容的完整字符数，让「交接了多少」可量化 */
  chars: z.number().int().nonnegative(),
});
export type TaskHandoffEntry = z.infer<typeof TaskHandoffEntrySchema>;

/** 服务端权威的步骤状态。比前端旧的 TaskStepStatus 多一个 paused —— */
/** queued 表示「等依赖」，paused 表示「等人」，混用会让「为什么不动」无法回答。 */
export const TaskRunStepStatusSchema = z.enum(['queued','running','completed','failed','skipped','paused']);
export type TaskRunStepStatus = z.infer<typeof TaskRunStepStatusSchema>;

/** TaskRunStep 行的序列化形状 */
export const TaskRunStepViewSchema = z.object({
  stepKey: z.string(),
  order: z.number().int(),
  title: z.string(),
  description: z.string(),
  employee: z.object({ id: z.string(), name: z.string(), avatar: z.string().nullable() }),
  capability: z.object({ id: z.string(), name: z.string() }),
  skillVersionId: z.string().nullable(),
  dependsOn: z.array(z.string()),
  rationale: z.string(),
  estimatedSeconds: z.number().int(),
  status: TaskRunStepStatusSchema,
  /** 会议要求的「输入」：真正送进模型的 prompt 全文 */
  inputPrompt: z.string().nullable(),
  /** 会议要求的「交接内容」 */
  handoff: z.array(TaskHandoffEntrySchema),
  output: z.string().nullable(),
  error: z.string().nullable(),
  sessionId: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  attempt: z.number().int(),
});
export type TaskRunStepView = z.infer<typeof TaskRunStepViewSchema>;

export const TaskEventTypeSchema = z.enum([
  'RUN_CREATED','RUN_STARTED','RUN_COMPLETED','RUN_FAILED','RUN_STOPPED',
  'STEP_STARTED','STEP_COMPLETED','STEP_FAILED','STEP_SKIPPED',
  'STEP_PAUSED','STEP_RESUMED','PLAN_EDITED','STEP_HANDOFF','DELIVERABLE_READY',
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

export const TaskRunEventViewSchema = z.object({
  id: z.string(),
  type: TaskEventTypeSchema,
  stepId: z.string().nullable(),
  stepTitle: z.string().nullable(),
  employeeName: z.string().nullable(),
  message: z.string().nullable(),
  payload: z.unknown().nullable(),
  createdAt: z.string(),
});
export type TaskRunEventView = z.infer<typeof TaskRunEventViewSchema>;

/** GET /tasks/:id/execution —— 执行视角的运行详情 */
export const TaskExecutionSnapshotSchema = z.object({
  id: z.string(),
  objective: z.string(),
  summary: z.string(),
  status: TaskRunStatusSchema,
  steps: z.array(TaskRunStepViewSchema),
  deliverable: z.string().nullable(),
  deliverableGeneratedAt: z.string().nullable(),
  deliverableDegraded: z.boolean(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** worker 最近一次心跳；running 且心跳很旧说明可能已失联 */
  heartbeatAt: z.string().nullable(),
  stopRequested: z.boolean(),
  updatedAt: z.string(),
});
export type TaskExecutionSnapshot = z.infer<typeof TaskExecutionSnapshotSchema>;

/**
 * SSE 帧类型。
 *
 * 为什么不只推「状态变了，你自己去拉」：会议要求展示完整过程，包括每一步
 * 正在生成的内容。只推失效信号的话，进行中的步骤只能看到一个转圈图标。
 */
export type TaskStreamFrame =
  /** 连接建立后的首帧全量快照，前端据此初始化，之后只打补丁 */
  | { type: 'snapshot'; snapshot: TaskExecutionSnapshot }
  | { type: 'run_status'; status: TaskRunStatus; startedAt: string | null; completedAt: string | null }
  | {
      type: 'step_status';
      stepKey: string;
      status: TaskRunStepStatus;
      startedAt?: string | null;
      completedAt?: string | null;
      durationMs?: number | null;
      error?: string | null;
      attempt?: number;
      sessionId?: string | null;
    }
  /** 模型流式增量。前端按 stepKey 累加，用于「正在写」的实时效果 */
  | { type: 'step_delta'; stepKey: string; delta: string }
  /** 步骤最终产出（落库后的全文）。到达后前端丢弃累加的增量改用这份 */
  | { type: 'step_output'; stepKey: string; output: string }
  | { type: 'step_input'; stepKey: string; inputPrompt: string; handoff: TaskHandoffEntry[] }
  | { type: 'tool'; stepKey: string; name: string; phase: 'start' | 'end'; success?: boolean; durationMs?: number }
  | { type: 'event'; event: TaskRunEventView }
  | { type: 'deliverable'; deliverable: string; degraded: boolean; generatedAt: string }
  /** 保活帧，同时携带 worker 心跳，前端据此判断「还活着」 */
  | { type: 'ping'; heartbeatAt: string | null };

export const RunTaskDtoSchema = z
  .object({
    /** 从哪个步骤开始（含）。省略 = 从第一个未完成步骤开始 */
    fromStepKey: z.string().optional(),
  })
  .strict();
export type RunTaskDto = z.infer<typeof RunTaskDtoSchema>;
