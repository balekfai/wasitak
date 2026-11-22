import React, { useEffect, useRef, useState } from 'react';
import { api, useFetch, Link, useRoute, useMe, useAction, useToast, Async, Field, Input, Img, Status, Stat, Modal, ORDER_STATUS, PRODUCT_STATUS, MERCHANT_STATUS, money, dt, match, uploadImage, Loading } from './common';
import { DashShell, type NavItem } from './shell';

const NAV: NavItem[] = [
  { href: '/merchant', icon: '📊', label: 'الرئيسية' }, { href: '/merchant/products', icon: '🛍️', label: 'منتجاتي' }, { href: '/merchant/orders', icon: '📦', label: 'الطلبات' },
  { href: '/merchant/finance', icon: '💰', label: 'المبيعات والمستحقات' }, { href: '/merchant/smart', icon: '✨', label: 'وسيطك الذكي' },
];

export function MerchantApp() {
  const { path } = useRoute(); const { me } = useMe();
  if (me?.user?.role !== 'merchant') return <div className="auth alert warn">هذه اللوحة لحسابات التجار فقط. <Link href="/login">تسجيل الدخول</Link></div>;
  let page: React.ReactNode = <Dashboard />; let m: any;
  if (path === '/merchant/products') page = <Products />;
  else if (path === '/merchant/products/new') page = <ProductForm />;
  else if ((m = match('/merchant/products/:id', path))) page = <ProductForm id={m.id} key={m.id} />;
  else if (path === '/merchant/orders') page = <MOrders />;
  else if (path === '/merchant/finance') page = <Finance />;
  else if (path === '/merchant/smart') page = <Smart />;
  return <DashShell title={me.merchant?.shop_name || 'لوحة التاجر'} nav={NAV}>{me.merchant?.status !== 'approved' && <MerchantStatusBanner m={me.merchant} />}{page}</DashShell>;
}

function MerchantStatusBanner({ m }: { m: any }) {
  return <div className={'alert ' + (m?.status === 'pending' ? 'warn' : 'bad')} style={{ marginBottom: 14 }}>
    {m?.status === 'pending' ? '⏳ طلب انضمامك قيد المراجعة. ستتمكن من إضافة المنتجات بعد موافقة الإدارة.' : `حسابك ${m ? MERCHANT_STATUS[m.status]?.[0] : ''}${m?.rejection_reason ? ': ' + m.rejection_reason : ''}`}</div>;
}

function Dashboard() {
  const r = useFetch<any>('/merchant/dashboard');
  return <><h1>لوحة التحكم</h1><Async r={r}>{d => {
    const pc = (s: string) => d.products.find((x: any) => x.status === s)?.n || 0; const oc = d.orders.reduce((a: number, x: any) => a + x.n, 0);
    return <><div className="grid g4"><Stat v={pc('approved')} l="منتجات منشورة" /><Stat v={pc('pending_review')} l="بانتظار المراجعة" /><Stat v={oc} l="إجمالي الطلبات" /><Stat v={d.low_stock} l="مخزون منخفض (≤3)" /></div>
      <h2 style={{ marginTop: 20 }}>الرصيد المستحق</h2>
      {d.balances.length ? <div className="grid g3">{d.balances.map((b: any) => <div key={b.currency} className="card stat"><span className="v num">{money(b.balance, b.currency)}</span><span className="l">إجمالي المبيعات {money(b.total_sales_credit, b.currency)} · المدفوع لك {money(b.total_paid || 0, b.currency)}</span></div>)}</div>
        : <div className="card empty">لا مستحقات بعد. تُحتسب المستحقات عند تسليم الطلبات للمشترين.</div>}</>; }}</Async></>;
}

