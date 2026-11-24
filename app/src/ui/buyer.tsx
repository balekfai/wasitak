import React, { useEffect, useRef, useState } from 'react';
import { api, useFetch, Link, useRoute, useMe, useCart, useAction, useToast, Async, Field, Input, Img, Stars, Status, ORDER_STATUS, money, dt, homeFor, Loading } from './common';
import { AdBanner } from './ads';


// ================= الهيكل =================
export function BuyerLayout({ children }: { children: React.ReactNode }) {
  const { me } = useMe(); const cart = useCart(); const { go, path, search } = useRoute();
  const [q, setQ] = useState(search.get('q') || '');
  const govs = useFetch<any>('/public/governorates');
  const [gov, setGov] = useState(() => { try { return localStorage.getItem('ws_gov') || ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('ws_gov', gov); } catch {} }, [gov]);
  const u = me?.user;
  const nav = [['/', '🏠', 'الرئيسية'], ['/shop', '🗂️', 'الأقسام'], ['/cart', '🛒', 'السلة'], ['/orders', '📦', 'طلباتي'], [u ? '/account' : '/login', '👤', u ? 'حسابي' : 'دخول']];
  return <>
    <header className="topbar"><div className="wrap">
      <Link href="/" className="logo">وسيط<b>ك</b></Link>
      <form className="search" role="search" onSubmit={e => { e.preventDefault(); go('/shop?q=' + encodeURIComponent(q)); }}>
        <input aria-label="بحث" placeholder="ابحث عن منتج أو متجر…" value={q} onChange={e => setQ(e.target.value)} /><button type="submit">بحث</button></form>
      <Link href="/cart" className="iconbtn hide-m" aria-label="السلة">🛒<span className="hide-m">السلة</span>{cart.count > 0 && <span className="cartbadge">{cart.count}</span>}</Link>
      {u ? <Link href={homeFor(u) === '/' ? '/account' : homeFor(u)} className="iconbtn hide-m">👤 {u.full_name.split(' ')[0]}</Link> : <Link href="/login" className="iconbtn hide-m">دخول / تسجيل</Link>}
    </div></header>
    <div className="govbar"><div className="wrap"><span>📍 التوصيل إلى:</span>
      <select aria-label="المحافظة" value={gov} onChange={e => setGov(e.target.value)}><option value="">كل المحافظات</option>{govs.data?.governorates.map((g: any) => <option key={g.id} value={g.id}>{g.name_ar}</option>)}</select>
    </div></div>
    <main className="wrap" style={{ paddingTop: 16 }}>{children}</main>
    <footer className="footer wrap">وسيطك — منصة التجارة والوساطة الرقمية · الدفع عند الاستلام</footer>
    <nav className="bottomnav" aria-label="التنقل">{nav.map(([h, i, l]) =>
      <Link key={h} href={h} className={path === h ? 'on' : ''}><span className="bi">{i}</span>{l}{h === '/cart' && cart.count > 0 && <span className="cartbadge" style={{ left: '28%' }}>{cart.count}</span>}</Link>)}</nav>
  </>;
}

// ================= بطاقة منتج =================
export function ProductCard({ p }: { p: any }) {
  return <Link href={'/product/' + p.id} className="pcard">
    <div className="pimg"><Img src={p.image_url} alt={p.name_ar} /></div>
    <div className="pbody"><span className="pname">{p.name_ar}</span><Stars v={p.avg_rating} />
      <span className="price num">{money(p.price, p.currency)}</span><span className="muted small">{p.shop_name}</span>
      {!p.in_stock && <span className="badge bad">نفدت الكمية</span>}</div></Link>;
}
const CAT_ICONS: Record<string, string> = { pharmacies: '💊', 'men-clothing': '👔', 'women-clothing': '👗', 'kids-clothing': '🧒', electronics: '📱', 'perfumes-cosmetics': '🧴', 'home-kitchen': '🍳', groceries: '🛒', 'shoes-bags': '👜', 'auto-supplies': '🚗' };

