// واجهة قاعدة بيانات موحدة. الإنتاج: حزمة `pg` (Neon). التطوير المحلي بلا إنترنت: مشغّل pgwire.
import { Conn, type QueryResult, type Row } from './pgwire';

export interface Tx { query<T = Row>(sql: string, params?: any[]): Promise<QueryResult<T>> }
export interface Db extends Tx {
  /** ينفذ داخل معاملة ويضبط app.user_id لسجل التدقيق وحركات المخزون */
  tx<T>(fn: (t: Tx) => Promise<T>, opts?: { userId?: string | null }): Promise<T>;
  close(): Promise<void>;
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/wasitak_test';
  let pg: any = null;
  if (!process.env.WASITAK_LOCAL_DRIVER) { try { pg = await import(/* @vite-ignore */ 'pg' as string); } catch { pg = null; } }
  singleton = pg ? makePgDb(pg, url) : makeLocalDb(url);
  return singleton;
}

export function resetDbForTests() { singleton = null; }

function withUser(userId: string | null | undefined) {
  return userId ? ['select set_config(\'app.user_id\', $1, true)', [userId]] as const : null;
}

function makePgDb(pg: any, url: string): Db {
  const Pool = pg.Pool || pg.default?.Pool;
  const pool = new Pool({ connectionString: url, max: 5, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  return {
    query: (sql, params) => pool.query(sql, params),
    close: () => pool.end(),
    async tx(fn, opts) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const u = withUser(opts?.userId); if (u) await c.query(u[0], u[1] as any);
        const r = await fn({ query: (s, p) => c.query(s, p) });
        await c.query('COMMIT'); return r;
      } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
      finally { c.release(); }
    },
  };
}

function makeLocalDb(url: string): Db {
  const u = new URL(url);
  const idle: Conn[] = [];
  const get = async () => idle.pop() || Conn.connect(u.hostname, Number(u.port || 5432), decodeURIComponent(u.username || 'postgres'), u.pathname.slice(1));
  return {
    async close() { while (idle.length) idle.pop()!.close(); },
    async query(sql, params) { const c = await get(); try { return await c.query(sql, params); } finally { idle.push(c); } },
    async tx(fn, opts) {
      const c = await get(); let broken = false;
      try {
        await c.query('BEGIN');
        const us = withUser(opts?.userId); if (us) await c.query(us[0], us[1] as any);
        const r = await fn({ query: (s, p) => c.query(s, p) });
        await c.query('COMMIT'); return r;
      } catch (e) { try { await c.query('ROLLBACK'); } catch { broken = true; } throw e; }
      finally { if (!broken) idle.push(c); else c.close(); }
    },
  };
}
