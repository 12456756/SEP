export function validateSkillImportEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const enabled = env.SKILL_IMPORT_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) {
    throw new Error('SKILL_IMPORT_ENABLED 必须为 true 或 false');
  }
  const instanceId = env.SKILL_IMPORT_INSTANCE_ID ?? '';
  if ((enabled === 'true' || instanceId) && !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
    throw new Error('SKILL_IMPORT_INSTANCE_ID 必须为 1-128 位字母、数字、下划线或连字符');
  }
  const minVersion = env.SKILL_IMPORT_MIN_CLIENT_VERSION ?? '1.0.0';
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minVersion)) {
    throw new Error('SKILL_IMPORT_MIN_CLIENT_VERSION 必须为正式发布版本 x.y.z');
  }
  const concurrency = env.SKILL_IMPORT_UPLOAD_CONCURRENCY ?? '1';
  if (!/^(?:[1-9]|1[0-6])$/.test(concurrency)) {
    throw new Error('SKILL_IMPORT_UPLOAD_CONCURRENCY 必须为 1-16 的整数');
  }
  return { ...env, SKILL_IMPORT_ENABLED: enabled, SKILL_IMPORT_INSTANCE_ID: instanceId,
    SKILL_IMPORT_MIN_CLIENT_VERSION: minVersion, SKILL_IMPORT_UPLOAD_CONCURRENCY: concurrency };
}
