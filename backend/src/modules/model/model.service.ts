import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { SettingService } from "../setting/setting.service";
import { SETTING_KEYS, hasPricing, type UpdatePlatformModelDto } from "shared";
import { ModelBillingService } from './model-billing.service';

/** 上游返回的模型条目（标准化后）。 */
export interface UpstreamModelEntry {
  id: string;
  label: string;
}

/** sub2api /v1/models 单条返回结构（仅取需要的字段）。 */
interface RawUpstreamModel {
  id: string;
  display_name?: string;
}

/** 同步结果摘要。 */
export interface SyncResult {
  upstreamTotal: number;
  added: number;
  restored: number; // 之前 isStale，本次上游又出现了
  staled: number; // 上游已消失，标记为失效
}

/**
 * 模型可用性测试的等待上限。
 *
 * 判定的是「首个流式片段能不能到」，不是「答完要多久」，所以不必给很长 ——
 * 卡住的模型是一个字节都不给，20 秒足以区分「慢」和「死」。
 */
const TEST_TIMEOUT_MS = 20_000;

@Injectable()
export class ModelService {
  private readonly logger = new Logger(ModelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingService: SettingService,
    private readonly billing: ModelBillingService,
  ) {}

  // ── 上游 ────────────────────────────────────────────────────────────────

  /**
   * 实时拉取上游 sub2api 的全量模型列表（管理员用，用于同步）。
   * URL/KEY 来自 SystemSetting（回退 .env）。
   */
  async listUpstream(): Promise<UpstreamModelEntry[]> {
    const baseURL = await this.settingService.getEffectiveValue(
      SETTING_KEYS.SUB2API_BASE_URL,
    );
    const apiKey = await this.settingService.getEffectiveValue(
      SETTING_KEYS.SUB2API_API_KEY,
    );

    if (!baseURL || !apiKey) {
      throw new ServiceUnavailableException(
        "上游渠道未配置，请先在系统设置中填写 sub2api 地址和密钥",
      );
    }

    const url = `${baseURL.replace(/\/$/, "")}/models`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error(`Failed to reach upstream ${url}`, err);
      throw new ServiceUnavailableException(
        "无法连接上游渠道，请检查地址和网络",
      );
    }

    if (!res.ok) {
      this.logger.error(`Upstream /models returned ${res.status}`);
      throw new ServiceUnavailableException(
        `上游返回错误 (${res.status})，请检查密钥是否有效`,
      );
    }

