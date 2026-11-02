import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSwitcher } from './model-switcher';

vi.mock('@/features/enterprise-settings/use-model-config', () => ({
  useAvailableModels: () => ({
    data: [
      {
        modelId: 'gpt-4o',
        label: 'GPT-4o',
        displayName: 'GPT-4o',
        billingMultiplier: '1',
        discountLabel: '按中转倍率计费',
        isFree: false,
        vendor: 'OpenAI',
        category: 'chat',
        contextLength: null,
        maxOutputTokens: null,
        pricingInputPer1M: null,
        pricingOutputPer1M: null,
        supportedFeatures: null,
        description: null,
      },
      {
        modelId: 'free-model', label: '免费模型', displayName: '免费模型', vendor: null, category: null,
        billingMultiplier: '0', discountLabel: '活动免费', isFree: true,
        contextLength: null, maxOutputTokens: null, pricingInputPer1M: '9', pricingOutputPer1M: '9',
        supportedFeatures: null, description: null,
      },
      {
        modelId: 'unknown-rate', label: '倍率未知模型', displayName: '倍率未知模型', vendor: null, category: null,
        billingMultiplier: null, discountLabel: '中转倍率暂不可用', isFree: false,
        contextLength: null, maxOutputTokens: null, pricingInputPer1M: null, pricingOutputPer1M: null,
        supportedFeatures: null, description: null,
      },
      {
        modelId: 'gemini-3.5-flash-high',
        label: 'Gemini 3.5 Flash High',
        displayName: 'Gemini 3.5 Flash High',
        billingMultiplier: '1',
        discountLabel: '按中转倍率计费',
        isFree: false,
        vendor: 'Google',
        category: 'chat',
        contextLength: null,
        maxOutputTokens: null,
        pricingInputPer1M: null,
        pricingOutputPer1M: null,
        supportedFeatures: null,
        description: null,
      },
    ],
    isLoading: false,
  }),
}));

function renderSwitcher(
  canSwitch: boolean,
  policy: 'FOLLOW_TEMPLATE' | 'FORCE_DEFAULT' = 'FOLLOW_TEMPLATE',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelSwitcher
        conversationId="conversation-1"
        currentModelId={null}
        employeeModelId="gpt-4o"
        enterpriseDefaultModel="gemini-3.5-flash-high"
        employeeModelPolicy={policy}
        employeeDefaultModel="claude-sonnet-5"
        enterpriseId="enterprise-1"
        canSwitch={canSwitch}
      />
    </QueryClientProvider>,
  );
}

describe('ModelSwitcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('模型被锁定时展示企业默认模型而不是员工模板模型', () => {
    renderSwitcher(false);

    expect(screen.getByText('Gemini 3.5 Flash High')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
  });

  it('允许切换时未选择模型也展示企业默认模型', () => {
    renderSwitcher(true);

    expect(screen.getByText('Gemini 3.5 Flash High')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
  });

  it('FORCE_DEFAULT 时展示统一指定模型而不是员工模板模型', () => {
    renderSwitcher(true, 'FORCE_DEFAULT');

    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
  });

  it('在模型项中展示倍率和折扣文案', async () => {
    renderSwitcher(true);
    fireEvent.click(screen.getByRole('button', { name: /Gemini 3.5 Flash High/ }));

    expect(screen.getAllByText('1 倍率 · 按中转倍率计费')).toHaveLength(2);
    expect(screen.queryByText('保底价计费')).not.toBeInTheDocument();
  });

  it('活动免费模型隐藏价格提示并显示活动免费', async () => {
    renderSwitcher(true);
    fireEvent.click(screen.getByRole('button', { name: /Gemini 3.5 Flash High/ }));
    expect(screen.getByText('0 倍率 · 活动免费')).toBeInTheDocument();
    expect(screen.queryByText(/¥9/)).not.toBeInTheDocument();
  });

  it('倍率暂不可用时仅展示服务端折扣说明', () => {
    renderSwitcher(true);
    fireEvent.click(screen.getByRole('button', { name: /Gemini 3.5 Flash High/ }));
    expect(screen.getByText('中转倍率暂不可用')).toBeInTheDocument();
  });
});
