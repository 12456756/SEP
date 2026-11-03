import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { createBasicRateLimitMiddleware } from './common/middleware/basic-rate-limit.middleware';
import { createJsonBodyMiddleware } from './common/middleware/json-body.middleware';
import { CspMiddleware } from './common/middleware/csp.middleware';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { GatewayLifecycleService } from './common/lifecycle/gateway-lifecycle.service';
import { installGatewayShutdown } from './common/lifecycle/gateway-shutdown';
import { configureTrustedProxy } from './common/trusted-proxy';
import { businessTracker } from './modules/security/rate-limit-policy';
import { RedisService } from './redis/redis.service';
import { createSkillImportIngressMiddleware } from './common/middleware/skill-import-ingress.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureTrustedProxy(app.getHttpAdapter().getInstance());
  const gatewayLifecycle = app.get(GatewayLifecycleService);
  installGatewayShutdown(app, gatewayLifecycle);
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (isProduction && corsOrigins.length === 0) {
    throw new Error('生产环境必须配置至少一个 CORS_ORIGIN');
  }

  // Helmet 安全头（生产环境启用）
  if (isProduction) {
    app.use(
      helmet({
        contentSecurityPolicy: false, // Disabled - using custom CSP middleware
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        },
      })
    );
  }

  // CSP middleware (applied in all environments for consistency)
  const cspMiddleware = new CspMiddleware();
  app.use((req, res, next) => cspMiddleware.use(req, res, next));

  app.use(requestContextMiddleware, createBasicRateLimitMiddleware(
    businessTracker(app.get(ConfigService), app.get(JwtService)),
  ));
  const importConfig = app.get(ConfigService);
  app.use(createSkillImportIngressMiddleware(() => app.get(RedisService).redis, {
    enabled: importConfig.get('SKILL_IMPORT_ENABLED') === 'true',
    instanceId: importConfig.get('SKILL_IMPORT_INSTANCE_ID') || 'disabled',
  }));
  app.use(createJsonBodyMiddleware());
  app.use(express.urlencoded({ limit: process.env.REQUEST_URLENCODED_LIMIT || '2mb', extended: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => Logger.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`, 'HTTP'));
    next();
  });

  // WebSocket adapter
  app.useWebSocketAdapter(new WsAdapter(app));

  // Cookie parser (required for refresh token cookie)
  app.use(cookieParser());

  // Enable CORS
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : ['http://localhost:3000', 'http://localhost:4173'],
    credentials: true,
  });

  // Global API prefix
  app.setGlobalPrefix('api');

  app.getHttpAdapter().get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'sep-backend', ...gatewayLifecycle.snapshot(), timestamp: new Date().toISOString() }));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Silicon Talent Platform API')
    .setDescription('硅基人才平台 API 文档')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'Short-lived skill import session or upload grant' },
      'skill-import-grant',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`🚀 Platform API is running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
}

bootstrap();