// ================= الرئيسية =================
export function Home() {
  const r = useFetch<any>('/public/home');
  return <Async r={r}>{d => <>
    <AdBanner />

    <section className="hero"><h1>كل ما تحتاجه من تجار موثوقين</h1><p style={{ margin: 0 }}>اطلب بسهولة، وادفع عند الاستلام، وتابع طلبك حتى باب بيتك.</p></section>
    <h2>الأقسام</h2>
    <div className="cat-tiles">{d.categories.map((c: any) => <Link key={c.id} href={'/shop?category=' + c.slug} className="cat-tile"><span className="ico">{CAT_ICONS[c.slug] || '🛍️'}</span>{c.name_ar}</Link>)}</div>
    <h2 style={{ marginTop: 24 }}>أحدث المنتجات</h2>
    {d.latest.length ? <div className="pgrid">{d.latest.map((p: any) => <ProductCard key={p.id} p={p} />)}</div>
      : <div className="card empty">لا توجد منتجات منشورة بعد. عند اعتماد التجار لمنتجاتهم ستظهر هنا.</div>}
  </>}</Async>;
}

// ================= المتجر والبحث =================
export function Shop() {
  const { search, go } = useRoute(); const cat = search.get('category') || ''; const q = search.get('q') || ''; const sort = search.get('sort') || 'new'; const page = Number(search.get('page') || 1);
  const cats = useFetch<any>('/public/categories');
  const qs = new URLSearchParams({ ...(cat && { category: cat }), ...(q && { q }), sort, page: String(page) }).toString();
  const r = useFetch<any>('/public/products?' + qs);
  const set = (k: string, v: string) => { const s = new URLSearchParams(search); v ? s.set(k, v) : s.delete(k); if (k !== 'page') s.delete('page'); go('/shop?' + s.toString()); };
  const tops = cats.data?.categories.filter((c: any) => !c.parent_id) || [];
  const active = cats.data?.categories.find((c: any) => c.slug === cat);
  const children = active ? cats.data!.categories.filter((c: any) => c.parent_id === (active.parent_id ? active.parent_id : active.id)) : [];
  return <>
    <div className="chips" role="tablist" aria-label="الأقسام"><button className={'chip' + (!cat ? ' on' : '')} onClick={() => set('category', '')}>الكل</button>
      {tops.map((c: any) => <button key={c.id} className={'chip' + (cat === c.slug || active?.parent_id === c.id ? ' on' : '')} onClick={() => set('category', c.slug)}>{c.name_ar}</button>)}</div>
    {children.length > 0 && <div className="chips">{children.map((c: any) => <button key={c.id} className={'chip' + (cat === c.slug ? ' on' : '')} onClick={() => set('category', c.slug)}>{c.name_ar}</button>)}</div>}
    <div className="row between" style={{ margin: '8px 0 12px' }}><span className="muted">{q ? `نتائج «${q}» — ` : ''}{r.data ? `${r.data.total} منتج` : ''}</span>
      <select className="input" style={{ width: 'auto' }} aria-label="الترتيب" value={sort} onChange={e => set('sort', e.target.value)}>
        <option value="new">الأحدث</option><option value="price_asc">الأرخص</option><option value="price_desc">الأغلى</option><option value="rating">الأعلى تقييماً</option></select></div>
    <Async r={r}>{d => d.products.length ? <>
      <div className="pgrid">{d.products.map((p: any) => <ProductCard key={p.id} p={p} />)}</div>
      {d.pages > 1 && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>{Array.from({ length: d.pages }, (_, i) => <button key={i} className={'chip' + (page === i + 1 ? ' on' : '')} onClick={() => set('page', String(i + 1))}>{i + 1}</button>)}</div>}
    </> : <div className="card empty">لا توجد نتائج مطابقة.</div>}</Async>
  </>;
}

