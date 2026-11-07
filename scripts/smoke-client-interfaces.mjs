import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.SEP_BASE_URL;
assert.ok(base, 'SEP_BASE_URL must point to a dedicated integration environment');
const baseUrl = new URL(base);
assert.equal(baseUrl.protocol, 'https:', 'Integration API must use HTTPS');
assert.notEqual(baseUrl.hostname.toLowerCase(), 'sep.longdaoec.com', 'Mutative smoke tests must not target production');
assert.ok(process.env.SEP_EMAIL && process.env.SEP_PASSWORD, 'SEP_EMAIL and SEP_PASSWORD are required');

let token;
async function request(path, { method = 'GET', body, key, expected = 200, auth = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, expected, `${method} ${path}: status=${response.status}, requestId=${response.headers.get('x-request-id')}`);
  return response.json();
}

const login = await request('/client/auth/login', { method: 'POST', auth: false, body: {
  email: process.env.SEP_EMAIL, password: process.env.SEP_PASSWORD,
  fingerprint: 'sep-client-interface-smoke', platform: 'linux', clientVersion: 'integration-smoke-20260916',
} });
token = login.accessToken;
assert.equal(login.enterprise.id, 'cmtwnxohc0001qq01uw0xciop');
await request('/enterprise/organization', { auth: false, expected: 401 });
const subscriptions = await request('/client/subscriptions');
assert.ok(subscriptions.length >= 2, 'Two granted employees are required');
const organization = await request('/enterprise/organization');
const overview = await request('/enterprise/overview');
assert.deepEqual(organization.statistics, overview.statistics);
assert.equal(overview.statistics.currentUserAvailableEmployeeCount, new Set(subscriptions.map(s => s.employeeId)).size);
assert.ok(organization.grants.length >= 2);
const statuses = await request('/enterprise/employee-status');
assert.ok(statuses.length >= 2);

const skills = await request(`/enterprise/employees/${subscriptions[0].employeeId}/skills`);
const skill = skills.skills.find(s => s.currentVersion);
assert.ok(skill, 'An approved skill must be bound');
const original = await request(`/enterprise/skill-versions/${skill.currentVersion.id}/preview`);
assert.ok(original.content.startsWith('---'), 'The fixture must preserve frontmatter');
const body = {
  capabilityId: skill.capability.id, parentVersionId: skill.currentVersion.id,
  content: '---\r\nname: client-smoke\r\ndescription: integration verification\r\n---\r\n\r\n# Acceptance\r\nPreserve this full source.  \r\n',
  changeSummary: 'Shared dev API smoke test',
};
await request('/enterprise/skill-versions', { method: 'POST', body, expected: 400 });
const key = randomUUID();
const saved = await Promise.all(Array.from({ length: 6 }, () => request('/enterprise/skill-versions', {
  method: 'POST', body, key, expected: 201,
})));
assert.equal(new Set(saved.map(v => v.id)).size, 1, 'Concurrent retries must create one version');
const version = saved[0];
assert.equal(version.status, 'PENDING_ENTERPRISE_REVIEW');
assert.ok(version.submittedAt);
assert.equal(version.content, body.content);
await request('/enterprise/skill-versions', { method: 'POST', body: { ...body, content: 'changed' }, key, expected: 409 });
const preview = await request(`/enterprise/skill-versions/${version.id}/preview`);
assert.equal(preview.content, body.content);
await request(`/enterprise/personal-versions/${version.id}`, { method: 'PATCH', body: { content: 'changed' }, expected: 409 });
await request(`/enterprise/personal-versions/${version.id}`, { method: 'DELETE', expected: 409 });
const queue = await request(`/enterprise/skill-version-reviews?capabilityId=${skill.capability.id}`);
assert.ok(queue.items.some(v => v.id === version.id));
await request(`/enterprise/skill-versions/${version.id}/review`, { method: 'POST', body: { decision: 'REJECT' }, expected: 400 });
await request(`/enterprise/skill-versions/${version.id}/review`, {
  method: 'POST', body: { decision: 'REJECT', comment: 'Smoke rejection verification' }, expected: 201,
});
await request(`/enterprise/skill-versions/${version.id}/review`, { method: 'POST', body: { decision: 'APPROVE' }, expected: 409 });
const retried = await request('/enterprise/skill-versions', { method: 'POST', body, key, expected: 201 });
assert.equal(retried.id, version.id);
assert.equal(retried.status, 'ENTERPRISE_REJECTED');
assert.ok(retried.enterpriseReviewedAt);
assert.equal(retried.rejectionReason, 'Smoke rejection verification');
const next = await request('/enterprise/skill-versions', {
  method: 'POST', body: { ...body, parentVersionId: version.id }, key: randomUUID(), expected: 201,
});
assert.notEqual(next.id, version.id);
await request(`/enterprise/skill-versions/${next.id}/review`, { method: 'POST', body: { decision: 'APPROVE' }, expected: 201 });
const versions = await request(`/enterprise/skill-versions?capabilityId=${skill.capability.id}`);
assert.equal(versions.find(v => v.id === next.id)?.status, 'ENTERPRISE_APPROVED');
assert.equal(versions.find(v => v.id === version.id)?.status, 'ENTERPRISE_REJECTED');
const after = await request(`/enterprise/employees/${subscriptions[0].employeeId}/skills`);
const afterSkill = after.skills.find(s => s.capability.id === skill.capability.id);
assert.equal(afterSkill.currentVersion.id, skill.currentVersion.id, 'Review must not replace the shared version');
assert.ok(afterSkill.versions.some(v => v.id === next.id));
assert.equal((await request(`/enterprise/skill-versions/${next.id}/preview`)).content, body.content);
const employment = await request('/client/auth/token', { method: 'POST', auth: false, body: {
  refreshToken: login.refreshToken, subscriptionId: subscriptions[0].subscriptionId,
} });
const gateway = await fetch(`${base}/gateway/v1/chat/completions`, {
  method: 'POST', headers: { Authorization: `Bearer ${employment.employmentToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: subscriptions[0].allowedModels[0], messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 32, stream: false }),
  signal: AbortSignal.timeout(60000),
});
assert.equal(gateway.status, 200, `Gateway status=${gateway.status}`);
const completion = await gateway.json();
assert.ok(completion.choices?.[0]?.message?.content, 'Gateway must return a nonempty completion');
console.log(JSON.stringify({
  status: 'passed', subscriptions: subscriptions.map(({ employeeId, subscriptionId }) => ({ employeeId, subscriptionId })),
  statistics: overview.statistics, capabilityId: skill.capability.id,
  rejectedVersionId: version.id, approvedVersionId: next.id,
  checks: ['organization', 'overview', 'employee-status', 'concurrent-idempotency', 'key-conflict',
    'source-roundtrip', 'immutable-submissions', 'validation', 'review-queue', 'review-results', 'shared-version-unchanged', 'employment-token-gateway'],
}, null, 2));