    const json = (await res.json()) as { data?: RawUpstreamModel[] };
    return (json.data ?? [])
      .map((m) => ({ id: m.id, label: m.display_name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ── 同步 ────────────────────────────────────────────────────────────────

  /**
   * 同步上游模型到平台白名单表。
   * - 上游新增 → 入库，enabled=false（需管理员手动启用，避免误开放图像/preview 模型）
   * - 上游仍在 → 刷新 lastSeenAt，若曾标记 isStale 则恢复
   * - 上游消失 → 标记 isStale（不物理删除，保留历史会话可读）
   */
  async syncFromUpstream(): Promise<SyncResult> {
    const upstream = await this.listUpstream();
    const upstreamIds = new Set(upstream.map((m) => m.id));
    const now = new Date();

    const existing = await this.prisma.platformModel.findMany();
    const existingByModelId = new Map(existing.map((m) => [m.modelId, m]));

    let added = 0;
    let restored = 0;

    for (const m of upstream) {
      const found = existingByModelId.get(m.id);
      if (!found) {
        await this.prisma.platformModel.create({
          data: {
            modelId: m.id,
            label: m.label,
            enabled: false,
            lastSeenAt: now,
          },
        });
        added++;
      } else {
        if (found.isStale) restored++;
        await this.prisma.platformModel.update({
          where: { id: found.id },
          data: { lastSeenAt: now, isStale: false },
        });
      }
    }

    // 上游已消失的：标记失效，不删除
    const staleTargets = existing.filter(
      (m) => !upstreamIds.has(m.modelId) && !m.isStale,
    );
    if (staleTargets.length > 0) {
      await this.prisma.platformModel.updateMany({
        where: { id: { in: staleTargets.map((m) => m.id) } },
        data: { isStale: true },
      });
    }

    const result: SyncResult = {
      upstreamTotal: upstream.length,
      added,
      restored,
      staled: staleTargets.length,
    };
    this.logger.log(`Model sync done: ${JSON.stringify(result)}`);
    return result;
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /**
   * 管理端：列出平台全部模型（含禁用与失效）。
   * 附带 hasPricing 标记 —— 未配价的模型启用后按保底价计费，
   * 前端据此显示警示，提醒尽快在 MODEL_PRICING 补上真实价格。
   */
  async listAll() {
    const rows = await this.prisma.platformModel.findMany({
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
    });
    return rows.map((r) => ({ ...r, hasPricing: hasPricing(r.modelId) }));
  }

  /**
   * 用户端：仅返回已启用且未失效的模型。
   * 用于员工表单的模型选择、会话内模型切换。
   */
  async listEnabled() {
    const rows = await this.prisma.platformModel.findMany({
      where: { enabled: true, isStale: false },
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
      select: {
        modelId: true,
        label: true,
        isFree: true,
        vendor: true,
        category: true,
        description: true,
        contextLength: true,
        maxOutputTokens: true,
        pricingInputPer1M: true,
        pricingOutputPer1M: true,
        supportedFeatures: true,
      },
    });
    const billing = await this.billing.describe(rows);
    return rows.map((r, index) => ({
      id: r.modelId,
      modelId: r.modelId,
      label: r.label,
      displayName: r.label,
      ...billing[index],
      vendor: r.vendor,
      category: r.category,
      description: r.description,
      contextLength: r.contextLength,
      maxOutputTokens: r.maxOutputTokens,
      pricingInputPer1M: r.pricingInputPer1M?.toNumber() ?? null,
      pricingOutputPer1M: r.pricingOutputPer1M?.toNumber() ?? null,
      supportedFeatures: r.supportedFeatures,
    }));
  }

  /** 校验某模型 ID 是否已对用户开放（切换模型时用）。 */
  async isEnabled(modelId: string): Promise<boolean> {
    const row = await this.prisma.platformModel.findUnique({
      where: { modelId },
      select: { enabled: true, isStale: true },
    });
    return !!row && row.enabled && !row.isStale;
  }

  // ── 修改 ────────────────────────────────────────────────────────────────

  /** 管理端：更新单个模型（启用状态 / 活动免费 / 显示名 / 排序）。 */
  async updateModel(
    id: string,
    data: UpdatePlatformModelDto,
  ) {
    const found = await this.prisma.platformModel.findUnique({ where: { id } });
    if (!found) throw new NotFoundException(`Model ${id} not found`);

    const updated = await this.prisma.platformModel.update({
      where: { id },
      data: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.label !== undefined && { label: data.label }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.isFree !== undefined && { isFree: data.isFree }),
      },
    });
    // 与 listAll 保持同样的返回结构，避免前端 PlatformModel 类型与实际响应不一致
    return { ...updated, hasPricing: hasPricing(updated.modelId) };
  }

  /** 管理端：测试模型可用性（发送一个简单的测试消息）。 */
  async testModel(id: string) {
    // 先查询数据库记录，获取真实的 modelId
    const model = await this.prisma.platformModel.findUnique({
      where: { id },
      select: { modelId: true, label: true },
    });
    if (!model) {
      throw new NotFoundException(`Model ${id} not found`);
    }

    const baseURL = await this.settingService.getEffectiveValue(
      SETTING_KEYS.SUB2API_BASE_URL,
    );
    const apiKey = await this.settingService.getEffectiveValue(
      SETTING_KEYS.SUB2API_API_KEY,
    );

    if (!baseURL || !apiKey) {
      throw new ServiceUnavailableException(
        '上游渠道未配置，请先在系统设置中填写 sub2api 地址和密钥',
      );
    }

    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    const startTime = Date.now();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // 必须用 stream: true 测。对话链路（streamText）永远是流式的，而中转对
        // 「非流式能回、流式一个字节都不回」的模型是真实存在的：2026-09-05 实测
        // 14 个上游模型有 6 个如此，其中 gemini-3.5-flash 还是某企业的默认会话模型。
        // 用非流式测出来的「可用」是假绿灯 —— 管理员据此启用，用户那边永远「正在输入」。
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: '你好，请回复一个字：好' }],
          max_tokens: 10,
          stream: true,
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(`Model test failed for ${model.modelId}: ${res.status} ${text}`);
        throw new ServiceUnavailableException(
          `模型测试失败 (${res.status})：${text.substring(0, 200)}`,
        );
      }

      const stream = await this.readFirstStreamDelta(res);
      const latency = Date.now() - startTime;

      if (!stream.receivedAnyByte) {
        throw new ServiceUnavailableException(
          `模型测试失败：上游接受了请求但 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒内没有返回任何流式数据。` +
            '该模型不能用于对话（对话链路只走流式）。',
        );
      }
      if (!stream.text) {
        throw new ServiceUnavailableException(
          `模型测试失败：上游返回了流但没有任何文本内容${stream.raw ? `（原始片段：${stream.raw.slice(0, 160)}）` : ''}。`,
        );
      }

      return {
        success: true,
        modelId: model.modelId,
        latency,
        response: stream.text,
        message: `流式测试成功，首字延迟 ${latency}ms`,
      };
    } catch (err) {
      this.logger.error(`Model test error for ${model.modelId}`, err);
      // fetch 的 AbortSignal.timeout 抛的是 "The operation was aborted due to
      // timeout"，对运营毫无信息量 —— 他要判断的是「这个模型能不能启用」。
      // 上游连响应头都不给的情况实测存在（gemini-3.5-flash 就是），必须说清。
      const raw = (err as Error).message ?? '';
      const timedOut =
        (err as Error).name === 'TimeoutError' || raw.includes('aborted');
      throw new ServiceUnavailableException(
        timedOut
          ? `模型测试失败：${Math.round(TEST_TIMEOUT_MS / 1000)} 秒内上游没有返回任何流式数据。` +
            '该模型不能用于对话（对话链路只走流式），不要启用它。'
          : `模型测试失败：${raw}`,
      );
    }
  }

  /**
   * 读 SSE 响应，拿到第一段有内容的 delta 就返回。
   *
   * 只读开头、不读完整回复：测试要回答的是「这个模型能不能开始流」，
   * 读完整段既慢又白花上游的钱。
   */
  private async readFirstStreamDelta(res: Response): Promise<{
    receivedAnyByte: boolean;
    text: string;
    raw: string;
  }> {
    const body = res.body;
    if (!body) return { receivedAnyByte: false, text: '', raw: '' };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) text += delta;
          } catch {
            // 半截 JSON：下一个 chunk 拼上再解析
          }
        }
        if (text) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { receivedAnyByte: raw.length > 0, text, raw };
  }
}
