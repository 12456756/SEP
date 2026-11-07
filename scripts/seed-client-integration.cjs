#!/usr/bin/env node
// Run inside sep-dev-backend: node /app/seed-client-integration.cjs [--apply].
// Optional --relay-config-stdin reads {baseUrl, apiKey} without logging secrets.
// This standalone operations script never starts application cron jobs.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const runtimeRequire = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = runtimeRequire('@prisma/client');

const ENTERPRISE_ID = 'cmtwnxohc0001qq01uw0xciop';
const USER_ID = 'cmtwnxogu0000qq01cp78q817';
const MODEL = 'gemini-3.5-flash-high';
const EXPIRES_AT = new Date('2026-10-16T16:00:00.000Z');
const LEGACY_CREDIT_ID = 'sep-client-dev-20260916-legacy-credit';
const apply = process.argv.includes('--apply');
const profiles = [
  {
    key: 'requirements', name: '客户端联调需求分析员', position: '需求分析', avatar: '/assets/employees/silicon/product-manager.webp',
    category: 'PRODUCT_DESIGN',
    description: '澄清业务目标、拆解需求、识别依赖并编写可验证的验收标准。',
    skillName: 'client-requirements-analysis',
    body: '# 需求分析\n\n## 职责\n梳理用户目标、范围、约束和未决问题。\n\n## 工作步骤\n1. 阅读用户提供的背景与材料，不虚构缺失事实。\n2. 将需求拆解为可执行任务，明确输入、输出和依赖。\n3. 为每个任务编写验收标准。\n4. 将测试设计任务交给测试验收员。\n\n## 输出\n提供需求摘要、任务清单、验收标准和待确认问题。\n',
  },
  {
    key: 'testing', name: '客户端联调测试验收员', position: '测试验收', avatar: '/assets/employees/silicon/qa-automation.webp',
    category: 'TECH',
    description: '根据需求和验收标准设计测试用例、检查边界条件并整理缺陷证据。',
    skillName: 'client-test-validation',
    body: '# 测试验收\n\n## 职责\n验证交付是否符合需求分析员给出的验收标准。\n\n## 工作步骤\n1. 阅读需求与验收标准，识别正常、异常和权限边界。\n2. 输出前置条件、操作步骤、预期结果和证据要求。\n3. 仅将实际执行过的检查标记为通过。\n4. 将需求不明确之处交回需求分析员澄清。\n\n## 输出\n提供测试用例、验收结果、缺陷清单和未验证范围。\n',
  },
].map((p) => ({
  ...p,
  employeeId: `sep-client-dev-${p.key}-employee`,
  capabilityId: `sep-client-dev-${p.key}-capability`,
  versionId: `sep-client-dev-${p.key}-skill-v1`,
  content: `---\nname: ${p.skillName}\ndescription: ${p.description}\n---\n\n${p.body}`,
}));

function assertDevEnvironment() {
  const url = new URL(process.env.DATABASE_URL || '');
  const apiBase = new URL(process.env.API_BASE_URL || '');
  const expectedApiBase = process.env.SEP_DEV_API_BASE_URL;
  if (!expectedApiBase || url.pathname !== '/sep_dev' || apiBase.href !== new URL(expectedApiBase).href) {
    throw new Error('Refusing to initialize anything except the explicitly configured sep_dev environment');
  }
  if (apiBase.hostname === 'sep.longdaoec.com') {
    throw new Error('Refusing to initialize integration data against production');
  }
  if (new Date() >= EXPIRES_AT) throw new Error('This integration fixture has expired');
}

