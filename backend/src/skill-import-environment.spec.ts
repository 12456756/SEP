import { validateSkillImportEnvironment } from './skill-import-environment';

describe('skill import environment', () => {
  it('defaults to disabled and preserves unrelated configuration', () => {
    expect(validateSkillImportEnvironment({ TEST_VALUE: 'preserved' })).toMatchObject({
      TEST_VALUE: 'preserved', SKILL_IMPORT_ENABLED: 'false', SKILL_IMPORT_UPLOAD_CONCURRENCY: '1',
    });
  });

  it('requires a stable instance identity before enabling', () => {
    expect(() => validateSkillImportEnvironment({ SKILL_IMPORT_ENABLED: 'true' })).toThrow('INSTANCE_ID');
    expect(validateSkillImportEnvironment({ SKILL_IMPORT_ENABLED: 'true', SKILL_IMPORT_INSTANCE_ID: 'sep-test' })
      .SKILL_IMPORT_ENABLED).toBe('true');
  });

  it.each([
    { SKILL_IMPORT_ENABLED: 'yes' }, { SKILL_IMPORT_INSTANCE_ID: 'https://other.example' },
    { SKILL_IMPORT_MIN_CLIENT_VERSION: 'latest' }, { SKILL_IMPORT_MIN_CLIENT_VERSION: '1.0.0-beta' },
    { SKILL_IMPORT_UPLOAD_CONCURRENCY: '0' }, { SKILL_IMPORT_UPLOAD_CONCURRENCY: '17' },
  ])('rejects invalid settings: %j', env => {
    expect(() => validateSkillImportEnvironment(env)).toThrow();
  });
});