// ================= صفحة المنتج =================
export function ProductPage({ id }: { id: string }) {
  const r = useFetch<any>('/public/products/' + id); const cart = useCart(); const toast = useToast(); const { go } = useRoute();
  const [vid, setVid] = useState(''); const [qty, setQty] = useState(1); const [img, setImg] = useState(0);
  useEffect(() => { if (r.data) { const v = r.data.product.variants.find((x: any) => x.stock > 0) || r.data.product.variants[0]; setVid(v?.id || ''); setImg(0); setQty(1); } }, [r.data]);
  return <Async r={r}>{d => {
    const p = d.product; const v = p.variants.find((x: any) => x.id === vid); const stock = v?.stock ?? 0;
    const addLine = () => ({ variant_id: v.id, product_id: p.id, name: p.name_ar, options: Object.values(v.options || {}).join(' / '), price: Number(v.price), currency: p.currency, image: p.images[0], qty, max: stock });
    return <>
      <div className="small muted" style={{ marginBottom: 8 }}><Link href="/shop">الأقسام</Link> › {p.category && <Link href={'/shop?category=' + p.category.id}>{p.category.name_ar}</Link>}</div>
      <div className="two">
        <div className="gallery"><div className="main"><Img src={p.images[img]} alt={p.name_ar} /></div>
          {p.images.length > 1 && <div className="thumbs">{p.images.map((u: string, i: number) => <button key={u} className={i === img ? 'on' : ''} onClick={() => setImg(i)} aria-label={`صورة ${i + 1}`}><img src={u} alt="" /></button>)}</div>}</div>
        <div className="stack">
          <h1>{p.name_ar}</h1><div className="row"><Stars v={p.avg_rating} /><span className="muted small">{p.review_count ? `(${p.review_count} تقييم)` : 'لا تقييمات بعد'}</span><span className="muted small">· المتجر: {p.shop_name}</span></div>
          <div className="price num" style={{ fontSize: '1.7rem' }}>{money(v?.price ?? p.price, p.currency)}</div>
          {p.variants.length > 1 && <div><div className="bold small" style={{ marginBottom: 6 }}>الخيارات</div><div className="chips" style={{ flexWrap: 'wrap' }}>{p.variants.map((x: any) =>
            <button key={x.id} className={'chip' + (x.id === vid ? ' on' : '')} disabled={x.stock <= 0} onClick={() => { setVid(x.id); setQty(1); }} style={x.stock <= 0 ? { opacity: .45 } : undefined}>{Object.values(x.options).join(' / ') || 'القياسي'}</button>)}</div></div>}
          {stock > 0 ? <div className="row"><div className="qty"><button aria-label="نقص" onClick={() => setQty(q => Math.max(1, q - 1))}>−</button><span className="num">{qty}</span><button aria-label="زيادة" onClick={() => setQty(q => Math.min(stock, q + 1))}>+</button></div>
            <span className={'small ' + (stock <= 3 ? 'bold' : 'muted')} style={stock <= 3 ? { color: 'var(--danger)' } : undefined}>{stock <= 3 ? `متبقي ${stock} فقط` : 'متوفر'}</span></div>
            : <div className="alert bad">نفدت الكمية</div>}
          <div className="row"><button className="btn grow" disabled={stock <= 0} onClick={() => { cart.add(addLine()); toast('أضيف إلى السلة'); }}>🛒 إضافة للسلة</button>
            <button className="btn accent grow" disabled={stock <= 0} onClick={() => { cart.add(addLine()); go('/checkout'); }}>شراء الآن</button></div>
          <div className="small muted">السعر شامل · رسوم التوصيل تُحتسب عند إتمام الطلب · الدفع عند الاستلام</div>
          {p.description && <div className="card flat"><h3>الوصف</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.description}</p></div>}
        </div>
      </div>
      <h2 style={{ marginTop: 24 }}>التقييمات</h2>
      {d.reviews.length ? <div className="stack">{d.reviews.map((rv: any, i: number) => <div key={i} className="card flat"><div className="row between"><b>{rv.name}</b><Stars v={rv.rating} /></div><p style={{ margin: '4px 0 0' }}>{rv.comment}</p></div>)}</div> : <div className="muted">لا توجد تقييمات بعد. التقييم متاح فقط لمن استلم المنتج فعلاً.</div>}
      {d.similar.length > 0 && <><h2 style={{ marginTop: 24 }}>منتجات مشابهة</h2><div className="pgrid">{d.similar.map((s: any) => <ProductCard key={s.id} p={s} />)}</div></>}
    </>; }}</Async>;
}

