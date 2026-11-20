import type { ContributionCapability } from '@/lib/types';

/**
 * 能力发布流程的唯一真相。
 *
 * 列表页的迷你轨道与详情页的时间轴都必须调用 buildPipeline()。
 * 重构前两处各有一套进度算法（列表硬编码 54%，详情按节点算 67%），
 * 同一个能力在两个页面显示不同进度。共用一个模型让这种不一致不可能发生。
 */

export type StageKey = 'draft' | 'validate' | 'enterprise' | 'authorize' | 'platform' | 'market';

export type StageState = 'done' | 'active' | 'waiting' | 'blocked';

export type ActorKind = 'contributor' | 'enterprise-admin' | 'platform-ops' | 'system' | 'market';

export type StageAction =
  | 'submit-enterprise'
  | 'approve'
  | 'reject'
  | 'request-platform'
  | 'authorize-platform';

export interface StageCta {
  action: StageAction;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
}

export interface StageActor {
  kind: ActorKind;
  label: string;
}

export interface PipelineStage {
  key: StageKey;
  title: string;
  state: StageState;
  actor: StageActor;
  /** 一句话事实，主语是真实经办人 */
  fact: string;
  at: string | null;
  /** active 状态下的等待天数 */
  waitingDays: number | null;
  /** blocked 状态下的驳回原因 */
  rejection: string | null;
  /** 仅当轮到当前用户操作时非空 */
  ctas: StageCta[];
}

export interface PipelineModel {
  stages: PipelineStage[];
  /** 0-based，指向第一个非 done 节点；全部完成时指向最后一个 */
  currentIndex: number;
  total: number;
  current: PipelineStage;
  /** 当前节点是否在等待当前用户操作 */
  ballInCourt: boolean;
}

export interface PipelineContext {
  hasEnterprise: boolean;
  isContributor: boolean;
  isEnterpriseAdmin: boolean;
}

const ACTOR_SYSTEM: StageActor = { kind: 'system', label: '系统' };
const ACTOR_ENTERPRISE_ADMIN: StageActor = { kind: 'enterprise-admin', label: '企业管理员' };
const ACTOR_PLATFORM_OPS: StageActor = { kind: 'platform-ops', label: '平台运营' };
const ACTOR_MARKET: StageActor = { kind: 'market', label: '元机AI人才市场' };

export const STAGE_SHORT_LABEL: Record<StageKey, string> = {
  draft: '草稿',
  validate: '校验',
  enterprise: '企业',
  authorize: '授权',
  platform: '平台',
  market: '上架',
};

function daysSince(value: string | null): number | null {
  if (!value) return null;
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return Math.floor(elapsed / 86_400_000);
}

function contributorActor(item: ContributionCapability, isContributor: boolean): StageActor {
  if (isContributor) return { kind: 'contributor', label: '你' };
  return { kind: 'contributor', label: item.contributor.name || item.contributor.email };
}

function draftStage(item: ContributionCapability, ctx: PipelineContext): PipelineStage {
  const actor = contributorActor(item, ctx.isContributor);
  const scope = ctx.hasEnterprise
    ? `归属 ${item.enterprise?.name ?? '企业工作区'}`
    : '归属贡献者本人';
  return {
    key: 'draft',
    title: ctx.hasEnterprise ? '创建能力草稿' : '创建个人草稿',
    state: 'done',
    actor,
    fact: `${actor.label} 起草了这项能力 · ${scope}`,
    at: item.createdAt,
    waitingDays: null,
    rejection: null,
    ctas: [],
  };
}

function validateStage(item: ContributionCapability): PipelineStage {
  const done = Boolean(item.validatedAt);
  return {
    key: 'validate',
    title: '自动校验',
    state: done ? 'done' : 'active',
    actor: ACTOR_SYSTEM,
    fact: done ? '系统已校验输入输出结构与安全边界' : '系统正在校验输入输出结构与安全边界',
    at: item.validatedAt,
    waitingDays: done ? null : daysSince(item.createdAt),
    rejection: null,
    // 系统在跑，球不在用户手里
    ctas: [],
  };
}

