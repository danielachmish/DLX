export interface Config {
  databaseUrl: string;
  ownerUrl: string;
  jwtSecret: string;
  port: number;
  paymentProvider: 'mock' | 'none';
  allocationProvider: 'mock' | 'none';
  publicBaseUrl: string;
  logger: boolean;
  softwareRegistration: string | null; // מספר רישום התוכנה ברשות המסים — בלעדיו אין מצב live
  corsOrigins: string[] | true;
  errorWebhookUrl: string | null;
}

function provider(v: string | undefined, prod: boolean): 'mock' | 'none' {
  const k = v ?? (prod ? 'none' : 'mock');
  if (k !== 'mock' && k !== 'none') throw new Error(`ספק לא מוכר: ${k}`);
  if (k === 'mock' && prod) throw new Error('אסור להריץ ספק דמה (mock) בייצור');
  return k;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? (prod ? '' : 'dev-only-secret-change-me');
  if (prod && jwtSecret.length < 32) throw new Error('JWT_SECRET חייב להיות לפחות 32 תווים בייצור');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://dlx_app:dlx_app_dev@localhost:5432/dlx',
    ownerUrl: env.DATABASE_OWNER_URL ?? 'postgres://dlx_owner:dlx_owner_dev@localhost:5432/dlx',
    jwtSecret,
    port: Number(env.PORT ?? 8787),
    // ספק דמה מותר רק מחוץ לייצור (ר' NoPaymentProvider)
    paymentProvider: provider(env.PAYMENT_PROVIDER, prod),
    allocationProvider: provider(env.ALLOCATION_PROVIDER, prod),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    logger: env.LOG !== '0',
    softwareRegistration: env.DLX_SOFTWARE_REGISTRATION?.trim() || null,
    corsOrigins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : prod ? [env.PUBLIC_BASE_URL ?? ''] : true,
    errorWebhookUrl: env.ERROR_WEBHOOK_URL || null,
  };
}
