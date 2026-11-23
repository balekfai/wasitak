import React, { useEffect, useRef, useState } from 'react';
import { api, useFetch, Link, useAction, Async, Field, Input, dt, money } from './common';

// ===== بانر الإعلانات في أعلى الصفحة الرئيسية =====
export function AdBanner() {
  const r = useFetch<any>('/public/ads');
  const ads: any[] = r.data?.ads || [];
  const n = ads.length;
  const [i, setI] = useState(0);
  const [hold, setHold] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (n < 2 || hold) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI(x => (x + 1) % n), 5000);
    return () => clearInterval(t);
  }, [n, hold]);
  const cur = n ? ads[i % n] : null;
  useEffect(() => {
    if (cur && !seen.current.has(cur.id)) {
      seen.current.add(cur.id);
      api('/public/ads/' + cur.id + '/event', { body: { event: 'impression' } }).catch(() => {});
    }
  }, [cur?.id]);
  if (!n) return null;
  const k0 = i % n;
  return <section className="adbanner" aria-roledescription="carousel" aria-label="إعلانات"
    onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} onTouchStart={() => setHold(true)} onTouchEnd={() => setHold(false)}>
    {ads.map((a, k) => <Link key={a.id} href={'/shop?merchant=' + a.merchant_id} className={'adslide' + (k === k0 ? ' on' : '')}
      aria-hidden={k !== k0} tabIndex={k === k0 ? 0 : -1}
      onClick={() => { api('/public/ads/' + a.id + '/event', { body: { event: 'click' } }).catch(() => {}); }}>
      <img src={a.image_url} alt={a.text_ar || a.shop_name} />
      {(a.text_ar || a.shop_name) && <span className="adcap">{a.text_ar || a.shop_name}</span>}
    </Link>)}
    <span className="adtag">إعلان</span>
    {n > 1 && <div className="addots">{ads.map((a, k) => <button key={a.id} type="button" aria-label={'الإعلان ' + (k + 1)} className={k === k0 ? 'on' : ''} onClick={() => setI(k)} />)}</div>}
  </section>;
}

// ===== صفحة الإعلانات في لوحة الإدارة =====
const EMPTY = { merchant_id: '', text_ar: '', days: '7', starts_at: '', amount_due: '0', payment_status: 'unpaid', image_url: '' };
const PAY: Record<string, string> = { unpaid: 'غير مدفوع', paid: 'مدفوع', waived: 'مجاني' };

export function AdminAds() {
  const r = useFetch<any>('/admin/ads');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(EMPTY);
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const pick = async (file?: File) => {
    if (!file) return;
    if (file.size > 4_000_000) { alert('الصورة كبيرة، اختر صورة أقل من 4 ميغابايت'); return; }
    const u = await run(() => api<{ url: string }>('/admin/ads/upload', { raw: file, method: 'POST' }));
    if (u) setF((x: any) => ({ ...x, image_url: u.url }));
  };
  const create = async () => {
    if (!f.merchant_id) return alert('اختر التاجر');
    if (!f.image_url) return alert('ارفع صورة الإعلان');
    const ok = await run(() => api('/admin/ads', { body: {
      merchant_id: f.merchant_id, image_url: f.image_url, text_ar: f.text_ar || undefined, days: Number(f.days),
      starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : undefined, amount_due: Number(f.amount_due) || 0, payment_status: f.payment_status,
    } }), 'تم إنشاء الإعلان وتفعيله');
    if (ok) { setF(EMPTY); r.reload(); }
  };
  const patch = async (id: string, body: any, msg: string) => { const ok = await run(() => api('/admin/ads/' + id, { method: 'PATCH', body }), msg); if (ok) r.reload(); };
  return <>
    <h1>الإعلانات</h1>
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0 }}>إعلان جديد (بانر الصفحة الرئيسية)</h2>
      <div className="g2">
        <Field label="التاجر"><select className="input" value={f.merchant_id} onChange={set('merchant_id')}><option value="">اختر التاجر…</option>{(r.data?.merchants || []).map((m: any) => <option key={m.id} value={m.id}>{m.shop_name}</option>)}</select></Field>
        <Field label="عدد الأيام"><Input type="number" min={1} max={365} value={f.days} onChange={set('days')} /></Field>
        <Field label="تاريخ البدء" hint="اتركه فارغاً ليبدأ الآن"><Input type="date" value={f.starts_at} onChange={set('starts_at')} /></Field>
        <Field label="المبلغ المتفق عليه"><Input type="number" min={0} value={f.amount_due} onChange={set('amount_due')} /></Field>
        <Field label="حالة الدفع"><select className="input" value={f.payment_status} onChange={set('payment_status')}>{Object.entries(PAY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="نص قصير على الإعلان (اختياري)"><Input maxLength={120} value={f.text_ar} onChange={set('text_ar')} /></Field>
      </div>
      <Field label="صورة الإعلان" hint="يفضّل صورة عريضة بنسبة 3:1 مثل 1200×400 وأقل من 4 ميغابايت">
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      </Field>
      {f.image_url && <img src={f.image_url} alt="معاينة الإعلان" style={{ width: '100%', maxWidth: 480, borderRadius: 12, margin: '8px 0' }} />}
      <button className="btn" disabled={busy} onClick={create}>إنشاء وتفعيل الإعلان</button>
    </div>
    <Async r={r}>{d => d.ads.length ? <div className="tablewrap"><table className="t"><thead><tr><th>الإعلان</th><th>الفترة</th><th>الحالة</th><th>الدفع</th><th>الظهور / النقرات</th><th></th></tr></thead><tbody>
      {d.ads.map((a: any) => <tr key={a.id}>
        <td><div className="row"><img src={a.image_url} alt="" style={{ width: 96, borderRadius: 8 }} /><div><b>{a.shop_name}</b><div className="muted small">{a.text_ar}</div></div></div></td>
        <td className="small">{dt(a.starts_at)}<br />{dt(a.ends_at)}</td>
        <td>{a.ended ? <span className="badge bad">منتهي</span> : a.status === 'active' ? <span className="badge ok">فعّال</span> : <span className="badge warn">موقوف</span>}</td>
        <td>{PAY[a.payment_status] || a.payment_status}<div className="muted small num">{money(a.amount_due, a.currency)}</div></td>
        <td className="num">{a.impressions} / {a.clicks}</td>
        <td><div className="row">
          {a.status === 'active' ? <button className="btn sm ghost" disabled={busy} onClick={() => patch(a.id, { status: 'paused' }, 'تم إيقاف الإعلان')}>إيقاف</button> : <button className="btn sm" disabled={busy} onClick={() => patch(a.id, { status: 'active' }, 'تم تفعيل الإعلان')}>تفعيل</button>}
          {a.payment_status === 'unpaid' && <button className="btn sm ghost" disabled={busy} onClick={() => patch(a.id, { payment_status: 'paid' }, 'تم تسجيل الدفع')}>تم الدفع</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => patch(a.id, { extend_days: 7 }, 'تم التمديد 7 أيام')}>+7 أيام</button>
        </div></td>
      </tr>)}
    </tbody></table></div> : <div className="card empty">لا توجد إعلانات بعد.</div>}</Async>
  </>;
}
