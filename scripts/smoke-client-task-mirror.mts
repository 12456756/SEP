/** Shared-dev only. Run with SEP_CLIENT_REPO and SEP_ACCESS_TOKEN via pnpm exec tsx.
 * Creates one clearly labelled test mirror (retained as verification evidence).
 * Uses the actual sibling client's API adapter, not a duplicated write client.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const base = process.env.SEP_BASE_URL;
assert.ok(base, 'SEP_BASE_URL must point to a dedicated integration environment');
const baseUrl = new URL(base);
assert.equal(baseUrl.protocol, 'https:', 'Integration API must use HTTPS');
assert.notEqual(baseUrl.hostname.toLowerCase(), 'sep.longdaoec.com', 'Mutative smoke tests must not target production');
assert.ok(process.env.SEP_CLIENT_REPO, 'SEP_CLIENT_REPO is required');
assert.ok(process.env.SEP_ACCESS_TOKEN, 'SEP_ACCESS_TOKEN is required (never print it)');
process.env.SEP_BASE_URL = base;
const token = process.env.SEP_ACCESS_TOKEN;
const { ClientTaskApi } = await import(pathToFileURL(resolve(process.env.SEP_CLIENT_REPO, 'electron/common/platform/client-task-api.ts')).href);
const auth = {
  getValidAccessToken: async () => token,
  invalidateAccessToken: () => { throw new Error('Session expired; obtain a fresh integration login'); },
};
const api = new ClientTaskApi(auth);
const checks: string[] = [];
async function read(path: string, expected = 200, authenticated = true) {
  const response = await fetch(`${base}${path}`, {
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, expected, `GET ${path}: HTTP ${response.status}`);
  return response.json();
}
await read('/client/tasks', 401, false);
checks.push('anonymous query rejected');
const subscriptions = await read('/client/subscriptions');
assert.ok(subscriptions.length, 'An authorized subscription is required');
const subscriptionId = subscriptions[0].subscriptionId;
const runtime = await read(`/client/subscriptions/${subscriptionId}/runtime`);
assert.equal(runtime.subscriptionId, subscriptionId);
checks.push('subscriptions and runtime');
const clientTaskId = `integration-smoke-${randomUUID()}`;
const clientRunId = randomUUID();
const payload = { clientTaskId, clientRunId, subscriptionId, title: `[联调验证] ${clientTaskId}`, status: 'QUEUED', createdAt: new Date().toISOString() };
const remote = await api.create(payload);
assert.ok(remote.id, 'Creation must return a top-level id');
assert.equal((await api.create(payload)).id, remote.id);
checks.push('create and replay return same top-level id');
await api.updateStatus(remote.id, 'RUNNING');
await api.heartbeat(remote.id);
const event = { sequence: 1, type: 'tool_call', occurredAt: new Date().toISOString(), data: { toolName: 'integration-check', success: true } };
await api.appendEvent(remote.id, event);
await api.appendEvent(remote.id, event);
const running = await read(`/client/tasks/${remote.id}`);
assert.equal(running.status, 'RUNNING');
assert.ok(running.lastHeartbeatAt);
assert.equal(running.events.length, 1);
assert.equal(running.events[0].type, event.type);
checks.push('running, heartbeat, event persistence and exact replay deduplication');
for (const status of ['WAITING_APPROVAL', 'PAUSED', 'RUNNING', 'COMPLETED']) {
  await api.updateStatus(remote.id, status);
  assert.equal((await read(`/client/tasks/${remote.id}`)).status, status);
}
checks.push('approval, pause, resume and complete states');
const completed = await read(`/client/tasks/${remote.id}`);
assert.ok(completed.completedAt);
assert.equal(completed.clientTaskId, clientTaskId);
assert.equal(completed.clientRunId, clientRunId);
assert.equal(completed.subscriptionId, subscriptionId);
assert.ok((await read('/client/tasks')).some((task: { id: string; status: string }) => task.id === remote.id && task.status === 'COMPLETED'));
checks.push('list and fresh detail query retain completed mirror');
// Exercise the real mirror coordinator with controlled task snapshots. This is
// not Electron/TaskRuntime execution; only its HTTP and persistence logic is real.
const { TaskCloudMirror } = await import(pathToFileURL(resolve(process.env.SEP_CLIENT_REPO, 'electron/runtime/task-cloud-mirror.ts')).href);
const directory = await mkdtemp(join(tmpdir(), 'sep-mirror-live-'));
const mirror = new TaskCloudMirror(auth, directory);
const lifecycleTaskId = `integration-lifecycle-${randomUUID()}`;
let lifecycleRemoteId: string | undefined;
try {
  const task = { id: lifecycleTaskId, title: `[联调生命周期] ${lifecycleTaskId}`, subscriptionId, activeRunId: null as string | null, status: 'pending', createdAt: Date.now() };
  const sync = async () => { mirror.observeTask({ ...task }); await mirror.chain.get(task.id); };
  await sync();
  assert.ok(!(await read('/client/tasks')).some((row: { clientTaskId: string }) => row.clientTaskId === task.id));
  task.activeRunId = randomUUID();
  task.status = 'running';
  await sync();
  const row = (await read('/client/tasks')).find((item: { clientTaskId: string }) => item.clientTaskId === task.id);
  assert.ok(row, 'Admitted task must create a real backend mirror');
  lifecycleRemoteId = row.id;
  assert.equal(row.clientRunId, task.activeRunId);
  mirror.observeEvent({ taskId: task.id, runId: task.activeRunId, sequence: 1, type: 'integration_verified', occurredAt: Date.now(), data: null });
  await mirror.chain.get(task.id);
  task.status = 'completed';
  task.activeRunId = null;
  await sync();
  const final = await read(`/client/tasks/${row.id}`);
  assert.equal(final.status, 'COMPLETED');
  assert.equal(final.events.length, 1);
  assert.equal(final.events[0].type, 'integration_verified');
  checks.push('real TaskCloudMirror defers null runId, creates on admission, sends event and completes with null runId');
} finally {
  mirror.stop();
  await mirror.persistChain;
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: 'passed', executedAt: new Date().toISOString(), base, clientTaskId, clientRunId, remoteTaskId: remote.id, lifecycleTaskId, lifecycleRemoteId, subscriptionId, checks,
  limitations: ['No Electron execution or model call; actual client HTTP adapter and mirror coordinator with controlled snapshots', 'No cross-account authorization or fault injection verification', 'Event data is not persisted by the current backend; only declared event fields are stored'] }, null, 2));
