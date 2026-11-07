import { z } from "zod";
import { SkillContentSchema } from './skill-content-schema';
import { CnyAmountSchema } from './cny-amount';
export { CnyAmountSchema } from './cny-amount';
export { RefundDepositDtoSchema } from './refund-deposit.dto';
export type { RefundDepositDto } from './refund-deposit.dto';
export * from './skill-content-schema';
import type { EmployeeAvatarAsset } from './employee-avatar';
export type { EmployeeAvatarAsset } from './employee-avatar';
export * from './task.dto';
export * from './client-task.dto';
export * from './notification.dto';
export * from './media.dto';
export * from './media-spec.dto';
export * from './media-video.dto';
export * from './media-video-config.dto';
export * from './media-video-real.dto';

// ============================================================================
// Model Catalog —— 已删除（2026-09-05）
// ----------------------------------------------------------------------------
// 这里原来有一份硬编码的 MODEL_CATALOG 和 isKnownModelId()。删掉的理由：
//
//  1. **没有任何代码读它**（全仓 grep 只有定义处），却让人以为它是模型白名单；
//  2. **内容已经是错的**：里面列着 gpt-4o / gpt-4o-mini / claude-sonnet-5 等，
//     而中转（sub2api）2026-09-05 实测只提供 gemini-* 一族，那些 ID 一律
//     404 model_not_found。一份没人读、又与上游不符的清单只会误导下一个人。
//
// 真正的白名单是 `platform_models` 表：`ModelService.syncFromUpstream()` 从
// GET /v1/models 拉全量、新模型默认 enabled=false、上游消失的标 isStale。
// 「这个模型能不能用」由 `POST /models/:id/test` 回答（按**流式**测，见该方法）。
// 价格仍在下方 MODEL_PRICING，未配价的走 FALLBACK_PRICING 保底。
// ============================================================================

/**
 * 系统默认模型（与 .env 的 SUB2API_DEFAULT_MODEL 保持一致）。
 *
 * 两个硬约束，都踩过：
 *  1. **必须支持 function calling** —— 员工未指定 modelId 时会落到这里，
 *     默认模型不支持 tools 的话，所有绑定了能力的员工都会因上游 400 而失败。
 *     实测 deepseek 系不支持，gemini 系支持。
 *  2. **必须支持流式** —— 对话链路只走 streamText。中转存在「非流式能回、
 *     流式一个字节都不回」的模型（2026-09-05 实测 14 个里 6 个如此，
 *     `gemini-3.5-flash` 就是其中一个），选到那种模型的表现是前端
 *     「正在输入」永不结束。换默认值前先用 `POST /models/:id/test` 验一遍，
 *     那个接口现在就是按流式测的。
 */
export const DEFAULT_MODEL_ID = "gemini-3.5-flash-high";

// ============================================================================
// System Settings (可在管理端配置的运行时设置)
// ----------------------------------------------------------------------------
// 运行时优先读 SystemSetting 表，未配置时回退 .env。
// secret=true 的项加密存储，接口永不回传明文。
// ============================================================================

export * from './model-runtime-policy';
export const UpdateSettingsDtoSchema = z.record(z.string(), z.string());
export type UpdateSettingsDto = z.infer<typeof UpdateSettingsDtoSchema>;

/**
 * 汇率默认值。真实生效值优先取系统设置（SETTING_KEYS.USD_TO_CNY_RATE），
 * 由调用方通过 calculateCost 的 rate 参数传入；此常量仅作兜底。
 * 汇率会波动，硬编码会导致改一次就要重新构建部署，故做成可配置项。
 */
export const DEFAULT_USD_TO_CNY_RATE = 7.2;

/** @deprecated 用 DEFAULT_USD_TO_CNY_RATE，或从系统设置读取生效值。 */
export const USD_TO_CNY_RATE = DEFAULT_USD_TO_CNY_RATE;

