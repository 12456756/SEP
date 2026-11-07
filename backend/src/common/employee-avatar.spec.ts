import { employeeAssetBaseUrl, withEmployeeAvatar } from './employee-avatar';
import registry from './employee-avatar-assets.json';

describe('employee avatars', () => {
  const originalEnv = process.env;
  const path = '/assets/employees/silicon/frontend-engineer.webp';
  beforeEach(() => {
    process.env = { ...originalEnv, ASSET_BASE_URL: 'https://images.example.com' };
  });
  afterEach(() => { process.env = originalEnv; });

  it('returns the same registered identity across employee names and subscription aliases', () => {
    const first = withEmployeeAvatar({ id: 'employee-1', name: 'Original', avatar: path });
    const renamed = withEmployeeAvatar({ id: 'employee-1', name: 'Renamed', avatar: path });
    expect(first.avatarAsset).toEqual(renamed.avatarAsset);
    expect(first.avatarAsset).toEqual({
      id: 'silicon:frontend-engineer',
      version: registry[path].version,
      portraitUrl: `https://images.example.com${path}?v=${registry[path].version}`,
      faceUrl: `https://images.example.com/assets/employees/silicon/frontend-engineer-face.webp?v=${registry[path].version}`,
    });
    expect(first.avatar).toBe(first.avatarAsset.portraitUrl);
    expect(withEmployeeAvatar(first)).toEqual(first);
  });

  it('publishes future style face and version consistently across consumers', () => {
    const employee = { id: 'e1', avatar: '/assets/new/person.webp', avatarStyle: 'follow-default',
      avatarBindings: { professional: { portraitUrl: '/assets/new/person.webp', faceUrl: '/assets/new/person-face.webp', version: 'v2' } } };
    const resolved = withEmployeeAvatar(employee);
    const asset = resolved.avatarAsset;
    expect(withEmployeeAvatar(resolved)).toEqual(resolved);
    expect(asset).toEqual({ id: 'employee:e1:professional', version: 'v2',
      portraitUrl: 'https://images.example.com/assets/new/person.webp?v=v2',
      faceUrl: 'https://images.example.com/assets/new/person-face.webp?v=v2' });
    expect(withEmployeeAvatar({ ...employee, name: 'Subscription alias' }).avatarAsset).toEqual(asset);
  });

  it('does not apply inactive bindings to a custom avatar', () => {
    const employee = { id: 'e1', avatar: 'https://external.example.com/custom.webp', avatarStyle: 'custom',
      avatarBindings: { professional: { portraitUrl: '/assets/new/person.webp', faceUrl: '/assets/new/face.webp', version: 'v2' } } };
    expect(withEmployeeAvatar(employee).avatarAsset.faceUrl).toBe(employee.avatar);
  });

  it('does not mutate the database object', () => {
    const employee = Object.freeze({ id: 'e1', avatar: path });
    withEmployeeAvatar(employee);
    expect(employee.avatar).toBe(path);
  });

  it.each([
    'https://external.example.com/custom.webp?sig=keep%2Bme',
    `https://external.example.com${path}`,
  ])('preserves external URLs without inventing variants: %s', (avatar) => {
    const result = withEmployeeAvatar({ id: 'e1', avatar });
    expect(result.avatar).toBe(avatar);
    expect(result.avatarAsset).toEqual({ id: 'employee:e1:avatar', version: null, portraitUrl: avatar, faceUrl: avatar });
  });

  it('resolves unregistered relative images without assuming a face variant', () => {
    const result = withEmployeeAvatar({ id: 'e1', avatar: '/assets/custom/new.webp' });
    expect(result.avatarAsset.faceUrl).toBe('https://images.example.com/assets/custom/new.webp');
    expect(result.avatarAsset.version).toBeNull();
  });

  it.each([null, '', 'javascript:alert(1)', 'data:image/png;base64,abc', '//untrusted.example.com/image.webp'])('handles absent or unsafe avatars: %s', (avatar) => {
    expect(withEmployeeAvatar({ id: 'e1', avatar })).toEqual({ id: 'e1', avatar: null, avatarAsset: null });
  });

  it('requires a public asset origin in production and never uses the API/CORS origin', () => {
    expect(employeeAssetBaseUrl({ NODE_ENV: 'development' })).toBe('http://localhost:3000');
    expect(employeeAssetBaseUrl({ NODE_ENV: 'production', FRONTEND_URL: 'https://web.example.com/' })).toBe('https://web.example.com');
    expect(() => employeeAssetBaseUrl({ NODE_ENV: 'production', CORS_ORIGIN: 'https://web.example.com' })).toThrow('ASSET_BASE_URL');
  });

  it('keeps local avatars local when payment callbacks use a production frontend URL', () => {
    process.env = { NODE_ENV: 'development', FRONTEND_URL: 'https://sep.longdaoec.com' };
    const result = withEmployeeAvatar({ id: 'e1', avatar: path });
    expect(new URL(result.avatarAsset.faceUrl).origin).toBe('http://localhost:3000');
    expect(new URL(result.avatarAsset.portraitUrl).origin).toBe('http://localhost:3000');
    expect(employeeAssetBaseUrl({ ...process.env, ASSET_BASE_URL: 'http://192.168.1.8:3000' })).toBe('http://192.168.1.8:3000');
  });

  it.each(['ftp://images.example.com', 'https://images.example.com/path', 'https://u:p@images.example.com', 'https://images.example.com?v=1'])('rejects invalid asset origins: %s', (ASSET_BASE_URL) => {
    expect(() => employeeAssetBaseUrl({ ASSET_BASE_URL })).toThrow('ASSET_BASE_URL');
  });
});
