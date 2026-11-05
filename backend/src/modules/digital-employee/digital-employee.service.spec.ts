import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DigitalEmployeeService } from './digital-employee.service';
import { EmployeeTrackRecordService } from './employee-track-record.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeeReadinessService } from './employee-readiness.service';

// ─── Mock PrismaService ───────────────────────────────────────────────────────

const mockEmployee = {
  id: 'emp-1',
  name: '电商运营助手',
  description: '专注电商运营的数字员工，可执行数据分析和内容创作任务',
  industry: '电商',
  position: '运营',
  avatar: null,
  systemPrompt: '你是一名专业的电商运营助手',
  modelId: 'gemini-3.5-flash-high',
  maxSteps: 10,
  price: 99.0,
  status: 'DRAFT',
  publishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  bindings: [],
};

const mockCapability = {
  id: 'cap-1',
  name: '商品描述生成',
  status: 'APPROVED',
};

const mockBinding = {
  id: 'bind-1',
  employeeId: 'emp-1',
  capabilityId: 'cap-1',
  priority: 0,
  createdAt: new Date(),
  capability: { id: 'cap-1', name: '商品描述生成', type: 'AGENT', description: '...' },
};

const prismaMock = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  digitalEmployee: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  capability: {
    findMany: jest.fn(),
  },
  skillVersion: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  employeeCapabilityBinding: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
  conversationSession: {
    findMany: jest.fn(),
  },
  toolExecution: {
    findMany: jest.fn(),
  },
};

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('DigitalEmployeeService', () => {
  let service: DigitalEmployeeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigitalEmployeeService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: EmployeeReadinessService,
          useFactory: () => new EmployeeReadinessService(prismaMock as any, { describe: jest.fn(), assertEmployeeSubscriptionsReady: jest.fn() } as any),
        },
        {
          // 人才市场履历由独立 service 算（一条原生 SQL），这里只需它别真跑
          provide: EmployeeTrackRecordService,
          useValue: {
            forEmployees: jest.fn().mockResolvedValue(new Map()),
            forEmployee: jest
              .fn()
              .mockResolvedValue({ totalExecutions: 0, successRate: null }),
          },
        },
      ],
    }).compile();

    service = module.get<DigitalEmployeeService>(DigitalEmployeeService);
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation((action) => action(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'emp-1' }]);
    prismaMock.employeeCapabilityBinding.findMany.mockResolvedValue([{
      ...mockBinding, enabled: true, defaultSkillVersionId: null, defaultSkillVersion: null,
      capability: { ...mockBinding.capability, status: 'APPROVED', enterpriseId: null },
    }]);
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    const baseDto = {
      name: '电商运营助手',
      description: '专注电商运营的数字员工，可执行数据分析和内容创作任务',
      industry: '电商',
      position: '运营',
      systemPrompt: '你是一名专业的电商运营助手',
      modelId: 'gemini-3.5-flash-high',
      maxSteps: 10,
      capabilityIds: [] as string[],
    };

    it('creates employee without capabilities', async () => {
      prismaMock.digitalEmployee.create.mockResolvedValue(mockEmployee);

      const result = await service.create(baseDto);

      expect(prismaMock.capability.findMany).not.toHaveBeenCalled();
      expect(prismaMock.digitalEmployee.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: baseDto.name }) }),
      );
      expect(result).toEqual(mockEmployee);
    });

    it('validates capabilities are APPROVED before creating', async () => {
      prismaMock.capability.findMany.mockResolvedValue([mockCapability]);
      prismaMock.digitalEmployee.create.mockResolvedValue({
        ...mockEmployee,
        bindings: [mockBinding],
      });

      const dto = { ...baseDto, capabilityIds: ['cap-1'] };
      await service.create(dto);

      expect(prismaMock.capability.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['cap-1'] } } }),
      );
    });

    it('throws BadRequestException when capability is not APPROVED', async () => {
      prismaMock.capability.findMany.mockResolvedValue([
        { id: 'cap-2', name: '未审核能力', status: 'PENDING' },
      ]);

      await expect(
        service.create({ ...baseDto, capabilityIds: ['cap-2'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when capability id does not exist', async () => {
      prismaMock.capability.findMany.mockResolvedValue([]);

      await expect(
        service.create({ ...baseDto, capabilityIds: ['non-existent'] }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── findAll ─────────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns all employees when no status filter', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([mockEmployee]);

      const result = await service.findAll();

      expect(prismaMock.digitalEmployee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
      expect(result).toHaveLength(1);
    });

    it('filters by status when provided', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findAll('APPROVED');

      expect(prismaMock.digitalEmployee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'APPROVED' } }),
      );
    });
  });

  // ── findOne ─────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns employee when found', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);

      const result = await service.findOne('emp-1');

      expect(result).toEqual(mockEmployee);
    });

    it('throws NotFoundException when not found', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(null);

      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates employee fields', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      const updated = { ...mockEmployee, name: '新名称' };
      prismaMock.digitalEmployee.update.mockResolvedValue(updated);

      const result = await service.update('emp-1', { name: '新名称' });

      expect(prismaMock.digitalEmployee.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'emp-1' } }),
      );
      expect(result.name).toBe('新名称');
    });

    it('stamps publishedAt after readiness checks when status changes to APPROVED', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.digitalEmployee.update.mockResolvedValue({
        ...mockEmployee,
        status: 'APPROVED',
      });

      await service.update('emp-1', { status: 'APPROVED' });

      expect(prismaMock.digitalEmployee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ publishedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws NotFoundException when employee not found', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(null);

      await expect(service.update('bad-id', { name: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ──────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes the employee', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.digitalEmployee.delete.mockResolvedValue(mockEmployee);

      await service.remove('emp-1');

      expect(prismaMock.digitalEmployee.delete).toHaveBeenCalledWith({ where: { id: 'emp-1' } });
    });

    it('throws NotFoundException when not found', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(null);

      await expect(service.remove('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ── bindCapability ───────────────────────────────────────────────────────────

  describe('bindCapability', () => {
    it('uses the latest platform publication as the default Skill version with creation time fallback', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.capability.findMany.mockResolvedValue([mockCapability]);
      prismaMock.skillVersion.findMany.mockResolvedValueOnce([
        { id: 'republished-old-draft', capabilityId: 'cap-1' },
        { id: 'previous-publication', capabilityId: 'cap-1' },
      ]);
      prismaMock.employeeCapabilityBinding.create.mockResolvedValue(mockBinding);

      await service.bindCapability('emp-1', { capabilityId: 'cap-1', priority: 0 });

      expect(prismaMock.skillVersion.findMany).toHaveBeenCalledWith({
        where: { capabilityId: { in: ['cap-1'] }, scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
        select: { id: true, capabilityId: true },
        orderBy: [
          { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      });
      expect(prismaMock.employeeCapabilityBinding.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ defaultSkillVersionId: 'republished-old-draft' }),
        }),
      );
    });

    it('binds an approved capability', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.capability.findMany.mockResolvedValue([mockCapability]);
      prismaMock.employeeCapabilityBinding.create.mockResolvedValue(mockBinding);

      const result = await service.bindCapability('emp-1', {
        capabilityId: 'cap-1',
        priority: 0,
      });

      expect(result).toEqual(mockBinding);
    });

    it('throws ConflictException when already bound (P2002)', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.capability.findMany.mockResolvedValue([mockCapability]);
      prismaMock.employeeCapabilityBinding.create.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.bindCapability('emp-1', { capabilityId: 'cap-1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when capability not approved', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.capability.findMany.mockResolvedValue([
        { id: 'cap-pending', name: 'x', status: 'PENDING' },
      ]);

      await expect(
        service.bindCapability('emp-1', { capabilityId: 'cap-pending' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── unbindCapability ─────────────────────────────────────────────────────────

  describe('unbindCapability', () => {
    it('removes the binding', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.employeeCapabilityBinding.findUnique.mockResolvedValue(mockBinding);
      prismaMock.employeeCapabilityBinding.delete.mockResolvedValue(mockBinding);

      await service.unbindCapability('emp-1', 'cap-1');

      expect(prismaMock.employeeCapabilityBinding.delete).toHaveBeenCalled();
    });

    it('throws NotFoundException when binding does not exist', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue(mockEmployee);
      prismaMock.employeeCapabilityBinding.findUnique.mockResolvedValue(null);

      await expect(service.unbindCapability('emp-1', 'non-bound')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── 公开投影（安全边界，不要放宽这些断言）─────────────────────────────────

  describe('findPublicList / findPublicOne', () => {
    /** 访客绝不该看到的字段 */
    const FORBIDDEN = ['systemPrompt', 'modelId', 'maxSteps'];

    it('列表只查 PUBLISHED，调用方无法指定 status', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findPublicList();

      const arg = prismaMock.digitalEmployee.findMany.mock.calls[0][0];
      expect(arg.where.status).toBe('APPROVED');
    });

    it('列表用 select 白名单，不含 systemPrompt / modelId / maxSteps', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findPublicList();

      const arg = prismaMock.digitalEmployee.findMany.mock.calls[0][0];
      // 必须是 select 白名单而非 include —— include 会带出全部标量字段
      expect(arg.select).toBeDefined();
      expect(arg.include).toBeUndefined();
      for (const f of FORBIDDEN) {
        expect(arg.select).not.toHaveProperty(f);
      }
    });

    it('capability 只投影 id/name/type', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findPublicList();

      const arg = prismaMock.digitalEmployee.findMany.mock.calls[0][0];
      // 白名单式断言：列出全部允许的字段。
      // 用 toEqual 而非 toMatchObject —— 后者不会在新增字段时报错，
      // 而这里的重点恰恰是「有人往公开投影里加字段时必须先改测试」。
      expect(arg.select.bindings.select.capability.select).toEqual({
        id: true,
        name: true,
        type: true,
        description: true,
      });
    });

    it('搜索词落到 name/description/industry/position 的 OR 上', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findPublicList('  文案  ');

      const arg = prismaMock.digitalEmployee.findMany.mock.calls[0][0];
      // 前后空格应被裁掉
      expect(arg.where.OR).toEqual([
        { name: { contains: '文案', mode: 'insensitive' } },
        { description: { contains: '文案', mode: 'insensitive' } },
        { industry: { contains: '文案', mode: 'insensitive' } },
        { position: { contains: '文案', mode: 'insensitive' } },
      ]);
      // 搜索不得覆盖 PUBLISHED 约束
      expect(arg.where.status).toBe('APPROVED');
    });

    it('搜索词为空白时不加 OR 条件', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([]);

      await service.findPublicList('   ');

      const arg = prismaMock.digitalEmployee.findMany.mock.calls[0][0];
      expect(arg.where.OR).toBeUndefined();
    });

    it('列表返回统一头像资产，保留公开字段白名单', async () => {
      const employee = {
        id: 'emp-avatar',
        name: '头像测试员工',
        avatar: 'https://cdn.example.com/avatar.webp',
        avatarStyle: 'custom',
        avatarBindings: {},
        publishedAt: new Date(),
        _count: { subscriptions: 0 },
      };
      prismaMock.digitalEmployee.findMany.mockResolvedValue([employee]);

      const result = await service.findPublicList();

      expect(result[0]).toEqual(expect.objectContaining({
        avatar: employee.avatar,
        avatarAsset: {
          id: 'employee:emp-avatar:avatar',
          version: null,
          portraitUrl: employee.avatar,
          faceUrl: employee.avatar,
        },
      }));
      expect(result[0]).not.toHaveProperty('systemPrompt');
      expect(result[0]).not.toHaveProperty('modelId');
      expect(result[0]).not.toHaveProperty('maxSteps');
    });

    it('列表为最近 7 天上架员工标记 NEW，并按使用信号标记 HOT', async () => {
      prismaMock.digitalEmployee.findMany.mockResolvedValue([
        {
          id: 'emp-new',
          publishedAt: new Date(),
          _count: { subscriptions: 2 },
        },
      ]);
      const result = await service.findPublicList();

      expect(result[0]).toEqual(
        expect.objectContaining({ isNew: true, isHot: true }),
      );
    });

    it('详情按 id + PUBLISHED 双条件查', async () => {
      prismaMock.digitalEmployee.findFirst.mockResolvedValue({ id: 'emp-1' });

      await service.findPublicOne('emp-1');

      const arg = prismaMock.digitalEmployee.findFirst.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'emp-1', status: 'APPROVED' });
      for (const f of FORBIDDEN) {
        expect(arg.select).not.toHaveProperty(f);
      }
    });

    it('未上架员工详情抛 404，而非返回 null', async () => {
      prismaMock.digitalEmployee.findFirst.mockResolvedValue(null);

      await expect(
        service.findPublicOne('emp-draft'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStats', () => {
    it('只汇总当前用户在该员工上的执行记录', async () => {
      prismaMock.digitalEmployee.findUnique.mockResolvedValue({ id: 'emp-1' });
      prismaMock.conversationSession.findMany.mockResolvedValue([]);

      await service.getStats('emp-1', 7, 'user-1');

      expect(prismaMock.conversationSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            employeeId: 'emp-1',
            userId: 'user-1',
          }),
        }),
      );
      expect(prismaMock.toolExecution.findMany).not.toHaveBeenCalled();
    });
  });
});
