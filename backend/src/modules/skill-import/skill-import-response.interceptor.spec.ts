import { ExecutionContext, HttpException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { SkillImportResponseInterceptor } from './skill-import-response.interceptor';

describe('Skill import serialized response budget', () => {
  const setHeader = jest.fn();
  const context = (view?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ path: '/api/skill-import/sessions/session', query: { view } }), getResponse: () => ({ statusCode: 200, setHeader }) }) } as unknown as ExecutionContext);
  const interceptor = new SkillImportResponseInterceptor();

  it('rejects a summary above 1MiB after actual JSON serialization', async () => {
    const response = interceptor.intercept(context(), { handle: () => of({ label: 'x'.repeat(1024 * 1024) }) });
    await expect(lastValueFrom(response)).rejects.toMatchObject({ status: 413 });
  });

  it('allows larger preview responses but rejects escaped JSON beyond 16MiB', async () => {
    const valid = { content: 'x'.repeat(2 * 1024 * 1024) };
    await expect(lastValueFrom(interceptor.intercept(context('preview'), { handle: () => of(valid) }))).resolves.toBe(valid);
    const escaped = { content: '\u0001'.repeat(3 * 1024 * 1024) };
    await expect(lastValueFrom(interceptor.intercept(context('preview'), { handle: () => of(escaped) }))).rejects.toMatchObject({ status: 413 });
  });

  it('returns a bounded Retry-After for module-level throttling', async () => {
    const error = new HttpException({ code: 'RATE_LIMITED', retryAfterSeconds: 60 }, 429);
    await expect(lastValueFrom(interceptor.intercept(context(), { handle: () => throwError(() => error) }))).rejects.toBe(error);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });
});
