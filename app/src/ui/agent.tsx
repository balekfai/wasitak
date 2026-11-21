import React, { useEffect, useRef, useState } from 'react';
import { api, useFetch, useMe, useAction, Async, Status, ORDER_STATUS, money, dt, Link } from './common';
import { DashShell } from './shell';

// مشاركة الموقع: بعد موافقة المندوب فقط، وأثناء طلب «خرج للتوصيل» فقط، ويتوقف تلقائياً عند التسليم
function useLocationShare(orderId: string | null, active: boolean) {
  const [state, setState] = useState<'off' | 'asking' | 'on' | 'denied' | 'unsupported'>('off'); const last = useRef(0);
  useEffect(() => {
    if (!active || !orderId) { setState('off'); return; }
    if (!('geolocation' in navigator)) { setState('unsupported'); return; }
    setState('asking');
    const id = navigator.geolocation.watchPosition(p => {
      setState('on'); if (Date.now() - last.current < 8000) return; last.current = Date.now();
      api(`/agent/orders/${orderId}/location`, { body: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy } }).catch(() => {});
    }, e => setState(e.code === 1 ? 'denied' : 'off'), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [orderId, active]);
  return state;
}

export function AgentApp() {
  const { me } = useMe(); const r = useFetch<any>('/agent/orders'); const { run, busy } = useAction();
  const active = r.data?.orders.find((o: any) => o.status === 'out_for_delivery');
  const loc = useLocationShare(active?.id || null, !!active);
  useEffect(() => { const h = setInterval(r.reload, 30000); return () => clearInterval(h); }, []);
  if (me?.user?.role !== 'delivery_agent') return <div className="auth alert warn">هذه الواجهة لمندوبي التوصيل فقط. <Link href="/login">تسجيل الدخول</Link></div>;
  return <DashShell title="واجهة المندوب" nav={[{ href: '/agent', icon: '🛵', label: 'مهامي' }]}><h1>مهام التوصيل</h1>
    {active && <div className={'alert ' + (loc === 'on' ? 'ok' : 'warn')} style={{ marginBottom: 12 }}>{loc === 'on' ? '📍 موقعك يُشارك مع العميل أثناء هذه المهمة فقط، ويتوقف تلقائياً عند التسليم.' : loc === 'denied' ? '⚠️ رفضتَ إذن الموقع؛ لن يتمكن العميل من تتبعك. فعّله من إعدادات المتصفح.' : loc === 'unsupported' ? 'جهازك لا يدعم الموقع.' : 'يُرجى الموافقة على مشاركة الموقع…'}<div className="small">ملاحظة: على الهاتف أبقِ الصفحة مفتوحة والشاشة مضاءة، فبعض الأجهزة توقف تحديث الموقع في الخلفية.</div></div>}
    <Async r={r}>{d => <div className="stack">
      {d.collected.length > 0 && <div className="card row">{d.collected.map((c: any) => <div key={c.currency} className="stat"><span className="v num">{money(c.total, c.currency)}</span><span className="l">المبالغ التي حصّلتها</span></div>)}</div>}
      {d.orders.length ? d.orders.map((o: any) => <div key={o.id} className="card stack"><div className="row between"><b className="num">{o.order_number}</b><Status map={ORDER_STATUS} v={o.status} /></div>
        <div><b>{o.recipient_name}</b> · <a href={'tel:' + o.recipient_phone} className="num" dir="ltr">{o.recipient_phone}</a></div><div className="muted">{o.governorate} — {o.address_detail}</div>{o.delivery_notes && <div className="small">ملاحظات: {o.delivery_notes}</div>}
        <div className="small">{o.items.map((i: any) => `${i.name} × ${i.qty}`).join('، ')}</div>
        <div className="row between"><span>المبلغ المطلوب تحصيله ({o.payment_method === 'cod' ? 'عند الاستلام' : o.payment_method})</span><b className="price num">{money(o.total, o.currency)}</b></div>
        <div className="row"><a className="btn secondary sm" href={'tel:' + o.recipient_phone}>📞 اتصال</a>
          {o.status === 'ready_for_delivery' && <button className="btn" disabled={busy} onClick={() => run(() => api(`/agent/orders/${o.id}/status`, { body: { to: 'out_for_delivery' } }), 'بدأ التوصيل').then(r.reload)}>▶ بدء التوصيل</button>}
          {o.status === 'out_for_delivery' && <button className="btn accent" disabled={busy} onClick={() => confirm('تأكيد تسليم الطلب وتحصيل المبلغ؟') && run(() => api(`/agent/orders/${o.id}/status`, { body: { to: 'delivered' } }), 'تم تسجيل التسليم').then(r.reload)}>✔ تأكيد التسليم</button>}
          {['confirmed', 'preparing', 'new'].includes(o.status) && <span className="muted small">بانتظار تجهيز الطلب</span>}</div>
        {o.delivered_at && <div className="small muted">سُلّم: {dt(o.delivered_at)}</div>}</div>) : <div className="card empty">لا مهام مسندة إليك حالياً.</div>}</div>}</Async></DashShell>;
}
