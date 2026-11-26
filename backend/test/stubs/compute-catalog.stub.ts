/** Existing media protocol tests can exercise an already-authorized connection without real account provisioning. */
export function mediaCatalogStub() {
  return {
    configured: jest.fn().mockResolvedValue(true),
    filterProfiles: jest.fn(async (_enterpriseId: string, _kind: string, profiles: any[]) => profiles),
    assertProfiles: jest.fn().mockResolvedValue(undefined),
    executionReady: jest.fn().mockReturnValue(true),
  };
}