function Products() {
  const r = useFetch<any>('/merchant/products'); const { me } = useMe();
  return <><div className="row between"><h1>منتجاتي</h1>{me?.merchant?.status === 'approved' && <Link href="/merchant/products/new" className="btn">＋ منتج جديد</Link>}</div>
    <Async r={r}>{d => d.products.length ? <div className="tablewrap"><table className="t"><thead><tr><th></th><th>المنتج</th><th>القسم</th><th>سعري</th><th>المخزون</th><th>الحالة</th><th></th></tr></thead><tbody>
      {d.products.map((p: any) => { const stock = p.variants.reduce((a: number, v: any) => a + v.quantity, 0); return <tr key={p.id}>
        <td style={{ width: 56 }}><div className="pimg" style={{ width: 44, height: 44, borderRadius: 8, fontSize: '1.2rem' }}><Img src={p.image_url} alt="" /></div></td>
        <td><b>{p.name_ar}</b>{p.review_notes && p.status === 'rejected' && <div className="small" style={{ color: 'var(--danger)' }}>سبب الرفض: {p.review_notes}</div>}</td><td>{p.category}</td><td className="num">{money(p.merchant_price, p.currency)}</td>
        <td><span className={'num' + (stock <= 3 ? ' bold' : '')} style={stock <= 3 ? { color: 'var(--danger)' } : undefined}>{stock}</span></td><td><Status map={PRODUCT_STATUS} v={p.status} /></td>
        <td><Link href={'/merchant/products/' + p.id} className="btn sm secondary">تعديل</Link></td></tr>; })}</tbody></table></div>
      : <div className="card empty">لم تضف منتجات بعد.</div>}</Async></>;
}

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const r = useFetch<any>('/public/categories');
  const cats = r.data?.categories || []; const kids = (id: string | null): any[] => cats.filter((c: any) => c.parent_id === id);
  const flat = (id: string | null, d = 0): any[] => kids(id).flatMap(c => [{ ...c, d }, ...flat(c.id, d + 1)]);
  return <select className="input" required value={value} onChange={e => onChange(e.target.value)}><option value="">اختر القسم…</option>{flat(null).map(c => <option key={c.id} value={c.id}>{'— '.repeat(c.d)}{c.name_ar}</option>)}</select>;
}

function ImagePicker({ images, setImages }: { images: string[]; setImages: (v: string[]) => void }) {
  const { run, busy } = useAction(); const ref = useRef<HTMLInputElement>(null);
    const pick = async (files: FileList | null) => { if (!files) return; let cur = images; for (const f of Array.from(files).slice(0, 8 - images.length)) { const u = await run(() => uploadImage(f)); if (u) { cur = [...cur, u].slice(0, 8); setImages(cur); } } };
  return <div className="imgs">{images.map((u, i) => <div key={u} className="im"><img src={u} alt={`صورة ${i + 1}`} /><button type="button" aria-label="حذف" onClick={() => setImages(images.filter(x => x !== u))}>✕</button></div>)}
    {images.length < 8 && <button type="button" className="upl" disabled={busy} onClick={() => ref.current?.click()} aria-label="رفع صورة">{busy ? '…' : '＋'}</button>}
    <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp"  multiple hidden onChange={e => { pick(e.target.files); e.target.value = ''; }} /></div>;
}

