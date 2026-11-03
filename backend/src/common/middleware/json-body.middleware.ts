import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';
import { skillImportSessionRoute } from './skill-import-route';

export type SkillImportEventByteConsumer = (req: Request, bytes: number) => Promise<void>;

export function createJsonBodyMiddleware(
  env: NodeJS.ProcessEnv = process.env,
  consumeSkillImportEventBytes?: SkillImportEventByteConsumer,
): RequestHandler {
  const gateway = express.json({ limit: env.GATEWAY_HTTP_JSON_LIMIT || '4mb' });
  const ordinary = express.json({ limit: env.REQUEST_JSON_LIMIT || '2mb' });
  // Escaped Markdown can occupy six JSON bytes per source byte, plus DTO metadata.
  const skill = express.json({ limit: env.SKILL_REQUEST_JSON_LIMIT || '16mb' });
  const eventBytes = new WeakMap<IncomingMessage, number>();
  const event = express.json({
    limit: env.SKILL_REQUEST_JSON_LIMIT || '16mb',
    verify: (req, _res, buffer) => { eventBytes.set(req, buffer.length); },
  });
  return (req, res, next) => {
    const isEvent = req.method === 'POST' && skillImportSessionRoute(req.path, 'events') !== null;
    const parser = req.method === 'POST' && /^\/api\/gateway\/v1\/chat\/completions\/?$/i.test(req.path)
      ? gateway : /^\/api\/(?:capabilities|contributions|admin\/skill-versions|enterprise\/(?:skill-versions|capabilities))(?:\/|$)/i.test(req.path)
        ? skill : isEvent ? event : ordinary;
    parser(req, res, (error?: unknown) => {
      const bytes = eventBytes.get(req);
      eventBytes.delete(req);
      if (!consumeSkillImportEventBytes || bytes === undefined) return next(error);
      // Charge received JSON even when parsing or subsequent DTO validation fails.
      void consumeSkillImportEventBytes(req, bytes).then(() => next(error), next);
    });
  };
}