// ================= السلة =================
export function CartPage() {
  const cart = useCart(); const { me } = useMe();
  if (!cart.lines.length) return <div className="card empty"><h2>سلتك فارغة</h2><Link href="/shop" className="btn">تصفح المنتجات</Link></div>;
  return <div className="two" style={{ gridTemplateColumns: '2fr 1fr', alignItems: 'start' }}>
    <div className="stack">{cart.lines.map(l => <div key={l.variant_id} className="card row" style={{ flexWrap: 'nowrap' }}>
      <div className="pimg" style={{ width: 84, height: 84, borderRadius: 10, flexShrink: 0 }}><Img src={l.image} alt={l.name} /></div>
      <div className="grow"><Link href={'/product/' + l.product_id} className="bold" style={{ color: 'var(--text)' }}>{l.name}</Link>{l.options && <div className="muted small">{l.options}</div>}
        <div className="price num">{money(l.price, l.currency)}</div>
        <div className="row" style={{ marginTop: 6 }}><div className="qty"><button aria-label="نقص" onClick={() => cart.setQty(l.variant_id, l.qty - 1)}>−</button><span className="num">{l.qty}</span><button aria-label="زيادة" onClick={() => cart.setQty(l.variant_id, l.qty + 1)}>+</button></div>
          <button className="btn ghost sm" onClick={() => cart.remove(l.variant_id)}>حذف</button></div></div>
      <div className="bold num hide-m">{money(l.price * l.qty, l.currency)}</div></div>)}</div>
    <div className="card stack"><h3>ملخص الطلب</h3><div className="row between"><span>المجموع ({cart.count} قطعة)</span><b className="num">{money(cart.total, cart.lines[0].currency)}</b></div>
      <div className="small muted">رسوم التوصيل تظهر في الخطوة التالية بحسب محافظتك. الأسعار تُؤكَّد من الخادم عند الطلب.</div>
      <Link href={me?.user ? '/checkout' : '/login?next=/checkout'} className="btn block">{me?.user ? 'إتمام الطلب' : 'سجّل الدخول لإتمام الطلب'}</Link></div></div>;
}