function enterpriseStage(item: ContributionCapability, ctx: PipelineContext): PipelineStage {
  const base = {
    key: 'enterprise' as const,
    title: '企业管理员审核',
    actor: ACTOR_ENTERPRISE_ADMIN,
    at: item.enterpriseReviewedAt,
  };
  switch (item.enterpriseReviewStatus) {
    case 'APPROVED':
      return { ...base, state: 'done', fact: '企业管理员 已通过审核', waitingDays: null, rejection: null, ctas: [] };
    case 'PENDING':
      return {
        ...base,
        state: 'active',
        fact: '企业管理员 正在审核这项能力',
        waitingDays: daysSince(item.validatedAt ?? item.createdAt),
        rejection: null,
        ctas: ctx.isEnterpriseAdmin
          ? [
              { action: 'approve', label: '企业通过', tone: 'primary' },
              { action: 'reject', label: '驳回', tone: 'danger' },
            ]
          : [],
      };
    case 'REJECTED':
      return {
        ...base,
        state: 'blocked',
        fact: '企业管理员 驳回了这项能力',
        waitingDays: null,
        rejection: item.enterpriseRejectionReason,
        ctas: ctx.isContributor ? [{ action: 'submit-enterprise', label: '修改后重新提交', tone: 'primary' }] : [],
      };
    default:
      return {
        ...base,
        state: 'waiting',
        fact: '等待提交企业审核',
        waitingDays: null,
        rejection: null,
        ctas: ctx.isContributor ? [{ action: 'submit-enterprise', label: '提交企业审核', tone: 'primary' }] : [],
      };
  }
}

function authorizeStage(item: ContributionCapability, ctx: PipelineContext): PipelineStage {
  const base = {
    key: 'authorize' as const,
    title: '授权公开投稿',
    actor: ACTOR_ENTERPRISE_ADMIN,
    at: item.platformSubmittedAt,
    rejection: null,
  };
  if (item.platformReviewStatus === 'REQUESTED') {
    return {
      ...base,
      state: 'active',
      fact: '等待 企业管理员 授权提交平台审核',
      waitingDays: daysSince(item.enterpriseReviewedAt),
      ctas: ctx.isEnterpriseAdmin ? [{ action: 'authorize-platform', label: '授权平台审核', tone: 'primary' }] : [],
    };
  }
  if (item.platformReviewStatus === 'PENDING_REVIEW' || item.platformReviewStatus === 'APPROVED') {
    return { ...base, state: 'done', fact: '企业管理员 已授权提交平台审核', waitingDays: null, ctas: [] };
  }
  const unlocked = item.enterpriseReviewStatus === 'APPROVED';
  return {
    ...base,
    state: 'waiting',
    fact: unlocked ? '可以申请把这项能力公开到市场' : '企业审核通过后开放',
    waitingDays: null,
    ctas: unlocked && ctx.isContributor ? [{ action: 'request-platform', label: '申请公开投稿', tone: 'secondary' }] : [],
  };
}

function platformStage(item: ContributionCapability, ctx: PipelineContext): PipelineStage {
  const base = {
    key: 'platform' as const,
    title: '平台运营审核',
    actor: ACTOR_PLATFORM_OPS,
    at: item.platformSubmittedAt,
  };
  switch (item.platformReviewStatus) {
    case 'APPROVED':
      return { ...base, state: 'done', fact: '平台运营 已通过审核', waitingDays: null, rejection: null, ctas: [] };
    case 'PENDING_REVIEW':
      return {
        ...base,
        state: 'active',
        fact: '平台运营 正在评估这项能力',
        waitingDays: daysSince(item.platformSubmittedAt),
        rejection: null,
        ctas: [],
      };
    case 'REJECTED':
      return {
        ...base,
        state: 'blocked',
        fact: '平台运营 驳回了这项能力',
        waitingDays: null,
        rejection: item.platformRejectionReason,
        ctas: ctx.isContributor ? [{ action: 'request-platform', label: '修改后重新提交', tone: 'primary' }] : [],
      };
    default:
      // 个人路径没有企业授权环节，提交平台审核的球直接在贡献者手里
      return {
        ...base,
        state: 'waiting',
        fact: ctx.hasEnterprise ? '企业授权后进入平台审核' : '等待提交平台审核',
        waitingDays: null,
        rejection: null,
        ctas: !ctx.hasEnterprise && ctx.isContributor
          ? [{ action: 'request-platform', label: '提交平台审核', tone: 'primary' }]
          : [],
      };
  }
}

