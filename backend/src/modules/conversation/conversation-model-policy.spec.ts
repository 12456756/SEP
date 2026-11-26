import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationService } from './conversation.service';

describe('ConversationService.switchModel enterprise policy', () => {
  let prisma: any;
  let modelConfig: any;
  let context: any;
  let service: ConversationService;

  beforeEach(() => {
    prisma = {
      conversationSession: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user', enterpriseId: 'enterprise' }),
        update: jest.fn().mockImplementation(async ({ data }) => data),
      },
      platformModel: { findUnique: jest.fn(), findFirst: jest.fn() },
    };
    modelConfig = { resolveEffectiveModel: jest.fn().mockResolvedValue({
      allowUserSwitchModel: true, allowedChatModels: ['enterprise-only'],
    }) };
    context = { resolve: jest.fn().mockResolvedValue({ enterpriseId: 'enterprise', departmentId: 'department' }) };
    service = new ConversationService(prisma, {} as never, modelConfig, {} as never, {} as never, context);
  });

  it('switches to a model authorized by the enterprise without querying the old model table', async () => {
    await expect(service.switchModel('session', 'user', 'enterprise-only')).resolves.toEqual({ modelId: 'enterprise-only' });
    expect(modelConfig.resolveEffectiveModel).toHaveBeenCalledWith({
      userId: 'user', enterpriseId: 'enterprise', departmentId: 'department', restrictToAvailableModels: true,
    });
    expect(prisma.platformModel.findUnique).not.toHaveBeenCalled();
    expect(prisma.platformModel.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a model outside the enterprise key and department intersection', async () => {
    await expect(service.switchModel('session', 'user', 'foreign')).rejects.toThrow(BadRequestException);
    expect(prisma.conversationSession.update).not.toHaveBeenCalled();
  });

  it('does not interpret an empty enterprise catalog as unrestricted', async () => {
    modelConfig.resolveEffectiveModel.mockResolvedValue({ allowUserSwitchModel: true, allowedChatModels: [] });
    await expect(service.switchModel('session', 'user', 'enterprise-only')).rejects.toThrow(BadRequestException);
    expect(prisma.conversationSession.update).not.toHaveBeenCalled();
  });

  it.each(['enterprise-only', ''])('enforces disabled switching for %p', async modelId => {
    modelConfig.resolveEffectiveModel.mockResolvedValue({ allowUserSwitchModel: false, allowedChatModels: ['enterprise-only'] });
    await expect(service.switchModel('session', 'user', modelId)).rejects.toThrow(ForbiddenException);
    expect(prisma.conversationSession.update).not.toHaveBeenCalled();
  });

  it('allows clearing a selection to follow the default when switching is allowed', async () => {
    await expect(service.switchModel('session', 'user', '')).resolves.toEqual({ modelId: null });
  });

  it.each([
    [null, NotFoundException],
    [{ userId: 'other', enterpriseId: 'enterprise' }, ForbiddenException],
    [{ userId: 'user', enterpriseId: 'other' }, ForbiddenException],
  ])('rejects missing or foreign sessions %j', async (session, exception) => {
    prisma.conversationSession.findUnique.mockResolvedValue(session);
    await expect(service.switchModel('session', 'user', 'enterprise-only')).rejects.toThrow(exception);
    expect(modelConfig.resolveEffectiveModel).not.toHaveBeenCalled();
    expect(prisma.conversationSession.update).not.toHaveBeenCalled();
  });
});
