export interface Config {
  databaseUrl: string;
  ownerUrl: string;
  jwtSecret: string;
  port: number;
  paymentProvider: 'mock';
  allocationProvider: 'mock';
  publicBaseUrl: string;
  logger: boolean;
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
    paymentProvider: 'mock',
    allocationProvider: 'mock',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    logger: env.LOG !== '0',
  };
}
