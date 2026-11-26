import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { ComputeCreditController } from './compute-credit.controller';
import { ComputeCreditService } from './compute-credit.service';
import { MemberAllowanceService } from './member-allowance.service';
import { MemberAllowanceQueryService } from './member-allowance-query.service';
import { UsageAnalyticsService } from './usage-analytics.service';

describe('Payment preference HTTP', () => {
  let app: INestApplication;
  const credit = { getPaymentPreference: jest.fn(), setPaymentPreference: jest.fn() };
  const context = { resolve: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ComputeCreditController], providers: [
        { provide: ComputeCreditService, useValue: credit },
        { provide: EnterpriseContextService, useValue: context },
        { provide: MemberAllowanceService, useValue: {} },
        { provide: MemberAllowanceQueryService, useValue: {} },
        { provide: UsageAnalyticsService, useValue: {} },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate(ctx) { ctx.switchToHttp().getRequest().user = { id: 'current-user' }; return true; } }).compile();
    app = module.createNestApplication(); await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    context.resolve.mockResolvedValue({ enterpriseId: 'current-company', role: 'MEMBER' });
    credit.getPaymentPreference.mockResolvedValue({ paymentMode: 'AUTO' });
    credit.setPaymentPreference.mockImplementation(async (_enterprise, _user, paymentMode) => ({ paymentMode }));
  });
  afterAll(async () => app.close());

  it('reads the authenticated user preference', async () => {
    await request(app.getHttpServer()).get('/compute-credit/payment-preference').expect(200, { paymentMode: 'AUTO' });
    expect(credit.getPaymentPreference).toHaveBeenCalledWith('current-company', 'current-user');
  });
  it.each(['MEMBER', 'DEPT_MANAGER', 'ENTERPRISE_ADMIN'])('allows %s to change their own preference', async role => {
    context.resolve.mockResolvedValue({ enterpriseId: 'current-company', role });
    await request(app.getHttpServer()).patch('/compute-credit/payment-preference').send({ paymentMode: 'PERSONAL_ONLY' }).expect(200, { paymentMode: 'PERSONAL_ONLY' });
    expect(credit.setPaymentPreference).toHaveBeenCalledWith('current-company', 'current-user', 'PERSONAL_ONLY');
  });
  it.each([{ paymentMode: 'INVALID' }, { paymentMode: 'AUTO', userId: 'someone-else' }, {}])('rejects invalid or unscoped input %j', async body => {
    await request(app.getHttpServer()).patch('/compute-credit/payment-preference').send(body).expect(400);
    expect(credit.setPaymentPreference).not.toHaveBeenCalled();
  });
});