function ProductForm({ id }: { id?: string }) {
  const { go } = useRoute(); const { run, busy } = useAction(); const toast = useToast();
  const cur = useFetch<any>('/public/currencies'); const list = useFetch<any>(id ? '/merchant/products' : null);
  const [f, setF] = useState<any>({ name_ar: '', description: '', category_id: '', merchant_price: '', currency: 'YER', is_available: true });
  const [images, setImages] = useState<string[]>([]); const [variants, setVariants] = useState<any[]>([{ color: '', size: '', quantity: 1, price_delta: 0 }]);
  const existing = id ? list.data?.products.find((p: any) => p.id === id) : null;
  useEffect(() => { if (existing) { setF({ name_ar: existing.name_ar, description: existing.description || '', category_id: existing.category_id, merchant_price: existing.merchant_price, currency: existing.currency, is_available: existing.is_available }); setImages(existing.images); } }, [existing?.id]);
  const upd = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));
  const [stock, setStock] = useState<Record<string, string>>({});
  if (id && list.loading) return <Loading />; if (id && !existing) return <div className="alert bad">المنتج غير موجود</div>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (id) { const r = await run(() => api('/merchant/products/' + id, { method: 'PATCH', body: { name_ar: f.name_ar, description: f.description, category_id: f.category_id, merchant_price: Number(f.merchant_price), is_available: !!f.is_available, images } })); if (r) { toast(r.sent_to_review ? 'تم الحفظ وأُعيد المنتج للمراجعة قبل النشر' : 'تم الحفظ'); go('/merchant/products'); } return; }
    const body = { name_ar: f.name_ar, description: f.description, category_id: f.category_id, merchant_price: Number(f.merchant_price), currency: f.currency, images,
      variants: variants.map(v => ({ options: { ...(v.color && { اللون: v.color }), ...(v.size && { المقاس: v.size }) }, quantity: Number(v.quantity), price_delta: Number(v.price_delta) || 0 })) };
    const r = await run(() => api('/merchant/products', { body })); if (r) { toast('أُرسل المنتج للمراجعة، وسيُنشر بعد موافقة الإدارة'); go('/merchant/products'); }
  };
  return <form className="stack" onSubmit={save} style={{ maxWidth: 760 }}><h1>{id ? 'تعديل المنتج' : 'منتج جديد'}</h1>
    {id && existing.status === 'approved' && <div className="alert warn">تعديل الاسم أو الوصف أو السعر أو الصور يُعيد المنتج للمراجعة ويُخفى مؤقتاً حتى الاعتماد.</div>}
    <div className="card stack">
      <Field label="اسم المنتج"><Input required minLength={2} value={f.name_ar} onChange={upd('name_ar')} /></Field>
      <Field label="الوصف" hint="اكتب الحقيقة فقط: المواصفات والمقاسات والخامة."><textarea className="input" value={f.description} onChange={upd('description')} /></Field>
      <div className="grid g2"><Field label="القسم"><CategorySelect value={f.category_id} onChange={v => setF((x: any) => ({ ...x, category_id: v }))} /></Field>
        <Field label="سعرك الأصلي" hint="هذا السعر لا يظهر للمشتري؛ تُضاف عليه نسبة وسيطك تلقائياً."><Input required type="number" min="1" step="any" dir="ltr" value={f.merchant_price} onChange={upd('merchant_price')} /></Field></div>
      {!id && <Field label="العملة"><select className="input" value={f.currency} onChange={upd('currency')}>{cur.data?.currencies.map((c: any) => <option key={c.code} value={c.code}>{c.name_ar} ({c.code})</option>)}</select></Field>}
      <div><div className="bold small" style={{ marginBottom: 6 }}>الصور (حتى 8)</div><ImagePicker images={images} setImages={setImages} /><div className="hint">يمكنك التصوير مباشرة من الهاتف.</div></div>
      {id && <label className="row"><input type="checkbox" checked={!!f.is_available} onChange={e => setF((x: any) => ({ ...x, is_available: e.target.checked }))} /> متاح للبيع</label>}
    </div>
    {!id ? <div className="card stack"><h3>الخيارات والمخزون</h3>
      {variants.map((v, i) => <div key={i} className="grid g4" style={{ alignItems: 'end' }}>
        <Field label="اللون"><Input value={v.color} onChange={e => setVariants(a => a.map((x, k) => k === i ? { ...x, color: e.target.value } : x))} /></Field>
        <Field label="المقاس"><Input value={v.size} onChange={e => setVariants(a => a.map((x, k) => k === i ? { ...x, size: e.target.value } : x))} /></Field>
        <Field label="الكمية"><Input type="number" min="0" required dir="ltr" value={v.quantity} onChange={e => setVariants(a => a.map((x, k) => k === i ? { ...x, quantity: e.target.value } : x))} /></Field>
        <div className="row"><Field label="فرق السعر"><Input type="number" min="0" step="any" dir="ltr" value={v.price_delta} onChange={e => setVariants(a => a.map((x, k) => k === i ? { ...x, price_delta: e.target.value } : x))} /></Field>
          {variants.length > 1 && <button type="button" className="btn ghost sm" onClick={() => setVariants(a => a.filter((_, k) => k !== i))} aria-label="حذف الخيار">✕</button>}</div></div>)}
      <button type="button" className="btn secondary sm" style={{ alignSelf: 'flex-start' }} onClick={() => setVariants(a => [...a, { color: '', size: '', quantity: 1, price_delta: 0 }])}>＋ خيار آخر</button></div>
      : <div className="card stack"><h3>إدارة المخزون</h3>{existing.variants.map((v: any) => <div key={v.id} className="row between"><span>{Object.values(v.options).join(' / ') || 'القياسي'}</span>
        <div className="row"><input className="input num" style={{ width: 110 }} type="number" min="0" dir="ltr" defaultValue={v.quantity} onChange={e => setStock(s => ({ ...s, [v.id]: e.target.value }))} aria-label="الكمية" />
          <button type="button" className="btn sm secondary" disabled={stock[v.id] === undefined} onClick={() => run(() => api(`/merchant/products/${id}/stock`, { method: 'PUT', body: { variant_id: v.id, quantity: Number(stock[v.id]) } }), 'تم تحديث المخزون').then(() => list.reload())}>حفظ</button></div></div>)}
        <div className="hint">كل تغيير في الكمية يُسجَّل باسمك وتاريخه.</div></div>}
    <div className="row"><button className="btn" disabled={busy}>{id ? 'حفظ التعديلات' : 'إرسال للمراجعة'}</button><Link href="/merchant/products" className="btn ghost">إلغاء</Link></div></form>;
}

