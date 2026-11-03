import express from 'express';
import type { RequestHandler } from 'express';

export function createJsonBodyMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const gateway = express.json({ limit: env.GATEWAY_HTTP_JSON_LIMIT || '4mb' });
  const ordinary = express.json({ limit: env.REQUEST_JSON_LIMIT || '2mb' });
  // Escaped Markdown can occupy six JSON bytes per source byte, plus DTO metadata.
  const skill = express.json({ limit: env.SKILL_REQUEST_JSON_LIMIT || '16mb' });
  return (req, res, next) => {
    const parser = req.method === 'POST' && /^\/api\/gateway\/v1\/chat\/completions\/?$/i.test(req.path)
      ? gateway : /^\/api\/(?:capabilities|contributions|admin\/skill-versions|enterprise\/(?:skill-versions|capabilities))(?:\/|$)/i.test(req.path)
        ? skill : req.method === 'POST' && /^\/api\/skill-import\/connector\/sessions\/[A-Za-z0-9_-]{1,160}\/events\/?$/i.test(req.path)
          ? skill : ordinary;
    parser(req, res, next);
  };
}
