/**
 * 全站中文文案单一来源。
 *
 * 规则（详见 docs/plans/2026-08-10-术语规范与拟人化方案.md）：
 * 1. 组件里不写死中文，一律引用此处的 key
 * 2. 只改展示层 —— 数据库枚举值与 API 字段名保持不变，
 *    状态文案通过映射表转换（ACTIVE → 工作中），不动枚举本身
 * 3. 核心叙事是「硅基 / 碳基」对比：硅基员工 = 数字员工，碳基员工 = 真人
 *
 * 未引入 i18n 库是有意的：当前只有中文，一个 as const 常量文件
 * 已经拿到集中管理与类型安全。将来真要多语言再迁移，成本不变。
 */

/** 硅基员工（原「数字员工」） */
export const employee = {
  entity: '硅基员工',
  market: '元机AI人才市场',
  mine: '我的员工',
  /** 企业与某个硅基员工的雇佣关系（后端 Subscription），展示层就叫「硅基员工」 */
  unit: '硅基员工',
  /** 管理员页：把硅基员工授权给碳基员工使用 */
  grantConfig: '员工授权',

  // 操作动词 —— 全部对齐真实招聘场景
  hire: '立即招聘',
  hireConfirm: '确认招聘',
  dismiss: '解聘',
  onboard: '上岗',
  pause: '暂停工作',
  addUnit: '新增硅基员工',
  manageUnit: '管理硅基员工',
  /** 单个硅基员工的终态回收，区别于「解除雇佣」（后者是整个模板的雇佣关系） */
  recycle: '回收席位',

  /**
   * 市场卡片上的招聘状态装饰文案。
   *
   * 与 subscriptionStatus 无关 —— 那个描述「本企业与某员工的雇佣关系」，
   * 这里描述「这位员工在市场上可不可招」，别再借用状态映射表。
   */
  hireable: '可雇佣',
} as const;

/**
 * 雇佣关系（代码层仍是 Subscription）。
 *
 * 「订阅」是 SaaS 词汇，与硅基/碳基的人格化叙事冲突，展示层统一说「雇佣」。
 */
export const employment = {
  entity: '雇佣关系',
  section: '雇佣管理',
  description: '一位硅基员工雇佣后，可在「员工授权」把 TA 分配给不同部门的碳基员工使用。',
  release: '解除雇佣',
  releaseConfirm: (name: string, refundAmount: number) =>
    refundAmount > 0
      ? `解除与「${name}」的雇佣关系后，TA 名下所有授权将不可用，且无法再新增。当前仍在 7 天试用期内，将全额退款 ¥${refundAmount.toFixed(2)} 到企业钱包；赠送算力不折现。已沉淀的技能与知识保留。确定解除？`
      : `解除与「${name}」的雇佣关系后，TA 名下所有授权将不可用，且无法再新增。当前已超过 7 天试用期，本次不退款；剩余赠送算力也会失效。已沉淀的技能与知识保留。确定解除？`,
  unitCount: (n: number) => `${n} 位在岗`,
  empty: '尚未雇佣任何硅基员工',
} as const;

/** 碳基员工（真人成员） */
export const member = {
  entity: '碳基员工',
  list: '碳基员工',
  invite: '邀请新成员',
  remove: '移出企业',
  /** 用户不归属任何企业时的状态 */
  unaffiliated: '未归属企业',
} as const;

/** 技能（代码层仍是 Capability） */
export const capability = {
  entity: '技能',
  config: '技能配置',
  grant: '赋予技能',
  revoke: '撤销技能',
  store: '技能商店',
  contribute: '贡献技能',
  /** 硅基员工已具备的技能清单（原「绑定能力」） */
  ownedList: '已掌握技能',
  downloadPack: '下载技能包',
  /** 会议决策：企业侧下载的是客户端，不是散装技能文件。
   *  客户端产物尚未实现，此文案先在市场页/详情页占位使用 */
  downloadClient: '下载企业客户端',
} as const;

export const knowledge = {
  entity: '知识库',
  /** 企业级批量维护入口 */
  management: '知识库',
  /** 挂在硅基员工下的主入口（决策 2） */
  grantToEmployee: '知识库授权',
  grantTarget: '授权给硅基员工',
} as const;

/**
 * 雇佣关系状态。key 为后端 SubscriptionStatus 枚举值，不可改动。
 *
 * 收敛后 InstanceStatus 已并入此枚举（PENDING_ACTIVATION→ACTIVE、
 * SUSPENDED→PAUSED、REVOKED→EXPIRED），另有 TERMINATED 作为试用期解聘终态。
 * 措辞取雇佣视角而非订阅视角 —— 企业看到的是「这个员工在不在岗」。
 * EXPIRED / TERMINATED 是终态，不可转回。
 */