function MOrders() {
  const r = useFetch<any>('/merchant/orders');
  return <><h1>طلبات منتجاتي</h1><div className="alert" style={{ marginBottom: 12 }}>تظهر هنا بنود منتجاتك فقط بسعرك الأصلي. بيانات المشتري الشخصية تبقى لدى وسيطك.</div>
    <Async r={r}>{d => d.orders.length ? <div className="stack">{d.orders.map((o: any) => <div key={o.id} className="card"><div className="row between"><b className="num">{o.order_number}</b><Status map={ORDER_STATUS} v={o.status} /></div>
      <div className="muted small">{dt(o.created_at)} · {o.governorate}</div>
      {o.items.map((i: any, k: number) => <div key={k} className="row between"><span>{i.name} × {i.qty}</span><span className="num">{money(i.unit * i.qty, i.currency)}</span></div>)}
      <div className="row between bold" style={{ marginTop: 6 }}><span>مستحقك من الطلب</span><span className="num">{money(o.merchant_total, o.items[0]?.currency)}</span></div></div>)}</div>
      : <div className="card empty">لا طلبات بعد.</div>}</Async></>;
}

function Finance() {
  const r = useFetch<any>('/merchant/finance'); const { run, busy } = useAction();
  const KIND: Record<string, string> = { sale_credit: 'استحقاق مبيعات', return_debit: 'مرتجع', payout_debit: 'صرف مستحقات', adjustment: 'قيد تصحيحي' };
  return <><h1>المبيعات والمستحقات</h1><Async r={r}>{d => <div className="stack">
    <div className="grid g3">{d.balances.length ? d.balances.map((b: any) => <div key={b.currency} className="card stat"><span className="v num">{money(b.balance, b.currency)}</span><span className="l">الرصيد المتبقي · مبيعات {money(b.total_sales_credit, b.currency)} · مدفوع {money(b.total_paid || 0, b.currency)}</span></div>) : <div className="card empty" style={{ gridColumn: '1/-1' }}>لا مستحقات بعد.</div>}</div>
    <h2>سندات الصرف</h2>{d.vouchers.length ? <div className="tablewrap"><table className="t"><thead><tr><th>رقم السند</th><th>المبلغ</th><th>الطريقة</th><th>السبب</th><th>التاريخ</th><th>الحالة</th></tr></thead><tbody>{d.vouchers.map((v: any) => <tr key={v.id}>
      <td className="num">{v.voucher_number}</td><td className="num">{money(v.amount, v.currency)}</td><td>{v.method === 'cash' ? 'نقداً' : 'تحويل'}</td><td>{v.reason}</td><td>{dt(v.created_at)}</td>
      <td>{v.status === 'confirmed' ? <span className="badge ok">تم الاستلام · {v.receipt_number}</span> : <button className="btn sm" disabled={busy} onClick={() => confirm('أؤكد أنني استلمت هذا المبلغ فعلياً؟') && run(() => api(`/merchant/vouchers/${v.id}/confirm`, { body: {} }), 'تم إنشاء سند القبض').then(() => r.reload())}>تأكيد الاستلام (سند قبض)</button>}</td></tr>)}</tbody></table></div> : <div className="card empty">لا سندات صرف بعد.</div>}
    <h2>سجل الحركات</h2><div className="tablewrap"><table className="t"><thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th></tr></thead><tbody>{d.transactions.map((t: any) => <tr key={t.id}><td>{dt(t.created_at)}</td><td>{KIND[t.kind] || t.kind}{t.note ? ' — ' + t.note : ''}</td><td className="num" style={{ color: Number(t.amount) < 0 ? 'var(--danger)' : 'var(--ok)' }}>{money(t.amount, t.currency)}</td></tr>)}</tbody></table></div></div>}</Async></>;
}

function Smart() {
  const r = useFetch<any>('/merchant/smart');
  return <><h1>✨ وسيطك الذكي</h1><div className="card stack" style={{ background: 'linear-gradient(120deg,#e6f4f2,#fef3c7)' }}>
    <h2 style={{ margin: 0 }}>هل تريد أن تظهر منتجاتك بشكل أفضل وتعرضها بطريقة احترافية؟</h2>
    <p style={{ margin: 0 }}>اشترك في وسيطك الذكي ودع الذكاء الاصطناعي يساعدك في تجهيز منتجاتك للنشر:</p>
    <ul style={{ margin: 0, paddingRight: 18 }}><li>تحسين صور المنتجات والإضاءة والخلفية</li><li>كتابة أسماء وأوصاف تسويقية احترافية</li><li>اقتراح الكلمات المفتاحية والقسم المناسب</li><li>تجهيز منشور كامل لتراجعه وتعدله قبل النشر</li></ul></div>
    <Async r={r}>{d => <div className={'alert ' + (d.enabled ? 'ok' : 'warn')} style={{ marginTop: 12 }}>{d.enabled ? 'الخدمة مفعّلة. الاشتراك والواجهة قيد التنفيذ.' : 'الخدمة غير مفعّلة حالياً وسيُعلن عنها قريباً. لن يُطلب منك أي دفع الآن.'}</div>}</Async></>;
}
