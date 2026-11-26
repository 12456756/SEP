/** An explicit enterprise provider for tests that exercise downstream model behavior. */
export function enterpriseConnectionStub(baseURL = 'https://relay.test/v1', apiKey = 'test-key') {
  return {
    isEnterpriseMode: async () => true,
    assertEnterpriseModeSupported: async () => undefined,
    chatProvider: async () => ({ baseURL, apiKey }),
  };
}
