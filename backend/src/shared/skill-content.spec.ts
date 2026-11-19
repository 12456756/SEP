import { ContributionSkillConfigDtoSchema, ContributionVersionCreateDtoSchema, ContributionVersionUpdateDtoSchema } from './index';
import { CreatePlatformSkillVersionDtoSchema, UpdateSkillVersionDtoSchema } from './skill-version.dto';
import { parseSkillMarkdown, prepareSkillMarkdown, skillLocalResourceReferences, SkillContentSchema, SKILL_CONTENT_MAX_BYTES } from './skill-content';

const entry = (body = '做图', fields = '') => `---\nname: 中文-ＡＩ\ndescription: 2026-10-14\n${fields}---\n${body}`;

describe('shared Skill markdown compatibility', () => {
  it.each(['CRM 标签体系', 'SKU 生命周期管理', '电商 SOP 编排'])('supports approved mixed-language names: %s', (name) => {
    const content = entry().replace('中文-ＡＩ', name);
    expect(prepareSkillMarkdown(content, 'fallback')).toMatchObject({ status: 'AVAILABLE', content, skillName: name });
  });
  it.each(['CON', 'COM¹', 'ＣＯＮ'])('normalizes unsafe names for installation: %s', (name) => {
    expect(prepareSkillMarkdown(entry().replace('中文-ＡＩ', name), 'fallback')).toMatchObject({ status: 'AVAILABLE', skillName: 'fallback' });
    expect(prepareSkillMarkdown('做图', name)).toMatchObject({ status: 'AVAILABLE', skillName: 'imported-skill' });
  });
  it.each(['', '\ufeff', '\n \t\n', '\ufeff\r\n\t\r\n'])('preserves approved bytes with compatible prefixes: %j', (prefix) => {
    const content = prefix + entry();
    expect(prepareSkillMarkdown(content, 'fallback')).toEqual({ status: 'AVAILABLE', content, skillName: '中文-ＡＩ', body: '做图' });
  });

  it.each(['\n', '\r\n', '\r'])('parses the same data for newline %j without rewriting the entry', (newline) => {
    const content = entry('做图\n下一步').replace(/\n/g, newline);
    const result = prepareSkillMarkdown(content, 'fallback');
    expect(result).toMatchObject({ status: 'AVAILABLE', content, body: '做图\n下一步' });
  });

  it('uses Pi-compatible CORE scalar semantics rather than YAML 1.1 timestamps/octal', () => {
    const parsed = parseSkillMarkdown(entry('body', 'metadata:\n  date: 2026-10-14\n  leading: 010\n  octal: 0o10\n  exponent: 1e3\n  bool: true\n  yes: yes\n  time: 1:30\ndisable-model-invocation: true\nunknown: keep\n'));
    expect(parsed.data).toMatchObject({ description: '2026-10-14', metadata: { date: '2026-10-14', leading: 10, octal: 8, exponent: 1000, bool: true, yes: 'yes', time: '1:30' }, 'disable-model-invocation': true, unknown: 'keep' });
    expect(prepareSkillMarkdown(entry('body', 'metadata:\n  version: 1\n  date: 2026-10-14\ndisable-model-invocation: true\n'), 'fallback').status).toBe('AVAILABLE');
  });

  it.each(['---\nname: a', '---yaml\nname: a\n---\nbody', '---\nname: a\nname: b\n---\nbody', '---\nname: !!js/function x\n---\nbody', '---\nname: a\n---invalid\nbody'])('keeps malformed frontmatter as importable source: %s', (content) => {
    expect(prepareSkillMarkdown(content, 'fallback')).toMatchObject({ status: 'AVAILABLE', skillName: 'fallback' });
  });

  it.each([
    '[image](https://example.com/assets/a.png)', 'https://example.com/assets/a.png',
    'Output `result.json` and `result.md` into `output/`.', '输出 `assets/result.json` 到输出目录。',
    'Save assets/result.json', 'The assets/ directory is optional.',
    '[Self](./SKILL.md#section)', '[Self](SKILL.md)', '[Self]: ./SKILL.md#section',
    '[Self](./%53KILL.md#section)', '<a href="./SKILL.md#section">Self</a>',
    '<a href="https://example.com/assets/a.png">External</a>',
  ])('does not require a package for external URLs, outputs, or safe self references: %s', (body) => {
    expect(prepareSkillMarkdown(entry(body), 'fallback').status).toBe('AVAILABLE');
  });

  it.each(['Read references/check.md', '运行 `scripts/run.py`', '[file](./input.md)', '[Self](../SKILL.md)',
    '<img src="assets/a.png">', 'Read `input.json`', '[file](%2e%2e/SKILL.md)'])('requires a package for concrete missing resources: %s', (body) => {
    expect(prepareSkillMarkdown(entry(body), 'fallback')).toMatchObject({ status: 'AVAILABLE' });
  });

  it('checks the generated entry byte budget as well as the approved body', () => {
    const full = entry('x'.repeat(SKILL_CONTENT_MAX_BYTES - Buffer.byteLength(entry(''), 'utf8')));
    expect(prepareSkillMarkdown(full, 'fallback').status).toBe('AVAILABLE');
    expect(prepareSkillMarkdown(full + 'x', 'fallback').status).toBe('BLOCKED');
    expect(prepareSkillMarkdown('x'.repeat(SKILL_CONTENT_MAX_BYTES), 'fallback').status).toBe('AVAILABLE');
  });
});

