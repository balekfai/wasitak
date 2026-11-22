// نواة الخادم: أخطاء، مصادقة، جلسات، موجّه. كل المعالجات بمعيار Web (Request → Response)
// وهو نفس توقيع Route Handlers في Next.js، فيُربط لاحقاً بمسار catch-all واحد دون إعادة كتابة.
import crypto from 'node:crypto';
import { getDb, type Db, type Tx } from './db.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: any) { super(message); }
}
export const bad = (m: string) => new HttpError(400, m);
export const forbidden = (m = 'غير مصرح لك بهذا الإجراء') => new HttpError(403, m);
export const notFound = (m = 'غير موجود') => new HttpError(404, m);

export interface User { id: string; role: string; full_name: string; phone: string; status: string; is_demo: boolean }
export interface Ctx {
  req: Request; url: URL; params: Record<string, string>; db: Db; user: User | null;
  body: any; ip: string;
  perm(code: string): Promise<boolean>;
  need(code: string): Promise<void>;
  setCookies: string[];
}

export const json = (data: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

// ---------- كلمات المرور (scrypt المدمجة في Node؛ لا اعتماد خارجي) ----------
const SCRYPT = { N: 16384, r: 8, p: 1 };
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => e ? rej(e) : res(k)));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, saltB, hashB] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB, 'base64');
  const h = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw, Buffer.from(saltB, 'base64'), expected.length, { N: +N, r: +r, p: +p }, (e, k) => e ? rej(e) : res(k)));
  return crypto.timingSafeEqual(h, expected);
}

export function normalizePhone(raw: string): string {
  let s = String(raw || '').trim().replace(/[\s\-()]/g, '');
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660));   // أرقام عربية → لاتينية
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const COOKIE = 'ws_session';
const SESSION_DAYS = 14;

export async function createSession(db: Db, userId: string, ip: string, ua: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4::inet, now() + ($5 || ' days')::interval)`,
    [userId, sha256(token), ua.slice(0, 300), /^[0-9a-f:.]+$/i.test(ip) ? ip : null, String(SESSION_DAYS)]);
  return token;
}
export const sessionCookie = (token: string, maxAge = SESSION_DAYS * 86400) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

function readCookie(req: Request, name: string) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}

export async function userFromRequest(db: Db, req: Request): Promise<User | null> {
  const tok = readCookie(req, COOKIE); if (!tok) return null;
  const r = await db.query<User>(`SELECT u.id, r.code AS role, u.full_name, u.phone, u.status, u.is_demo
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`, [sha256(tok)]);
  return r.rows[0] || null;
}
export async function revokeSession(db: Db, req: Request) {
  const tok = readCookie(req, COOKIE); if (tok) await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(tok)]);
}

// ---------- الموجّه ----------
export type Guard = 'none' | 'user' | { roles: string[] } | { perm: string };
type Handler = (c: Ctx) => Promise<any>;
interface Route { method: string; re: RegExp; keys: string[]; guard: Guard; h: Handler; raw?: boolean }
const routes: Route[] = [];

export function route(method: string, pattern: string, guard: Guard, h: Handler, opts: { raw?: boolean } = {}) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, guard, h, raw: opts.raw });
}

// حد محاولات بسيط في الذاكرة (إضافة لقفل الحساب في القاعدة)؛ في Vercel يُستبدل بتخزين مشترك
const hits = new Map<string, { n: number; t: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now(); const h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); return; }
  if (++h.n > max) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
}

const PG_USER_ERRORS = new Set(['P0001', '23514', '42501', '23505', '23503']);

export async function dispatch(req: Request, pathOverride?: string): Promise<Response> {
  const url = new URL(req.url);
  const path = pathOverride ?? (url.pathname.replace(/^\/api/, '') || '/');
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(path));
    if (!r) throw notFound('المسار غير موجود');
    const m = path.match(r.re)!; const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'wasitak') throw forbidden('طلب غير موثوق');
    const db = await getDb();
    const user = await userFromRequest(db, req);
    if (r.guard !== 'none' && !user) throw new HttpError(401, 'يجب تسجيل الدخول');
    if (typeof r.guard === 'object' && 'roles' in r.guard && !r.guard.roles.includes(user!.role)) throw forbidden();

    const permCache = new Map<string, boolean>();
    const ctx: Ctx = {
      req, url, params, db, user, body: null, setCookies: [],
      ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local',
      async perm(code) {
        if (!user) return false;
        if (!permCache.has(code)) permCache.set(code, (await db.query('SELECT user_has_permission($1,$2) AS ok', [user.id, code])).rows[0].ok);
        return permCache.get(code)!;
      },
      async need(code) { if (!(await ctx.perm(code))) throw forbidden(); },
    };
    if (typeof r.guard === 'object' && 'perm' in r.guard) await ctx.need(r.guard.perm);
    if (!r.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const txt = await req.text();
      if (txt.length > 200_000) throw new HttpError(413, 'الطلب كبير');
      try { ctx.body = txt ? JSON.parse(txt) : {}; } catch { throw bad('جسم الطلب ليس JSON صحيحاً'); }
    }
    const out = await r.h(ctx);
    if (out instanceof Response) return out;
    const headers: Record<string, string> = {};
    const res = json(out ?? { ok: true }, 200, headers);
    for (const c of ctx.setCookies) res.headers.append('set-cookie', c);
    return res;
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    if (e?.name === 'ZodError') return json({ error: 'بيانات غير صحيحة: ' + e.issues.map((i: any) => `${i.path.join('.')} ${i.message}`).join('، ') }, 400);
    if (e?.code === '22P02') return json({ error: 'معرّف غير صحيح' }, 404);
    if (e?.code && PG_USER_ERRORS.has(e.code)) {
      const status = e.code === '42501' ? 403 : e.code === 'P0001' || e.code === '23514' || e.code === '23505' ? 409 : 400;
      return json({ error: e.code === '23505' ? 'السجل موجود مسبقاً' : e.code === '23503' ? 'مرجع غير صحيح' : e.message }, status);
    }
    console.error('[api]', req.method, path, e);
    return json({ error: 'خطأ داخلي في الخادم' }, 500);
  }
}

export type { Db, Tx };