// ================= إتمام الطلب =================
export function Checkout() {
  const cart = useCart(); const { me } = useMe(); const { go } = useRoute(); const { run, busy } = useAction();
  const geo = useFetch<any>('/public/governorates'); const pm = useFetch<any>('/public/payment-methods');
  const [f, setF] = useState({ name: me?.user?.full_name || '', phone: me?.user?.phone || '', governorate_id: (() => { try { return localStorage.getItem('ws_gov') || ''; } catch { return ''; } })(), area_id: '', address: '', notes: '', payment_method: 'cod' });
  const [fee, setFee] = useState<any>(null); const key = useRef('o-' + crypto.randomUUID());
  const upd = (k: string) => (e: any) => setF(x => ({ ...x, [k]: e.target.value, ...(k === 'governorate_id' ? { area_id: '' } : {}) }));
  useEffect(() => { if (!f.governorate_id) { setFee(null); return; } api(`/public/delivery-fee?governorate_id=${f.governorate_id}${f.area_id ? '&area_id=' + f.area_id : ''}`).then(setFee).catch(() => setFee(null)); }, [f.governorate_id, f.area_id]);
  useEffect(() => { if (me && !me.user) go('/login?next=/checkout', true); }, [me]);
  if (!cart.lines.length) return <div className="card empty"><h2>سلتك فارغة</h2><Link href="/shop" className="btn">تصفح المنتجات</Link></div>;
  if (me?.user && me.user.role !== 'buyer') return <div className="alert warn">الطلب متاح لحسابات المشترين فقط. سجّل الدخول بحساب مشتري.</div>;
  const areas = geo.data?.areas.filter((a: any) => a.governorate_id === f.governorate_id) || [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api('/orders', { body: { items: cart.lines.map(l => ({ variant_id: l.variant_id, qty: l.qty })), ...f, area_id: f.area_id || null, idempotency_key: key.current } }));
    if (r) { cart.clear(); go('/orders/' + r.order.id + '?new=1'); }
  };
  const fn = Number(fee?.fee || 0);
  return <form onSubmit={submit} className="two" style={{ gridTemplateColumns: '2fr 1fr', alignItems: 'start' }}>
    <div className="card stack"><h2>بيانات التوصيل</h2>
      <div className="grid g2"><Field label="الاسم"><Input required value={f.name} onChange={upd('name')} autoComplete="name" /></Field><Field label="رقم الهاتف"><Input required dir="ltr" inputMode="tel" value={f.phone} onChange={upd('phone')} autoComplete="tel" /></Field></div>
      <div className="grid g2"><Field label="المحافظة"><select className="input" required value={f.governorate_id} onChange={upd('governorate_id')}><option value="">اختر…</option>{geo.data?.governorates.map((g: any) => <option key={g.id} value={g.id}>{g.name_ar}</option>)}</select></Field>
        <Field label="المنطقة"><select className="input" value={f.area_id} onChange={upd('area_id')} disabled={!areas.length}><option value="">{areas.length ? 'اختر…' : 'غير مطلوبة'}</option>{areas.map((a: any) => <option key={a.id} value={a.id}>{a.name_ar}</option>)}</select></Field></div>
      <Field label="العنوان التفصيلي"><textarea className="input" required minLength={5} value={f.address} onChange={upd('address')} placeholder="الحي، الشارع، أقرب معلم" /></Field>
      <Field label="ملاحظات التوصيل (اختياري)"><Input value={f.notes} onChange={upd('notes')} /></Field>
      <Field label="طريقة الدفع"><div className="stack">{pm.data?.methods.map((m: any) => <label key={m.code} className="card flat row" style={{ cursor: 'pointer' }}><input type="radio" name="pm" checked={f.payment_method === m.code} onChange={() => setF(x => ({ ...x, payment_method: m.code }))} /> <b>{m.name_ar}</b></label>)}</div></Field></div>
    <div className="card stack"><h3>ملخص الطلب</h3>
      {cart.lines.map(l => <div key={l.variant_id} className="row between small"><span>{l.name} × {l.qty}</span><span className="num">{money(l.price * l.qty, l.currency)}</span></div>)}
      <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
      <div className="row between"><span>المجموع</span><b className="num">{money(cart.total, cart.lines[0].currency)}</b></div>
      <div className="row between"><span>التوصيل</span><b className="num">{!f.governorate_id ? 'اختر المحافظة' : fee?.configured ? money(fn, fee.currency) : 'بدون رسوم'}</b></div>
      <div className="row between" style={{ fontSize: '1.15rem' }}><b>الإجمالي</b><b className="price num">{money(cart.total + fn, cart.lines[0].currency)}</b></div>
      <button className="btn accent block" disabled={busy}>{busy ? 'جارٍ الإرسال…' : 'تأكيد الطلب'}</button>
      <div className="hint">سيتم التحقق من السعر والمخزون عند الإرسال.</div></div></form>;
}

// ================= الطلبات =================
export function Orders() {
  const r = useFetch<any>('/orders'); const { me } = useMe(); const { go } = useRoute();
  useEffect(() => { if (me && !me.user) go('/login?next=/orders', true); }, [me]);
  if (!me?.user) return <Loading />;
  return <><h1>طلباتي</h1><Async r={r}>{d => d.orders.length ? <div className="stack">{d.orders.map((o: any) =>
    <Link key={o.id} href={'/orders/' + o.id} className="card row between" style={{ color: 'var(--text)' }}><div><b className="num">{o.order_number}</b><div className="muted small">{dt(o.created_at)} · {o.items_count} منتج</div></div>
      <div style={{ textAlign: 'left' }}><Status map={ORDER_STATUS} v={o.status} /><div className="bold num">{money(o.total, o.currency)}</div></div></Link>)}</div>
    : <div className="card empty">لا توجد طلبات بعد. <Link href="/shop">ابدأ التسوق</Link></div>}</Async></>;
}

