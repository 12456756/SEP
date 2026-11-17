import { MediaParameterSchema, MediaProfileParametersSchema, MediaReferenceRuleSchema, validateMediaParameterConstraints } from './media-runtime-parameters';

const parameter = { label: '时长', type: 'integer', support: 'supported', required: true,
  operations: ['text-to-video'], valuesMode: 'suggested', values: [4, 8], source: 'profile-config', confidence: 'declared', observedAt: null };

describe('media runtime parameter contract', () => {
  it.each([
    { values: ['4'] }, { minimum: 9, maximum: 4 }, { step: 0 }, { step: 0.5 },
    { valuesMode: 'allowed', default: 6 }, { minimum: 5 }, { support: 'unsupported' },
    { minimum: 1, step: 2 }, { values: [4], step: 2, default: 5 },
  ])('rejects inconsistent parameter metadata %j', change => {
    expect(MediaParameterSchema.safeParse({ ...parameter, ...change }).success).toBe(false);
  });
  it('preserves suggestions and an explicit false default without inventing defaults', () => {
    expect(MediaParameterSchema.parse({ ...parameter, default: 6 }).default).toBe(6);
    expect(MediaParameterSchema.parse(parameter)).not.toHaveProperty('default');
    expect(MediaParameterSchema.parse({ ...parameter, type: 'boolean', values: [false, true], default: false }).default).toBe(false);
  });
  it('rejects dangling or wrongly typed constraint fields and invalid references', () => {
    const rule = { type: 'whenAllowed', operations: ['text-to-video'], code: 'RULE', message: '限制', when: { field: 'durationSeconds', equals: 4 }, field: 'durationSeconds', values: ['bad'] };
    expect(MediaProfileParametersSchema.safeParse({ parameters: { durationSeconds: parameter }, constraints: [rule], referenceRules: [] }).success).toBe(false);
    expect(MediaProfileParametersSchema.safeParse({ parameters: {}, constraints: [rule], referenceRules: [] }).success).toBe(false);
    expect(MediaReferenceRuleSchema.safeParse({ operation: 'edit', minCount: 2, maxCount: 1, maxInputBytes: 100, mimeTypes: ['image/png'] }).success).toBe(false);
  });
  it('evaluates required alternatives and preserves explicit false', () => {
    const rules = [{ type: 'requireAny' as const, operations: ['text-to-video' as const], alternatives: [['audio'], ['width', 'height']], code: 'REQUIRED', message: '需要参数' }];
    expect(validateMediaParameterConstraints({ audio: false }, 'text-to-video', rules)).toEqual([]);
    expect(validateMediaParameterConstraints({ width: 100 }, 'text-to-video', rules)).toEqual([{ code: 'REQUIRED', message: '需要参数' }]);
    expect(validateMediaParameterConstraints({}, 'image-to-video', rules)).toEqual([]);
  });
  it('rejects combination options outside an existing hard enum', () => {
    const rule = { type: 'whenAllowed', operations: ['text-to-video'], code: 'RULE', message: '限制',
      when: { field: 'durationSeconds', equals: 4 }, field: 'durationSeconds', values: [6] };
    expect(MediaProfileParametersSchema.safeParse({ parameters: { durationSeconds: { ...parameter, valuesMode: 'allowed' } },
      constraints: [rule], referenceRules: [] }).success).toBe(false);
  });
  it('evaluates paired fields and conditional options only for the current operation', () => {
    const rules = MediaProfileParametersSchema.parse({ parameters: { width: parameter, height: parameter,
      audio: { ...parameter, type: 'boolean', values: [false, true] } }, constraints: [
      { type: 'requiredTogether', operations: ['text-to-video'], fields: ['width', 'height'], code: 'PAIR', message: '填写完整宽高' },
      { type: 'whenAllowed', operations: ['text-to-video'], when: { field: 'audio', equals: false },
        field: 'width', values: [4], code: 'SIZE', message: '宽度仅支持4' },
    ], referenceRules: [] }).constraints;
    expect(validateMediaParameterConstraints({ audio: false, width: 8 }, 'text-to-video', rules).map(rule => rule.code)).toEqual(['PAIR', 'SIZE']);
    expect(validateMediaParameterConstraints({ audio: false, width: 4, height: 4 }, 'text-to-video', rules)).toEqual([]);
  });
});
