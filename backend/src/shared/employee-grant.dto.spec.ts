import {
  GrantBatchCreateDtoSchema,
  EMPLOYEE_GRANT_BATCH_LIMIT,
  MemberGrantBatchCreateDtoSchema,
  MemberGrantCandidateQuerySchema,
} from "./employee-grant.dto";

describe("GrantBatchCreateDtoSchema", () => {
  it("accepts one target kind and defaults expired renewal to off", () => {
    expect(GrantBatchCreateDtoSchema.parse({ memberIds: ["m-1"] })).toEqual({
      memberIds: ["m-1"],
      renewExpired: false,
    });
    expect(
      GrantBatchCreateDtoSchema.parse({
        departmentIds: ["d-1"],
        renewExpired: true,
      }),
    ).toEqual({
      departmentIds: ["d-1"],
      renewExpired: true,
    });
  });

  it("rejects empty, mixed, missing, duplicate, blank and oversized targets", () => {
    const cases = [
      {},
      { memberIds: [] },
      { memberIds: ["m-1"], departmentIds: ["d-1"] },
      { memberIds: ["m-1", "m-1"] },
      { departmentIds: ["  "] },
      {
        memberIds: Array.from(
          { length: EMPLOYEE_GRANT_BATCH_LIMIT + 1 },
          (_, i) => `m-${i}`,
        ),
      },
    ];
    for (const value of cases)
      expect(GrantBatchCreateDtoSchema.safeParse(value).success).toBe(false);
  });

  it("requires ISO datetime and rejects unknown fields", () => {
    expect(
      GrantBatchCreateDtoSchema.safeParse({
        memberIds: ["m-1"],
        expiresAt: "tomorrow",
      }).success,
    ).toBe(false);
    expect(
      GrantBatchCreateDtoSchema.safeParse({
        memberIds: ["m-1"],
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it("accepts the batch limit and normalizes IDs before checking duplicates", () => {
    const memberIds = Array.from(
      { length: EMPLOYEE_GRANT_BATCH_LIMIT },
      (_, i) => `m-${i}`,
    );
    expect(
      GrantBatchCreateDtoSchema.parse({ memberIds }).memberIds,
    ).toHaveLength(100);
    expect(
      GrantBatchCreateDtoSchema.parse({ memberIds: [" m-1 "] }).memberIds,
    ).toEqual(["m-1"]);
    expect(
      GrantBatchCreateDtoSchema.safeParse({ memberIds: ["m-1", " m-1 "] })
        .success,
    ).toBe(false);
  });
});

describe("MemberGrantBatchCreateDtoSchema", () => {
  it("accepts subscription IDs and defaults renewal to false", () => {
    expect(MemberGrantBatchCreateDtoSchema.parse({ subscriptionIds: ["s-1"] })).toEqual({
      subscriptionIds: ["s-1"],
      renewExpired: false,
    });
  });

  it("rejects duplicates, empty IDs and unknown fields", () => {
    expect(MemberGrantBatchCreateDtoSchema.safeParse({ subscriptionIds: [] }).success).toBe(false);
    expect(MemberGrantBatchCreateDtoSchema.safeParse({ subscriptionIds: ["s-1", " s-1 "] }).success).toBe(false);
    expect(MemberGrantBatchCreateDtoSchema.safeParse({ subscriptionIds: ["s-1"], memberId: "m-1" }).success).toBe(false);
  });
});

describe("MemberGrantCandidateQuerySchema", () => {
  it("applies defaults and coerces pagination", () => {
    expect(MemberGrantCandidateQuerySchema.parse({})).toEqual({
      status: "grantable",
      page: 1,
      pageSize: 20,
    });
    expect(MemberGrantCandidateQuerySchema.parse({ page: "2", pageSize: "50", status: "granted" })).toEqual({
      status: "granted",
      page: 2,
      pageSize: 50,
    });
  });
});
