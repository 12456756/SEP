import { Decimal } from '@prisma/client/runtime/library';

/** Isolated enterprise credentials and remote fee records, without a public-key route. */
export function enterpriseMediaStub(base: string, key: string, fingerprint: string, grossCny: string) {
  const snapshot = { enterpriseId: 'enterprise', credentialId: 'enterprise-key', baseUrl: base };
  const dispatches = new Map<string, string>();
  let observed: { status?: string } | undefined;
  const connections = {
    assertEnterpriseModeSupported: jest.fn(async () => undefined),
    isEnterpriseMode: jest.fn(async () => true),
    resolve: jest.fn(async () => ({ baseURL: base, apiKey: key })),
  };
  const media = {
    connection: jest.fn(async (enterpriseId: string, _kind: string, pinned?: unknown, sourceRef?: string) => ({
      base, key, fingerprint, compute: { enterpriseId, ...(sourceRef ? { executionId: `execution_${sourceRef}` } : {}) },
      snapshot: { ...snapshot, enterpriseId },
    })),
    begin: jest.fn(async (_enterpriseId: string, _kind: string, receiptId: string) => {
      dispatches.set(receiptId, 'PREPARED'); return { id: `execution_${receiptId}` };
    }),
    markDispatch: jest.fn(async (_enterpriseId: string, _kind: string, receiptId: string) => { dispatches.set(receiptId, 'DISPATCHED'); }),
    closeUnsent: jest.fn(async (_enterpriseId: string, _kind: string, receiptId: string) => {
      if (dispatches.get(receiptId) === 'DISPATCHED') return false;
      dispatches.set(receiptId, 'NOT_SUBMITTED'); return true;
    }),
    fee: jest.fn(async (_enterpriseId: string, _kind: string, receiptId: string): Promise<any> => ({
      id: `execution_${receiptId}`, feeStatus: observed && !['settled', 'not_charged'].includes(observed.status) ? 'PENDING' : 'FINAL',
      grossCny: new Decimal(observed?.status === 'not_charged' ? '0' : grossCny),
    })),
  };
  return { connections, media, feeStatus: () => observed?.status,
    observe: (contract: { billing?: { status?: string } }) => { observed = contract.billing; } };
}

export const signedMediaProtocolStub = {
  validateAddress: (value: string) => new URL(value),
  fetchSigned: (url: string, init: RequestInit, identity: { apiKey?: string }) => {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${identity.apiKey}`);
    return fetch(url, { ...init, redirect: 'error', headers });
  },
};
