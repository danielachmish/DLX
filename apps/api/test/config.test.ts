import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { NoAllocationProvider, NoPaymentProvider } from '../src/services/providers.js';

describe('production safety', () => {
  const prod = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://shop.example' };
  it('refuses demo providers in production and defaults to none', () => {
    expect(() => loadConfig({ ...prod, PAYMENT_PROVIDER: 'mock' })).toThrow(/mock/);
    const c = loadConfig(prod);
    expect(c.paymentProvider).toBe('none');
    expect(c.allocationProvider).toBe('none');
    expect(c.corsOrigins).toEqual(['https://shop.example']);
  });
  it('requires a strong JWT secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
  it('the no-provider never approves a charge or an allocation', async () => {
    expect((await new NoPaymentProvider().charge()).status).toBe('failed');
    expect((await new NoAllocationProvider().request()).status).toBe('failed');
  });
});