function decrypt(stored) {
  if (!stored?.startsWith('enc:v1:')) return stored;
  const [iv, tag, data] = stored.slice(7).split(':');
  const key = crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${content.toString('base64')}`;
}

async function main(db) {
  const member = await db.enterpriseMember.findUnique({
    where: { userId_enterpriseId: { userId: USER_ID, enterpriseId: ENTERPRISE_ID } },
    include: { enterprise: true },
  });
  if (member?.role !== 'ENTERPRISE_ADMIN' || member.enterprise.name !== '客户端联调企业') {
    throw new Error('Expected integration enterprise administrator was not found');
  }
  const settings = await db.systemSetting.findMany({ where: { key: { in: ['SUB2API_BASE_URL', 'SUB2API_API_KEY'] } } });
  const saved = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const replacement = process.argv.includes('--relay-config-stdin') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
  const baseUrl = replacement?.baseUrl || saved.SUB2API_BASE_URL || process.env.SUB2API_BASE_URL;
  const apiKey = replacement?.apiKey || decrypt(saved.SUB2API_API_KEY) || process.env.SUB2API_API_KEY;
  if (baseUrl !== 'https://ai.longdaoec.com/v1' || !apiKey) throw new Error('Expected SEP model relay configuration is missing');
  const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`SEP relay model discovery failed: HTTP ${response.status}`);
  const models = await response.json();
  if (!models.data?.some((m) => m.id === MODEL)) throw new Error('Integration model is unavailable at the SEP relay');

  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, enterpriseId: ENTERPRISE_ID, memberId: member.id, model: MODEL, expiresAt: EXPIRES_AT, employees: profiles.map(({ employeeId, capabilityId, versionId, name }) => ({ employeeId, capabilityId, versionId, name })), giftCNYPerSubscription: 25, legacyGiftCNYOnce: 25, monthlyAllowanceCNY: 50, relayConfigurationWillBeUpdated: Boolean(replacement) }, null, 2));
    return;
  }

  const result = await db.$transaction(async (tx) => {
    // Serialize concurrent runs so unique IDs cannot race the one-time credit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(9162026)`;
    const rows = [];
    for (const p of profiles) {
      await tx.capability.upsert({ where: { id: p.capabilityId }, update: {}, create: {
        id: p.capabilityId, name: p.name + '技能', description: p.description, type: 'SKILL',
        industry: ['通用'], position: [p.position], inputSchema: {}, outputSchema: {},
        contributorId: USER_ID, status: 'APPROVED', visibility: 'MARKET_PUBLIC',
        platformReviewStatus: 'APPROVED', approvedAt: new Date(), metadata: { fixture: 'sep-client-dev-20260916' },
        skillConfig: { create: { template: p.content, modelId: MODEL } },
      } });
      await tx.skillConfig.update({ where: { capabilityId: p.capabilityId }, data: { modelId: MODEL } });
      const version = await tx.skillVersion.upsert({ where: { id: p.versionId }, update: {}, create: {
        id: p.versionId, capabilityId: p.capabilityId, scope: 'PLATFORM', version: '1.0.0',
        content: p.content, status: 'PLATFORM_APPROVED', createdById: USER_ID,
        submittedAt: new Date(), platformReviewedAt: new Date(), changeSummary: '共享联调初始化技能',
      } });
      if (version.content !== p.content || version.capabilityId !== p.capabilityId || version.status !== 'PLATFORM_APPROVED') {
        throw new Error('Existing integration skill differs; refusing to overwrite a published version');
      }
      await tx.digitalEmployee.upsert({ where: { id: p.employeeId }, update: { avatar: p.avatar }, create: {
        id: p.employeeId, name: p.name, description: p.description, position: p.position, avatar: p.avatar,
        industry: '通用', functionalCategory: p.category, systemPrompt: p.description,
        modelId: MODEL, status: 'APPROVED', publishedAt: new Date(), version: '1.0.0',
        annualPriceCNY: 0, includedComputeCNY: 25,
      } });
      await tx.employeeCapabilityBinding.upsert({ where: { employeeId_capabilityId: { employeeId: p.employeeId, capabilityId: p.capabilityId } }, update: {}, create: {
        employeeId: p.employeeId, capabilityId: p.capabilityId, defaultSkillVersionId: p.versionId, enabled: true,
      } });
      const subscription = await tx.subscription.upsert({ where: { enterpriseId_employeeId: { enterpriseId: ENTERPRISE_ID, employeeId: p.employeeId } }, update: {}, create: {
        enterpriseId: ENTERPRISE_ID, employeeId: p.employeeId, name: p.name, status: 'ACTIVE',
        templateVersion: '1.0.0', endDate: EXPIRES_AT, purchaseAmountCNY: 0, config: { fixture: 'sep-client-dev-20260916' },
      } });
      const existingGrant = await tx.employeeGrant.findFirst({ where: { subscriptionId: subscription.id, memberId: member.id } });
      if (!existingGrant) await tx.employeeGrant.create({ data: { subscriptionId: subscription.id, memberId: member.id, expiresAt: EXPIRES_AT } });
      await tx.subscriptionCredit.upsert({ where: { subscriptionId: subscription.id }, update: {}, create: {
        subscriptionId: subscription.id, enterpriseId: ENTERPRISE_ID, employeeId: p.employeeId,
        grantedCNY: 25, usedCNY: 0, status: 'ACTIVE', sourceType: 'subscription', sourceId: 'sep-client-dev-20260916',
      } });
      rows.push({ employeeId: p.employeeId, subscriptionId: subscription.id, capabilityId: p.capabilityId, versionId: p.versionId, name: p.name });
    }
    await tx.memberComputeAllowance.upsert({ where: { enterpriseId_userId: { enterpriseId: ENTERPRISE_ID, userId: USER_ID } }, update: {}, create: {
      enterpriseId: ENTERPRISE_ID, userId: USER_ID, limitCNY: 50, period: 'MONTH', carryOver: false, enabled: true,
    } });
    const account = await tx.computeAccount.upsert({ where: { enterpriseId: ENTERPRISE_ID }, update: {}, create: { enterpriseId: ENTERPRISE_ID } });
    if (!await tx.computeTransaction.findUnique({ where: { id: LEGACY_CREDIT_ID } })) {
      await tx.computeTransaction.create({ data: { id: LEGACY_CREDIT_ID, accountId: account.id, type: 'RECHARGE', amount: 25, description: '客户端联调一次性测试额度', metadata: { fixture: 'sep-client-dev-20260916' } } });
      await tx.computeAccount.update({ where: { id: account.id }, data: { balance: { increment: 25 } } });
    }
    await tx.platformModel.upsert({ where: { modelId: MODEL }, update: { enabled: true }, create: { modelId: MODEL, label: MODEL, enabled: true } });
    await tx.enterpriseModelConfig.upsert({ where: { enterpriseId: ENTERPRISE_ID }, update: { plannerModel: MODEL }, create: { enterpriseId: ENTERPRISE_ID, allowedChatModels: [MODEL], defaultChatModel: MODEL, plannerModel: MODEL } });
    if (replacement) {
      for (const [key, value, isSecret] of [['SUB2API_BASE_URL', baseUrl, false], ['SUB2API_API_KEY', encrypt(apiKey), true]]) {
        await tx.systemSetting.upsert({ where: { key }, update: { value, isSecret }, create: { key, value, isSecret, category: 'sub2api' } });
      }
    }
    return rows;
  }, { timeout: 30000 });
  console.log(JSON.stringify({ dryRun: false, enterpriseId: ENTERPRISE_ID, memberId: member.id, expiresAt: EXPIRES_AT, model: MODEL, employees: result }, null, 2));
}

let db;
Promise.resolve().then(() => { assertDevEnvironment(); db = new PrismaClient(); return main(db); })
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => db?.$disconnect());
