import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

// ================= API =================
export class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: any; raw?: BodyInit } = {}): Promise<T> {
  const method = opts.method || (opts.body !== undefined || opts.raw ? 'POST' : 'GET');
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'x-requested-with': 'wasitak', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  let data: any = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data.error || 'حدث خطأ غير متوقع');
  return data;
}

export function useFetch<T = any>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return; let live = true; setLoading(true); setError('');
    api<T>(path).then(d => { if (live) { setData(d); setLoading(false); } }).catch(e => { if (live) { setError(e.message); setLoading(false); } });
    return () => { live = false; };
  }, [path, tick, ...deps]);
  return { data, error, loading, reload: () => setTick(t => t + 1) };
}

// ================= الموجّه =================
const RouteCtx = createContext<{ path: string; search: URLSearchParams; go: (to: string, replace?: boolean) => void }>({ path: '/', search: new URLSearchParams(), go: () => {} });
export const useRoute = () => useContext(RouteCtx);
export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [loc, setLoc] = useState(() => location.pathname + location.search);
  useEffect(() => { const f = () => setLoc(location.pathname + location.search); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const go = useCallback((to: string, replace = false) => { (replace ? history.replaceState : history.pushState).call(history, null, '', to); setLoc(to); window.scrollTo(0, 0); }, []);
  const [p, s] = loc.split('?');
  const v = useMemo(() => ({ path: p, search: new URLSearchParams(s || ''), go }), [loc, go]);
  return <RouteCtx.Provider value={v}>{children}</RouteCtx.Provider>;
}
export function Link({ href, children, className, onClick, ...rest }: any) {
  const { go } = useRoute();
  return <a href={href} className={className} {...rest} onClick={(e: any) => { if (e.metaKey || e.ctrlKey || e.button) return; e.preventDefault(); onClick?.(); go(href); }}>{children}</a>;
}
export function match(pattern: string, path: string): Record<string, string> | null {
  const keys: string[] = []; const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  const m = path.match(re); if (!m) return null; const o: Record<string, string> = {}; keys.forEach((k, i) => (o[k] = decodeURIComponent(m[i + 1]))); return o;
}

// ================= المستخدم الحالي =================
export interface Me { user: null | { id: string; role: string; full_name: string; phone: string; is_demo: boolean; is_staff: boolean; permissions: string[] }; merchant?: any }
const MeCtx = createContext<{ me: Me | null; refresh: () => Promise<void> }>({ me: null, refresh: async () => {} });
export const useMe = () => useContext(MeCtx);
export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => { try { setMe(await api<Me>('/auth/me')); } catch { setMe({ user: null }); } }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return <MeCtx.Provider value={{ me, refresh }}>{children}</MeCtx.Provider>;
}
export const homeFor = (u: NonNullable<Me['user']>) => u.is_staff ? '/admin' : u.role === 'merchant' ? '/merchant' : u.role === 'delivery_agent' ? '/agent' : '/';

// ================= التنبيهات =================
const ToastCtx = createContext<(m: string, kind?: 'ok' | 'bad') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<{ id: number; m: string; kind: string }[]>([]);
  const push = useCallback((m: string, kind: 'ok' | 'bad' = 'ok') => { const id = Date.now() + Math.random(); setItems(x => [...x, { id, m, kind }]); setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3800); }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{items.map(i => <div key={i.id} className={'toast ' + i.kind}>{i.m}</div>)}</div></ToastCtx.Provider>;
}
export function useAction() {
  const toast = useToast(); const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true); try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e: any) { toast(e.message || 'تعذر تنفيذ العملية', 'bad'); } finally { setBusy(false); }
  }, [toast]);
  return { run, busy };
}