export const subscriptionStatus: Record<string, string> = {
  ACTIVE: '工作中',
  PAUSED: '已暂停',
  EXPIRED: '已解聘',
  TERMINATED: '已解聘',
};

/** 拟人化提示文案 */
export const messages = {
  hireSuccess: '招聘成功！该硅基员工已加入贵司，前往「我的员工」安排上岗',
  onboardConfirm: '确定让该硅基员工上岗工作吗？',
  /** 特意点出技能保留 —— 这是「员工走了，能力留在企业」的核心卖点 */
  dismissConfirm: '解聘后该硅基员工将从企业移除，已沉淀的技能与知识保留。确定解聘？',
  emptyEmployees: '您还未招聘硅基员工，前往「元机AI人才市场」挑选合适人选',
  emptyUnits: '尚未配置硅基员工，招聘后可授权给各部门的碳基员工使用',
  unaffiliatedHint: '您当前未归属任何企业，请等待企业邀请或创建企业',
  memberLeftNotice: (name: string) => `${name} 已解除与贵司的归属关系`,
} as const;

/** 导航菜单 */
export const nav = {
  dashboard: '工作台',
  departments: '部门管理',
  members: member.list,
  // 侧边栏入口：普通成员的核心页面。组标题已收敛为「员工」，
  // 这里用「硅基员工」点明是数字员工（区别于上方「碳基员工」）。
  myEmployees: employee.entity,
  marketplace: employee.market,
  subscriptions: employment.section,
  chat: '对话中心',
  // 会议决议：「任务中心」改成更贴近用户的「工作安排」，并减少「自动编排」这类
  // 技术化表达。术语对照见 docs/plans/2026-08-31-会议7五决策落地开发方案.md 附录 B。
  tasks: '工作安排',
  // 会议决议：对外避免「监控」。会议给的词是「能力迭代」，但决策 1 同时要求
  // 「减少技术化表达」——「迭代」正是技术词，故改叫「技能库」，与同组的「知识库」
  // 对称（技能资产 / 文档资产）。企业内部改技能（这个）与
  // 向平台投稿（contributions）拆成两个入口，回应「目录过度收拢」的批评。
  capabilities: '技能库',
  contributions: '能力贡献中心',
  knowledge: knowledge.management,
  // 会议决议：三个「钱」相关页面各回答一个问题 —— 企业钱包（还有多少钱）、
  // 算力余额（算力还剩多少、怎么分的）、用量分析（花出去的钱怎么分布）。
  usage: '用量分析',
  personalSettings: '个人设置',
} as const;

/** 通用术语 */
export const common = {
  actions: {
    submit: '提交',
    cancel: '取消',
    confirm: '确定',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    search: '搜索',
    filter: '筛选',
    reset: '重置',
    create: '新建',
    update: '更新',
    close: '关闭',
    back: '返回',
    next: '下一步',
    prev: '上一步',
  },
  status: {
    /** 运营端：平台审核内容（能力/员工/技能审核队列） */
    pendingReview: '待审核',
    /** 企业端：企业内部审批流（成员申请、订阅申请） */
    pendingApproval: '待审批',
    active: '进行中',
    completed: '已完成',
    failed: '失败',
    loading: '加载中',
    success: '成功',
    error: '错误',
  },
  empty: {
    noData: '暂无数据',
    noResult: '没有匹配的结果',
    tryOtherKeywords: '试试放宽筛选条件或换个关键词',
    notYet: (entity: string) => `尚未${entity}`,
  },
  feedback: {
    saveSuccess: '保存成功',
    saveFailed: '保存失败',
    deleteSuccess: '删除成功',
    deleteFailed: '删除失败',
    updateSuccess: '更新成功',
    updateFailed: '更新失败',
    createSuccess: '创建成功',
    createFailed: '创建失败',
    operationSuccess: '操作成功',
    operationFailed: '操作失败',
    deleteConfirm: '确定删除吗？此操作不可撤销。',
    loading: '处理中...',
  },
  search: {
    placeholder: '搜索...',
    noResult: '未找到匹配项',
  },
} as const;

/** 表格通用列名 */
export const table = {
  columns: {
    name: '名称',
    status: '状态',
    type: '类型',
    description: '描述',
    createdAt: '创建时间',
    updatedAt: '更新时间',
    actions: '操作',
    creator: '创建人',
    owner: '所有者',
  },
} as const;

export const zhCN = {
  employee,
  employment,
  member,
  capability,
  knowledge,
  subscriptionStatus,
  messages,
  nav,
  common,
  table,
} as const;

export default zhCN;