describe('Skill local resource references', () => {
  it('separates executable paths from command arguments', () => {
    expect(skillLocalResourceReferences([
      'Run `scripts/_contract.py doctor`.',
      'Run `python3 scripts/probe.py input.mp4 --json`.',
      'Run `node "scripts/my tool.js" --help`.',
    ].join('\n'))).toEqual(['scripts/_contract.py', 'scripts/probe.py', 'scripts/my tool.js']);
  });

  it('uses an explicitly declared script directory for shorthand script names', () => {
    const body = [
      'Run `python3 <skill-dir>/scripts/<name>.py`.',
      'Probe (`probe.py`), then `render.py project.json`.',
      'Run `python3 <skill-dir>/scripts/check.py output.mp4`.',
    ].join('\n');
    expect(skillLocalResourceReferences(body)).toEqual(['scripts/probe.py', 'scripts/render.py', 'scripts/check.py']);
  });

  it('does not guess script directories or rewrite explicit paths', () => {
    expect(skillLocalResourceReferences('Run `probe.py`.')).toEqual(['probe.py']);
    expect(skillLocalResourceReferences('Run `python3 scripts/<name>.py`; read `./probe.py`.'))
      .toEqual(['./probe.py']);
    expect(skillLocalResourceReferences('Run `python3 scripts/<name>.py` or `python3 tools/<name>.py`; run `probe.py`.'))
      .toEqual(['probe.py']);
  });

  it('checks executable paths in other declared directories and retains invalid paths for validation', () => {
    expect(skillLocalResourceReferences('Run `python3 tools/<name>.py`; run `probe.py`.'))
      .toEqual(['tools/probe.py']);
    expect(skillLocalResourceReferences('Run `python3 helpers/run.py --help`, then `/missing.py`.'))
      .toEqual(['helpers/run.py', '/missing.py']);
  });

  it('ignores names explicitly described as nonexistent or forbidden without hiding the next instruction', () => {
    expect(skillLocalResourceReferences([
      'The tool list (no `doctor.py`, `trim.py`, `subtitle.py`).',
      '没有 `missing.py`、`old.py`，请运行 `scripts/run.py`。',
      'Never use `legacy.py`; read `references/required.md`.',
      'No `unused.py`, but run `required.py`.',
    ].join('\n'))).toEqual(['scripts/run.py', 'references/required.md', 'required.py']);
  });

  it('preserves explicit links, nested paths, and filenames containing spaces', () => {
    expect(skillLocalResourceReferences('[Input](references/nested/input.md#section)\nRead `references/my guide.md`.'))
      .toEqual(['references/nested/input.md', 'references/my guide.md']);
  });
});

describe('Skill content DTO byte budget', () => {
  it.each(['做图', 'x', '中'.repeat(170666) + 'aa', 'x'.repeat(SKILL_CONTENT_MAX_BYTES)])('accepts nonempty content up to relaxed limit (case %#)', (content) => {
    expect(SkillContentSchema.parse(content)).toBe(content);
    expect(ContributionSkillConfigDtoSchema.parse({ template: content }).template).toBe(content);
    expect(ContributionVersionCreateDtoSchema.parse({ content, changeSummary: 'revision' }).content).toBe(content);
    for (const schema of [ContributionVersionUpdateDtoSchema, CreatePlatformSkillVersionDtoSchema, UpdateSkillVersionDtoSchema]) {
      expect(schema.parse({ content }).content).toBe(content);
    }
  });
  it.each(['', '\n \t', '中'.repeat(170667), 'x'.repeat(SKILL_CONTENT_MAX_BYTES + 1)])('rejects empty content or content over the configured limit (case %#)', (content) => {
    if (content.trim() && Buffer.byteLength(content, 'utf8') <= SKILL_CONTENT_MAX_BYTES) return;
    for (const schema of [ContributionVersionUpdateDtoSchema, CreatePlatformSkillVersionDtoSchema, UpdateSkillVersionDtoSchema]) {
      expect(schema.safeParse({ content }).success).toBe(false);
    }
    expect(ContributionSkillConfigDtoSchema.safeParse({ template: content }).success).toBe(false);
    expect(ContributionVersionCreateDtoSchema.safeParse({ content, changeSummary: 'revision' }).success).toBe(false);
  });
});
