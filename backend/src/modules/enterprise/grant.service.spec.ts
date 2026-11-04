import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { GrantService } from "./grant.service";
import { EnterpriseContextService } from "./enterprise-context.service";
import { EmployeeUsageService } from "./employee-usage.service";
import { PackageService } from "../digital-employee/package.service";
import { PrismaService } from "../../prisma/prisma.service";
import { withEmployeeAvatar } from '../../common/employee-avatar';

const ADMIN_CTX = {
  enterpriseId: "ent-a",
  memberId: "m-admin",
  role: "ENTERPRISE_ADMIN" as const,
  departmentId: "d-1",
};

/** 造一条 findMany 返回的授权行 */
const grantRow = (subscriptionId: string, expiresAt: Date | null = null) => ({
  expiresAt,
  subscription: {
    id: subscriptionId,
    name: `雇佣关系 ${subscriptionId}`,
    templateVersion: "1.0.0",
    employee: { id: "t1", name: "客服", avatar: null },
  },
});

describe("GrantService", () => {
  let service: GrantService;
  let prisma: any;
  let ctx: any;
  let packages: any;
  let usage: any;

  beforeEach(async () => {
    prisma = {
      employeeGrant: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      subscription: { findUnique: jest.fn(), findMany: jest.fn() },
      department: { findUnique: jest.fn() },
      enterpriseMember: { findUnique: jest.fn() },
      // myEmployees 会批量补上每个员工的赠送余额；默认「没有赠送记录」
      subscriptionCredit: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    ctx = {
      resolve: jest.fn().mockResolvedValue(ADMIN_CTX),
      assertEnterpriseAdmin: jest.fn(),
    };
    packages = {
      // 默认无包 —— 测 myEmployees 时不关心 packageAvailable 的具体值
      employeeIdsWithPackage: jest.fn().mockResolvedValue(new Set()),
    };
    usage = {
      // 默认「没有使用情况」—— 聚合口径由 employee-usage.service.spec.ts 覆盖
      forSubscriptions: jest.fn().mockResolvedValue(new Map()),
    };

    const mod = await Test.createTestingModule({
      providers: [
        GrantService,
        { provide: PrismaService, useValue: prisma },
        { provide: EnterpriseContextService, useValue: ctx },
        // 只用于给 myEmployees 标注 packageAvailable，默认「都没有包」
        { provide: PackageService, useValue: packages },
        { provide: EmployeeUsageService, useValue: usage },
      ],
    }).compile();

    service = mod.get(GrantService);
  });

  describe("myEmployees —— 两条授权路径合并", () => {
    it('returns platform avatar metadata for both grant paths', async () => {
      const direct = grantRow('direct');
      const department = grantRow('department');
      direct.subscription.employee.avatar = '/assets/employees/silicon/frontend-engineer.webp';
      department.subscription.employee.avatar = direct.subscription.employee.avatar;
      prisma.employeeGrant.findMany.mockResolvedValueOnce([direct]).mockResolvedValueOnce([department]);
      const rows = await service.myEmployees('u1');
      const expected = withEmployeeAvatar(direct.subscription.employee);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.employee.avatarAsset).toEqual(expected.avatarAsset);
        expect(row.employee.avatar).toBe(expected.avatar);
      }
    });
    it("部门授权与直接授权使用相同的能力字段选择", async () => {
      await service.myEmployees("u1");
      const [direct, department] = prisma.employeeGrant.findMany.mock.calls.map(([query]: any[]) => query.include.subscription.include.employee);
      expect(department).toEqual(direct);
      expect(department.select.bindings).toBeDefined();
      expect(department.select.functionalCategory).toBe(true);
      expect(department.select.systemPrompt).toBeUndefined();
    });
    it("直接授权与部门授权都返回", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([grantRow("i-direct")]) // 直接
        .mockResolvedValueOnce([grantRow("i-dept")]); // 部门

      const rows = await service.myEmployees("u1");

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.subscriptionId === "i-direct")?.grantSource).toBe(
        "DIRECT",
      );
      expect(rows.find((r) => r.subscriptionId === "i-dept")?.grantSource).toBe(
        "DEPARTMENT",
      );
    });

    it("同一雇佣关系两条路径都命中时只返回一条，直接授权优先", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([grantRow("i-same")])
        .mockResolvedValueOnce([grantRow("i-same")]);

      const rows = await service.myEmployees("u1");

      expect(rows).toHaveLength(1);
      expect(rows[0].grantSource).toBe("DIRECT");
    });

    it("成员不属于任何部门时跳过部门查询", async () => {
      ctx.resolve.mockResolvedValue({ ...ADMIN_CTX, departmentId: null });
      prisma.employeeGrant.findMany.mockResolvedValueOnce([
        grantRow("i-direct"),
      ]);

      const rows = await service.myEmployees("u1");

      // 只查了一次（直接授权），没查部门
      expect(prisma.employeeGrant.findMany).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(1);
    });

    it("只查 ACTIVE 雇佣关系且过滤未过期授权", async () => {
      await service.myEmployees("u1");

      const where = prisma.employeeGrant.findMany.mock.calls[0][0].where;
      expect(where.subscription).toMatchObject({
        enterpriseId: "ent-a",
        status: "ACTIVE",
      });
      // expiresAt 为空或未到期
      expect(where.OR).toEqual([
        { expiresAt: null },
        { expiresAt: { gt: expect.any(Date) } },
      ]);
    });

    it("按当前成员 id 查直接授权，而非 userId", async () => {
      await service.myEmployees("u1");
      const where = prisma.employeeGrant.findMany.mock.calls[0][0].where;
      expect(where.memberId).toBe("m-admin");
    });

    it("标注 packageAvailable —— 前端据此决定下载按钮是否可点", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([grantRow("i-has-pkg")])
        .mockResolvedValueOnce([]);
      // 模板 t1 有包
      packages.employeeIdsWithPackage.mockResolvedValue(new Set(["t1"]));

      const rows = await service.myEmployees("u1");

      expect(rows[0].packageAvailable).toBe(true);
      // 只按去重后的模板 id 查一次，不是每行查一次
      expect(packages.employeeIdsWithPackage).toHaveBeenCalledWith(["t1"]);
    });

    it("运营未上传包时 packageAvailable 为 false，而非 undefined", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([grantRow("i-no-pkg")])
        .mockResolvedValueOnce([]);
      packages.employeeIdsWithPackage.mockResolvedValue(new Set());

      const rows = await service.myEmployees("u1");

      expect(rows[0].packageAvailable).toBe(false);
    });

    it("附上使用情况，且只按去重后的订阅批量算一次", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([grantRow("i-a")])
        .mockResolvedValueOnce([grantRow("i-b")]);
      usage.forSubscriptions.mockResolvedValue(
        new Map([
          [
            "i-a",
            {
              activeUserCount30d: 3,
              grantedUserCount: 8,
              lastUsedAt: "2026-09-01T00:00:00.000Z",
              monthCostCNY: "12.40",
              monthCallCount: 27,
              executionCount30d: 115,
              successRate30d: 96,
            },
          ],
        ]),
      );

      const rows = await service.myEmployees("u1");

      expect(usage.forSubscriptions).toHaveBeenCalledTimes(1);
      expect(usage.forSubscriptions).toHaveBeenCalledWith("ent-a", [
        { subscriptionId: "i-a", employeeId: "t1" },
        { subscriptionId: "i-b", employeeId: "t1" },
      ]);
      expect(rows.find((r) => r.subscriptionId === "i-a")?.usage)
        .toMatchObject({ activeUserCount30d: 3, grantedUserCount: 8 });
      // 没有聚合结果的行留 undefined，前端据此隐藏这一段而不是显示 0
      expect(rows.find((r) => r.subscriptionId === "i-b")?.usage).toBeUndefined();
    });

    it("默认按最近使用排序，从没用过的排最后", async () => {
      prisma.employeeGrant.findMany
        .mockResolvedValueOnce([
          grantRow("i-old"),
          grantRow("i-never"),
          grantRow("i-new"),
        ])
        .mockResolvedValueOnce([]);
      const usageRow = (lastUsedAt: string | null) => ({
        activeUserCount30d: 0,
        grantedUserCount: 0,
        lastUsedAt,
        monthCostCNY: "0.00",
        monthCallCount: 0,
        executionCount30d: 0,
        successRate30d: null,
      });
      usage.forSubscriptions.mockResolvedValue(
        new Map([
          ["i-old", usageRow("2026-08-01T00:00:00.000Z")],
          ["i-never", usageRow(null)],
          ["i-new", usageRow("2026-09-02T00:00:00.000Z")],
        ]),
      );

      const rows = await service.myEmployees("u1");

      expect(rows.map((r) => r.subscriptionId)).toEqual([
        "i-new",
        "i-old",
        "i-never",
      ]);
    });
  });

  describe("create", () => {
    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: "i1",
        enterpriseId: "ent-a",
        status: "ACTIVE",
      });
      prisma.employeeGrant.create.mockResolvedValue({
        id: "g1",
        expiresAt: null,
        createdAt: new Date(),
        department: { id: "d-1", name: "客服部" },
        member: null,
      });
    });

    it("授权给部门", async () => {
      prisma.department.findUnique.mockResolvedValue({
        id: "d-1",
        enterpriseId: "ent-a",
      });

      const r = await service.create("u1", "i1", { departmentId: "d-1" });

      expect(r.department).toEqual({ id: "d-1", name: "客服部" });
      expect(prisma.employeeGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subscriptionId: "i1",
            departmentId: "d-1",
            memberId: null,
          }),
        }),
      );
    });

    it("已失效的雇佣关系不可授权", async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: "i1",
        enterpriseId: "ent-a",
        status: "EXPIRED",
      });

      await expect(
        service.create("u1", "i1", { departmentId: "d-1" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.employeeGrant.create).not.toHaveBeenCalled();
    });

    it("雇佣关系失效时先于授权对象校验 —— 主体失效就不必再查部门", async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: "i1",
        enterpriseId: "ent-a",
        status: "EXPIRED",
      });

      await expect(
        service.create("u1", "i1", { departmentId: "d-not-exist" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.department.findUnique).not.toHaveBeenCalled();
    });

    it("跨企业部门返回 404", async () => {
      prisma.department.findUnique.mockResolvedValue({
        id: "d-x",
        enterpriseId: "ent-b",
      });

      await expect(
        service.create("u1", "i1", { departmentId: "d-x" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("跨企业成员返回 404", async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: "m-x",
        enterpriseId: "ent-b",
      });

      await expect(
        service.create("u1", "i1", { memberId: "m-x" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("重复授权返回 409", async () => {
      prisma.department.findUnique.mockResolvedValue({
        id: "d-1",
        enterpriseId: "ent-a",
      });
      prisma.employeeGrant.create.mockRejectedValue({ code: "P2002" });

      await expect(
        service.create("u1", "i1", { departmentId: "d-1" }),
      ).rejects.toThrow(ConflictException);
    });

    it("非 P2002 的错误原样抛出，不误报为重复", async () => {
      prisma.department.findUnique.mockResolvedValue({
        id: "d-1",
        enterpriseId: "ent-a",
      });
      prisma.employeeGrant.create.mockRejectedValue(new Error("连接中断"));

      await expect(
        service.create("u1", "i1", { departmentId: "d-1" }),
      ).rejects.toThrow("连接中断");
    });

    it("非企业管理员被拦截", async () => {
      ctx.assertEnterpriseAdmin.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        service.create("u1", "i1", { departmentId: "d-1" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("终止状态不可授权且过去到期时间被拒绝", async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: "i1", enterpriseId: "ent-a", status: "TERMINATED" });
      await expect(service.create("u1", "i1", { departmentId: "d-1" })).rejects.toThrow(BadRequestException);
      prisma.subscription.findUnique.mockResolvedValue({ id: "i1", enterpriseId: "ent-a", status: "ACTIVE" });
      prisma.department.findUnique.mockResolvedValue({ id: "d-1", enterpriseId: "ent-a" });
      await expect(service.create("u1", "i1", { departmentId: "d-1", expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(BadRequestException);
    });
  });

  describe("createBatch", () => {
    const setup = () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({ id: "m-admin", enterpriseId: "ent-a", role: "ENTERPRISE_ADMIN" });
      prisma.subscription.findUnique.mockResolvedValue({ id: "i1", enterpriseId: "ent-a", status: "ACTIVE", endDate: null });
      prisma.enterpriseMember.findMany = jest.fn().mockResolvedValue([{ id: "m-1" }, { id: "m-2" }]);
      prisma.employeeGrant.findMany.mockResolvedValue([]);
      prisma.employeeGrant.createMany.mockResolvedValue({ count: 1 });
      prisma.employeeGrant.update.mockResolvedValue({});
    };
    it("批量创建成员授权并返回结果", async () => {
      setup();
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-2"], renewExpired: false })).resolves.toEqual({ target: "member", createdIds: ["m-1", "m-2"], renewedIds: [], skippedIds: [] });
      expect(prisma.employeeGrant.createMany).toHaveBeenCalledTimes(2);
    });
    it("旧单条接口并发先创建的目标跳过，不导致其余目标失败", async () => {
      setup();
      prisma.employeeGrant.createMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-2"], renewExpired: false })).resolves.toEqual({
        target: "member", createdIds: ["m-2"], renewedIds: [], skippedIds: ["m-1"],
      });
    });
    it("有效记录跳过，过期记录仅 renewExpired 时更新", async () => {
      setup();
      prisma.employeeGrant.findMany.mockResolvedValue([{ id: "g1", memberId: "m-1", departmentId: null, expiresAt: new Date(Date.now() + 10000) }, { id: "g2", memberId: "m-2", departmentId: null, expiresAt: new Date(Date.now() - 10000) }]);
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-2"], renewExpired: false })).resolves.toMatchObject({ skippedIds: ["m-1", "m-2"] });
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-2"], renewExpired: true })).resolves.toMatchObject({ skippedIds: ["m-1"], renewedIds: ["m-2"] });
      expect(prisma.employeeGrant.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "g2" } }));
    });
    it("任一目标不属于企业则整批拒绝且不写入", async () => {
      setup();
      prisma.enterpriseMember.findMany.mockResolvedValue([{ id: "m-1" }]);
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-x"], renewExpired: false })).rejects.toThrow(BadRequestException);
      expect(prisma.employeeGrant.createMany).not.toHaveBeenCalled();
    });
    it("支持部门授权", async () => {
      setup();
      prisma.department.findMany = jest.fn().mockResolvedValue([{ id: "d-1" }, { id: "d-2" }]);
      await expect(service.createBatch("u1", "i1", { departmentIds: ["d-1", "d-2"], renewExpired: false })).resolves.toMatchObject({ target: "department", createdIds: ["d-1", "d-2"] });
    });
    it("非管理员、跨企业订阅、终态订阅、结束订阅均拒绝", async () => {
      setup();
      prisma.enterpriseMember.findUnique.mockResolvedValue({ id: "m-admin", enterpriseId: "ent-a", role: "MEMBER" });
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1"], renewExpired: false })).rejects.toThrow(ForbiddenException);
      prisma.enterpriseMember.findUnique.mockResolvedValue({ id: "m-admin", enterpriseId: "ent-a", role: "ENTERPRISE_ADMIN" });
      prisma.subscription.findUnique.mockResolvedValue({ id: "i1", enterpriseId: "ent-b", status: "ACTIVE", endDate: null });
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1"], renewExpired: false })).rejects.toThrow(NotFoundException);
      for (const subscription of [
        { id: "i1", enterpriseId: "ent-a", status: "EXPIRED", endDate: null },
        { id: "i1", enterpriseId: "ent-a", status: "TERMINATED", endDate: null },
        { id: "i1", enterpriseId: "ent-a", status: "ACTIVE", endDate: new Date(Date.now() - 1000) },
      ]) {
        prisma.subscription.findUnique.mockResolvedValue(subscription);
        await expect(service.createBatch("u1", "i1", { memberIds: ["m-1"], renewExpired: false })).rejects.toThrow(BadRequestException);
      }
    });
    it("拒绝过去的有效期", async () => {
      setup();
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1"], expiresAt: new Date(Date.now() - 1000).toISOString(), renewExpired: false })).rejects.toThrow(BadRequestException);
    });
    it("事务内重新校验管理员，且写入错误整批传播", async () => {
      setup();
      prisma.enterpriseMember.findUnique.mockResolvedValueOnce({ id: "m-admin", enterpriseId: "ent-a", role: "MEMBER" });
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1"], renewExpired: false })).rejects.toThrow(ForbiddenException);
      expect(prisma.employeeGrant.createMany).not.toHaveBeenCalled();
      setup();
      prisma.enterpriseMember.findUnique.mockResolvedValue({ id: "m-admin", enterpriseId: "ent-a", role: "ENTERPRISE_ADMIN" });
      prisma.enterpriseMember.findMany.mockResolvedValue([{ id: "m-1" }, { id: "m-2" }]);
      prisma.employeeGrant.createMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error("write failed"));
      await expect(service.createBatch("u1", "i1", { memberIds: ["m-1", "m-2"], renewExpired: false })).rejects.toThrow("write failed");
      expect(prisma.employeeGrant.createMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("remove", () => {
    it("收回本企业的授权", async () => {
      prisma.employeeGrant.findUnique.mockResolvedValue({
        id: "g1",
        subscription: { enterpriseId: "ent-a" },
      });
      prisma.employeeGrant.delete.mockResolvedValue({ id: "g1" });

      const r = await service.remove("u1", "g1");

      expect(r).toEqual({ id: "g1" });
      expect(prisma.employeeGrant.delete).toHaveBeenCalledWith({
        where: { id: "g1" },
      });
    });

    it("跨企业授权返回 404 且不删除", async () => {
      prisma.employeeGrant.findUnique.mockResolvedValue({
        id: "g9",
        subscription: { enterpriseId: "ent-b" },
      });

      await expect(service.remove("u1", "g9")).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.employeeGrant.delete).not.toHaveBeenCalled();
    });
  });

  describe("listForMember", () => {
    it("returns direct grant and department coverage separately", async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: "m-1",
        enterpriseId: "ent-a",
        departmentId: "d-1",
      });
      prisma.subscription.findMany.mockResolvedValue([
        {
          id: "s-1",
          name: null,
          status: "ACTIVE",
          endDate: null,
          employee: { id: "e-1", name: "客服", avatar: null, position: "客服" },
          grants: [
            { id: "g-direct", memberId: "m-1", departmentId: null, expiresAt: null },
            { id: "g-dept", memberId: null, departmentId: "d-1", expiresAt: null },
          ],
        },
      ]);

      const result = await service.listForMember("u1", "m-1", {
        status: "all",
        page: 1,
        pageSize: 20,
      });

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        subscriptionId: "s-1",
        name: "客服",
        coveredByDepartment: true,
        directGrant: { id: "g-direct", expired: false },
      });
    });

    it("filters grantable and rejects cross-enterprise member", async () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: "m-x",
        enterpriseId: "ent-b",
        departmentId: null,
      });
      await expect(
        service.listForMember("u1", "m-x", { status: "grantable", page: 1, pageSize: 20 }),
      ).rejects.toThrow(NotFoundException);

      prisma.enterpriseMember.findUnique.mockResolvedValue({
        id: "m-1",
        enterpriseId: "ent-a",
        departmentId: null,
      });
      prisma.subscription.findMany.mockResolvedValue([
        {
          id: "s-1",
          name: "已授权",
          status: "ACTIVE",
          endDate: null,
          employee: { id: "e-1", name: "客服", avatar: null, position: "客服" },
          grants: [{ id: "g-1", memberId: "m-1", departmentId: null, expiresAt: new Date(Date.now() + 10000) }],
        },
      ]);
      const result = await service.listForMember("u1", "m-1", { status: "grantable", page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(0);
    });
  });

  describe("createBatchForMember", () => {
    const setup = () => {
      prisma.enterpriseMember.findUnique.mockResolvedValue({ id: "m-1", enterpriseId: "ent-a" });
      prisma.subscription.findMany.mockResolvedValue([
        { id: "s-1", status: "ACTIVE", endDate: null },
        { id: "s-2", status: "PAUSED", endDate: null },
      ]);
      prisma.employeeGrant.findMany.mockResolvedValue([]);
      prisma.employeeGrant.createMany.mockResolvedValue({ count: 1 });
      prisma.employeeGrant.findFirst.mockImplementation(async ({ where }: any) => ({ id: `g-${where.subscriptionId}` }));
      prisma.employeeGrant.update.mockResolvedValue({});
    };

    it("creates direct grants for one or more subscriptions", async () => {
      setup();
      await expect(
        service.createBatchForMember("u1", "m-1", { subscriptionIds: ["s-1", "s-2"], renewExpired: false }),
      ).resolves.toEqual({
        memberId: "m-1",
        createdIds: ["g-s-1", "g-s-2"],
        renewedSubscriptionIds: [],
        skippedSubscriptionIds: [],
      });
      expect(prisma.employeeGrant.createMany).toHaveBeenCalledTimes(2);
    });

    it("renews expired grants only when requested", async () => {
      setup();
      prisma.employeeGrant.findMany.mockResolvedValue([
        { id: "g-s-1", subscriptionId: "s-1", expiresAt: new Date(Date.now() - 1000) },
      ]);
      await expect(
        service.createBatchForMember("u1", "m-1", { subscriptionIds: ["s-1", "s-2"], renewExpired: false }),
      ).resolves.toMatchObject({ skippedSubscriptionIds: ["s-1"], createdIds: ["g-s-2"] });
      await expect(
        service.createBatchForMember("u1", "m-1", { subscriptionIds: ["s-1", "s-2"], renewExpired: true }),
      ).resolves.toMatchObject({ renewedSubscriptionIds: ["s-1"], createdIds: ["g-s-2"] });
    });

    it("rejects cross-enterprise or ended subscriptions before writing", async () => {
      setup();
      prisma.subscription.findMany.mockResolvedValue([{ id: "s-1", status: "ACTIVE", endDate: null }]);
      await expect(
        service.createBatchForMember("u1", "m-1", { subscriptionIds: ["s-1", "s-x"], renewExpired: false }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.employeeGrant.createMany).not.toHaveBeenCalled();

      prisma.subscription.findMany.mockResolvedValue([
        { id: "s-1", status: "TERMINATED", endDate: null },
      ]);
      await expect(
        service.createBatchForMember("u1", "m-1", { subscriptionIds: ["s-1"], renewExpired: false }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("listForSubscription", () => {
    it("过期记录标 expired=true 但仍返回", async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: "i1",
        enterpriseId: "ent-a",
        status: "ACTIVE",
      });
      const past = new Date(Date.now() - 86400_000);
      prisma.employeeGrant.findMany.mockResolvedValue([
        {
          id: "g-expired",
          expiresAt: past,
          createdAt: new Date(),
          department: null,
          member: {
            id: "m-1",
            user: { name: "小王", email: "w@acme.local" },
          },
        },
        {
          id: "g-forever",
          expiresAt: null,
          createdAt: new Date(),
          department: { id: "d-1", name: "客服部" },
          member: null,
        },
      ]);

      const rows = await service.listForSubscription("u1", "i1");

      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === "g-expired")?.expired).toBe(true);
      expect(rows.find((r) => r.id === "g-forever")?.expired).toBe(false);
      // 成员信息扁平化，不暴露嵌套的 user 对象
      expect(rows.find((r) => r.id === "g-expired")?.member).toEqual({
        id: "m-1",
        name: "小王",
        email: "w@acme.local",
      });
    });
  });
});
