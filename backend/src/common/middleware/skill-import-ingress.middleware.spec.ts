import express from 'express';
import request from 'supertest';
import type { Request } from 'express';
import { createSkillImportEventByteConsumer, createSkillImportIngressMiddleware } from './skill-import-ingress.middleware';
import { skillImportSessionRoute } from './skill-import-route';

describe('skill import ingress before body parsing', () => {
  const evalScript = jest.fn();
  const parsed = jest.fn();
  function start(enabled = true) {
    const app = express();
    app.use(createSkillImportIngressMiddleware(() => ({ eval: evalScript }), { enabled, instanceId: 'test', redisTimeoutMs: 20 }));
    app.use((_req, _res, next) => { parsed(); next(); });
    app.use(express.json());
    app.use((_req, res) => res.json({ ok: true }));
    return app;
  }
  beforeEach(() => { jest.resetAllMocks(); evalScript.mockResolvedValue([1, 60_000]); });

  it('does not affect unrelated routes or the feature configuration endpoint', async () => {
    const app = start(false);
    await request(app).get('/api/capabilities').expect(200);
    await request(app).get('/api/skill-import/config').expect(200);
    expect(evalScript).not.toHaveBeenCalled();
    await request(app).post('/api/skill-import/sessions').send({}).expect(503);
    expect(parsed).toHaveBeenCalledTimes(2);
  });

  it('allows authenticated cleanup paths to reach their guards after disabling', async () => {
    const app = start(false);
    await request(app).delete('/api/skill-import/sessions/s-1').expect(200);
    await request(app).delete('/api/skill-import/devices/d-1').expect(200);
    await request(app).post('/api/skill-import/connector/devices/d-1/revoke').send({}).expect(200);
    const response = await request(app).post('/api/skill-import/connector/grants').send({}).expect(503);
    expect(response.body.code).toBe('IMPORT_DISABLED');
    expect(parsed).toHaveBeenCalledTimes(3);
  });

  it('rejects anonymous proof floods before parsing malformed JSON', async () => {
    evalScript.mockResolvedValue([21, 12_100]);
    const response = await request(start()).post('/api/skill-import/connector/pairings')
      .set('Content-Type', 'application/json').send('{').expect(429);
    expect(response.headers['retry-after']).toBe('13');
    expect(response.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(parsed).not.toHaveBeenCalled();
  });

  it('uses a separate allowance for pending grant polling and cancellation', async () => {
    evalScript.mockResolvedValue([21, 60_000]);
    const app = start();
    await request(app).post('/api/skill-import/connector/grants').send({}).expect(200);
    await request(app).delete('/api/skill-import/sessions/s-1').expect(200);
    const keys = evalScript.mock.calls.map(call => call[2]);
    expect(keys[0]).toContain(':grants:');
    expect(keys[1]).toContain(':cancel:');
    expect(keys.join('')).not.toContain('127.0.0.1');
  });

  it('fails closed on Redis errors before parsing', async () => {
    evalScript.mockRejectedValue(new Error('private redis url'));
    const response = await request(start()).post('/api/skill-import/sessions').send({}).expect(503);
    expect(response.body.code).toBe('IMPORT_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(parsed).not.toHaveBeenCalled();
  });

  it('checks declared body budgets before attempting Redis or parsing', async () => {
    await request(start()).post('/api/skill-import/connector/pairings')
      .set('Content-Type', 'application/json').send('{}')
      .set('Content-Length', String(2 * 1024 * 1024 + 1)).expect(413);
    expect(evalScript).not.toHaveBeenCalled();
    expect(parsed).not.toHaveBeenCalled();
  });

  it('bounds the wait when the Redis connection never responds', async () => {
    evalScript.mockImplementation(() => new Promise(() => {}));
    await request(start()).post('/api/skill-import/sessions').send({}).expect(503);
    expect(parsed).not.toHaveBeenCalled();
  });

  it('atomically charges per-session actual bytes with a fixed bounded lifetime', async () => {
    const consume = createSkillImportEventByteConsumer(() => ({ eval: evalScript }), { instanceId: 'test' });
    const req = { method: 'POST', path: '/api/skill-import/connector/sessions/Mixed-Case/events' } as Request;
    evalScript.mockResolvedValue(128 * 1024 * 1024);
    await expect(consume(req, 1024)).resolves.toBeUndefined();
    expect(evalScript).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCRBY'"), 1, 'skill-import:v1:test:event-bytes:Mixed-Case', 1024, 35 * 60_000);
    evalScript.mockResolvedValue(128 * 1024 * 1024 + 1);
    await expect(consume(req, 1)).rejects.toMatchObject({ status: 400, response: { code: 'EVENT_BUDGET_EXCEEDED' } });
    expect(evalScript).toHaveBeenCalledTimes(2);
  });

  it('does not charge unrelated requests and fails closed if byte accounting is unavailable', async () => {
    const consume = createSkillImportEventByteConsumer(() => ({ eval: evalScript }), { instanceId: 'test', redisTimeoutMs: 20 });
    await consume({ method: 'POST', path: '/api/capabilities' } as Request, 100);
    expect(evalScript).not.toHaveBeenCalled();
    const req = { method: 'POST', path: '/api/skill-import/connector/sessions/s-1/events' } as Request;
    evalScript.mockRejectedValue(new Error('private redis connection'));
    await expect(consume(req, 100)).rejects.toMatchObject({ status: 503, response: { code: 'IMPORT_UNAVAILABLE' } });
    evalScript.mockImplementation(() => new Promise(() => {}));
    await expect(consume(req, 100)).rejects.toMatchObject({ status: 503, response: { code: 'IMPORT_UNAVAILABLE' } });
  });

  it('charges canonical and encoded IDs to the same case-preserving session bucket', async () => {
    evalScript.mockResolvedValue(1);
    const consume = createSkillImportEventByteConsumer(() => ({ eval: evalScript }), { instanceId: 'test' });
    for (const sessionId of ['Abc-_1', '%41bc%2D%5F%31']) {
      await consume({ method: 'POST', path: `/api/skill-import/connector/sessions/${sessionId}/events` } as Request, 100);
    }
    expect(evalScript.mock.calls.map((call) => call[2])).toEqual(['skill-import:v1:test:event-bytes:Abc-_1', 'skill-import:v1:test:event-bytes:Abc-_1']);
    for (const sessionId of ['%2FAbc', '%2541bc', '%broken']) {
      await consume({ method: 'POST', path: `/api/skill-import/connector/sessions/${sessionId}/events` } as Request, 100);
      expect(skillImportSessionRoute(`/api/skill-import/connector/sessions/${sessionId}/package`, 'package')).toBeNull();
    }
    expect(evalScript).toHaveBeenCalledTimes(2);
  });

  it('keeps encoded event routes in the event-specific ingress rate bucket', async () => {
    await request(start()).post('/api/skill-import/connector/sessions/%61bc/events').send({}).expect(200);
    expect(evalScript.mock.calls[0][2]).toContain(':ingress:events:');
    expect(skillImportSessionRoute('/API/SKILL-IMPORT/CONNECTOR/SESSIONS/%41bc/package/', 'package')).toBe('Abc');
  });
});
