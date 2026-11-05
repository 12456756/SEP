import { createRequire } from 'module';
import { SkillArtifactFrontmatterSchema, SkillArtifactNameSchema } from './client-skill-artifact.dto';
import { SkillContentSchema } from './skill-content-schema';

// Resolve at runtime so webpack cannot replace gray-matter's path with a module ID.
const runtimeRequire = createRequire(__filename);
// Reuse gray-matter's installed YAML engine; no new dependency or default timestamp coercion.
const yaml = createRequire(runtimeRequire.resolve('gray-matter'))('js-yaml');
const coreSchema = new yaml.Schema({
  include: [yaml.FAILSAFE_SCHEMA],
  implicit: [
    ...yaml.CORE_SCHEMA.compiledImplicit.filter((type: { tag: string }) =>
      !['tag:yaml.org,2002:int', 'tag:yaml.org,2002:float'].includes(type.tag)),
    new yaml.Type('tag:yaml.org,2002:int', {
      kind: 'scalar',
      resolve: (value: string) => /^[-+]?[0-9]+$|^0o[0-7]+$|^0x[\da-fA-F]+$/.test(value),
      construct: (value: string) => value.startsWith('0o') ? parseInt(value.slice(2), 8) : Number(value),
    }),
    new yaml.Type('tag:yaml.org,2002:float', {
      kind: 'scalar',
      resolve: (value: string) => /^[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$|^[-+]?\.inf$|^\.nan$/i.test(value),
      construct: (value: string) => /^[-+]?\.inf$/i.test(value) ? (value.startsWith('-') ? -Infinity : Infinity)
        : /^\.nan$/i.test(value) ? NaN : Number(value),
    }),
  ],
});

export { SKILL_CONTENT_MAX_BYTES, SkillContentSchema } from './skill-content-schema';

export function parseSkillMarkdown(content: string) {
  // Strip only the parsing prefix, never the approved/downloaded source.
  const input = content.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)*/, '');
  if (!input.startsWith('---')) return { hasFrontmatter: false, data: {}, content: input };
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(input);
  if (match) {
    try {
      const data = yaml.safeLoad(match[1], { schema: coreSchema }) ?? {};
      if (typeof data === 'object' && !Array.isArray(data)) {
        return { hasFrontmatter: true, data, content: input.slice(match[0].length) };
      }
    } catch { /* Preserve unparseable metadata as source text. */ }
  }
  return { hasFrontmatter: false, data: {}, content: input, invalidFrontmatter: true };
}

export function skillLocalResourceReferences(body: string): string[] {
  const references = new Set<string>();
  const add = (target: string) => {
    const path = target.replace(/^<|>$/g, '').replace(/[?#].*$/, '');
    if (!path || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target.replace(/^</, ''))) return;
    references.add(path);
  };
  for (const match of body.matchAll(/\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) add(match[1]);
  for (const match of body.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+).*$/gm)) add(match[1]);
  for (const match of body.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  const prose = body.replace(/(?:\b[a-z][a-z0-9+.-]*:|\/\/)[^\s`"'<>]+/gi, '');
  for (const match of prose.matchAll(/`([^`\n]+)`|(?:^|[\s"'(])((?:\.\.?\/)?(?:references|scripts|assets)\/[^\s`"'<>()[\]]+)/g)) {
    const value = match[1] ?? match[2];
    if (value.endsWith('/') || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue;
    if (!/^(?:\.\.?\/|(?:references|scripts|assets)\/)/.test(value) &&
      !/^[\p{L}\p{N}_.-]+\.(?:md|py|sh|js|ts|json|ya?ml|png|jpe?g|webp|csv|pdf|txt)$/u.test(value)) continue;
    const context = prose.slice(Math.max(0, (match.index ?? 0) - 100), match.index)
      .replace(/`[^`]*`/g, '').split(/[\n.!?]/).at(-1) ?? '';
    if (/(?:output|write|save|create|generate|export)\b[^\n]*$/i.test(context) || /(?:输出|写入|保存|生成|导出)[^\n]*$/.test(context)) continue;
    add(value.replace(/[.,;:]+$/, ''));
  }
  return [...references];
}

export type PreparedSkillMarkdown =
  | { status: 'AVAILABLE'; content: string; skillName: string; body: string }
  | { status: 'BLOCKED'; reason: 'INVALID_ENTRY' | 'PACKAGE_REQUIRED' };

export function singleFileSkillWarnings(content: string) {
  return skillLocalResourceReferences(parseSkillMarkdown(content).content).map((path) => ({
    code: 'RESOURCE_REFERENCE', path,
    message: `单文件技能引用了本地资源：${path}。请确认是否由运行环境提供或运行时生成；如需随技能分发，可上传包含附件的压缩包。不影响审核通过。`,
  }));
}

export function prepareSkillMarkdown(content: string, fallbackName: string): PreparedSkillMarkdown {
  const invalid = { status: 'BLOCKED', reason: 'INVALID_ENTRY' } as const;
  if (!SkillContentSchema.safeParse(content).success || Buffer.from(content, 'utf8').toString('utf8') !== content) return invalid;
  try {
    const parsed = parseSkillMarkdown(content);
    let skillName = fallbackName;
    let output = content;
    if (!parsed.content.trim()) return invalid;
    const result = SkillArtifactFrontmatterSchema.safeParse(parsed.data);
    if (parsed.hasFrontmatter && result.success) {
      skillName = result.data.name;
    } else {
      const data = parsed.data as Record<string, unknown>;
      const candidate = typeof data.name === 'string' ? data.name : fallbackName;
      skillName = Array.from(candidate.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')).slice(0, 64).join('').replace(/-$/, '');
      if (!SkillArtifactNameSchema.safeParse(skillName).success) {
        skillName = SkillArtifactNameSchema.safeParse(fallbackName).success ? fallbackName : 'imported-skill';
      }
      const summary = Array.from(parsed.content.trim().replace(/\s+/g, ' ')).slice(0, 300).join('');
      const description = typeof data.description === 'string' && data.description.trim()
        ? data.description.trim().slice(0, 1024) : summary;
      const metadata: Record<string, unknown> = { ...data, name: skillName, description };
      for (const [key, schema] of Object.entries(SkillArtifactFrontmatterSchema.shape)) {
        if (!schema.safeParse(metadata[key]).success) delete metadata[key];
      }
      output = `---\n${yaml.safeDump(metadata, { schema: coreSchema })}---\n${parsed.content}`;
    }
    return { status: 'AVAILABLE', content: output, skillName, body: parsed.content };
  } catch {
    return invalid;
  }
}