export const SETTING_KEYS = {
  SUB2API_BASE_URL: "SUB2API_BASE_URL",
  SUB2API_API_KEY: "SUB2API_API_KEY",
  SUB2API_DEFAULT_MODEL: "SUB2API_DEFAULT_MODEL",
  MEDIA_BASE_URL: "MEDIA_BASE_URL",
  MEDIA_API_KEY: "MEDIA_API_KEY",
  MEDIA_VIDEO_BASE_URL: "MEDIA_VIDEO_BASE_URL",
  MEDIA_VIDEO_API_KEY: "MEDIA_VIDEO_API_KEY",
  /** 美元→人民币汇率。模型单价以 USD 计，计费入账以 CNY 计。 */
  USD_TO_CNY_RATE: "USD_TO_CNY_RATE",
  /** 客户端实例令牌有效期（分钟）。建议初值 15。 */
  CLIENT_TOKEN_TTL_MINUTES: "CLIENT_TOKEN_TTL_MINUTES",
  // 平台基础信息
  PLATFORM_NAME: "PLATFORM_NAME",
  PLATFORM_LOGO_URL: "PLATFORM_LOGO_URL",
  SUPPORT_EMAIL: "SUPPORT_EMAIL",
  SUPPORT_PHONE: "SUPPORT_PHONE",
  ICP_NUMBER: "ICP_NUMBER",
  // 计费配置
  /** 未配价模型的保底单价（元 / 1K tokens）。留空则回退「已知模型最高单价」。 */
  FALLBACK_PRICE_INPUT: "FALLBACK_PRICE_INPUT",
  FALLBACK_PRICE_OUTPUT: "FALLBACK_PRICE_OUTPUT",
  /** 新员工「订阅赠送算力（元）」默认值。员工级 includedComputeCNY 为 null 时用它。 */
  DEFAULT_EMPLOYEE_GIFT_CNY: "DEFAULT_EMPLOYEE_GIFT_CNY",
  /** 员工年费的默认赠送比例；仅员工级赠送金额为 null 时生效。 */
  DEFAULT_EMPLOYEE_GIFT_PERCENTAGE: "DEFAULT_EMPLOYEE_GIFT_PERCENTAGE",
  /** 低余额告警阈值（元）。口径统一为人民币，不再是 tokens。 */
  LOW_BALANCE_THRESHOLD: "LOW_BALANCE_THRESHOLD",
  // 安全与限制
  MAX_TOKENS_PER_CONVERSATION: "MAX_TOKENS_PER_CONVERSATION",
  MAX_CONCURRENT_SESSIONS: "MAX_CONCURRENT_SESSIONS",
  ADMIN_IP_WHITELIST: "ADMIN_IP_WHITELIST",
  // 注册与审核
  ENTERPRISE_REGISTRATION_APPROVAL: "ENTERPRISE_REGISTRATION_APPROVAL",
  SEND_WELCOME_EMAIL: "SEND_WELCOME_EMAIL",
  // 内容审核
  CONTENT_FILTER_ENABLED: "CONTENT_FILTER_ENABLED",
  // 数据保留
  CONVERSATION_RETENTION_DAYS: "CONVERSATION_RETENTION_DAYS",
  OPERATION_LOG_RETENTION_DAYS: "OPERATION_LOG_RETENTION_DAYS",
  SOFT_DELETE_RETENTION_DAYS: "SOFT_DELETE_RETENTION_DAYS",
  // 性能与缓存
  REDIS_CACHE_ENABLED: "REDIS_CACHE_ENABLED",
  CONVERSATION_CACHE_TTL: "CONVERSATION_CACHE_TTL",
  MODEL_RESPONSE_TIMEOUT: "MODEL_RESPONSE_TIMEOUT",
  // 通知配置
  ADMIN_NOTIFICATION_EMAIL: "ADMIN_NOTIFICATION_EMAIL",
  ABNORMAL_USAGE_THRESHOLD: "ABNORMAL_USAGE_THRESHOLD",
  SYSTEM_MAINTENANCE_NOTICE: "SYSTEM_MAINTENANCE_NOTICE",
  CONTRIBUTION_REWARDS_ENABLED: "CONTRIBUTION_REWARDS_ENABLED",
  CONTRIBUTION_ENTERPRISE_REWARD_CNY: "CONTRIBUTION_ENTERPRISE_REWARD_CNY",
  CONTRIBUTION_PLATFORM_REWARD_CNY: "CONTRIBUTION_PLATFORM_REWARD_CNY",
  // 认证中心（运营端可动态配置）
  MAIL_ENABLED: "MAIL_ENABLED",
  MAIL_HOST: "MAIL_HOST",
  MAIL_PORT: "MAIL_PORT",
  MAIL_SECURE: "MAIL_SECURE",
  MAIL_USER: "MAIL_USER",
  MAIL_PASSWORD: "MAIL_PASSWORD",
  MAIL_FROM: "MAIL_FROM",
  MAIL_FROM_NAME: "MAIL_FROM_NAME",
  WECHAT_OAUTH_ENABLED: "WECHAT_OAUTH_ENABLED",
  DINGTALK_OAUTH_ENABLED: "DINGTALK_OAUTH_ENABLED",
  DINGTALK_CLIENT_ID: "DINGTALK_CLIENT_ID",
  DINGTALK_CLIENT_SECRET: "DINGTALK_CLIENT_SECRET",
  DINGTALK_REDIRECT_URI: "DINGTALK_REDIRECT_URI",
  DINGTALK_SCOPE: "DINGTALK_SCOPE",
  WECHAT_APP_ID: "WECHAT_APP_ID",
  WECHAT_APP_SECRET: "WECHAT_APP_SECRET",
  WECHAT_REDIRECT_URI: "WECHAT_REDIRECT_URI",
  QQ_OAUTH_ENABLED: "QQ_OAUTH_ENABLED",
  QQ_APP_ID: "QQ_APP_ID",
  QQ_APP_KEY: "QQ_APP_KEY",
  QQ_REDIRECT_URI: "QQ_REDIRECT_URI",
  AUTH_MAX_FAILED_ATTEMPTS: "AUTH_MAX_FAILED_ATTEMPTS",
  AUTH_LOCK_MINUTES: "AUTH_LOCK_MINUTES",
  AUTH_RATE_LOGIN_IP_LIMIT: "AUTH_RATE_LOGIN_IP_LIMIT",
  AUTH_RATE_LOGIN_IP_WINDOW_SECONDS: "AUTH_RATE_LOGIN_IP_WINDOW_SECONDS",
  AUTH_RATE_LOGIN_ACCOUNT_LIMIT: "AUTH_RATE_LOGIN_ACCOUNT_LIMIT",
  AUTH_RATE_LOGIN_ACCOUNT_WINDOW_SECONDS: "AUTH_RATE_LOGIN_ACCOUNT_WINDOW_SECONDS",
  AUTH_RATE_PASSWORD_RESET_EMAIL_LIMIT: "AUTH_RATE_PASSWORD_RESET_EMAIL_LIMIT",
  AUTH_RATE_PASSWORD_RESET_EMAIL_WINDOW_SECONDS: "AUTH_RATE_PASSWORD_RESET_EMAIL_WINDOW_SECONDS",
  AUTH_RATE_PASSWORD_RESET_IP_LIMIT: "AUTH_RATE_PASSWORD_RESET_IP_LIMIT",
  AUTH_RATE_PASSWORD_RESET_IP_WINDOW_SECONDS: "AUTH_RATE_PASSWORD_RESET_IP_WINDOW_SECONDS",
  AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_LIMIT: "AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_LIMIT",
  AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_WINDOW_SECONDS: "AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_WINDOW_SECONDS",
  AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_LIMIT: "AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_LIMIT",
  AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_WINDOW_SECONDS: "AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_WINDOW_SECONDS",
  AUTH_RATE_EMAIL_VERIFICATION_USER_LIMIT: "AUTH_RATE_EMAIL_VERIFICATION_USER_LIMIT",
  AUTH_RATE_EMAIL_VERIFICATION_USER_WINDOW_SECONDS: "AUTH_RATE_EMAIL_VERIFICATION_USER_WINDOW_SECONDS",
  AUTH_RATE_EMAIL_VERIFICATION_IP_LIMIT: "AUTH_RATE_EMAIL_VERIFICATION_IP_LIMIT",
  AUTH_RATE_EMAIL_VERIFICATION_IP_WINDOW_SECONDS: "AUTH_RATE_EMAIL_VERIFICATION_IP_WINDOW_SECONDS",
  AUTH_RATE_OAUTH_CALLBACK_IP_LIMIT: "AUTH_RATE_OAUTH_CALLBACK_IP_LIMIT",
  AUTH_RATE_OAUTH_CALLBACK_IP_WINDOW_SECONDS: "AUTH_RATE_OAUTH_CALLBACK_IP_WINDOW_SECONDS",
  OAUTH_TRANSACTION_TTL_SECONDS: "OAUTH_TRANSACTION_TTL_SECONDS",
  DEFAULT_AVATAR_STYLE: "DEFAULT_AVATAR_STYLE",
  // 支付宝配置
  ALIPAY_APP_ID: "alipay.appId",
  ALIPAY_PRIVATE_KEY: "alipay.privateKey",
  ALIPAY_PUBLIC_KEY: "alipay.publicKey",
  ALIPAY_GATEWAY: "alipay.gateway",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** 哪些配置项是敏感值（加密存储、接口打码）。 */
export const SECRET_SETTING_KEYS: readonly SettingKey[] = [
  SETTING_KEYS.SUB2API_API_KEY,
  SETTING_KEYS.MEDIA_API_KEY,
  SETTING_KEYS.MEDIA_VIDEO_API_KEY,
  SETTING_KEYS.ALIPAY_PRIVATE_KEY,
  SETTING_KEYS.MAIL_PASSWORD,
  SETTING_KEYS.WECHAT_APP_SECRET,
  SETTING_KEYS.DINGTALK_CLIENT_SECRET,
  SETTING_KEYS.QQ_APP_KEY,
];

/** 管理端可编辑的配置项元信息（用于渲染设置表单）。 */
export interface SettingFieldMeta {
  key: SettingKey;
  label: string;
  secret: boolean;
  envFallback: string; // 对应的 .env 变量名（回退用）
  placeholder?: string;
  category?: string;
  description?: string;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'email' | 'url';
  unit?: string;
  defaultValue?: string;
  editable?: boolean;
  restartRequired?: boolean;
  testable?: boolean;
  min?: number;
  max?: number;
}

export const SETTING_FIELDS: readonly SettingFieldMeta[] = [
  // AI 服务
  {
    key: SETTING_KEYS.SUB2API_BASE_URL,
    label: "sub2api 上游地址",
    secret: false,
    envFallback: "SUB2API_BASE_URL",
    placeholder: "https://ai.longdaoec.com/v1",
    category: "ai",
    description: "统一模型上游服务地址。",
    type: "url",
  },
  {
    key: SETTING_KEYS.SUB2API_API_KEY,
    label: "sub2api API Key",
    secret: true,
    envFallback: "SUB2API_API_KEY",
    placeholder: "sk-...",
    category: "ai",
    description: "仅保存加密密文，页面不会回显。",
    type: "string",
  },
  {
    key: SETTING_KEYS.SUB2API_DEFAULT_MODEL,
    label: "默认模型",
    secret: false,
    envFallback: "SUB2API_DEFAULT_MODEL",
    placeholder: DEFAULT_MODEL_ID,
    category: "ai",
    type: "string",
  },
  {
    key: SETTING_KEYS.MEDIA_BASE_URL,
    label: "媒体模型上游地址",
    secret: false,
    envFallback: "MEDIA_BASE_URL",
    placeholder: "https://example.com/v1",
    category: "media",
    description: "独立于会话模型的图片/视频模型上游地址。",
    type: "url",
    editable: false,
  },
  {
    key: SETTING_KEYS.MEDIA_API_KEY,
    label: "媒体模型 API Key",
    secret: true,
    envFallback: "MEDIA_API_KEY",
    placeholder: "sk-...",
    category: "media",
    description: "仅保存加密密文，页面不会回显。",
    type: "string",
    editable: false,
  },
  {
    key: SETTING_KEYS.MEDIA_VIDEO_BASE_URL,
    label: "视频模型上游地址",
    secret: false,
    envFallback: "MEDIA_VIDEO_BASE_URL",
    placeholder: "https://example.com/v1",
    category: "media",
    description: "独立的视频模型上游地址。",
    type: "url",
    editable: false,
  },
  {
    key: SETTING_KEYS.MEDIA_VIDEO_API_KEY,
    label: "视频模型 API Key",
    secret: true,
    envFallback: "MEDIA_VIDEO_API_KEY",
    placeholder: "sk-...",
    category: "media",
    description: "仅保存加密密文，页面不会回显。",
    type: "string",
    editable: false,
  },
  // 平台基础信息
  {
    key: SETTING_KEYS.PLATFORM_NAME,
    label: "平台名称",
    secret: false,
    envFallback: "PLATFORM_NAME",
    placeholder: "硅基人才平台",
    category: "platform",
    type: "string",
  },
  {
    key: SETTING_KEYS.PLATFORM_LOGO_URL,
    label: "平台 Logo 地址",
    secret: false,
    envFallback: "PLATFORM_LOGO_URL",
    placeholder: "https://example.com/logo.png",
    category: "platform",
    type: "url",
  },
  {
    key: SETTING_KEYS.SUPPORT_EMAIL,
    label: "客服邮箱",
    secret: false,
    envFallback: "SUPPORT_EMAIL",
    placeholder: "support@example.com",
    category: "platform",
    type: "email",
  },
  {
    key: SETTING_KEYS.SUPPORT_PHONE,
    label: "客服电话",
    secret: false,
    envFallback: "SUPPORT_PHONE",
    placeholder: "400-000-0000",
    category: "platform",
    type: "string",
  },
  {
    key: SETTING_KEYS.ICP_NUMBER,
    label: "备案号",
    secret: false,
    envFallback: "ICP_NUMBER",
    placeholder: "京ICP备00000000号",
    category: "platform",
    type: "string",
  },
  // 计费与额度
  {
    key: SETTING_KEYS.USD_TO_CNY_RATE,
    label: "美元汇率（USD→CNY）",
    secret: false,
    envFallback: "USD_TO_CNY_RATE",
    placeholder: String(DEFAULT_USD_TO_CNY_RATE),
    category: "billing",
    type: "number",
    unit: "元/美元",
    min: 0,
  },
  {
    key: SETTING_KEYS.FALLBACK_PRICE_INPUT,
    label: "保底计费-输入价格",
    secret: false,
    envFallback: "FALLBACK_PRICE_INPUT",
    placeholder: "0.001",
    category: "billing",
    description: "未单独配置模型价格时的输入 token 单价。",
    type: "number",
    unit: "元/1K tokens",
    min: 0,
  },
  {
    key: SETTING_KEYS.FALLBACK_PRICE_OUTPUT,
    label: "保底计费-输出价格",
    secret: false,
    envFallback: "FALLBACK_PRICE_OUTPUT",
    placeholder: "0.002",
    category: "billing",
    description: "未单独配置模型价格时的输出 token 单价。",
    type: "number",
    unit: "元/1K tokens",
    min: 0,
  },
  {
    key: SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_CNY,
    label: "订阅赠送算力默认值",
    secret: false,
    envFallback: "DEFAULT_EMPLOYEE_GIFT_CNY",
    placeholder: "0",
    category: "billing",
    type: "number",
    unit: "元",
    min: 0,
  },
  {
    key: SETTING_KEYS.DEFAULT_EMPLOYEE_GIFT_PERCENTAGE,
    label: "订阅赠送算力默认比例",
    secret: false,
    envFallback: "DEFAULT_EMPLOYEE_GIFT_PERCENTAGE",
    placeholder: "10",
    category: "billing",
    description: "员工未单独设置赠送金额时，默认按员工年费的 10% 赠送；设为 0 时使用固定默认赠送金额。",
    type: "number",
    unit: "%",
    defaultValue: "10",
    min: 0,
    max: 100,
  },
  {
    key: SETTING_KEYS.LOW_BALANCE_THRESHOLD,
    label: "低余额告警阈值",
    secret: false,
    envFallback: "LOW_BALANCE_THRESHOLD",
    placeholder: "10",
    category: "billing",
    type: "number",
    unit: "元",
    min: 0,
  },
  {
    key: SETTING_KEYS.CONTRIBUTION_REWARDS_ENABLED,
    label: "贡献奖励开关",
    secret: false,
    envFallback: "CONTRIBUTION_REWARDS_ENABLED",
    defaultValue: "false",
    category: "billing",
    type: "boolean",
  },
  {
    key: SETTING_KEYS.CONTRIBUTION_ENTERPRISE_REWARD_CNY,
    label: "企业审核奖励",
    secret: false,
    envFallback: "CONTRIBUTION_ENTERPRISE_REWARD_CNY",
    placeholder: "10",
    category: "billing",
    type: "number",
    unit: "元",
    min: 0,
  },
  {
    key: SETTING_KEYS.CONTRIBUTION_PLATFORM_REWARD_CNY,
    label: "平台审核奖励",
    secret: false,
    envFallback: "CONTRIBUTION_PLATFORM_REWARD_CNY",
    placeholder: "50",
    category: "billing",
    type: "number",
    unit: "元",
    min: 0,
  },
  // 用户与企业
  {
    key: SETTING_KEYS.ENTERPRISE_REGISTRATION_APPROVAL,
    label: "企业注册需人工审核",
    secret: false,
    envFallback: "ENTERPRISE_REGISTRATION_APPROVAL",
    placeholder: "true",
    category: "users",
    type: "boolean",
  },
  {
    key: SETTING_KEYS.SEND_WELCOME_EMAIL,
    label: "审核通过发送欢迎邮件",
    secret: false,
    envFallback: "SEND_WELCOME_EMAIL",
    placeholder: "false",
    category: "users",
    type: "boolean",
  },
  // 安全与数据
  {
    key: SETTING_KEYS.MAX_TOKENS_PER_CONVERSATION,
    label: "单次对话最大 tokens",
    secret: false,
    envFallback: "MAX_TOKENS_PER_CONVERSATION",
    placeholder: "32000",
    category: "security",
    type: "integer",
    unit: "tokens",
    min: 1,
    editable: false,
    description: "未接入运行链路的旧配置，仅供历史审查；请使用模型运行策略。",
  },
  {
    key: SETTING_KEYS.MAX_CONCURRENT_SESSIONS,
    label: "单企业并发会话数",
    secret: false,
    envFallback: "MAX_CONCURRENT_SESSIONS",
    placeholder: "10",
    category: "security",
    description: "未接入运行链路的旧配置，不映射为企业模型并发；请使用模型运行策略。",
    editable: false,
    type: "integer",
    unit: "个",
    min: 0,
  },
  {
    key: SETTING_KEYS.ADMIN_IP_WHITELIST,
    label: "管理员 IP 白名单",
    secret: false,
    envFallback: "ADMIN_IP_WHITELIST",
    placeholder: "127.0.0.1,10.0.0.0/8",
    category: "security",
    type: "string",
  },
  {
    key: SETTING_KEYS.CONTENT_FILTER_ENABLED,
    label: "敏感词过滤开关",
    secret: false,
    envFallback: "CONTENT_FILTER_ENABLED",
    placeholder: "false",
    category: "security",
    type: "boolean",
  },
  {
    key: SETTING_KEYS.CONVERSATION_RETENTION_DAYS,
    label: "对话记录保留天数",
    secret: false,
    envFallback: "CONVERSATION_RETENTION_DAYS",
    placeholder: "90",
    category: "security",
    description: "设置为 0 表示永久保留。",
    type: "integer",
    unit: "天",
    min: 0,
  },
  {
    key: SETTING_KEYS.OPERATION_LOG_RETENTION_DAYS,
    label: "操作日志保留天数",
    secret: false,
    envFallback: "OPERATION_LOG_RETENTION_DAYS",
    placeholder: "180",
    category: "security",
    description: "设置为 0 表示永久保留。",
    type: "integer",
    unit: "天",
    min: 0,
  },
  {
    key: SETTING_KEYS.SOFT_DELETE_RETENTION_DAYS,
    label: "软删除数据保留天数",
    secret: false,
    envFallback: "SOFT_DELETE_RETENTION_DAYS",
    placeholder: "30",
    category: "security",
    type: "integer",
    unit: "天",
    min: 0,
  },
  // 通知与告警
  {
    key: SETTING_KEYS.ADMIN_NOTIFICATION_EMAIL,
    label: "管理员通知邮箱",
    secret: false,
    envFallback: "ADMIN_NOTIFICATION_EMAIL",
    placeholder: "admin@example.com",
    category: "notifications",
    type: "email",
  },
  {
    key: SETTING_KEYS.ABNORMAL_USAGE_THRESHOLD,
    label: "异常消耗告警阈值",
    secret: false,
    envFallback: "ABNORMAL_USAGE_THRESHOLD",
    placeholder: "100000",
    category: "notifications",
    type: "integer",
    unit: "tokens/小时",
    min: 1,
  },
  {
    key: SETTING_KEYS.SYSTEM_MAINTENANCE_NOTICE,
    label: "系统维护公告（兼容字段）",
    secret: false,
    envFallback: "SYSTEM_MAINTENANCE_NOTICE",
    placeholder: "",
    category: "notifications",
    description: "建议使用公告模块发布维护通知；该字段暂保留兼容旧配置。",
    type: "string",
  },
  // 运行环境（部署级 URL、Redis 连接串和密钥不在这里暴露）
  {
    key: SETTING_KEYS.CLIENT_TOKEN_TTL_MINUTES,
    label: "客户端实例令牌有效期",
    secret: false,
    envFallback: "CLIENT_TOKEN_TTL_MINUTES",
    placeholder: "15",
    category: "runtime",
    type: "integer",
    unit: "分钟",
    min: 1,
  },
  {
    key: SETTING_KEYS.REDIS_CACHE_ENABLED,
    label: "Redis 缓存开关",
    secret: false,
    envFallback: "REDIS_CACHE_ENABLED",
    placeholder: "true",
    category: "runtime",
    type: "boolean",
  },
  {
    key: SETTING_KEYS.CONVERSATION_CACHE_TTL,
    label: "对话历史缓存时长",
    secret: false,
    envFallback: "CONVERSATION_CACHE_TTL",
    placeholder: "3600",
    category: "runtime",
    type: "integer",
    unit: "秒",
    min: 0,
  },
  {
    key: SETTING_KEYS.MODEL_RESPONSE_TIMEOUT,
    label: "模型响应超时",
    secret: false,
    envFallback: "MODEL_RESPONSE_TIMEOUT",
    placeholder: "120",
    category: "runtime",
    type: "integer",
    unit: "秒",
    min: 1,
    editable: false,
    description: "未接入运行链路的旧配置，不映射为各阶段超时；请使用模型运行策略。",
  },
  // 认证与安全配置
  { key: SETTING_KEYS.MAIL_ENABLED, label: "启用邮件服务", secret: false, envFallback: "MAIL_ENABLED", placeholder: "false", category: "auth", description: "用于注册验证码、密码重置、邮箱验证和安全通知。", type: "boolean", defaultValue: "false", testable: true },
  { key: SETTING_KEYS.MAIL_HOST, label: "SMTP 服务器", secret: false, envFallback: "MAIL_HOST", placeholder: "smtp.example.com", category: "auth", description: "邮件服务商提供的 SMTP 主机地址。", type: "string", testable: true },
  { key: SETTING_KEYS.MAIL_PORT, label: "SMTP 端口", secret: false, envFallback: "MAIL_PORT", placeholder: "587", category: "auth", description: "通常使用 587（STARTTLS）或 465（SSL）。", type: "integer", unit: "端口", defaultValue: "587", min: 1, max: 65535, testable: true },
  { key: SETTING_KEYS.MAIL_SECURE, label: "SMTP SSL", secret: false, envFallback: "MAIL_SECURE", placeholder: "false", category: "auth", description: "465 端口通常需要开启。", type: "boolean", defaultValue: "false", testable: true },
  { key: SETTING_KEYS.MAIL_USER, label: "SMTP 用户名", secret: false, envFallback: "MAIL_USER", placeholder: "mailer@example.com", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.MAIL_PASSWORD, label: "SMTP 密码 / 授权码", secret: true, envFallback: "MAIL_PASSWORD", placeholder: "请输入 SMTP 密码或授权码", category: "auth", description: "仅保存加密密文，页面不会回显。", type: "string", testable: true },
  { key: SETTING_KEYS.MAIL_FROM, label: "发件邮箱", secret: false, envFallback: "MAIL_FROM", placeholder: "no-reply@example.com", category: "auth", type: "email", testable: true },
  { key: SETTING_KEYS.MAIL_FROM_NAME, label: "发件人名称", secret: false, envFallback: "MAIL_FROM_NAME", placeholder: "硅基人才平台", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.WECHAT_OAUTH_ENABLED, label: "启用微信登录", secret: false, envFallback: "WECHAT_OAUTH_ENABLED", placeholder: "false", category: "auth", description: "微信开放平台网站应用登录。", type: "boolean", defaultValue: "false", testable: true },
  { key: SETTING_KEYS.DINGTALK_OAUTH_ENABLED, label: "启用钉钉登录", secret: false, envFallback: "DINGTALK_OAUTH_ENABLED", placeholder: "false", category: "auth", description: "钉钉 OAuth 2.0 Web 登录；建议作为国内企业用户主登录方式。", type: "boolean", defaultValue: "false", testable: true },
  { key: SETTING_KEYS.DINGTALK_CLIENT_ID, label: "钉钉 Client ID", secret: false, envFallback: "DINGTALK_CLIENT_ID", placeholder: "请输入 Client ID（企业内部应用通常为 AppKey）", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.DINGTALK_CLIENT_SECRET, label: "钉钉 Client Secret", secret: true, envFallback: "DINGTALK_CLIENT_SECRET", placeholder: "请输入 Client Secret（企业内部应用通常为 AppSecret）", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.DINGTALK_REDIRECT_URI, label: "钉钉回调地址", secret: false, envFallback: "DINGTALK_REDIRECT_URI", placeholder: "https://api.example.com/auth/oauth/dingtalk/callback", category: "auth", description: "必须与钉钉开放平台应用配置完全一致，并使用 HTTPS。", type: "url", testable: true },
  { key: SETTING_KEYS.DINGTALK_SCOPE, label: "钉钉授权范围", secret: false, envFallback: "DINGTALK_SCOPE", placeholder: "openid", category: "auth", description: "默认使用 openid；只有确认应用已申请对应权限时才增加 scope。", type: "string", defaultValue: "openid", testable: true },
  { key: SETTING_KEYS.WECHAT_APP_ID, label: "微信 AppID", secret: false, envFallback: "WECHAT_APP_ID", placeholder: "wx...", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.WECHAT_APP_SECRET, label: "微信 AppSecret", secret: true, envFallback: "WECHAT_APP_SECRET", placeholder: "请输入 AppSecret", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.WECHAT_REDIRECT_URI, label: "微信回调地址", secret: false, envFallback: "WECHAT_REDIRECT_URI", placeholder: "https://api.example.com/auth/oauth/wechat/callback", category: "auth", description: "必须与微信开放平台后台配置完全一致，并使用 HTTPS。", type: "url", testable: true },
  { key: SETTING_KEYS.QQ_OAUTH_ENABLED, label: "启用 QQ 登录", secret: false, envFallback: "QQ_OAUTH_ENABLED", placeholder: "false", category: "auth", description: "QQ 互联网站应用登录。", type: "boolean", defaultValue: "false", testable: true },
  { key: SETTING_KEYS.QQ_APP_ID, label: "QQ AppID", secret: false, envFallback: "QQ_APP_ID", placeholder: "请输入 AppID", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.QQ_APP_KEY, label: "QQ AppKey", secret: true, envFallback: "QQ_APP_KEY", placeholder: "请输入 AppKey", category: "auth", type: "string", testable: true },
  { key: SETTING_KEYS.QQ_REDIRECT_URI, label: "QQ 回调地址", secret: false, envFallback: "QQ_REDIRECT_URI", placeholder: "https://api.example.com/auth/oauth/qq/callback", category: "auth", description: "必须与 QQ 互联后台配置完全一致，并使用 HTTPS。", type: "url", testable: true },
  { key: SETTING_KEYS.AUTH_MAX_FAILED_ATTEMPTS, label: "连续登录失败次数", secret: false, envFallback: "AUTH_MAX_FAILED_ATTEMPTS", placeholder: "5", category: "auth", description: "达到次数后锁定账号。", type: "integer", unit: "次", defaultValue: "5", min: 3, max: 20 },
  { key: SETTING_KEYS.AUTH_LOCK_MINUTES, label: "账号锁定时长", secret: false, envFallback: "AUTH_LOCK_MINUTES", placeholder: "15", category: "auth", type: "integer", unit: "分钟", defaultValue: "15", min: 1, max: 1440 },
  { key: SETTING_KEYS.OAUTH_TRANSACTION_TTL_SECONDS, label: "第三方登录事务有效期", secret: false, envFallback: "OAUTH_TRANSACTION_TTL_SECONDS", placeholder: "300", category: "auth", type: "integer", unit: "秒", defaultValue: "300", min: 60, max: 900 },
  { key: SETTING_KEYS.AUTH_RATE_LOGIN_IP_LIMIT, label: "登录 IP 限流次数", secret: false, envFallback: "AUTH_RATE_LOGIN_IP_LIMIT", placeholder: "20", category: "auth", type: "integer", unit: "次/秒", defaultValue: "20", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_LOGIN_IP_WINDOW_SECONDS, label: "登录 IP 限流窗口", secret: false, envFallback: "AUTH_RATE_LOGIN_IP_WINDOW_SECONDS", placeholder: "60", category: "auth", type: "integer", unit: "秒", defaultValue: "60", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_LOGIN_ACCOUNT_LIMIT, label: "登录账号限流次数", secret: false, envFallback: "AUTH_RATE_LOGIN_ACCOUNT_LIMIT", placeholder: "10", category: "auth", type: "integer", unit: "次/秒", defaultValue: "10", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_LOGIN_ACCOUNT_WINDOW_SECONDS, label: "登录账号限流窗口", secret: false, envFallback: "AUTH_RATE_LOGIN_ACCOUNT_WINDOW_SECONDS", placeholder: "300", category: "auth", type: "integer", unit: "秒", defaultValue: "300", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_PASSWORD_RESET_EMAIL_LIMIT, label: "密码重置邮箱限流次数", secret: false, envFallback: "AUTH_RATE_PASSWORD_RESET_EMAIL_LIMIT", placeholder: "3", category: "auth", type: "integer", unit: "次/秒", defaultValue: "3", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_PASSWORD_RESET_EMAIL_WINDOW_SECONDS, label: "密码重置邮箱限流窗口", secret: false, envFallback: "AUTH_RATE_PASSWORD_RESET_EMAIL_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_PASSWORD_RESET_IP_LIMIT, label: "密码重置 IP 限流次数", secret: false, envFallback: "AUTH_RATE_PASSWORD_RESET_IP_LIMIT", placeholder: "20", category: "auth", type: "integer", unit: "次/秒", defaultValue: "20", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_PASSWORD_RESET_IP_WINDOW_SECONDS, label: "密码重置 IP 限流窗口", secret: false, envFallback: "AUTH_RATE_PASSWORD_RESET_IP_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_LIMIT, label: "注册验证码邮箱发送次数", secret: false, envFallback: "AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_LIMIT", placeholder: "3", category: "auth", type: "integer", unit: "次/窗口", defaultValue: "3", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_WINDOW_SECONDS, label: "注册验证码邮箱限流窗口", secret: false, envFallback: "AUTH_RATE_REGISTRATION_EMAIL_CODE_EMAIL_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_LIMIT, label: "注册验证码 IP 发送次数", secret: false, envFallback: "AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_LIMIT", placeholder: "10", category: "auth", type: "integer", unit: "次/窗口", defaultValue: "10", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_WINDOW_SECONDS, label: "注册验证码 IP 限流窗口", secret: false, envFallback: "AUTH_RATE_REGISTRATION_EMAIL_CODE_IP_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_EMAIL_VERIFICATION_USER_LIMIT, label: "邮箱验证用户限流次数", secret: false, envFallback: "AUTH_RATE_EMAIL_VERIFICATION_USER_LIMIT", placeholder: "5", category: "auth", type: "integer", unit: "次/秒", defaultValue: "5", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_EMAIL_VERIFICATION_USER_WINDOW_SECONDS, label: "邮箱验证用户限流窗口", secret: false, envFallback: "AUTH_RATE_EMAIL_VERIFICATION_USER_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_EMAIL_VERIFICATION_IP_LIMIT, label: "邮箱验证 IP 限流次数", secret: false, envFallback: "AUTH_RATE_EMAIL_VERIFICATION_IP_LIMIT", placeholder: "20", category: "auth", type: "integer", unit: "次/秒", defaultValue: "20", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_EMAIL_VERIFICATION_IP_WINDOW_SECONDS, label: "邮箱验证 IP 限流窗口", secret: false, envFallback: "AUTH_RATE_EMAIL_VERIFICATION_IP_WINDOW_SECONDS", placeholder: "3600", category: "auth", type: "integer", unit: "秒", defaultValue: "3600", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_OAUTH_CALLBACK_IP_LIMIT, label: "OAuth 回调 IP 限流次数", secret: false, envFallback: "AUTH_RATE_OAUTH_CALLBACK_IP_LIMIT", placeholder: "30", category: "auth", type: "integer", unit: "次/秒", defaultValue: "30", min: 1, max: 100000 },
  { key: SETTING_KEYS.AUTH_RATE_OAUTH_CALLBACK_IP_WINDOW_SECONDS, label: "OAuth 回调 IP 限流窗口", secret: false, envFallback: "AUTH_RATE_OAUTH_CALLBACK_IP_WINDOW_SECONDS", placeholder: "300", category: "auth", type: "integer", unit: "秒", defaultValue: "300", min: 1, max: 100000 },
  // 支付宝配置
  {
    key: SETTING_KEYS.ALIPAY_APP_ID,
    label: "支付宝应用ID",
    secret: false,
    envFallback: "ALIPAY_APP_ID",
    placeholder: "202400012345678",
    category: "payments",
    type: "string",
  },
  {
    key: SETTING_KEYS.ALIPAY_PRIVATE_KEY,
    label: "支付宝应用私钥",
    secret: true,
    envFallback: "ALIPAY_PRIVATE_KEY",
    placeholder: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...",
    category: "payments",
    type: "string",
    description: "仅保存加密密文，页面不会回显。",
  },
  {
    key: SETTING_KEYS.ALIPAY_PUBLIC_KEY,
    label: "支付宝公钥",
    secret: false,
    envFallback: "ALIPAY_PUBLIC_KEY",
    placeholder: "MIIBIjANBgkqhkiG9w0BAQEFAAOC...",
    category: "payments",
    type: "string",
  },
  {
    key: SETTING_KEYS.ALIPAY_GATEWAY,
    label: "支付宝网关地址",
    secret: false,
    envFallback: "ALIPAY_GATEWAY",
    placeholder: "https://openapi.alipay.com/gateway.do",
    category: "payments",
    type: "url",
  },
];

// ============================================================================
// Capability Result (统一返回格式)
// ============================================================================

export const CapabilityResultSchema = z.object({
  success: z.boolean(),
  data: z.any(),
  error: z.string().optional(),
  metadata: z
    .object({
      duration: z.number(), // 执行耗时（ms）
      tokensUsed: z.number().optional(), // Token 消耗
    })
    .optional(),
});

export type CapabilityResult = z.infer<typeof CapabilityResultSchema>;

// ============================================================================
// Capability Interface (统一执行接口)
// ============================================================================

export interface Capability {
  id: string;
  name: string;
  type: "agent" | "rpa" | "skill" | "ai-app";
  description: string;
  industry: string[];
  position: string[];
  inputSchema: Record<string, any>; // JSON Schema
  outputSchema: Record<string, any>; // JSON Schema

  // 统一执行接口
  execute(params: Record<string, any>): Promise<CapabilityResult>;
}

// ============================================================================
// Agent Runtime Types
// ============================================================================

export interface DigitalEmployeeConfig {
  id: string;
  name: string;
  systemPrompt: string;
  modelId: string;
  maxSteps: number;
  capabilities: Capability[];
}

export interface ChatRequest {
  message: string;
  sessionId: string;
  employeeId: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  createdAt: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  result?: any;
}

// ============================================================================
// API DTOs
// ============================================================================

// Auth

/**
 * 邮箱字段的统一定义 —— 所有身份边界都该用它，不要写裸 z.string().email()。
 *
 * 归一化放在 Zod 层而非各 service 里，理由有两条：
 *   ① 邮箱大小写不敏感。若不归一化，"Bob@x.com" 能绕过"该邮箱已是成员"
 *      之类的等值检查，建出同一个人的第二条记录。
 *   ② trim 必须在 email 校验**之前**跑。顺序反了的话，用户在输入框里
 *      多打一个尾随空格，拿到的是"邮箱格式不正确"这种查不出原因的报错。
 */
export const EmailSchema = z.string().trim().toLowerCase().email();

export const TestMailDeliveryDtoSchema = z.object({
  to: EmailSchema,
});
export type TestMailDeliveryDto = z.infer<typeof TestMailDeliveryDtoSchema>;

/**
 * 企业自助注册。
 *
 * 注册的不是"个人账号"，而是「公司 + 创建者」一并建立：
 * User + Enterprise + EnterpriseMember(ENTERPRISE_ADMIN) + ComputeAccount。
 *
 * 为什么第一个人必须在注册时就成为管理员：「企业管理员」这个身份无法
 * 自行申请（申请给谁批？），只能来自"这家公司是我开的"。第二个人起
 * 不走注册，由管理员在企业管理台添加 —— 若同事也去点注册，
 * 会创建出第二家公司。
 */
export const RegisterDtoSchema = z.object({
  email: EmailSchema,
  emailCode: z.string().regex(/^\d{6}$/),
  password: z.string().min(8),
  name: z.string().optional(),
  /** 公司名称。注册即创建该企业，注册人成为其首个企业管理员。 */
  enterpriseName: z.string().min(2).max(100),
});

export type RegisterDto = z.infer<typeof RegisterDtoSchema>;

/**
 * 已登录且**无企业归属**的账号开新公司。
 *
 * 为什么不复用 RegisterDto：注册要建 User（需要 email/password），
 * 这里 User 已存在，只缺 Enterprise + Member + ComputeAccount。
 * 让无归属账号带着 email/password 再走一遍注册，等于要求用户
 * 重新提供已有凭据，且会撞上「邮箱已被注册」。
 *
 * 这条路径对应状态机里的 `[无归属] ── 开新公司 ──> [企业管理员]`：
 * 被前公司移除的人不该为了开自己的公司而换一个邮箱。
 */
export const CreateEnterpriseDtoSchema = z.object({
  name: z.string().min(2).max(100),
});
export type CreateEnterpriseDto = z.infer<typeof CreateEnterpriseDtoSchema>;

export const LoginDtoSchema = z.object({
  email: EmailSchema,
  password: z.string(),
});

export type LoginDto = z.infer<typeof LoginDtoSchema>;

export const ForgotPasswordDtoSchema = z.object({
  email: EmailSchema,
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordDtoSchema>;

export const RequestRegistrationEmailCodeDtoSchema = z.object({
  email: EmailSchema,
});
export type RequestRegistrationEmailCodeDto = z.infer<
  typeof RequestRegistrationEmailCodeDtoSchema
>;

export const ResetPasswordDtoSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordDtoSchema>;

export const RequestEmailVerificationDtoSchema = z.object({}).default({});
export type RequestEmailVerificationDto = z.infer<typeof RequestEmailVerificationDtoSchema>;

export const ConfirmEmailVerificationDtoSchema = z.object({
  token: z.string().min(1),
});
export type ConfirmEmailVerificationDto = z.infer<typeof ConfirmEmailVerificationDtoSchema>;

export const RequestEmailChangeDtoSchema = z.object({
  newEmail: EmailSchema,
});
export type RequestEmailChangeDto = z.infer<typeof RequestEmailChangeDtoSchema>;

export const ConfirmEmailChangeDtoSchema = z.object({
  token: z.string().min(1),
});
export type ConfirmEmailChangeDto = z.infer<typeof ConfirmEmailChangeDtoSchema>;

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    /** 头像地址（本地上传的稳定路径或外链）。未设置时为 null。 */
    avatar: string | null;
    /** 全局角色。ADMIN = 平台运营人员，与企业内角色是两套体系。 */
    role: string;
  };
  /**
   * 所属企业。平台运营人员不属于任何企业，故可为 null。
   * 前端存入 Zustand，用于企业管理台的数据归属显示。
   */
  enterprise: {
    id: string;
    name: string;
  } | null;
  /**
   * 企业内角色（ENTERPRISE_ADMIN / DEPT_MANAGER / MEMBER）。
   * 前端据此决定侧边栏可见项与按钮可操作性 ——
   * ⚠️ 仅为体验优化，真正的权限拦截在后端。
   */
  roleInEnterprise: string | null;
}

// Capability Upload
export const CapabilityUploadDtoSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  type: z.enum(["agent", "rpa", "skill", "ai-app"]),
  industry: z.array(z.string()),
  position: z.array(z.string()),
  inputSchema: z.record(z.any()),
  outputSchema: z.record(z.any()),

  // Type-specific configs (conditional based on type)
  agentConfig: z
    .object({
      platform: z.enum(["coze", "dify", "n8n", "opencode"]),
      botId: z.string().optional(),
      apiKey: z.string().optional(),
      workflowUrl: z.string().url().optional(),
      skillName: z.string().optional(),
    })
    .optional(),

  rpaConfig: z
    .object({
      platform: z.enum(["shizai", "yingdao"]),
      executionMode: z.enum(["download", "cloud", "client"]),
      packageUrl: z.string().url().optional(),
      configDoc: z.string().optional(),
    })
    .optional(),

  skillConfig: z
    .object({
      template: z.string(),
      modelId: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().min(1).max(100000).optional(),
    })
    .optional(),

  aiAppConfig: z
    .object({
      integrationMode: z.enum(["api", "iframe", "redirect"]),
      apiUrl: z.string().url().optional(),
      webUrl: z.string().url().optional(),
    })
    .optional(),
});