function TrackMap({ id }: { id: string }) {
  const [t, setT] = useState<any>(null); const box = useRef<HTMLDivElement>(null); const map = useRef<any>(null); const marker = useRef<any>(null);
  useEffect(() => { let live = true; const tick = () => api('/orders/' + id + '/tracking').then(x => live && setT(x)).catch(() => {}); tick(); const h = setInterval(tick, 8000); return () => { live = false; clearInterval(h); }; }, [id]);
  useEffect(() => {
    const L = (window as any).L; if (!L || !box.current || !t?.location) return;
    const pos = [t.location.lat, t.location.lng];
    if (!map.current) { map.current = L.map(box.current).setView(pos, 15); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current); marker.current = L.marker(pos).addTo(map.current); }
    else { marker.current.setLatLng(pos); map.current.panTo(pos); }
  }, [t]);
  if (!t?.active) return null;
  return <div className="card stack"><h3>🛵 تتبع المندوب مباشرة</h3>
    {t.location ? <><div className="mapbox" ref={box}>{!(window as any).L && <span className="muted">تعذر تحميل الخريطة</span>}</div>
      <div className="small muted">آخر تحديث: {dt(t.location.recorded_at)} · <a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${t.location.lat}&mlon=${t.location.lng}#map=16/${t.location.lat}/${t.location.lng}`}>فتح في OpenStreetMap</a></div></>
      : <div className="alert">المندوب في الطريق، وسيظهر موقعه فور مشاركته.</div>}</div>;
}

export function OrderDetail({ id }: { id: string }) {
  const r = useFetch<any>('/orders/' + id); const { run, busy } = useAction(); const { search } = useRoute();
  return <Async r={r}>{d => { const o = d.order; return <div className="stack">
    {search.get('new') && <div className="alert ok">✅ تم استلام طلبك بنجاح. رقم الطلب <b className="num">{o.order_number}</b> — سنتواصل معك قريباً.</div>}
    <div className="row between"><h1 style={{ margin: 0 }}>طلب <span className="num">{o.order_number}</span></h1><Status map={ORDER_STATUS} v={o.status} /></div>
    <TrackMap id={id} />
    <div className="two" style={{ alignItems: 'start' }}>
      <div className="card stack"><h3>المنتجات</h3>{d.items.map((i: any, k: number) => <div key={k} className="row between"><span>{i.product_name} × {i.quantity}</span><b className="num">{money(i.line_total, o.currency)}</b></div>)}
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} /><div className="row between"><span>المجموع</span><span className="num">{money(o.subtotal, o.currency)}</span></div>
        <div className="row between"><span>التوصيل</span><span className="num">{money(o.delivery_fee, o.currency)}</span></div><div className="row between"><b>الإجمالي</b><b className="price num">{money(o.total, o.currency)}</b></div>
        <div className="muted small">الدفع: عند الاستلام</div></div>
      <div className="stack"><div className="card stack"><h3>التوصيل</h3><div>{o.recipient_name} · <span className="num" dir="ltr">{o.recipient_phone}</span></div><div className="muted">{o.governorate} — {o.address_detail}</div>
        {d.agent && <div className="row between"><span>🛵 المندوب: <b>{d.agent.full_name}</b></span><a className="btn sm secondary" href={'tel:' + d.agent.phone}>📞 اتصال</a></div>}</div>
        <div className="card"><h3>سجل الحالات</h3><ul className="timeline">{d.history.map((h: any, i: number) => <li key={i}><Status map={ORDER_STATUS} v={h.to_status} /> <span className="muted small">{dt(h.created_at)}</span></li>)}</ul></div>
        {['new', 'pending_confirmation', 'confirmed'].includes(o.status) && <button className="btn danger" disabled={busy} onClick={() => confirm('إلغاء الطلب؟') && run(() => api(`/orders/${id}/cancel`, { method: 'POST', body: {} }), 'تم إلغاء الطلب').then(() => r.reload())}>إلغاء الطلب</button>}</div></div></div>; }}</Async>;
}

