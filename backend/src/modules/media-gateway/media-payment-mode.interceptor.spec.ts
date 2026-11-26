import { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { MediaPaymentModeInterceptor } from './media-payment-mode.interceptor';

describe('Media payment mode legacy transport', () => {
  it.each(['AUTO', 'ENTERPRISE_ONLY', 'PERSONAL_ONLY'])('exposes %s in headers without modifying strict JSON funding', async paymentMode => {
    const setHeader = jest.fn();
    const context = { switchToHttp: () => ({ getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
    const funding = { creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.000000' };
    const value = { quoteId: 'quote-1', funding: { ...funding, paymentMode } };
    const result = await lastValueFrom(new MediaPaymentModeInterceptor().intercept(context, { handle: () => of(value) }));
    expect(result).toEqual({ quoteId: 'quote-1', funding });
    expect(setHeader).toHaveBeenCalledWith('X-SEP-Payment-Mode', paymentMode);
    expect(value.funding.paymentMode).toBe(paymentMode);
  });
  it('keeps original receipt metadata intact while omitting the new JSON field', async () => {
    const setHeader = jest.fn();
    const context = { switchToHttp: () => ({ getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
    const value = { receiptId: 'receipt-1', status: 'RUNNING', paymentMode: 'PERSONAL_ONLY' };
    const result = await lastValueFrom(new MediaPaymentModeInterceptor().intercept(context, { handle: () => of(value) }));
    expect(result).toEqual({ receiptId: 'receipt-1', status: 'RUNNING' });
    expect(value.paymentMode).toBe('PERSONAL_ONLY');
  });
});
