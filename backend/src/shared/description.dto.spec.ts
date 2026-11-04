import {
  CapabilityUploadDtoSchema,
  ContributionCapabilityCreateDtoSchema,
  ContributionCapabilityUpdateDtoSchema,
  DigitalEmployeeCreateDtoSchema,
  DigitalEmployeeUpdateDtoSchema,
} from './index';

const cases = [
  {
    name: 'capability upload', schema: CapabilityUploadDtoSchema, optional: false,
    input: { name: '能力', type: 'skill', industry: [], position: [], inputSchema: {}, outputSchema: {} },
  },
  {
    name: 'contribution create', schema: ContributionCapabilityCreateDtoSchema, optional: false,
    input: { name: '能力', type: 'skill', skillConfig: { template: '做图' } },
  },
  { name: 'contribution update', schema: ContributionCapabilityUpdateDtoSchema, optional: true, input: {} },
  {
    name: 'employee create', schema: DigitalEmployeeCreateDtoSchema, optional: false,
    input: { name: '员工', industry: '电商', position: '运营', systemPrompt: '处理电商运营任务并提供结果' },
  },
  { name: 'employee update', schema: DigitalEmployeeUpdateDtoSchema, optional: true, input: {} },
];

describe.each(cases)('$name description', ({ schema, input, optional }) => {
  it.each(['x', '做图', '短描述', '中'.repeat(2000)])('accepts nonempty descriptions within the limit (case %#)', (description) => {
    expect(schema.parse({ ...input, description }).description).toBe(description);
  });

  it.each([' \t做图\r\n', '\u00a0做图\u3000', ` ${'中'.repeat(2000)} `])('trims before validating and returning descriptions (case %#)', (description) => {
    expect(schema.parse({ ...input, description }).description).toBe(description.trim());
  });

  it.each(['', ' \r\n\t', '\u00a0\u3000', '中'.repeat(2001), null, 1])('rejects blank, oversized, or non-string descriptions (case %#)', (description) => {
    const result = schema.safeParse({ ...input, description });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['description'] }),
    ]));
  });

  it('keeps the existing required or optional contract', () => {
    expect(schema.safeParse(input).success).toBe(optional);
  });
});

describe('description relaxation scope', () => {
  it('keeps employee systemPrompt and contribution RPA configDoc minimum lengths', () => {
    expect(DigitalEmployeeCreateDtoSchema.safeParse({
      name: '员工', description: '短', industry: '电商', position: '运营', systemPrompt: '短',
    }).success).toBe(false);
    expect(DigitalEmployeeUpdateDtoSchema.safeParse({ description: '短', systemPrompt: '短' }).success).toBe(false);
    expect(ContributionCapabilityCreateDtoSchema.safeParse({
      name: '能力', description: '短', type: 'rpa',
      rpaConfig: { platform: 'yingdao', packageSha256: 'a'.repeat(64), configDoc: '短' },
    }).success).toBe(false);
  });
});

describe('employee name length', () => {
  it('accepts names longer than 100 characters for create and update', () => {
    const name = '员'.repeat(101);
    expect(DigitalEmployeeCreateDtoSchema.safeParse({
      name, description: '员工描述', industry: '通用', position: '通用', systemPrompt: '足够长的员工系统提示词内容',
    }).success).toBe(true);
    expect(DigitalEmployeeUpdateDtoSchema.safeParse({ name }).success).toBe(true);
  });
});
