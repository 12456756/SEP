/**
 * 逐笔账单的作用域。
 *
 * 这个接口两种人都能进：管理员看全公司，成员看自己。范围的差别不是 UI ——
 * 前端不画表格只是不画，curl 照样能打。所以边界必须落在 `where` 里，
 * 而且 `scopeUserId` 必须写在 `memberId` **之后**：
 * 谁把这两行调个顺序，成员就能在地址栏加一个 `?memberId=<同事>` 翻别人的账。
 *
 * 这一组只测 where 的组装 —— 分页、金额格式化那些由别的用例覆盖。
 */
import { ComputeCreditService } from "./compute-credit.service";

describe("ComputeCreditService.listUsageRecords 作用域", () => {
  let prisma: any;
  let svc: ComputeCreditService;

  const whereOf = () =>
    prisma.computeUsageRecord.findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma = {
      computeUsageRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    svc = new ComputeCreditService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("不传 scopeUserId（管理员）时 where 里没有 userId —— 看的是全公司", async () => {
    await svc.listUsageRecords("ent-1", {});

    expect(whereOf()).toEqual({ enterpriseId: "ent-1" });
  });

  it("管理员的 memberId 筛选照常生效：他本来就能看别人的账", async () => {
    await svc.listUsageRecords("ent-1", { memberId: "u-9" });

    expect(whereOf().userId).toBe("u-9");
  });

  it("成员的 scopeUserId 落进 where", async () => {
    await svc.listUsageRecords("ent-1", {}, "u-1");

    expect(whereOf()).toEqual({ enterpriseId: "ent-1", userId: "u-1" });
  });

  it("❗scopeUserId 覆盖 memberId —— 这两行的顺序本身就是权限边界", async () => {
    await svc.listUsageRecords("ent-1", { memberId: "u-9" }, "u-1");

    expect(whereOf().userId).toBe("u-1");
  });

  it("成员的 employeeId 筛选仍然可用 —— 那只是在他自己的账里再切一刀", async () => {
    await svc.listUsageRecords("ent-1", { employeeId: "e-1" }, "u-1");

    expect(whereOf()).toEqual({
      enterpriseId: "ent-1",
      employeeId: "e-1",
      userId: "u-1",
    });
  });

  it("count 与 findMany 用同一个 where —— 否则分页总数会算成全公司的", async () => {
    await svc.listUsageRecords("ent-1", { memberId: "u-9" }, "u-1");

    expect(prisma.computeUsageRecord.count.mock.calls[0][0].where).toEqual(
      whereOf(),
    );
  });

  it("分页参数被限制在 1..100，避免一次查询拖垮数据库", async () => {
    const result = await svc.listUsageRecords("ent-1", {
      page: 0,
      pageSize: 9999,
    });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(100);
    expect(prisma.computeUsageRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });

  it("拒绝无效或倒置的日期范围，而不是把 Invalid Date 传给 Prisma", async () => {
    await expect(
      svc.listUsageRecords("ent-1", { startDate: "not-a-date" }),
    ).rejects.toThrow("startDate 必须是有效日期");

    await expect(
      svc.listUsageRecords("ent-1", {
        startDate: "2026-09-10",
        endDate: "2026-09-01",
      }),
    ).rejects.toThrow("startDate 不能晚于 endDate");

    expect(prisma.computeUsageRecord.count).not.toHaveBeenCalled();
  });
});
