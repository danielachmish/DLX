// מה מחובר בשרת (מסוף אשראי, רשות המסים) — נטען פעם אחת. הממשק מסתיר אפשרויות שלא קיימות
import { useEffect, useState } from 'react';
import { api } from './api';

export interface SystemInfo { paymentIntegrated: boolean; paymentProvider: string; allocationConnected: boolean; softwareRegistered: boolean; demoProviders: boolean }
let cache: Promise<SystemInfo> | null = null;
export const loadSystemInfo = () => (cache ??= api.get<SystemInfo>('/system/info').catch((e) => { cache = null; throw e; }));

export function useSystemInfo(): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => { loadSystemInfo().then(setInfo, () => {}); }, []);
  return info;
}