export type CapabilityUploadDto = z.infer<typeof CapabilityUploadDtoSchema>;

/** SKILL 包上传的 sha256（内容寻址 key，小写十六进制） */
export const SkillPackageSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'sha256 格式非法');

/**
 * Skill 正文来源，二选一：
 *   - `packageSha256`：先调 POST /contributions/skill-package 上传 zip，拿到 sha256。
 *     正文由服务端按 sha256 重新解包提取 —— **不接受客户端回传正文**，否则可以
 *     拿 A 包的哈希配 B 包的正文，绕过上传时的自动校验。
 *   - `template`：在线编写的正文。
 */
export const ContributionSkillConfigDtoSchema = z
  .object({
    template: SkillContentSchema.optional(),
    packageSha256: SkillPackageSha256Schema.optional(),
    /** 展示用的原始文件名。定位靠 sha256，这个字段错了也不影响正文来源。 */
    packageFilename: z.string().max(120).optional(),
    modelId: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(100000).optional(),
  })
  .refine(
    (config) => Boolean(config.template) !== Boolean(config.packageSha256),
    { message: "必须且只能提供 template 或 packageSha256 之一" },
  );
export type ContributionSkillConfigDto = z.infer<
  typeof ContributionSkillConfigDtoSchema
>;

/** 上传 SKILL 包的解析结果，前端据此预填能力信息并展示校验结论。 */
export interface RpaPackageParseResult {
  sha256: string;
  filename: string;
  fileCount: number;
  totalBytes: number;
  uncompressedBytes: number;
  files: string[];
}