// ================= الحساب =================
export function Account() {
  const { me, refresh } = useMe(); const { go } = useRoute();
  useEffect(() => { if (me && !me.user) go('/login', true); }, [me]);
  const u = me?.user; if (!u) return <Loading />;
  return <div className="auth stack"><h1>حسابي</h1><div className="card stack"><div><span className="muted">الاسم:</span> <b>{u.full_name}</b></div><div><span className="muted">الهاتف:</span> <b className="num" dir="ltr">{u.phone}</b></div>
    {u.is_demo && <span className="badge warn">حساب تجريبي معزول</span>}
    <Link href="/orders" className="btn secondary">طلباتي</Link>
    <button className="btn ghost" onClick={async () => { await api('/auth/logout', { method: 'POST', body: {} }); await refresh(); go('/'); }}>تسجيل الخروج</button></div></div>;
}

// ================= الدخول والتسجيل =================
export function AuthPage({ initial }: { initial: 'login' | 'register' }) {
  const { refresh } = useMe(); const { go, search } = useRoute(); const { run, busy } = useAction(); const govs = useFetch<any>('/public/governorates');
  const [mode, setMode] = useState<'login' | 'register'>(initial); const [role, setRole] = useState<'buyer' | 'merchant'>('buyer');
  const [f, setF] = useState({ full_name: '', phone: '', identifier: '', password: '', shop_name: '', governorate_id: '', address: '' }); const upd = (k: string) => (e: any) => setF(x => ({ ...x, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => mode === 'login' ? api('/auth/login', { body: { identifier: f.identifier, password: f.password } })
      : api('/auth/register', { body: { role, full_name: f.full_name, phone: f.phone, password: f.password, governorate_id: f.governorate_id || undefined, ...(role === 'merchant' ? { shop_name: f.shop_name, address: f.address || undefined } : {}) } }));
    if (r) { await refresh(); const next = search.get('next'); go(next || (r.role === 'merchant' ? '/merchant' : r.role === 'buyer' ? '/' : r.role === 'delivery_agent' ? '/agent' : '/admin')); }
  };
  return <div className="auth stack"><div className="tabs" role="tablist"><button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>تسجيل الدخول</button><button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>حساب جديد</button></div>
    <form className="card stack" onSubmit={submit}>
      {mode === 'register' && <div className="tabs"><button type="button" className={role === 'buyer' ? 'on' : ''} onClick={() => setRole('buyer')}>أنا مشتري</button><button type="button" className={role === 'merchant' ? 'on' : ''} onClick={() => setRole('merchant')}>أنا تاجر</button></div>}
      {mode === 'register' && <Field label="الاسم الكامل"><Input required minLength={2} value={f.full_name} onChange={upd('full_name')} autoComplete="name" /></Field>}
      {mode === 'register' && role === 'merchant' && <Field label="اسم المحل"><Input required value={f.shop_name} onChange={upd('shop_name')} /></Field>}
      {mode === 'login'
        ? <Field label="البريد الإلكتروني أو رقم الهاتف"><Input required dir="ltr" placeholder="البريد الإلكتروني أو رقم الهاتف" value={f.identifier} onChange={upd('identifier')} autoComplete="username" /></Field>
        : <Field label="رقم الهاتف"><Input required dir="ltr" inputMode="tel" placeholder="+967…" value={f.phone} onChange={upd('phone')} autoComplete="tel" /></Field>}
      <Field label="كلمة المرور" hint={mode === 'register' ? '8 أحرف على الأقل' : undefined}><Input required type="password" minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={upd('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
      {mode === 'register' && <Field label="المحافظة"><select className="input" value={f.governorate_id} onChange={upd('governorate_id')}><option value="">اختر…</option>{govs.data?.governorates.map((g: any) => <option key={g.id} value={g.id}>{g.name_ar}</option>)}</select></Field>}
      {mode === 'register' && role === 'merchant' && <div className="alert">سيُراجع فريق وسيطك طلب انضمامك قبل تفعيل إضافة المنتجات.</div>}
      <button className="btn block" disabled={busy}>{busy ? '…' : mode === 'login' ? 'دخول' : role === 'merchant' ? 'تقديم طلب الانضمام' : 'إنشاء الحساب'}</button></form></div>;
}
