import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClientSkillArtifactParamsSchema,
  ClientSkillArtifactSchema,
  SkillArtifactBlockedReasonSchema,
  SkillArtifactFrontmatterSchema,
  SkillArtifactNameSchema,
  SkillArtifactSha256Schema,
} from './client-skill-artifact.dto';

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures/skill-artifact-v1.json'), 'utf8'));
const available = fixtures[0].artifact;
const blocked = fixtures[2].artifact;

describe('client skill artifact v1 schemas', () => {
  it('keeps explicitly mock fixtures synchronized with the actual descriptor schema', () => {
    for (const fixture of fixtures) {
      expect(fixture.mock).toBe(true);
      expect(fixture.name).toMatch(/^mock-/);
      expect(ClientSkillArtifactSchema.parse(fixture.artifact)).toEqual(fixture.artifact);
    }
    expect(fixtures.filter((fixture) => fixture.artifact.status === 'AVAILABLE').map((fixture) => fixture.artifact.format))
      .toEqual(['single-file', 'zip']);
    expect(fixtures.filter((fixture) => fixture.artifact.status === 'BLOCKED').map((fixture) => fixture.artifact.reason))
      .toEqual(SkillArtifactBlockedReasonSchema.options);
  });

  it.each(['SKILL.md', 'weekly/SKILL.md', 'bundle/weekly/SKILL.md', 'CRM 标签体系/SKILL.md'])('accepts safe entryPath %s', (entryPath) => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, entryPath }).success).toBe(true);
  });

  it.each([
    '', '/SKILL.md', '//weekly/SKILL.md', '../SKILL.md', 'weekly/../SKILL.md', './SKILL.md',
    'weekly/./SKILL.md', 'weekly//SKILL.md', 'weekly/SKILL.md/', 'weekly\\SKILL.md',
    'C:/SKILL.md', 'weekly\u0000/SKILL.md', 'weekly\n/SKILL.md', 'weekly\u007f/SKILL.md',
    'NOTSKILL.md', 'weekly/skill.md', `${'a'.repeat(1020)}/SKILL.md`,
    'CON/SKILL.md', 'com1.txt/SKILL.md', 'COM¹/SKILL.md', 'ＮＵＬ/SKILL.md',
    'weekly./SKILL.md', 'weekly /SKILL.md', 'weekly?/SKILL.md', 'weekly|/SKILL.md',
  ])('rejects unsafe or non-entry path %j', (entryPath) => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, entryPath }).success).toBe(false);
  });

  it.each([
    { apiKey: 'mock-secret' }, { storageKey: 'skills/mock.zip' }, { packageKey: 'skills/mock.zip' },
    { absolutePath: '/tmp/mock.zip' }, { buffer: 'mock-buffer' }, { signedUrl: 'https://mock.invalid/file?key=mock-secret' },
  ])('rejects extra secret or storage fields on either status: %j', (extra) => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, ...extra }).success).toBe(false);
    expect(ClientSkillArtifactSchema.safeParse({ ...blocked, ...extra }).success).toBe(false);
  });

  it.each([
    '/api/client/subscriptions/sub-mock/skills/cap-mock/versions/ver-mock/artifact',
    'https://mock.invalid/client/subscriptions/sub-mock/skills/cap-mock/versions/ver-mock/artifact',
    '/client/subscriptions/sub-mock/skills/cap-mock/versions/ver-mock/artifact?token=mock-secret',
    '/client/subscriptions/sub-mock/skills/cap-mock/versions/ver-mock/artifact#mock',
    '/client/subscriptions//skills/cap-mock/versions/ver-mock/artifact',
    '/client/subscriptions/sub-mock/skills/cap-mock/versions/ver-mock/artifact/extra',
  ])('rejects download locations outside the relative artifact route: %s', (downloadPath) => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, downloadPath }).success).toBe(false);
  });

  it.each([
    { protocolVersion: 2 }, { status: 'UNKNOWN' }, { capabilityId: '' }, { versionId: '' },
    { approvedContentSha256: 'bad' }, { entrySha256: 'A'.repeat(64) }, { artifactSha256: 'a'.repeat(63) },
    { format: 'tar' }, { installationDirectory: '../skill' }, { installationDirectory: 'Bad_Name' },
    { byteLength: 0 }, { byteLength: -1 }, { byteLength: 1.5 }, { byteLength: 100 * 1024 * 1024 + 1 },
    { fileCount: 0 }, { fileCount: 1.5 }, { fileCount: 10001 },
  ])('rejects invalid AVAILABLE descriptor fields: %j', (override) => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, ...override }).success).toBe(false);
  });

  it('accepts inclusive ZIP size and entry-count boundaries', () => {
    expect(ClientSkillArtifactSchema.safeParse({ ...available, byteLength: 20 * 1024 * 1024, fileCount: 500 }).success).toBe(true);
    expect(ClientSkillArtifactSchema.safeParse({ ...available, byteLength: 20 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(ClientSkillArtifactSchema.safeParse({ ...available, fileCount: 501 }).success).toBe(false);
  });

  it('requires all AVAILABLE fields and forbids a blocked reason on AVAILABLE', () => {
    for (const key of Object.keys(available)) {
      const missing = { ...available };
      delete missing[key];
      expect(ClientSkillArtifactSchema.safeParse(missing).success).toBe(false);
    }
    expect(ClientSkillArtifactSchema.safeParse({ ...available, reason: 'INVALID_ENTRY' }).success).toBe(false);
  });

  it('keeps BLOCKED descriptors download-free and accepts only known reasons', () => {
    for (const reason of SkillArtifactBlockedReasonSchema.options) {
      const descriptor = reason === 'CLIENT_LIMIT_EXCEEDED'
        ? { ...blocked, reason, fileCount: 501 }
        : { ...blocked, reason };
      expect(ClientSkillArtifactSchema.safeParse(descriptor).success).toBe(true);
    }
    for (const override of [
      { reason: 'INTERNAL_ERROR' }, { reason: undefined }, { protocolVersion: 2 }, { approvedContentSha256: 'bad' },
      { downloadPath: available.downloadPath }, { format: 'zip' }, { entryPath: 'SKILL.md' },
      { artifactSha256: available.artifactSha256 }, { byteLength: 1 }, { fileCount: 1 },
      { installationDirectory: 'mock-skill' },
    ]) {
      expect(ClientSkillArtifactSchema.safeParse({ ...blocked, ...override }).success).toBe(false);
    }
    expect(ClientSkillArtifactSchema.safeParse({ ...blocked, reason: 'CLIENT_LIMIT_EXCEEDED' }).success).toBe(false);
  });

  it.each(['a', 'a0', 'weekly-report-1', 'a'.repeat(64), 'A', '中文', '電商-分析', 'ＡＩ', '𐐀'.repeat(64),
    'CRM 标签体系', 'SKU 生命周期管理', '电商 SOP 编排', 'Two  Spaces', 'Unicode\u00a0Space', 'CON-tool', 'COM10'])('accepts valid frontmatter names without rewriting: %s', (name) => {
    expect(SkillArtifactNameSchema.safeParse(name).success).toBe(true);
    expect(SkillArtifactNameSchema.parse(name)).toBe(name);
  });

  it.each(['', '-a', 'a-', 'a--b', 'a_b', ' a', 'a ', 'a'.repeat(65), 'a/b', 'a\u0000', 'a\u202eb', 'a\tb', 'a\nb', '..', 'a\\b'])('rejects invalid frontmatter names: %j', (name) => {
    expect(SkillArtifactNameSchema.safeParse(name).success).toBe(false);
  });

  it.each(['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM¹', 'LPT²', 'ＣＯＮ'])('rejects Windows device names: %s', (name) => {
    expect(SkillArtifactNameSchema.safeParse(name).success).toBe(false);
    expect(ClientSkillArtifactSchema.safeParse({ ...available, installationDirectory: name }).success).toBe(false);
  });

  it('requires valid name and description, with boundary and optional-field validation', () => {
    const frontmatter = { name: 'mock-skill', description: 'Mock approved skill' };
    expect(SkillArtifactFrontmatterSchema.parse(frontmatter)).toEqual(frontmatter);
    expect(SkillArtifactFrontmatterSchema.safeParse({ ...frontmatter, description: 'x'.repeat(1024) }).success).toBe(true);
    expect(SkillArtifactFrontmatterSchema.safeParse({ ...frontmatter, description: ` ${'x'.repeat(1022)} ` }).success).toBe(true);
    expect(SkillArtifactFrontmatterSchema.safeParse({ ...frontmatter, compatibility: 'a' }).success).toBe(true);
    expect(SkillArtifactFrontmatterSchema.parse({
      ...frontmatter, license: 'MIT', compatibility: 'x'.repeat(500),
      metadata: { author: 'mock', version: '1' }, 'allowed-tools': 'Read Bash', custom: 'preserved',
    })).toMatchObject({ metadata: { author: 'mock', version: '1' }, custom: 'preserved' });
    for (const override of [
      { name: undefined }, { description: undefined }, { description: '' }, { description: ' \n ' },
      { description: 'x'.repeat(1025) }, { description: ` ${'x'.repeat(1024)} ` }, { description: 1 },
      { compatibility: '' }, { compatibility: 'x'.repeat(501) },
      { compatibility: null }, { license: 1 }, { 'allowed-tools': ['Read'] }, { metadata: null },
      { metadata: ['mock'] }, { 'disable-model-invocation': 'true' },
    ]) {
      expect(SkillArtifactFrontmatterSchema.safeParse({ ...frontmatter, ...override }).success).toBe(false);
    }
  });

  it('accepts only lowercase 64-character SHA256 values', () => {
    expect(SkillArtifactSha256Schema.safeParse('0'.repeat(64)).success).toBe(true);
    for (const hash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(SkillArtifactSha256Schema.safeParse(hash).success).toBe(false);
    }
  });

  it('validates strict artifact route params without traversal or injection', () => {
    const params = { subscriptionId: 'sub-mock_1', capabilityId: 'cap-mock', versionId: 'ver-mock' };
    expect(ClientSkillArtifactParamsSchema.parse(params)).toEqual(params);
    for (const key of Object.keys(params)) {
      for (const value of ['', '.', '..', '../mock', 'a/b', 'a\\b', 'a:mock', 'a?secret=mock', 'a#mock', 'a%2fb', 'a'.repeat(129)]) {
        expect(ClientSkillArtifactParamsSchema.safeParse({ ...params, [key]: value }).success).toBe(false);
      }
    }
    expect(ClientSkillArtifactParamsSchema.safeParse({ ...params, apiKey: 'mock-secret' }).success).toBe(false);
  });

  it.each(['capabilityId', 'versionId'])('uses route-param ID constraints in both descriptor identities: %s', (field) => {
    for (const value of ['a', 'Mock_123-valid', 'a'.repeat(128)]) {
      expect(ClientSkillArtifactSchema.safeParse({ ...available, [field]: value }).success).toBe(true);
      expect(ClientSkillArtifactSchema.safeParse({ ...blocked, [field]: value }).success).toBe(true);
    }
    for (const value of ['', '.', '..', 'a.b', 'a/b', 'a\\b', 'a:mock', 'a%2fb', 'a%252fb', 'a?b', 'a#b', 'a b', 'a\n', '中文', 'a'.repeat(129)]) {
      expect(ClientSkillArtifactSchema.safeParse({ ...available, [field]: value }).success).toBe(false);
      expect(ClientSkillArtifactSchema.safeParse({ ...blocked, [field]: value }).success).toBe(false);
    }
  });

  it.each([0, 1, 2])('validates each downloadPath ID segment with the route-param constraints (%s)', (index) => {
    const downloadPath = (value: string) => {
      const ids = ['sub-mock', 'cap-mock', 'ver-mock'];
      ids[index] = value;
      return `/client/subscriptions/${ids[0]}/skills/${ids[1]}/versions/${ids[2]}/artifact`;
    };
    for (const value of ['a', 'Mock_123-valid', 'a'.repeat(128)]) {
      expect(ClientSkillArtifactSchema.safeParse({ ...available, downloadPath: downloadPath(value) }).success).toBe(true);
    }
    for (const value of ['', '.', '..', 'a.b', 'a/b', 'a\\b', 'a:mock', '%2e%2e', 'a%2fb', 'a%252fb', 'a b', 'a\n', '中文', 'a'.repeat(129)]) {
      expect(ClientSkillArtifactSchema.safeParse({ ...available, downloadPath: downloadPath(value) }).success).toBe(false);
    }
  });
});