export interface SkillPackageParseResult {
  sha256: string;
  filename: string;
  fileCount: number;
  totalBytes: number;
  /** SKILL.md 剥掉 frontmatter 的正文 */
  content: string;
  /** SKILL.md frontmatter 里可用于预填的字段 */
  suggested: { name: string | null; description: string | null };
  /** 上传即校验，提交审核前就把问题暴露出来 */
  validation: {
    valid: boolean;
    checks: Array<{ code: string; passed: boolean; message: string }>;
    issues: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
}

// 能力贡献中心：所有注册用户都可创建，企业归属和两层审核由服务端决定。
export const ContributionCapabilityCreateDtoSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    type: z.enum(["agent", "skill", "rpa"]),
    industry: z.array(z.string()).default([]),
    position: z.array(z.string()).default([]),
    inputSchema: z.record(z.any()).default({}),
    outputSchema: z.record(z.any()).default({}),
    skillConfig: ContributionSkillConfigDtoSchema.optional(),
    agentConfig: z
      .object({
        platform: z.enum(["coze", "dify", "n8n", "opencode"]),
        botId: z.string().optional(),
        workflowUrl: z.string().url().optional(),
        skillName: z.string().optional(),
      })
      .optional(),
    rpaConfig: z
      .object({
        platform: z.enum(["shizai", "yingdao"]),
        executionMode: z.literal("download").default("download"),
        packageSha256: SkillPackageSha256Schema,
        packageFilename: z.string().max(120).optional(),
        configDoc: z.string().min(10).max(10000),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const configs = [
      value.skillConfig,
      value.agentConfig,
      value.rpaConfig,
    ].filter(Boolean).length;
    if (configs !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "必须且只能提供当前能力类型对应的一种配置",
      });
      return;
    }
    const hasExpectedConfig =
      value.type === "skill"
        ? value.skillConfig
        : value.type === "agent"
          ? value.agentConfig
          : value.rpaConfig;
    if (!hasExpectedConfig)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.type} 能力缺少对应配置`,
      });
  });
export type ContributionCapabilityCreateDto = z.infer<
  typeof ContributionCapabilityCreateDtoSchema
>;

export const ContributionCapabilityUpdateDtoSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  industry: z.array(z.string()).optional(),
  position: z.array(z.string()).optional(),
  inputSchema: z.record(z.any()).optional(),
  outputSchema: z.record(z.any()).optional(),
});
export type ContributionCapabilityUpdateDto = z.infer<
  typeof ContributionCapabilityUpdateDtoSchema
>;

export const ContributionEmployeeBindSchema = z.object({
  employeeId: z.string().min(1),
  priority: z.number().int().min(0).max(100).optional(),
});
export type ContributionEmployeeBindDto = z.infer<typeof ContributionEmployeeBindSchema>;

export const ContributionReviewDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().max(2000).optional(),
});
export type ContributionReviewDecision = z.infer<
  typeof ContributionReviewDecisionSchema
>;

/**
 * 发布新版本。正文来源与创建能力时同规则：上传包（只送 sha256）或在线编写，二选一。
 * `changeSummary` 必填 —— 版本迭代没有变更说明，审核人无从判断改了什么。
 */
export const ContributionVersionCreateDtoSchema = z
  .object({
    /** 派生自哪个版本。不传则取该作用域内最新的版本，没有则取当前公开版本。 */
    parentVersionId: z.string().optional(),
    content: SkillContentSchema.optional(),
    packageSha256: SkillPackageSha256Schema.optional(),
    packageFilename: z.string().max(120).optional(),
    changeSummary: z.string().min(1).max(1000),
  })
  .refine((dto) => Boolean(dto.content) !== Boolean(dto.packageSha256), {
    message: "必须且只能提供 content 或 packageSha256 之一",
  });
export type ContributionVersionCreateDto = z.infer<
  typeof ContributionVersionCreateDtoSchema
>;

/** 作者在贡献中心编辑草稿版本的正文（仅在线编写的版本可改）。 */
export const ContributionVersionUpdateDtoSchema = z.object({
  content: SkillContentSchema,
  changeSummary: z.string().min(1).max(1000).optional(),
});
export type ContributionVersionUpdateDto = z.infer<
  typeof ContributionVersionUpdateDtoSchema
>;

/**
 * 人民币金额（元）：非负、最多两位小数。
 * 在边界处拦住 0.001 元这类值，避免它一路流到 Decimal 列被静默截断。
 */

// Digital Employee
export const EmployeeAvatarUrlSchema = z.union([
  z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '头像必须使用 HTTP(S) 地址'),
  z.string().regex(/^\/assets\/employees\/silicon\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/, '请选择硅基员工素材路径'),
]);

export const DigitalEmployeeCreateDtoSchema = z.object({
  name: z.string().min(1),
  description: z.string().trim().min(1).max(2000),
  industry: z.string(),
  position: z.string(),
  functionalCategory: z.enum(["TECH", "PRODUCT_DESIGN", "MARKETING_GROWTH", "ECOMMERCE", "SALES_CUSTOMER", "OPERATIONS_ORG", "FINANCE_LEGAL"]).default("OPERATIONS_ORG"),
  avatar: EmployeeAvatarUrlSchema.optional(),
  systemPrompt: z.string().min(10),
  modelId: z.string().default(DEFAULT_MODEL_ID),
  maxSteps: z.number().min(1).max(20).default(10),
  price: z.number().min(0).optional(),
  /** 年费（元） */
  annualPriceCNY: CnyAmountSchema.optional(),
  /**
   * 订阅赠送算力（元）。**null 与 0 语义不同**：
   * null/省略 = 用系统默认值 DEFAULT_EMPLOYEE_GIFT_CNY，0 = 明确不赠送。
   */
  includedComputeCNY: CnyAmountSchema.nullable().optional(),
  // 初始绑定的已审核 Capability ID 列表（可为空）
  capabilityIds: z.array(z.string()).default([]),
});

export type DigitalEmployeeCreateDto = z.infer<
  typeof DigitalEmployeeCreateDtoSchema
>;

export const DigitalEmployeeUpdateDtoSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  industry: z.string().optional(),
  position: z.string().optional(),
  functionalCategory: z.enum(["TECH", "PRODUCT_DESIGN", "MARKETING_GROWTH", "ECOMMERCE", "SALES_CUSTOMER", "OPERATIONS_ORG", "FINANCE_LEGAL"]).optional(),
  avatar: EmployeeAvatarUrlSchema.optional(),
  systemPrompt: z.string().min(10).optional(),
  modelId: z.string().optional(),
  maxSteps: z.number().min(1).max(20).optional(),
  price: z.number().min(0).optional(),
  /** 年费（元） */
  annualPriceCNY: CnyAmountSchema.optional(),
  /** 订阅赠送算力（元）。null = 回落系统默认值，0 = 明确不赠送。 */
  includedComputeCNY: CnyAmountSchema.nullable().optional(),
  status: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED", "ARCHIVED"]).optional(),
  /**
   * 版本号。运营发版时同步更新这里和上传对应的员工包，
   * 已有实例的 upgradeAvailable 才会真正触发。
   */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, '格式须为 x.y.z').optional(),
});

export type DigitalEmployeeUpdateDto = z.infer<
  typeof DigitalEmployeeUpdateDtoSchema
>;

export const BindCapabilityDtoSchema = z.object({
  capabilityId: z.string().min(1),
  priority: z.number().int().min(0).max(100).optional(),
});

export type BindCapabilityDto = z.infer<typeof BindCapabilityDtoSchema>;

// Subscription
export const SubscriptionCreateDtoSchema = z.object({
  employeeId: z.string(),
  config: z.record(z.any()).optional(),
});

export type SubscriptionCreateDto = z.infer<typeof SubscriptionCreateDtoSchema>;

export const WalletAdjustDtoSchema = z.object({
  enterpriseId: z.string().min(1),
  amount: z.number().finite().refine((value) => value !== 0, '调整金额不能为 0'),
  reason: z.string().trim().min(1).max(500),
});
export type WalletAdjustDto = z.infer<typeof WalletAdjustDtoSchema>;

/**
 * 修改雇佣关系。收敛后没有 departmentId ——
 * 部门差异化由 EmployeeGrant / KnowledgeGrant 的 departmentId 表达，
 * 雇佣关系本身不挂部门。
 */
export const SubscriptionUpdateDtoSchema = z.object({
  /** 企业内自定义称呼。传 null 恢复为展示模板名。 */
  name: z.string().min(1).max(50).nullable().optional(),
  config: z.record(z.any()).optional(),
});

export type SubscriptionUpdateDto = z.infer<typeof SubscriptionUpdateDtoSchema>;

/** 雇佣关系状态。收敛后 InstanceStatus 已并入此枚举。 */
export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'PAUSED', 'EXPIRED'] as const;
export type SubscriptionStatusValue = (typeof SUBSCRIPTION_STATUSES)[number];

export const SubscriptionStatusDtoSchema = z.object({
  status: z.enum(SUBSCRIPTION_STATUSES),
});

export type SubscriptionStatusDto = z.infer<typeof SubscriptionStatusDtoSchema>;

// ============================================================================
// Enterprise Organization DTOs（P1 企业组织管理）
// ============================================================================

/** 企业内角色。与全局 UserRole 是两套体系。 */
export const ENTERPRISE_ROLES = [
  'ENTERPRISE_ADMIN',
  'DEPT_MANAGER',
  'MEMBER',
] as const;

export const EnterpriseRoleSchema = z.enum(ENTERPRISE_ROLES);
export type EnterpriseRoleValue = z.infer<typeof EnterpriseRoleSchema>;

/**
 * **可新分配**的企业角色 —— 不含 DEPT_MANAGER。
 *
 * 该角色本版暂按普通成员对待（详见 EnterpriseContextService.assertCanApprove），
 * 故不允许新设，但**枚举值保留**：库里已有的 DEPT_MANAGER 成员仍是合法数据，
 * 照常登录、按普通成员权限走。等「数据范围」那层做出来再放开。
 */
export const ASSIGNABLE_ENTERPRISE_ROLES = [
  'ENTERPRISE_ADMIN',
  'MEMBER',
] as const;

export const AssignableEnterpriseRoleSchema = z.enum(
  ASSIGNABLE_ENTERPRISE_ROLES,
);
export type AssignableEnterpriseRoleValue = z.infer<
  typeof AssignableEnterpriseRoleSchema
>;

// ── 部门 ────────────────────────────────────────────────────────────────────

export const DepartmentCreateDtoSchema = z.object({
  name: z.string().min(1).max(50),
  /** 父部门 id。省略表示顶级部门。 */
  parentId: z.string().optional(),
  sortOrder: z.number().int().optional(),
});
export type DepartmentCreateDto = z.infer<typeof DepartmentCreateDtoSchema>;

export const DepartmentUpdateDtoSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  /** 移动部门。传 null 表示提升为顶级部门。 */
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type DepartmentUpdateDto = z.infer<typeof DepartmentUpdateDtoSchema>;

/** 部门树节点（含子节点，供前端直接渲染树形）。 */
export interface DepartmentTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  memberCount: number;
  children: DepartmentTreeNode[];
}

// ── 成员 ────────────────────────────────────────────────────────────────────

/**
 * 添加企业成员。
 *
 * 这是第二个人进入企业的**唯一途径** —— 注册入口只用于开公司，
 * 同事若走注册会创建出另一家公司。
 *
 * 认证中心 P1 起改为邀请制，管理员不再接触成员密码。
 */
export const MemberCreateDtoSchema = z.object({
  email: EmailSchema,
  name: z.string().min(1).max(50).optional(),
  /** 兼容旧客户端字段；服务端忽略，不再由管理员设置员工密码。 */
  password: z.string().min(8).optional(),
  role: AssignableEnterpriseRoleSchema.default('MEMBER'),
  departmentId: z.string().optional(),
  position: z.string().max(50).optional(),
});
export type MemberCreateDto = z.infer<typeof MemberCreateDtoSchema>;

export const MemberUpdateDtoSchema = z.object({
  role: AssignableEnterpriseRoleSchema.optional(),
  /** 调岗。传 null 表示移出部门。 */
  departmentId: z.string().nullable().optional(),
  position: z.string().max(50).nullable().optional(),
});
export type MemberUpdateDto = z.infer<typeof MemberUpdateDtoSchema>;

// ── 企业邀请 ────────────────────────────────────────────────────────────────

export * from './invitation-routing';
export * from './account-closure';

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'EXPIRED',
  'REVOKED',
] as const;
export const InvitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatusValue = z.infer<typeof InvitationStatusSchema>;

/** 邀请默认有效期（天）。过期后 token 失效，需管理员重新邀请。 */
export const INVITATION_EXPIRES_DAYS = 7;
export const INVITATION_EMAIL_STATUSES = ['UNKNOWN', 'SENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED'] as const;
export const InvitationEmailStatusSchema = z.enum(INVITATION_EMAIL_STATUSES);
export type InvitationEmailStatusValue = z.infer<typeof InvitationEmailStatusSchema>;

/**
 * 创建邀请。相比 MemberCreateDto 的「管理员代建账号 + 代设密码」，
 * 邀请制让被邀请人自己设密码 —— 管理员不接触他人凭据。
 *
 * 邮件发送失败时创建仍成功，响应提供一次性邀请链接作为备用。
 */
export const InvitationCreateDtoSchema = z.object({
  email: EmailSchema,
  role: AssignableEnterpriseRoleSchema.default('MEMBER'),
  departmentId: z.string().optional(),
  position: z.string().max(50).optional(),
});
export type InvitationCreateDto = z.infer<typeof InvitationCreateDtoSchema>;

/**
 * 受邀注册。token 来自邀请链接，email 必须与邀请记录一致 ——
 * 否则链接被转发后任何人都能用它加入企业。
 */
export const RegisterByInvitationDtoSchema = z.object({
  token: z.string().min(1),
  email: EmailSchema,
  emailCode: z.string().regex(/^\d{6}$/),
  password: z.string().min(8),
  name: z.string().min(1).max(50).optional(),
});
export type RegisterByInvitationDto = z.infer<
  typeof RegisterByInvitationDtoSchema
>;

/**
 * 已登录用户接受邀请。
 * 不需要传 email —— 从 JWT 里取当前用户，再与邀请记录比对。
 */
export const AcceptInvitationDtoSchema = z.object({
  token: z.string().min(1),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationDtoSchema>;

export * from './employee-grant.dto';

// ── 员工授权 ────────────────────────────────────────────────────────────────

/**
 * 开通授权。授权对象**二选一**：整个部门，或具体某个成员。
 *
 * 用 refine 而非两个独立可选字段，是因为「都不传」会造出一条谁都匹配不上的
 * 死记录，「都传」的语义又无法定义（是且还是或？）。DB 层的
 * `@@unique([subscriptionId, departmentId, memberId])` 挡不住这两种情况。
 */
export const GrantCreateDtoSchema = z
  .object({
    departmentId: z.string().optional(),
    memberId: z.string().optional(),
    /** 限时授权到期时间（ISO 字符串）。省略表示长期有效。 */
    expiresAt: z.string().datetime().optional(),
  })
  .refine(
    (d) => Boolean(d.departmentId) !== Boolean(d.memberId),
    { message: '授权对象必须是部门或成员之一，不能同时指定或都不指定' },
  );
export type GrantCreateDto = z.infer<typeof GrantCreateDtoSchema>;

/** 一条授权记录。target 二选一，另一个为 null。 */
export interface GrantView {
  id: string;
  department: { id: string; name: string } | null;
  member: { id: string; name: string | null; email: string } | null;
  expiresAt: string | null;
  /** 已过期但未清理的记录，前端应标灰 */
  expired: boolean;
  createdAt: Date;
}

/**
 * 「我的员工」—— 当前成员可用的雇佣关系。
 *
 * 这是**使用者视角**，不含配置/升级等管理信息，但多一个 grantSource
 * 说明「为什么我能用这个」。
 */
export interface MyEmployeeView {
  /** 雇佣关系 id（收敛前是 instanceId）。所有下游操作都以此为锚点。 */
  subscriptionId: string;
  /** 企业自定义称呼，未设置时回落到模板名 */
  name: string;
  templateVersion: string;
  /** 员工模板。收敛前此字段名为 template。 */
  employee: { id: string; name: string; avatar: string | null; avatarAsset?: EmployeeAvatarAsset | null; functionalCategory?: string };
  /**
   * 授权来源部门。收敛后语义变了 —— 从前是「实例归属哪个部门」，
   * 现在是「这条授权发给哪个部门」，DIRECT 授权时为 null。
   */
  department: { id: string; name: string } | null;
  /** 授权来源：直接给我的，还是给我所在部门的 */
  grantSource: 'DIRECT' | 'DEPARTMENT';
  expiresAt: string | null;
  /**
   * 该模板是否有可下载的员工包。为 false 时前端应禁用下载按钮 ——
   * 运营尚未上传包，点了只会拿到 404。
   */
  packageAvailable?: boolean;

  // ── 订阅赠送算力余额（元，Decimal 序列化为字符串）───────────────────────
  /** 订阅时生成的赠送金额快照 */
  giftGrantedCNY?: string;
  giftUsedCNY?: string;
  /** 剩余可用赠送金额。非 ACTIVE 状态一律为 '0.00' —— 花不掉的钱不算剩余。 */
  giftRemainingCNY?: string;
  /** ACTIVE 可用 · EXHAUSTED 已用尽 · EXPIRED 订阅已终止 · NONE 无赠送记录 */
  giftStatus?: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'NONE';

  /**
   * 使用情况（会议2 §6.1「使用人数即口碑」）。
   * 全部限定在**本企业范围内**：跨企业的用量既不该看见，也不是管理员想问的。
   */
  usage?: MyEmployeeUsage;
}

/**
 * 一张员工卡片上的使用情况。
 *
 * 「在用人数 vs 已授权人数」是这里唯一的重点：授权 8 人只 3 人在用，
 * 说明这个员工买了没人用 —— 单看任何一个数都得不出这个结论。
 */
export interface MyEmployeeUsage {
  /** 近 30 天在本企业调用过该员工的人数（去重）。系统内部调用不计人。 */
  activeUserCount30d: number;
  /** 当前有效授权覆盖到的人数。部门授权已展开成人数，与直接授权去重。 */
  grantedUserCount: number;
  /**
   * 授权是怎么给出去的：几个部门、几个人。
   *
   * 光有 grantedUserCount 说不清「4 人」是点了 4 次还是授权了一个 4 人部门 ——
   * 而这两种情况的收回方式完全不同（改部门授权 vs 删 4 条记录）。
   * 数据来自同一批已查出的授权记录，不额外查库。
   */
  grantedDepartmentCount: number;
  grantedMemberCount: number;
  /** 本企业最后一次调用时间。从未用过为 null —— 「没用过」不等于「很久没用」。 */
  lastUsedAt: string | null;
  /** 本自然月消费（元）。自然月而非滚动 30 天 —— 要能和账单、算力余额页对上。 */
  monthCostCNY: string;
  /** 本自然月计费调用次数（模型调用，与消费同源） */
  monthCallCount: number;
  /**
   * 近 30 天能力执行总次数 —— 成功率的分母。
   *
   * 必须和比例一起给：4/6 和 87/100 都是 67%，但前者说明不了任何事。
   * 前端要靠它决定「显示成功率」还是「样本太少」。
   */
  executionCount30d: number;
  /**
   * 近 30 天能力执行成功率（0–100 整数）。
   *
   * 窗口与 `activeUserCount30d` 一致，**不是**自然月：月初样本只有几次，
   * 一次失败就能把它从 100% 打到 67%，那不是质量信号。
   * 无执行记录时为 null 而非 0 —— 「没跑过」和「全失败」是两件事。
   */
  successRate30d: number | null;
}

// ── 员工包 ──────────────────────────────────────────────────────────────────

/** 发布新版本（multipart 表单的文本字段，文件另走 file 字段）*/
export const PackagePublishDtoSchema = z.object({
  /** 与 DigitalEmployee.version 同步更新，格式 x.y.z */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, '版本格式须为 x.y.z'),
  changelog: z.string().max(500).optional(),
  /**
   * pi package 引用（决策 5）。
   * 若只填 packageRef 不上传文件，平台不经手字节流，客户端直接 `pi install`。
   * 若同时上传文件，两者并存（ZIP 作为兜底通道）。
   */
  packageRef: z.object({
    type: z.enum(['npm', 'git']),
    spec: z.string().min(1).max(200),
  }).optional(),
});
export type PackagePublishDto = z.infer<typeof PackagePublishDtoSchema>;

export interface PackageView {
  id: string;
  version: string;
  /** ZIP 文件名，packageRef-only 时为 null */
  filename: string | null;
  /** SHA-256，packageRef-only 时为 null */
  sha256: string | null;
  /** 文件大小，packageRef-only 时为 null */
  fileSizeBytes: number | null;
  /** pi package 引用，ZIP-only 时为 null */
  packageRef: { type: 'npm' | 'git'; spec: string } | null;
  changelog: string | null;
  createdAt: Date;
}

/** 客户端获取雇佣关系可安装的包信息（P3.2） */
export interface EmploymentPackageInfo {
  version: string;
  packageRef: { type: 'npm' | 'git'; spec: string } | null;
  /** ZIP 通道是否可用（packageRef 不存在时客户端可提示手动下载）*/
  zipAvailable: boolean;
  sha256: string | null;
}

/** 员工包大小上限。ZIP 里只装 skills 与说明，20MB 足够且能挡住误传大文件。 */
export const PACKAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 订阅视图（管理台）。收敛后订阅即雇佣关系，取代了原先的 InstanceView。
 */
export interface SubscriptionView {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'EXPIRED';
  /** 订阅锁定的模板版本 */
  templateVersion: string;
  /** 模板当前最新版本 */
  latestVersion: string;
  /**
   * 是否有可用升级。提示式升级（决策 14）：不自动跟进，
   * 由企业在管理台主动确认。
   */
  upgradeAvailable: boolean;
  employee: { id: string; name: string; avatar: string | null };
  config: Record<string, unknown> | null;
  createdAt: Date;
}

// Conversation
export const ConversationSourceSchema = z.enum(['CHAT', 'TASK']);
export type ConversationSource = z.infer<typeof ConversationSourceSchema>;

export const ConversationCreateDtoSchema = z.object({
  employeeId: z.string(),
  title: z.string().optional(),
  source: ConversationSourceSchema.optional().default('CHAT'),
  taskPlanId: z.string().optional(),
  taskStepId: z.string().optional(),
});

export type ConversationCreateDto = z.infer<typeof ConversationCreateDtoSchema>;

export const ConversationUpdateDtoSchema = z.object({
  title: z.string().min(1).max(100),
});

export type ConversationUpdateDto = z.infer<typeof ConversationUpdateDtoSchema>;

/** 附件类别，与后端上传白名单（upload.constants.ts）保持一致 */
export const ATTACHMENT_TYPES = ['image', 'document', 'video'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/**
 * 消息附件。前端不自造这个对象 —— 必须是 POST /upload/files 的返回值，
 * 否则 key 指向的对象不存在。url 有时效，key 才是永久标识。
 */
export const MessageAttachmentSchema = z.object({
  type: z.enum(ATTACHMENT_TYPES),
  key: z.string().min(1),
  // 绝对地址（OSS 驱动）或根相对路径（本地驱动，前端拼 /api 前缀走同源代理）。
  // 不能只收 .url()：本地驱动返回的就是 /uploads/...，那样所有本地上传都发不出去。
  url: z
    .string()
    .min(1)
    .refine(
      (v) => /^https?:\/\//i.test(v) || v.startsWith('/'),
      { message: '附件地址须为 http(s) 绝对地址或根相对路径' },
    ),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
});

export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

/** 单条消息最多携带的附件数，与 upload.constants.ts 的 MAX_FILES_PER_REQUEST 对齐 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export const MessageSendDtoSchema = z.object({
  // 带附件时允许空文本（"看看这张图"式的纯附件消息），
  // 但不能既没文本也没附件
  content: z.string().max(10000),
  targetEmployeeId: z.string().optional(), // 指定处理该消息的员工（多员工协作）
  attachments: z
    .array(MessageAttachmentSchema)
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .optional(),
}).refine(
  (dto) => dto.content.trim().length > 0 || (dto.attachments?.length ?? 0) > 0,
  { message: '消息内容和附件不能同时为空', path: ['content'] },
);

export type MessageSendDto = z.infer<typeof MessageSendDtoSchema>;

// User Profile
export const UpdateProfileDtoSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  avatar: z.string().url().optional(),
});

export type UpdateProfileDto = z.infer<typeof UpdateProfileDtoSchema>;

// ============================================================================
// Enterprise Model Config DTOs (Phase 1 — 模型配置中心)
// ============================================================================

export const EMPLOYEE_MODEL_POLICIES = ['FOLLOW_TEMPLATE', 'FORCE_DEFAULT'] as const;
export type EmployeeModelPolicy = (typeof EMPLOYEE_MODEL_POLICIES)[number];

export const UpdateEnterpriseModelConfigDtoSchema = z.object({
  defaultChatModel: z.string().min(1).optional(),
  allowedChatModels: z.array(z.string()).optional(),
  allowUserSwitchModel: z.boolean().optional(),
  rerankModel: z.string().nullable().optional(),
  employeeModelPolicy: z.enum(EMPLOYEE_MODEL_POLICIES).optional(),
  employeeDefaultModel: z.string().nullable().optional(),
  /** 编排与分析模型。null / 空串 = 跟随平台默认模型 */
  plannerModel: z.string().nullable().optional(),
});
export type UpdateEnterpriseModelConfigDto = z.infer<typeof UpdateEnterpriseModelConfigDtoSchema>;

export const DepartmentModelPolicyDtoSchema = z.object({
  defaultChatModel: z.string().nullable().optional(),
  allowedChatModels: z.array(z.string()).optional(),
});
export type DepartmentModelPolicyDto = z.infer<typeof DepartmentModelPolicyDtoSchema>;

/** 解析后最终生效的模型配置（会话侧消费） */
export interface EffectiveModelConfig {
  chatModel: string;
  allowedChatModels: string[];
  allowUserSwitchModel: boolean;
  embeddingModel: string;
  rerankModel: string | null;
  embeddingBatchSize: number;
  embeddingTimeoutMs: number;
}

export const ChangePasswordDtoSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export type ChangePasswordDto = z.infer<typeof ChangePasswordDtoSchema>;

export interface UserProfileResponse {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  name: string | null;
  avatar: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Model Pricing (计费价格表)
// ----------------------------------------------------------------------------
// 单位：美元 / 1M tokens
// 数据来源：各厂商官网定价（截至 2026-07）
// ============================================================================

export interface ModelPricing {
  inputPrice: number; // 输入 token 单价（美元 / 1M tokens）
  outputPrice: number; // 输出 token 单价（美元 / 1M tokens）
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── 中转（sub2api）实际提供的模型。2026-09-05 用 GET /v1/models 核过：
  //    上游只有 gemini-* 一族，任何 gpt-* / claude-* 都会 404 model_not_found。
  //    价格按 flash / flash-lite / pro 三档定，同档不同后缀（-low/-high/-extra-low）
  //    只是推理预算档位，单价相同。
  "gemini-2.5-flash": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.5-flash": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.5-flash-low": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.5-flash-high": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.5-flash-extra-low": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.5-flash-lite": { inputPrice: 0.075, outputPrice: 0.3 },
  "gemini-3.6-flash": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.7-flash": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.8-flash": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.1-flash-image": { inputPrice: 0.15, outputPrice: 0.6 },
  "gemini-3.1-flash-lite-preview": { inputPrice: 0.075, outputPrice: 0.3 },
  "gemini-3-pro-preview": { inputPrice: 1.25, outputPrice: 10.0 },
  "gemini-3.1-pro-preview": { inputPrice: 1.25, outputPrice: 10.0 },
  "gemini-3.1-pro-preview-low": { inputPrice: 1.25, outputPrice: 10.0 },
  // ── 上游已不提供，但**历史账单里还有这些 modelId**（实测本地库：gpt-4o-mini
  //    106 条、gpt-4o 41 条、claude-3-5-sonnet 14 条），价格必须留着：
  //    删掉会让老记录在任何重算路径上掉到保底价，与已入账金额对不上；
  //    而且 FALLBACK_PRICING 取的是本表最高价，删掉最贵的那几档等于悄悄
  //    调低了「未配价模型」的保底单价 —— 那正是用来堵免费对话漏洞的。
  "gpt-4o": { inputPrice: 2.5, outputPrice: 10.0 },
  "gpt-4o-mini": { inputPrice: 0.15, outputPrice: 0.6 },
  "claude-sonnet-5": { inputPrice: 3.0, outputPrice: 15.0 },
  "claude-haiku-4-5": { inputPrice: 0.8, outputPrice: 4.0 },
  "deepseek-v4-flash": { inputPrice: 0.14, outputPrice: 0.55 },
  "deepseek-v4-pro": { inputPrice: 2.19, outputPrice: 8.77 },
};

/** 解析汇率配置值，非法输入回退默认值（避免把 NaN 写进账单）。 */
export function parseUsdToCnyRate(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_TO_CNY_RATE;
}

/**
 * 解析一个「元」金额配置值。非法/负数/空值一律回退 `fallback`，
 * 绝不把 NaN 或负数写进账本。最多保留两位小数。
 */
export function parseCnyAmount(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 100) / 100;
}

/**
 * 运营配置的保底单价（元 / 1K tokens）。两项都配了才生效 ——
 * 只配一半会让另一半静默走「已知模型最高单价」，账单口径变得无法解释。
 */
export interface FallbackPriceConfigCNY {
  inputCnyPer1K: number;
  outputCnyPer1K: number;
}

/** 从系统设置的原始字符串解析保底单价；任一项缺失/非法则返回 null（走默认保底价）。 */
export function parseFallbackPriceConfig(
  rawInput: string | undefined,
  rawOutput: string | undefined,
): FallbackPriceConfigCNY | null {
  // 空白必须当「未配置」处理：Number('') === 0，直接 Number() 会把一个从未设置过的
  // 配置项解析成 0 元单价，让所有未配价模型静默变成免费对话。
  const input = parsePositivePrice(rawInput);
  const output = parsePositivePrice(rawOutput);
  if (input === null || output === null) return null;
  return { inputCnyPer1K: input, outputCnyPer1K: output };
}

/** 单价：空白/非法/负数 → null；否则返回数值（允许 0，表示运营明确「免费」）。 */
function parsePositivePrice(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 保底价：取 MODEL_PRICING 中各维度的最高单价。
 * 未在价格表中的模型（上游 57 个里只有 7 个配了价）按此保底计费，
 * 宁可多收也不漏收，避免未配价模型被启用后「免费对话」。
 * 管理端应对这类模型显示警示，提醒尽快补上真实价格。
 */
export const FALLBACK_PRICING: ModelPricing = {
  inputPrice: Math.max(
    ...Object.values(MODEL_PRICING).map((p) => p.inputPrice),
  ),
  outputPrice: Math.max(
    ...Object.values(MODEL_PRICING).map((p) => p.outputPrice),
  ),
};

/** 该模型是否已配置真实价格（未配则计费走保底价）。 */
export function hasPricing(modelId: string): boolean {
  return modelId in MODEL_PRICING;
}

export interface ComputeCostBreakdown {
  costUSD: number;
  costCNY: number;
  isFallback: boolean;
  rate: number;
  /** 本次实际使用的输入/输出单价（美元 / 1M tokens），写进账单以便复核 */
  inputPriceUsdPerMillion: number;
  outputPriceUsdPerMillion: number;
}

/**
 * 计算单次对话的成本。
 *
 * @param modelId 模型 ID
 * @param inputTokens 输入 token 数
 * @param outputTokens 输出 token 数
 * @param rate 生效汇率，省略则用默认值（调用方应从系统设置读取后传入）
 * @param fallbackConfig 运营配置的保底单价（元/1K tokens）。仅对**未配价模型**生效；
 *   给出时按它计价，并换算回等价美元单价写入账单，保证账单口径始终是同一套字段。
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  rate: number = DEFAULT_USD_TO_CNY_RATE,
  fallbackConfig?: FallbackPriceConfigCNY | null,
): ComputeCostBreakdown {
  const isFallback = !hasPricing(modelId);

  // 未配价 + 运营配了保底价：以人民币单价为准。换算成 USD/1M 存档，
  // 让 ComputeUsageRecord 的单价字段对所有账单保持同一含义。
  const pricing =
    isFallback && fallbackConfig
      ? {
          inputPrice: (fallbackConfig.inputCnyPer1K / rate) * 1000,
          outputPrice: (fallbackConfig.outputCnyPer1K / rate) * 1000,
        }
      : isFallback
        ? FALLBACK_PRICING
        : MODEL_PRICING[modelId];

  const costUSD =
    (inputTokens * pricing.inputPrice + outputTokens * pricing.outputPrice) /
    1_000_000;
  const costCNY = costUSD * rate;

  // 返回 rate 与单价：账单需可复核 —— 改价改汇率后旧账单仍应能解释当时的金额
  return {
    costUSD,
    costCNY,
    isFallback,
    rate,
    inputPriceUsdPerMillion: pricing.inputPrice,
    outputPriceUsdPerMillion: pricing.outputPrice,
  };
}

// ============================================================================
// Client Auth DTOs (P4)
// ============================================================================
export const ClientLoginDtoSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1),
  fingerprint: z.string().min(1).max(256),
  platform: z.enum(['darwin', 'win32', 'linux']).or(z.string()),
  clientVersion: z.string().optional(),
});
export type ClientLoginDto = z.infer<typeof ClientLoginDtoSchema>;

export const ClientTokenDtoSchema = z.object({
  refreshToken: z.string().min(1),
  subscriptionId: z.string().min(1),
});
export type ClientTokenDto = z.infer<typeof ClientTokenDtoSchema>;

export const ClientRefreshDtoSchema = z.object({
  refreshToken: z.string().min(1),
});
export type ClientRefreshDto = z.infer<typeof ClientRefreshDtoSchema>;

// ============================================================================
// Gateway Layer Types (OpenAI-compatible chat completion)
// ============================================================================

const ChatCompletionFunctionNameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const ChatCompletionTextSchema = z.string().max(1024 * 1024);
const ChatCompletionImageUrlSchema = z.string().max(4 * 1024 * 1024).superRefine((value, ctx) => {
  if (value.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i.exec(value);
    if (!match || match[2].length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '图片 data URL 必须是受支持 MIME 类型的有效 Base64 数据' });
    }
    return;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '图片 URL 必须使用 HTTP 或 HTTPS' });
  }
});
const ChatCompletionContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: ChatCompletionTextSchema }).strict(),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: ChatCompletionImageUrlSchema, detail: z.enum(['auto', 'low', 'high']).optional() }).strict(),
  }).strict(),
]);
const ChatCompletionJsonSchema: z.ZodType<Record<string, unknown> | boolean> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.object({
      type: z.union([
        z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']),
        z.array(z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])).min(1).max(7),
      ]).optional(),
      properties: z.record(ChatCompletionJsonSchema).optional(),
      required: z.array(z.string().min(1).max(256)).max(256).optional(),
      items: z.union([ChatCompletionJsonSchema, z.array(ChatCompletionJsonSchema).max(128)]).optional(),
      additionalProperties: ChatCompletionJsonSchema.optional(),
      allOf: z.array(ChatCompletionJsonSchema).min(1).max(128).optional(),
      anyOf: z.array(ChatCompletionJsonSchema).min(1).max(128).optional(),
      oneOf: z.array(ChatCompletionJsonSchema).min(1).max(128).optional(),
      not: ChatCompletionJsonSchema.optional(),
      $defs: z.record(ChatCompletionJsonSchema).optional(),
      definitions: z.record(ChatCompletionJsonSchema).optional(),
      enum: z.array(z.unknown()).min(1).max(256).optional(),
      description: ChatCompletionTextSchema.optional(),
      $ref: z.string().max(1024).optional(),
    }).catchall(z.unknown()),
  ]),
);

// 先限制 JSON 的深度和节点数，再递归校验 schema，避免任意深度耗尽调用栈。
const ChatCompletionFunctionParametersSchema = z.record(z.unknown()).superRefine((parameters, ctx) => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parameters, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > 8192 || depth > 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数 schema 超过结构资源上限' });
      return;
    }
    if (value === null || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= 1024 * 1024)) continue;
    if (typeof value !== 'object') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数 schema 必须是有界 JSON 结构' });
      return;
    }
    const entries = Object.entries(value);
    if (entries.length > (Array.isArray(value) ? 1024 : 256) ||
        entries.some(([key]) => key.length > 256)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '参数 schema 字段或数组超过上限' });
      return;
    }
    for (const [, child] of entries) stack.push({ value: child, depth: depth + 1 });
  }
}).pipe(ChatCompletionJsonSchema).pipe(z.object({
  type: z.literal('object').optional(),
}).catchall(z.unknown()));

const ChatCompletionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: ChatCompletionFunctionNameSchema,
    description: ChatCompletionTextSchema.optional(),
    parameters: ChatCompletionFunctionParametersSchema.optional(),
    strict: z.boolean().optional(),
  }).strict(),
}).strict();

const ChatCompletionToolCallSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('function'),
  function: z.object({
    name: ChatCompletionFunctionNameSchema,
    arguments: ChatCompletionTextSchema,
  }).strict(),
}).strict();

const ChatCompletionMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  // 用户消息支持 OpenAI 兼容的多模态内容；工具调用轮 assistant 可省略文本。
  content: z.union([ChatCompletionTextSchema, z.array(ChatCompletionContentPartSchema).min(1).max(128)])
    .nullable().optional(),
  name: ChatCompletionFunctionNameSchema.optional(),
  tool_calls: z.array(ChatCompletionToolCallSchema).max(128).optional(),
  tool_call_id: z.string().min(1).max(128).optional(),
  // 推理模型的工具回传可能要求原样保留此字段，不能在 Zod parse 时剥离。
  reasoning_content: ChatCompletionTextSchema.nullable().optional(),
}).strict().superRefine((message, ctx) => {
  if (Array.isArray(message.content) && message.role !== 'user') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: '多模态内容仅支持 user 消息' });
  }
  if (message.content == null && !(message.role === 'assistant' && message.tool_calls?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: '此消息必须提供文本 content' });
  }
  if (message.role === 'tool' && !message.tool_call_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_call_id'], message: '工具结果必须提供 tool_call_id' });
  }
  if (message.role !== 'assistant' && message.tool_calls !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_calls'], message: '仅 assistant 可以发起工具调用' });
  }
  if (message.role !== 'tool' && message.tool_call_id !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_call_id'], message: '仅 tool 消息可以关联工具结果' });
  }
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(ChatCompletionMessageSchema).min(1).max(512),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  stream: z.boolean().optional(),
  tools: z.array(ChatCompletionToolSchema).max(128).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({ type: z.literal('function'), function: z.object({ name: ChatCompletionFunctionNameSchema }).strict() }).strict(),
  ]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  reasoning_effort: z.string().min(1).max(64).optional(),
}).strict().superRefine((request, ctx) => {
  const pendingCalls = new Set<string>();
  request.messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      // 新 assistant 轮取代上一轮，不能把过期或已消费的 ID 用于孤立结果。
      pendingCalls.clear();
      for (const call of message.tool_calls ?? []) {
        if (pendingCalls.has(call.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', index, 'tool_calls'], message: '同轮工具调用 ID 不能重复' });
        }
        pendingCalls.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!message.tool_call_id || !pendingCalls.delete(message.tool_call_id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages', index, 'tool_call_id'], message: '工具结果必须关联当前轮此前未消费的 assistant tool_calls ID' });
      }
    } else {
      pendingCalls.clear();
    }
  });
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * 计算模型调用成本（CNY）。
 * @param modelId 模型ID（如 gpt-4）
 * @param inputTokens prompt token数
 * @param outputTokens completion token数
 * @param usdRate 美元→人民币汇率
 * @returns 成本（人民币）
 */
export function calculateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  usdRate: number,
): number {
  // 简化版：用默认费率，后续从 PlatformModel 读单价
  const RATES: Record<string, { input: number; output: number }> = {
    'gpt-4': { input: 0.03 / 1000, output: 0.06 / 1000 },  // USD per token
    'gpt-3.5-turbo': { input: 0.001 / 1000, output: 0.002 / 1000 },
    'claude-3-opus': { input: 0.015 / 1000, output: 0.075 / 1000 },
  };
  const rate = RATES[modelId] || RATES['gpt-3.5-turbo']; // fallback
  const costUsd = inputTokens * rate.input + outputTokens * rate.output;
  return costUsd * usdRate;
}

// ============================================================================
// Department Member Management DTOs
// ============================================================================

/** 批量将成员（EnterpriseMember）分配到某部门 */
export const AssignDeptMembersDtoSchema = z.object({
  memberIds: z.array(z.string()).min(1, '至少指定一位成员'),
});
export type AssignDeptMembersDto = z.infer<typeof AssignDeptMembersDtoSchema>;

/** 设置 / 清除部门主管 */
export const SetDeptLeaderDtoSchema = z.object({
  memberId: z.string().nullable(),
});
export type SetDeptLeaderDto = z.infer<typeof SetDeptLeaderDtoSchema>;

// ============================================================================
// Knowledge Base DTOs
// ============================================================================

export * from './knowledge.dto';

// ============================================================================
// Compute Account DTOs
// ============================================================================

export * from './compute.dto';

// ============================================================================
// Model Config DTOs
// ============================================================================

export * from './model-config.dto';

// ============================================================================
// Enterprise Settings DTOs (Phase 4 · 企业设置拆分 + 权限细化)
// ============================================================================

export * from './enterprise-settings.dto';
export * from './skill-version.dto';

// ============================================================================
// Cost Analytics DTOs
// ============================================================================

export const CostSummarySchema = z.object({
  totalCost: z.number(),
  budgetCNY: z.number().nullable(),
  budgetUsagePercent: z.number().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  comparisonPeriodCost: z.number().optional(),
  changePercent: z.number().optional(),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

export const CostByDimensionItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: z.number(),
  percent: z.number(),
  messageCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type CostByDimensionItem = z.infer<typeof CostByDimensionItemSchema>;

export const CostTrendPointSchema = z.object({
  date: z.string(),
  cost: z.number(),
  messageCount: z.number(),
});
export type CostTrendPoint = z.infer<typeof CostTrendPointSchema>;

export const CostAlertSchema = z.object({
  id: z.string(),
  type: z.enum(['BUDGET_THRESHOLD', 'BUDGET_EXCEEDED', 'ANOMALY']),
  severity: z.enum(['WARNING', 'ERROR']),
  message: z.string(),
  triggeredAt: z.string(),
  acknowledged: z.boolean(),
});
export type CostAlert = z.infer<typeof CostAlertSchema>;

export * from './client-employee.dto';
export * from './subscription-usage.dto';
export * from './client-skill-artifact.dto';
export * from './media-gateway.dto';
export * from './media-real.dto';
export * from './skill-import-schema';
export * from './employee-copy.dto';
export * from './employee-bundle.dto';
