// مشغّل PostgreSQL مصغّر (بروتوكول الاستعلام الموسّع، مصادقة trust فقط).
// للتطوير/الاختبار المحلي عند تعذر تثبيت حزمة `pg`. في الإنتاج (Vercel/Neon) تُستخدم حزمة `pg` عبر db.ts.
import net from 'node:net';

export type Row = Record<string, any>;
export interface QueryResult<T = Row> { rows: T[]; rowCount: number }

class PgError extends Error {
  code?: string; detail?: string; constraint?: string;
}

function toParam(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return '{' + v.map(x => x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseArray(s: string): any[] {
  if (s === '{}') return [];
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '\\') cur += s[++i]; else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(x => (x === 'NULL' ? null : x));
}

function convert(oid: number, s: string | null): any {
  if (s === null) return null;
  switch (oid) {
    case 16: return s === 't';
    case 21: case 23: return parseInt(s, 10);
    case 700: case 701: return parseFloat(s);
    case 114: case 3802: return JSON.parse(s);
    case 1009: case 1015: case 2951: case 1007: case 1028: return parseArray(s);
    default: return s;   // numeric/int8/timestamps كنص (مطابق لسلوك pg لـ numeric وint8)
  }
}

export class Conn {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiter: ((m: { t: string; body: Buffer }) => void) | null = null;
  private queue: { t: string; body: Buffer }[] = [];
  private busy = false;

  static async connect(host: string, port: number, user: string, database: string): Promise<Conn> {
    const c = new Conn();
    await new Promise<void>((res, rej) => {
      c.sock = net.connect(port, host, () => res());
      c.sock.once('error', rej);
    });
    c.sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); c.pump(); });
    const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
    const head = Buffer.alloc(8); head.writeInt32BE(8 + params.length, 0); head.writeInt32BE(196608, 4);
    c.sock.write(Buffer.concat([head, params]));
    for (;;) {
      const m = await c.next();
      if (m.t === 'R' && m.body.readInt32BE(0) !== 0) throw new Error('مصادقة غير مدعومة في المشغّل المحلي (استخدم trust)');
      if (m.t === 'E') throw c.parseError(m.body);
      if (m.t === 'Z') break;
    }
    return c;
  }

  private pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const m = { t: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
      this.buf = this.buf.subarray(1 + len);
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(m); } else this.queue.push(m);
    }
  }
  private next(): Promise<{ t: string; body: Buffer }> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise(r => { this.waiter = r; });
  }
  private msg(t: string, body: Buffer) {
    const h = Buffer.alloc(5); h.write(t, 0); h.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([h, body]);
  }
  private cstr(s: string) { return Buffer.from(s + '\0'); }
  private parseError(b: Buffer): PgError {
    const f: Record<string, string> = {}; let i = 0;
    while (i < b.length && b[i] !== 0) { const k = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1); f[k] = b.toString('utf8', i + 1, e); i = e + 1; }
    const err = new PgError(f['M'] || 'pg error'); err.code = f['C']; err.detail = f['D']; err.constraint = f['n'];
    return err;
  }

  async query<T = Row>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    if (this.busy) throw new Error('الاتصال مشغول');
    this.busy = true;
    try {
      const ps = params.map(toParam);
      const parse = this.msg('P', Buffer.concat([this.cstr(''), this.cstr(sql), Buffer.from([0, 0])]));
      const parts: Buffer[] = [Buffer.from([0, 0]), (() => { const b = Buffer.alloc(2); b.writeInt16BE(ps.length); return b; })()];
      for (const p of ps) {
        if (p === null) { const b = Buffer.alloc(4); b.writeInt32BE(-1); parts.push(b); }
        else { const d = Buffer.from(p, 'utf8'); const b = Buffer.alloc(4); b.writeInt32BE(d.length); parts.push(b, d); }
      }
      parts.push(Buffer.from([0, 0]));
      const bind = this.msg('B', Buffer.concat([this.cstr(''), this.cstr(''), ...parts]));
      const describe = this.msg('D', Buffer.concat([Buffer.from('P'), this.cstr('')]));
      const exec = this.msg('E', Buffer.concat([this.cstr(''), Buffer.from([0, 0, 0, 0])]));
      const sync = this.msg('S', Buffer.alloc(0));
      this.sock.write(Buffer.concat([parse, bind, describe, exec, sync]));

      let cols: { name: string; oid: number }[] = []; const rows: Row[] = []; let err: PgError | null = null; let tag = '';
      for (;;) {
        const m = await this.next();
        if (m.t === 'T') {
          const n = m.body.readInt16BE(0); let o = 2; cols = [];
          for (let k = 0; k < n; k++) {
            const e = m.body.indexOf(0, o); const name = m.body.toString('utf8', o, e); o = e + 1;
            const oid = m.body.readInt32BE(o + 6); o += 18; cols.push({ name, oid });
          }
        } else if (m.t === 'D') {
          const n = m.body.readInt16BE(0); let o = 2; const row: Row = {};
          for (let k = 0; k < n; k++) {
            const l = m.body.readInt32BE(o); o += 4;
            let s: string | null = null; if (l >= 0) { s = m.body.toString('utf8', o, o + l); o += l; }
            row[cols[k].name] = convert(cols[k].oid, s);
          }
          rows.push(row);
        } else if (m.t === 'C') tag = m.body.toString('utf8', 0, m.body.length - 1);
        else if (m.t === 'E') err = this.parseError(m.body);
        else if (m.t === 'Z') break;
      }
      if (err) throw err;
      const rc = parseInt(tag.split(' ').pop() || '0', 10);
      return { rows: rows as T[], rowCount: rows.length || (isNaN(rc) ? 0 : rc) };
    } finally { this.busy = false; }
  }

  close() { this.sock.end(); }
}