function marketStage(item: ContributionCapability): PipelineStage {
  const listed = item.platformReviewStatus === 'APPROVED';
  return {
    key: 'market',
    title: '上架元机AI人才市场',
    state: listed ? 'done' : 'waiting',
    actor: ACTOR_MARKET,
    fact: listed ? '市场用户可以发现并使用这项能力' : '通过平台审核后所有企业可以雇佣',
    at: null,
    waitingDays: null,
    rejection: null,
    ctas: [],
  };
}

export function buildPipeline(item: ContributionCapability, ctx: PipelineContext): PipelineModel {
  const stages: PipelineStage[] = ctx.hasEnterprise
    ? [
        draftStage(item, ctx),
        validateStage(item),
        enterpriseStage(item, ctx),
        authorizeStage(item, ctx),
        platformStage(item, ctx),
        marketStage(item),
      ]
    : [draftStage(item, ctx), validateStage(item), platformStage(item, ctx), marketStage(item)];

  // SKILL 的正文投稿、企业授权和平台申请已迁移到客户端/运营监控；Web 只读历史流程。
  if (item.type === 'SKILL') {
    for (const stage of stages) stage.ctas = [];
  }

  const blockedIndex = stages.findIndex((stage) => stage.state === 'blocked');
  const activeIndex = stages.findIndex((stage) => stage.state === 'active');
  const waitingIndex = stages.findIndex((stage) => stage.state === 'waiting');
  const firstOpen = [blockedIndex, activeIndex, waitingIndex].find((index) => index >= 0);
  const currentIndex = firstOpen ?? stages.length - 1;
  const current = stages[currentIndex];

  return {
    stages,
    currentIndex,
    total: stages.length,
    current,
    ballInCourt: current.ctas.length > 0,
  };
}

/** 「第 N/M 步 · 步骤名」——取代重构前的百分比 */
export function pipelineStepLabel(model: PipelineModel): string {
  const done = model.stages.every((stage) => stage.state === 'done');
  if (done) return `已完成 ${model.total}/${model.total} 步`;
  return `第 ${model.currentIndex + 1}/${model.total} 步 · ${model.current.title}`;
}

/**
 * 轨道看板的列归属。
 *
 * 不能直接用 current.key：draft 恒为 done，所以 currentIndex 永远不会指向它，
 * 「已校验但还没提交审核」的能力会落进「企业审核」列，看起来像已经提交了。
 * 这里把「等待用户提交」的情况归回草稿列。
 */
export function boardLane(model: PipelineModel): StageKey {
  const { current } = model;
  if (current.key === 'validate') return 'validate';
  if (current.key === 'enterprise') return current.state === 'active' ? 'enterprise' : 'draft';
  if (current.key === 'platform') {
    if (current.state === 'waiting') return model.total === 4 ? 'draft' : 'authorize';
    return 'platform';
  }
  return current.key;
}

/** 「平台运营 处理中 · 已等 2 天」 */
export function pipelineWaitLabel(model: PipelineModel): string | null {
  const { current } = model;
  if (current.state === 'blocked') {
    // 被驳回且需要本人修改时，不能只说「已驳回」——那会把「该你动手」这个信号丢掉
    return model.ballInCourt ? `${current.actor.label} 已驳回 · 待你修改` : `${current.actor.label} 已驳回`;
  }
  if (current.state !== 'active' && current.state !== 'waiting') return null;
  const days = current.waitingDays;
  const suffix = days !== null && days > 0 ? ` · 已等 ${days} 天` : '';
  if (model.ballInCourt) return `轮到你处理${suffix}`;
  if (current.state === 'active') return `${current.actor.label} 处理中${suffix}`;
  return `等待 ${current.actor.label}`;
}
