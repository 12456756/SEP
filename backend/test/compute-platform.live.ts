import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComputeProtocolClient } from '../src/modules/compute-integration/compute-protocol.client';
import { ComputeRemoteAdapter } from '../src/modules/compute-integration/compute-remote.adapter';
import { ComputeIntegrationService } from '../src/modules/compute-integration/compute-integration.service';
import { ComputeIntegrationWorker } from '../src/modules/compute-integration/compute-integration.worker';
import { ComputeAccountingService } from '../src/modules/compute-integration/compute-accounting.service';
import { ComputeConnectionService } from '../src/modules/compute-integration/compute-connection.service';
import { ComputeModelCatalogService } from '../src/modules/compute-integration/compute-model-catalog.service';
import { Sub2apiImageAdapter } from '../src/modules/media-gateway/sub2api-image.adapter';
import { Sub2apiVideoAdapter } from '../src/modules/media-gateway/sub2api-video.adapter';
import { sanitizeError } from '../src/common/errors/error-diagnostics';
import { runComputeBusinessFixture } from './compute-business.live';
import { AuthService } from '../src/modules/auth/auth.service';
import { SessionService } from '../src/modules/auth/session.service';

const computeOrigin = 'http://127.0.0.1:28080';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const databaseUrl = process.env.COMPUTE_TEST_DATABASE_URL;
  if (process.env.SEP_COMPUTE_LIVE_TEST !== 'local-isolated-only' || !databaseUrl || !process.env.COMPUTE_TEST_ADMIN_PASSWORD) {
    throw new Error('Explicit local-isolated-only opt-in, isolated database and local fixture admin password are required');
  }
  const database = new URL(databaseUrl);
  assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '25434'); assert.equal(database.pathname, '/sep_compute_test');
  const remoteDatabase = execFileSync('docker', ['exec', 'longdao-model-pricing-test-20261120', 'psql', '-U', 'pricing_test', '-d', 'pricing_test', '-Atc', 'SELECT current_database()'], { encoding: 'utf8' }).trim();
  assert.equal(remoteDatabase, 'pricing_test');
  const db = new PrismaService({ datasourceUrl: databaseUrl });
  const stamp = Date.now().toString(), directory = await mkdtemp(join(tmpdir(), 'sep-live-'));
  const models = { chat: `sep-link-chat-${stamp}`, image: `gpt-image-2-link-${stamp}`, video: `minimax-h3-link-${stamp}` };
  let token = '', previous: Record<string, any> | undefined, enterpriseId: string | undefined;
  let fixtureAccountId: number | undefined, upstreamCalls = 0;
  const groups: Array<{ id: number }> = [];
  const adminKeyIds: number[] = [];
  const businessFixtureIds: string[] = [];
  const imageBytes = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1024x1024',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { maxBuffer: 5 * 1024 * 1024 });
  const videoTasks = new Set<string>();
  const videoBytes = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1280x720:r=24', '-t', '6',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { maxBuffer: 5 * 1024 * 1024 });
  async function admin(method: string, path: string, body?: unknown) {
    const response = await fetch(`${computeOrigin}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json',
      'User-Agent': 'SEPIsolatedIntegration/1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Fixture admin ${method} ${path} returned ${response.status}`);
    return Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value;
  }
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (req.method === 'POST') upstreamCalls++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      const input = JSON.parse(body);
      if (input.messages[0].content === 'missing-usage') {
        res.end(JSON.stringify({ id: `no-usage-${stamp}`, object: 'chat.completion', model: 'upstream-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }] })); return;
      }
      if (input.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'upstream-chat', choices: [{ index: 0, delta: { content: 'fixture' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'upstream-chat', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
      }
      res.end(JSON.stringify({ id: `chat-${stamp}-${upstreamCalls}`, object: 'chat.completion', created: 1, model: 'upstream-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
    } else if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: imageBytes.toString('base64') }] }));
    } else if (req.url === '/v1/videos') {
      const id = `video_${stamp}_${upstreamCalls}`; videoTasks.add(id);
      res.end(JSON.stringify({ object: 'video', model: models.video, id, status: 'queued', seconds: '6', size: '1280x720' }));
    } else if (req.url?.endsWith('/content') && videoTasks.has(req.url.split('/')[3])) {
      res.setHeader('Content-Type', 'video/mp4'); res.end(videoBytes);
    } else if (videoTasks.has(req.url?.split('/')[3] ?? '')) {
      res.end(JSON.stringify({ object: 'video', model: models.video, id: req.url.split('/')[3], status: 'completed', seconds: '6', size: '1280x720' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await db.$connect();
    const auth = await admin('POST', '/auth/login', { email: process.env.COMPUTE_TEST_ADMIN_EMAIL ?? 'pricing-admin@local.test', password: process.env.COMPUTE_TEST_ADMIN_PASSWORD });
    token = auth.access_token;
    previous = await admin('GET', '/admin/sep/config');
    assert.equal(previous!.enabled, false, 'Another integration is active; fixture must not replace it');
    const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const signingFile = join(directory, 'sign.pem'), encryptionFile = join(directory, 'enc.pem');
    await writeFile(signingFile, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(encryptionFile, encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    for (const kind of ['chat', 'image', 'video'] as const) groups.push(await admin('POST', '/admin/groups', {
      name: `sep-link-${kind}-${stamp}`, platform: 'openai', subscription_type: 'standard', rate_multiplier: 1,
      allow_image_generation: true, models_list_config: { enabled: true, models: [models[kind]] },
    }));
    const signingId = `sep-link-sign-${stamp}`, encryptionId = `sep-link-enc-${stamp}`;
    await admin('PUT', '/admin/sep/config', { ...previous, enabled: true, integration_id: previous!.integration_id || 'sep-local-validation',
      signing_key_id: signingId, signing_public_key: signing.publicKey.export({ type: 'spki', format: 'pem' }),
      encryption_key_id: encryptionId, encryption_public_key: encryption.publicKey.export({ type: 'spki', format: 'pem' }),
      chat_group_id: groups[0].id, image_group_id: groups[1].id, video_group_id: groups[2].id });
    const config = new ConfigService({ NODE_ENV: 'test', JWT_SECRET: 'isolated-link-fixture-only', COMPUTE_INTEGRATION_ENABLED: 'true',
      COMPUTE_ALLOW_LOOPBACK_HTTP: 'true', COMPUTE_API_ORIGIN: computeOrigin, COMPUTE_SIGNING_KEY_ID: signingId,
      COMPUTE_SIGNING_PRIVATE_KEY_FILE: signingFile, COMPUTE_ENCRYPTION_KEY_ID: encryptionId,
      COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES: JSON.stringify({ [encryptionId]: encryptionFile }) });
    const protocol = new ComputeProtocolClient(config), remote = new ComputeRemoteAdapter(protocol);
    const service = new ComputeIntegrationService(db, config, remote);
    const workerDb = new Proxy(db, { get(target, property) {
      if (property === 'computeIntegrationJob') return { ...target.computeIntegrationJob,
        findMany: (args: any) => target.computeIntegrationJob.findMany({ ...args, where: { ...args.where, enterpriseId: enterpriseId ?? '__fixture_not_created__' } }) };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const worker = new ComputeIntegrationWorker(workerDb, remote, service);
    const accounting = new ComputeAccountingService(db);
    const loginEmail = `sep-link-${stamp}@example.test`, loginPassword = 'SepComputeFixture2026!';
    const sessions = new SessionService(db, config);
    const authService = new AuthService(db, new JwtService(), config, {} as any,
      { createDefaultDepartments: async () => undefined } as any, sessions,
      undefined, undefined, undefined, undefined, undefined,
      { consume: async () => undefined } as any, service);
    const response = { cookie: () => undefined } as any;
    // Email-code delivery is outside this isolated fixture; registration, hashing and sessions use real services.
    const registered = await authService.register({ email: loginEmail, password: loginPassword,
      enterpriseName: `SEP联调-${stamp}`, emailCode: '123456' }, response);
    enterpriseId = registered.enterprise!.id;
    const passwordHash = (await db.authCredential.findUniqueOrThrow({
      where: { userId_type: { userId: registered.user.id, type: 'LOCAL_PASSWORD' } },
    })).passwordHash!;
    assert.equal(JSON.stringify(registered).includes(passwordHash), false);
    assert.ok((await authService.login({ email: loginEmail, password: loginPassword }, response)).token);
    await assert.rejects(authService.login({ email: loginEmail, password: 'wrong-fixture-password' }, response));
    await service.prepare(enterpriseId);
    await worker.deliver();
    const view = await service.view(enterpriseId);
    assert.equal(view.status, 'READY'); assert.equal(view.activationAllowed, true);
    assert.ok(view.credentials.every(value => value.configured)); assert.equal(view.mode, 'PREPARING');
    assert.equal(JSON.stringify(view).includes('apiKey'), false);
    const registration = await db.computeIntegrationJob.findUniqueOrThrow({ where: { businessId: `reg_${enterpriseId}` } });
    assert.equal(JSON.stringify(registration.requestPayload).includes(passwordHash), false);
    const original = await remote.provision(service.registrationRequest(registration.requestPayload));
    assert.equal(original.remoteAccountId, view.remoteAccountId);
    const credentials = await db.enterpriseComputeCredential.findMany({ where: { enterpriseId } });
    assert.ok(credentials.every(value => value.encryptedKey.startsWith('enc:')));
    console.log('PASS: SEP durable worker -> real compute N01, JWE verification/storage and original registration replay');
    const login = await admin('POST', '/auth/login', { email: loginEmail, password: loginPassword });
    assert.equal(String(login.user.id), view.remoteAccountId);
    assert.equal(login.user.role, 'user');
    const registeredRequest = service.registrationRequest(registration.requestPayload);
    assert.equal(registeredRequest.passwordHash, passwordHash);
    await assert.rejects(remote.provision({ ...registeredRequest, enterpriseId: `email-conflict-${stamp}`, registrationRef: `email-conflict-${stamp}` }),
      (error: any) => error.getResponse().error?.code === 'EMAIL_ALREADY_EXISTS' || error.getResponse().reason === 'EMAIL_ALREADY_EXISTS');
    await assert.rejects(admin('POST', '/auth/login', { email: loginEmail, password: 'wrong-fixture-password' }));
    console.log('PASS: same-email/password ordinary login, encrypted password snapshot, original account replay and email conflict');

    const upstreamCompany = await admin('POST', '/admin/upstream-companies', { name: `SEP link ${stamp}` });
    const prices = [
      { model: models.chat, mode: 'token', discount: '1', markup: '1', items: [{ kind: 'input', tier: '', unit: 'USD/MTok', amount: '2' }, { kind: 'output', tier: '', unit: 'USD/MTok', amount: '8' }], policy: {} },
      { model: models.image, mode: 'image', discount: '1', markup: '1', items: [{ kind: 'image', tier: '1K', unit: 'USD/image', amount: '0.04' }], policy: {} },
      { model: models.video, mode: 'video', discount: '1', markup: '1', items: [{ kind: 'video', tier: '720p', unit: 'USD/second', amount: '0.02' }], policy: {} },
    ];
    const fixtureAccount = await admin('POST', '/admin/accounts', { name: `SEP link upstream ${stamp}`, platform: 'openai', type: 'apikey', concurrency: 10,
      priority: 1, rate_multiplier: 1, group_ids: groups.map(group => group.id), credentials: { api_key: 'fixture-unused-key',
        base_url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, model_mapping: {
          [models.chat]: 'upstream-chat', [models.image]: 'gpt-image-2', [models.video]: models.video,
        }, openai_capabilities: ['chat_completions', 'videos'] }, extra: { openai_responses_mode: 'force_chat_completions' },
      upstream_company_id: upstreamCompany.id, model_prices: prices });
    fixtureAccountId = fixtureAccount.id;
    const listed = await admin('GET', `/admin/accounts/${fixtureAccount.id}/model-prices`);
    for (const price of listed.prices) await admin('PUT', '/admin/model-pricing/base-price', { model: price.model, source_price_id: price.id, source_revision: price.revision, expected_version: 0 });
    const connections = new ComputeConnectionService({ getEffectiveValue: async () => computeOrigin + '/v1' } as any, service, protocol);
    const catalog = new ComputeModelCatalogService(db, connections, protocol);
    for (const kind of ['chat', 'image', 'video'] as const) assert.deepEqual((await catalog.list(enterpriseId, kind)).map(value => value.modelId), [models[kind]]);
    console.log('PASS: enterprise and purpose catalogs through signed /v1/models with explicitly restricted test groups');

    const callsBeforeCalibration = upstreamCalls;
    for (const kind of ['image', 'video'] as const) {
      const key = await admin('POST', '/keys', { name: `sep-admin-calibration-${kind}-${stamp}`, group_id: groups[kind === 'image' ? 1 : 2].id });
      adminKeyIds.push(key.id); assert.ok(key.key);
      if (kind === 'image') {
        const price = await new Sub2apiImageAdapter({} as any, protocol).pricing({ protocolVersion: 3, specRevision: 1, profileId: 'fixture', configVersion: 'cfg_1', operation: 'generate',
          referenceIds: [], creativeBrief: 'fixture', requestedSpec: { size: '1024x1024', count: 1, quality: 'medium' } }, models.image, { base: computeOrigin + '/v1', key: key.key });
        assert.equal(price.currency, 'USD'); assert.ok(price.amount_usd);
      } else {
        const base = computeOrigin + '/v1';
        const price = await new Sub2apiVideoAdapter({} as any, protocol).pricing({ base, key: key.key, fingerprint: createHash('sha256').update(base + '\0' + key.key).digest('hex') },
          { protocolVersion: 3, specRevision: 1, profileId: 'fixture', configVersion: 'cfg_1', operation: 'text-to-video', referenceIds: [], creativeBrief: 'fixture',
            requestedSpec: { resolution: '720p', durationSeconds: 6, aspectRatio: '16:9', frameRate: 24, audio: false, outputFormat: 'video/mp4' } }, models.video);
        assert.equal(price.currency, 'USD'); assert.ok(price.amount_usd);
      }
    }
    assert.equal(upstreamCalls, callsBeforeCalibration);
    console.log('PASS: existing SEP image/video adapters calibrate with administrator account keys; no enterprise key or supplier execution');

    const chatCredential = await service.selectEnterpriseCredential(enterpriseId, 'chat');
    const execute = async (source: string, message = 'fixture', stream = false) => {
      const execution = await accounting.createExecution({ enterpriseId: enterpriseId!, kind: 'chat', sourceRef: source, credentialId: chatCredential.credentialId });
      const response = await protocol.request('/v1/chat/completions', { method: 'POST', enterpriseId, executionId: execution.id,
        apiKey: chatCredential.apiKey, body: { model: models.chat, messages: [{ role: 'user', content: message }], stream } });
      const text = await response.text(); assert.ok(stream ? text.includes('[DONE]') : text.includes('fixture'));
      return execution;
    };
    const finalBill = async (id: string) => {
      for (let i = 0; i < 50; i++) { const bill = await remote.billing(enterpriseId!, id); if (bill.fee_status === 'final') return bill; await wait(100); }
      throw new Error('Actual CNY fee not finalized');
    };
    // This fixture exercises adapter/worker primitives. No SEP wallet is credited or debited.
    const freeExecution = await execute(`free_${stamp}`, 'fixture', true), freeBill = await finalBill(freeExecution.id);
    await accounting.recordFee({ enterpriseId, executionId: freeExecution.id, computeRequestId: freeBill.compute_request_id, currency: 'CNY',
      status: 'FINAL', billId: freeBill.bill_id, billVersion: freeBill.bill_version, grossCny: freeBill.gross_cny! });
    assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '0.000000');
    const freeDecision = { enterpriseId, executionId: freeExecution.id, kind: 'chat' as const, billId: freeBill.bill_id, billVersion: 1,
      currency: 'CNY' as const, grossCny: freeBill.gross_cny!, freeCny: freeBill.gross_cny!, paidCny: '0.000000', unpaidCny: '0.000000' };
    await db.$transaction(tx => service.recordSettlement(tx, freeDecision));
    // Only an isolated fixture can set this; production activation remains blocked.
    await db.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { mode: 'ENTERPRISE' } });
    for (let i = 0; i < 50; i++) {
      await worker.deliver();
      const settlement = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: freeExecution.id } });
      if (settlement.status === 'COMMITTED') break;
      await wait(100);
    }
    const freeSettlement = await db.computeIntegrationSettlement.findUniqueOrThrow({ where: { executionId: freeExecution.id } });
    const freeJob = await db.computeIntegrationJob.findUniqueOrThrow({ where: { businessId: `settle_${freeSettlement.id}` } });
    assert.equal(freeSettlement.status, 'COMMITTED', JSON.stringify({ status: freeJob.status,
      attempts: freeJob.attempts, code: freeJob.lastErrorCode, message: freeJob.lastErrorMessage }));
    assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '0.000000');
    const originalCalls = upstreamCalls;
    await assert.rejects(protocol.request('/v1/chat/completions', { method: 'POST', enterpriseId, executionId: freeExecution.id, apiKey: chatCredential.apiKey,
      body: { model: models.chat, messages: [{ role: 'user', content: 'fixture' }], stream: true } }));
    assert.equal(upstreamCalls, originalCalls);
    console.log('PASS: signed SSE, final CNY fee, all-free zero debit, durable settlement delivery and no duplicate generation');

    const transfer = { enterpriseId, businessId: `credit_${stamp}`, remoteAccountId: view.remoteAccountId!, direction: 'credit_compute' as const,
      currency: 'CNY' as const, amountCny: '1.000000', fundingRef: `fixture_${stamp}` };
    const credits = await Promise.all(Array.from({ length: 4 }, () => remote.transfer(transfer)));
    assert.ok(credits.every(value => value.remoteLedgerId === credits[0].remoteLedgerId));
    assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '1.000000');
    assert.equal((await remote.queryTransfer(transfer)).status, 'committed');
    const rejected = { ...transfer, businessId: `reject_${stamp}`, direction: 'debit_compute' as const, amountCny: '2.000000' };
    await assert.rejects(remote.transfer(rejected), (error: any) => error.getResponse().code === 'COMPUTE_TRANSFER_REJECTED');
    assert.equal((await remote.queryTransfer(rejected)).status, 'rejected');
    const first = await remote.ledger(enterpriseId, '0', '0', 1);
    await remote.transfer({ ...transfer, businessId: `credit2_${stamp}` });
    const rest = await remote.ledger(enterpriseId, first.after_sequence, first.snapshot_sequence, 200);
    assert.equal(rest.total_paid_cny, first.total_paid_cny); assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '2.000000');
    console.log('PASS: concurrent idempotent CNY credit, durable rejected debit, original transfer query and fixed ledger snapshot');

    const mixedExecution = await execute(`mixed_${stamp}`), mixedBill = await finalBill(mixedExecution.id);
    const paid = '0.001000';
    const { Decimal } = await import('@prisma/client/runtime/library');
    const mixed = { ...freeDecision, executionId: mixedExecution.id, billId: mixedBill.bill_id, grossCny: mixedBill.gross_cny!,
      paidCny: paid, freeCny: new Decimal(mixedBill.gross_cny!).minus(paid).toFixed(6), businessId: `mixed_settle_${stamp}`, remoteAccountId: view.remoteAccountId! };
    const receipts = await Promise.all(Array.from({ length: 4 }, () => remote.settle(mixed)));
    assert.ok(receipts.every(value => value.remoteLedgerId === receipts[0].remoteLedgerId));
    assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '1.999000');
    const missing = await execute(`missing_${stamp}`, 'missing-usage');
    for (let i = 0; i < 20; i++) { const bill = await remote.billing(enterpriseId, missing.id); if (bill.fee_status === 'reconciling') break; await wait(100); }
    const pending = await remote.billing(enterpriseId, missing.id); assert.equal(pending.gross_cny, null); assert.notEqual(pending.fee_status, 'final');
    const missingFee = await remote.executionFee(enterpriseId, missing.id, 'chat');
    assert.equal(missingFee.status, 'RECONCILING');
    const unresolved = await accounting.recordFee(missingFee); assert.equal(unresolved.grossCny, null); assert.equal(unresolved.feeStatus, 'RECONCILING');
    console.log('PASS: concurrent mixed settlement debits paid portion once; missing usage remains unresolved rather than zero');

    for (let i = 0; i < 8; i++) await remote.transfer({ ...transfer, businessId: `page_${stamp}_${i}`, amountCny: '0.000001' });
    let page = await remote.ledger(enterpriseId, '0', '0', 3);
    const snapshot = page.snapshot_sequence, snapshotBalance = page.total_paid_cny;
    assert.ok(BigInt(snapshot) >= 12n);
    const entries = [...page.items];
    await remote.transfer({ ...transfer, businessId: `after_snapshot_${stamp}`, amountCny: '0.000001' });
    while (page.has_more) {
      assert.ok(entries.length < 200, 'Ledger pagination did not terminate');
      page = await remote.ledger(enterpriseId, page.after_sequence, snapshot, 3);
      assert.equal(page.total_paid_cny, snapshotBalance);
      entries.push(...page.items);
    }
    assert.deepEqual(entries.map(entry => entry.sequence), Array.from({ length: Number(snapshot) }, (_, i) => String(i + 1)));
    assert.equal(new Set(entries.map(entry => entry.ledger_entry_id)).size, entries.length);
    const mixedEntries = entries.filter(entry => entry.settlement_id === mixed.businessId);
    assert.deepEqual(mixedEntries.map(entry => entry.type).sort(), ['free_record', 'paid_consumption']);
    assert.equal(mixedEntries.find(entry => entry.type === 'free_record')!.amount_cny, '0.000000');
    const latest = await remote.ledger(enterpriseId, snapshot, '0', 5);
    assert.equal(latest.items.length, 1);
    assert.equal(latest.items[0].transfer_id, `after_snapshot_${stamp}`);
    console.log(`PASS: N09 numeric ordering across ${entries.length} entries with limit=3, complete pages, mixed split and stable snapshot during new credit`);

    const imageKey = await service.selectEnterpriseCredential(enterpriseId, 'image');
    const imageQuote: any = await protocol.json('/v1/sub2api/images/pricing', { method: 'POST', enterpriseId, apiKey: imageKey.apiKey,
      body: { model: models.image, operation: 'generate', size: '1024x1024', quality: 'medium', n: 1 } });
    assert.equal(imageQuote.currency, 'CNY'); assert.ok(imageQuote.quote_id); assert.equal('amount_usd' in imageQuote, false);
    const imageExecution = await accounting.createExecution({ enterpriseId, kind: 'image', sourceRef: `image_${stamp}`, credentialId: imageKey.credentialId });
    await protocol.json('/v1/images/generations', { method: 'POST', enterpriseId, executionId: imageExecution.id, apiKey: imageKey.apiKey,
      quoteId: imageQuote.quote_id, body: { model: models.image, prompt: 'fixture', n: 1, size: '1024x1024', quality: 'medium' } });
    assert.equal((await finalBill(imageExecution.id)).kind, 'image');
    const videoKey = await service.selectEnterpriseCredential(enterpriseId, 'video');
    const videoQuote: any = await protocol.json('/v1/sub2api/videos/pricing', { method: 'POST', enterpriseId, apiKey: videoKey.apiKey,
      body: { model: models.video, operation: 'text-to-video', resolution: '720p', duration_seconds: 6 } });
    const videoExecution = await accounting.createExecution({ enterpriseId, kind: 'video', sourceRef: `video_${stamp}`, credentialId: videoKey.credentialId });
    const task: any = await protocol.json('/v1/videos', { method: 'POST', enterpriseId, executionId: videoExecution.id, apiKey: videoKey.apiKey,
      quoteId: videoQuote.quote_id, videoOperation: 'text-to-video', body: { model: models.video, prompt: 'fixture', seconds: '6', size: '1280x720' } });
    assert.ok(task.id); assert.equal((await finalBill(videoExecution.id)).kind, 'video');
    console.log('PASS: enterprise CNY image/video quotes, signed quote-bound execution and asynchronous video fee confirmation');
    await runComputeBusinessFixture(db, config, protocol, remote, service, models, directory, businessFixtureIds, imageBytes);
    console.log(`PASS: local compute interoperability and SEP business transactions completed with ${upstreamCalls} simulated supplier submissions`);
  } finally {
    const cleanupErrors: string[] = [];
    for (const id of businessFixtureIds) {
      try { await admin('PUT', `/admin/sep/enterprises/${id}`, { status: 'disabled', groups: {} }); } catch { cleanupErrors.push('disable remote business fixture'); }
      try { await db.enterpriseComputeBinding.update({ where: { enterpriseId: id }, data: { mode: 'PREPARING' } }); } catch { cleanupErrors.push('restore local business fixture mode'); }
    }
    if (enterpriseId) {
      try { await admin('PUT', `/admin/sep/enterprises/${enterpriseId}`, { status: 'disabled', groups: {} }); } catch { cleanupErrors.push('disable remote fixture enterprise'); }
      try { await db.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { mode: 'PREPARING' } }); } catch { cleanupErrors.push('restore local fixture mode'); }
    }
    if (fixtureAccountId) try { await admin('PUT', `/admin/accounts/${fixtureAccountId}`, { schedulable: false }); } catch { cleanupErrors.push('disable mock supplier'); }
    for (const id of adminKeyIds) try { await admin('PUT', `/keys/${id}`, { status: 'inactive' }); } catch { cleanupErrors.push('disable fixture admin key'); }
    if (previous) try { await admin('PUT', '/admin/sep/config', previous); } catch { cleanupErrors.push('restore prior SEP public configuration'); }
    for (const group of groups) try { await admin('PUT', `/admin/groups/${group.id}`, { status: 'inactive' }); } catch { cleanupErrors.push(`disable fixture group ${group.id}`); }
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await db.$disconnect(); await rm(directory, { recursive: true, force: true });
    if (cleanupErrors.length) throw new Error(`Fixture cleanup requires attention: ${cleanupErrors.join(', ')}`);
  }
}
main().catch(error => {
  console.error(JSON.stringify(sanitizeError(error && typeof error.getResponse === 'function' ? error.getResponse() : error)));
  process.exitCode = 1;
});