// ================= تنسيقات =================
const SYM: Record<string, string> = { YER: 'ر.ي', SAR: 'ر.س', USD: '$' };
export const money = (v: any, cur = 'YER') => v === null || v === undefined || v === '' ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${SYM[cur] || cur}`;
export const dt = (s: string) => s ? new Date(s).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const ORDER_STATUS: Record<string, [string, string]> = {
  new: ['جديد', 'info'], pending_confirmation: ['بانتظار التأكيد', 'warn'], confirmed: ['مؤكد', 'info'], preparing: ['قيد التجهيز', 'warn'], ready_for_delivery: ['جاهز للتوصيل', 'info'],
  out_for_delivery: ['خرج للتوصيل', 'warn'], delivered: ['تم التسليم', 'ok'], cancelled: ['ملغي', 'bad'], return_requested: ['طلب إرجاع', 'warn'], return_processing: ['قيد معالجة الإرجاع', 'warn'], return_completed: ['مكتمل الإرجاع', 'info'], refunded: ['مسترد المبلغ', 'bad'],
};
export const PRODUCT_STATUS: Record<string, [string, string]> = { draft: ['مسودة', ''], pending_review: ['بانتظار المراجعة', 'warn'], approved: ['منشور', 'ok'], rejected: ['مرفوض', 'bad'], archived: ['مؤرشف', ''] };
export const MERCHANT_STATUS: Record<string, [string, string]> = { pending: ['بانتظار الموافقة', 'warn'], approved: ['مقبول', 'ok'], rejected: ['مرفوض', 'bad'], suspended: ['موقوف', 'bad'] };
export const Status = ({ map, v }: { map: Record<string, [string, string]>; v: string }) => <span className={'badge ' + (map[v]?.[1] || '')}>{map[v]?.[0] || v}</span>;

// ================= مكونات =================
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useRef('f' + Math.random().toString(36).slice(2)).current;
  return <div className="field"><label htmlFor={id}>{label}</label>{React.isValidElement(children) ? React.cloneElement(children as any, { id }) : children}{hint && <span className="hint">{hint}</span>}</div>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input className="input" {...p} />;
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [onClose]);
  return <div className="modal-bg" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-label={title}>
    <div className="row between" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="إغلاق">✕</button></div>{children}</div></div>;
}
export const Loading = () => <div className="stack">{[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 56 }} />)}</div>;
export const ErrorBox = ({ msg }: { msg: string }) => <div className="alert bad">{msg}</div>;
export function Async<T>({ r, children }: { r: { data: T | null; error: string; loading: boolean }; children: (d: T) => React.ReactNode }) {
  if (r.loading && !r.data) return <Loading />; if (r.error) return <ErrorBox msg={r.error} />; return r.data ? <>{children(r.data)}</> : null;
}
export const Stat = ({ v, l }: { v: React.ReactNode; l: string }) => <div className="card stat"><span className="v num">{v}</span><span className="l">{l}</span></div>;
export function Img({ src, alt }: { src?: string | null; alt: string }) { return src ? <img src={src} alt={alt} loading="lazy" /> : <span aria-hidden>🛍️</span>; }
export const Stars = ({ v }: { v: any }) => v ? <span className="stars" aria-label={`التقييم ${v} من 5`}>{'★'.repeat(Math.round(Number(v)))}{'☆'.repeat(5 - Math.round(Number(v)))} <span className="muted">{v}</span></span> : null;

async function shrink(file: File): Promise<Blob> {
  if (file.size < 1_500_000) return file;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('img')); i.src = url; });
    URL.revokeObjectURL(url);
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const b = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.85));
    return b && b.size < file.size ? b : file;
  } catch { return file; }
}
export async function uploadImage(file: File): Promise<string> {
  if (file.size > 25 * 1024 * 1024) throw new Error('الصورة كبيرة جداً');
  const body = await shrink(file);
  if (body.size > 4_000_000) throw new Error('الصورة كبيرة، اختر صورة أصغر');
  const r = await api<{ url: string }>('/merchant/uploads', { raw: body, method: 'POST' });
  return r.url;
  }
// ================= السلة (localStorage مع تحقق كامل من الخادم عند الطلب) =================
export interface CartLine { variant_id: string; product_id: string; name: string; options: string; price: number; currency: string; image?: string | null; qty: number; max: number }
const CartCtx = createContext<{ lines: CartLine[]; add: (l: CartLine) => void; setQty: (id: string, q: number) => void; remove: (id: string) => void; clear: () => void; count: number; total: number }>(null as any);
export const useCart = () => useContext(CartCtx);
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => { try { return JSON.parse(localStorage.getItem('ws_cart') || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem('ws_cart', JSON.stringify(lines)); } catch {} }, [lines]);
  const v = useMemo(() => ({
    lines, count: lines.reduce((a, l) => a + l.qty, 0), total: lines.reduce((a, l) => a + l.qty * l.price, 0),
    add: (l: CartLine) => setLines(x => { const e = x.find(i => i.variant_id === l.variant_id); return e ? x.map(i => i === e ? { ...i, qty: Math.min(i.max || 99, i.qty + l.qty), price: l.price } : i) : [...x, l]; }),
    setQty: (id: string, q: number) => setLines(x => x.map(i => i.variant_id === id ? { ...i, qty: Math.max(1, Math.min(i.max || 99, q)) } : i)),
    remove: (id: string) => setLines(x => x.filter(i => i.variant_id !== id)), clear: () => setLines([]),
  }), [lines]);
  return <CartCtx.Provider value={v}>{children}</CartCtx.Provider>;
}
