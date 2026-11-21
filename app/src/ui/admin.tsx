import React, { useState } from 'react';
import { api, useFetch, Link, useRoute, useMe, useAction, Async, Field, Input, Img, Status, Stat, Modal, ORDER_STATUS, PRODUCT_STATUS, MERCHANT_STATUS, money, dt, match } from './common';
import { DashShell, type NavItem } from './shell';

const ALL_NAV: (NavItem & { perm?: string })[] = [
  { href: '/admin', icon: '📊', label: 'لوحة المعلومات', section: 'عام' },
  { href: '/admin/orders', icon: '📦', label: 'الطلبات', perm: 'orders.view', section: 'العمليات' },
  { href: '/admin/products', icon: '🛍️', label: 'مراجعة المنتجات', perm: 'products.review', section: 'العمليات' },
  { href: '/admin/merchants', icon: '🏪', label: 'التجار', perm: 'merchants.review', section: 'العمليات' },
  { href: '/admin/categories', icon: '🗂️', label: 'الأقسام', perm: 'categories.manage', section: 'الكتالوج' },
  { href: '/admin/pricing', icon: '🏷️', label: 'التسعير وأسعار الصرف', perm: 'pricing.manage', section: 'الكتالوج' },
  { href: '/admin/accounting', icon: '💰', label: 'المحاسبة والمستحقات', perm: 'accounting.view', section: 'المالية' },
  { href: '/admin/users', icon: '👥', label: 'المستخدمون والموظفون', perm: 'users.manage', section: 'النظام' },
  { href: '/admin/modules', icon: '🧩', label: 'وحدات النظام والميزات', perm: 'modules.manage', section: 'النظام' },
  { href: '/admin/audit', icon: '🧾', label: 'سجل التدقيق', perm: 'audit.view', section: 'النظام' },
];

export function AdminApp() {
  const { path } = useRoute(); const { me } = useMe(); const u = me?.user;
  if (!u?.is_staff) return <div className="auth alert warn">هذه اللوحة لحسابات الإدارة والموظفين فقط. <Link href="/login">تسجيل الدخول</Link></div>;
  const has = (p?: string) => !p || u.permissions.includes(p);
  const nav = ALL_NAV.filter(n => has(n.perm));
  const rules: [string, React.ReactNode, string?][] = [['/admin/orders', <Orders />, 'orders.view'], ['/admin/products', <Products />, 'products.review'], ['/admin/merchants', <Merchants />, 'merchants.review'],
    ['/admin/categories', <Categories />, 'categories.manage'], ['/admin/pricing', <Pricing />, 'pricing.manage'], ['/admin/accounting', <Accounting />, 'accounting.view'],
    ['/admin/users', <Users />, 'users.manage'], ['/admin/modules', <Modules />, 'modules.manage'], ['/admin/audit', <Audit />, 'audit.view']];
  const hit = rules.find(r => r[0] === path);
  return <DashShell title="لوحة الإدارة" nav={nav}>{!hit ? <Dashboard /> : has(hit[2]) ? hit[1] : <div className="alert bad">لا تملك صلاحية هذه الصفحة</div>}</DashShell>;
}

function Dashboard() {
  const r = useFetch<any>('/admin/stats');
  return <><h1>لوحة المعلومات</h1><Async r={r}>{d => { const n = (s: string[]) => d.orders.filter((o: any) => s.includes(o.status)).reduce((a: number, o: any) => a + o.n, 0);
    return <><div className="grid g4"><Stat v={n(Object.keys(ORDER_STATUS))} l="كل الطلبات" /><Stat v={n(['new', 'pending_confirmation'])} l="طلبات جديدة" /><Stat v={n(['confirmed', 'preparing', 'ready_for_delivery'])} l="قيد التجهيز" /><Stat v={n(['out_for_delivery'])} l="قيد التوصيل" /></div>
      <div className="grid g4" style={{ marginTop: 14 }}><Stat v={n(['delivered'])} l="طلبات مكتملة" /><Stat v={d.merchants} l="التجار" /><Stat v={d.customers} l="العملاء" /><Stat v={d.products} l="المنتجات" /></div>
      <div className="grid g4" style={{ marginTop: 14 }}><Stat v={d.products_pending} l="منتجات بانتظار المراجعة" /><Stat v={d.merchants_pending} l="تجار بانتظار القبول" /><Stat v={d.returns_open} l="مرتجعات مفتوحة" /><Stat v={d.complaints_open} l="شكاوى مفتوحة" /></div>
      {d.finance && <><h2 style={{ marginTop: 20 }}>الأرقام المالية (الحقيقية فقط)</h2><div className="grid g3">
        {d.finance.sales.map((s: any) => <Stat key={'s' + s.currency} v={money(s.total, s.currency)} l="إجمالي المبيعات المسلّمة" />)}
        {d.finance.platform.filter((p: any) => p.kind === 'markup_revenue').map((s: any) => <Stat key={'p' + s.currency} v={money(s.total, s.currency)} l="أرباح وسيطك" />)}
        {d.finance.merchants_due.map((s: any) => <Stat key={'m' + s.currency} v={money(s.total, s.currency)} l="مستحقات التجار المتبقية" />)}</div></>}</>; }}</Async></>;
}

function Orders() {
  const [st, setSt] = useState(''); const r = useFetch<any>('/admin/orders' + (st ? '?status=' + st : '')); const [sel, setSel] = useState<string | null>(null);
  return <><h1>الطلبات</h1><div className="chips"><button className={'chip' + (!st ? ' on' : '')} onClick={() => setSt('')}>الكل</button>{Object.entries(ORDER_STATUS).map(([k, v]) => <button key={k} className={'chip' + (st === k ? ' on' : '')} onClick={() => setSt(k)}>{v[0]}</button>)}</div>
    <Async r={r}>{d => d.orders.length ? <div className="tablewrap"><table className="t"><thead><tr><th>الطلب</th><th>العميل</th><th>المحافظة</th><th>الإجمالي</th><th>المندوب</th><th>الحالة</th><th></th></tr></thead><tbody>{d.orders.map((o: any) => <tr key={o.id}>
      <td><b className="num">{o.order_number}</b>{o.is_demo && <span className="badge warn" style={{ marginRight: 4 }}>تجريبي</span>}<div className="muted small">{dt(o.created_at)}</div></td><td>{o.recipient_name}</td><td>{o.governorate}</td><td className="num">{money(o.total, o.currency)}</td><td>{o.agent || '—'}</td><td><Status map={ORDER_STATUS} v={o.status} /></td>
      <td><button className="btn sm secondary" onClick={() => setSel(o.id)}>إدارة</button></td></tr>)}</tbody></table></div> : <div className="card empty">لا طلبات.</div>}</Async>
    {sel && <OrderModal id={sel} onClose={() => { setSel(null); r.reload(); }} />}</>;
}
const NEXT: Record<string, string[]> = { new: ['pending_confirmation', 'confirmed', 'cancelled'], pending_confirmation: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['ready_for_delivery', 'cancelled'], ready_for_delivery: ['out_for_delivery', 'cancelled'], out_for_delivery: ['delivered', 'cancelled'], delivered: ['return_requested'], return_requested: ['return_processing'], return_processing: ['return_completed'], return_completed: ['refunded'] };
function OrderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useFetch<any>('/admin/orders/' + id); const agents = useFetch<any>('/admin/agents'); const { me } = useMe(); const { run, busy } = useAction(); const [agent, setAgent] = useState('');
  const can = (p: string) => me?.user?.permissions.includes(p);
  return <Modal title="إدارة الطلب" onClose={onClose}><Async r={r}>{d => { const o = d.order; return <div className="stack">
    <div className="row between"><b className="num">{o.order_number}</b><Status map={ORDER_STATUS} v={o.status} /></div>
    <div className="card flat"><div>{o.recipient_name} · <span className="num" dir="ltr">{o.recipient_phone}</span></div><div className="muted">{o.governorate} — {o.address_detail}</div>{o.delivery_notes && <div className="small">ملاحظات: {o.delivery_notes}</div>}</div>
    <div className="tablewrap"><table className="t" style={{ minWidth: 0 }}><thead><tr><th>المنتج</th><th>التاجر</th><th>الكمية</th><th>السعر</th>{d.items[0]?.merchant_unit_price !== undefined && <><th>سعر التاجر</th><th>ربح وسيطك</th></>}</tr></thead><tbody>{d.items.map((i: any, k: number) => <tr key={k}><td>{i.product_name}</td><td>{i.shop_name}</td><td className="num">{i.quantity}</td><td className="num">{money(i.unit_price, o.currency)}</td>
      {i.merchant_unit_price !== undefined && <><td className="num">{money(i.merchant_unit_price)}</td><td className="num">{money(i.markup_unit_amount * i.quantity)}</td></>}</tr>)}</tbody></table></div>
    <div className="row between"><span>التوصيل: <b className="num">{money(o.delivery_fee, o.currency)}</b></span><b>الإجمالي: <span className="num">{money(o.total, o.currency)}</span></b></div>
    {can('orders.manage') && (NEXT[o.status] || []).length > 0 && <div><div className="bold small">تغيير الحالة</div><div className="row">{NEXT[o.status].map(s => <button key={s} className={'btn sm ' + (s === 'cancelled' ? 'danger' : '')} disabled={busy} onClick={() => run(() => api(`/admin/orders/${id}/status`, { body: { to: s } }), 'تم تحديث الحالة').then(() => r.reload())}>{ORDER_STATUS[s][0]}</button>)}</div></div>}
    {can('orders.assign') && !['delivered', 'cancelled', 'refunded', 'return_completed'].includes(o.status) && <div className="row"><select className="input grow" value={agent} onChange={e => setAgent(e.target.value)} aria-label="المندوب"><option value="">اختر مندوباً…</option>{agents.data?.agents.map((a: any) => <option key={a.id} value={a.id}>{a.full_name}</option>)}</select>
      <button className="btn sm" disabled={!agent || busy} onClick={() => run(() => api(`/admin/orders/${id}/assign`, { body: { agent_id: agent } }), 'تم إسناد الطلب').then(() => r.reload())}>إسناد</button></div>}
    <div><div className="bold small">السجل</div><ul className="timeline">{d.history.map((h: any, i: number) => <li key={i}><Status map={ORDER_STATUS} v={h.to_status} /> <span className="muted small">{dt(h.created_at)} · {h.actor || 'النظام'}{h.note ? ' — ' + h.note : ''}</span></li>)}</ul></div></div>; }}</Async></Modal>;
}

function Products() {
  const [st, setSt] = useState('pending_review'); const r = useFetch<any>('/admin/products?status=' + st); const { run, busy } = useAction();
  return <><h1>مراجعة المنتجات</h1><div className="chips">{['pending_review', 'approved', 'rejected'].map(s => <button key={s} className={'chip' + (st === s ? ' on' : '')} onClick={() => setSt(s)}>{PRODUCT_STATUS[s][0]}</button>)}</div>
    <Async r={r}>{d => d.products.length ? <div className="stack">{d.products.map((p: any) => <div key={p.id} className="card"><div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <div className="pimg" style={{ width: 96, height: 96, borderRadius: 10, flexShrink: 0 }}><Img src={p.image_url} alt={p.name_ar} /></div>
      <div className="grow"><div className="row between"><b>{p.name_ar}</b><Status map={PRODUCT_STATUS} v={p.status} /></div><div className="muted small">{p.shop_name} · {p.category}{p.is_restricted && <span className="badge bad" style={{ marginRight: 6 }}>قسم مقيّد — تحقق من الترخيص</span>}</div>
        <p className="small" style={{ margin: '4px 0' }}>{p.description || 'بلا وصف'}</p>
        <div className="row small"><span>سعر التاجر: <b className="num">{money(p.merchant_price, p.currency)}</b></span>{p.preview && <span>السعر النهائي للمشتري: <b className="num price">{money(p.preview.final_price, p.currency)}</b> (+{Number(p.preview.markup_percent)}%)</span>}{p.preview_error && <span className="badge bad">{p.preview_error}</span>}<span>المخزون: <b className="num">{p.stock}</b></span><span>الصور: {p.images.length}</span></div>
        {p.review_notes && <div className="small muted">ملاحظات: {p.review_notes}</div>}
        {p.status === 'pending_review' && <div className="row" style={{ marginTop: 8 }}><button className="btn sm" disabled={busy || p.images.length === 0} title={p.images.length === 0 ? 'لا صور للمنتج' : ''} onClick={() => run(() => api(`/admin/products/${p.id}/review`, { body: { decision: 'approve' } }), 'تم اعتماد المنتج ونشره').then(() => r.reload())}>✔ اعتماد ونشر</button>
          <button className="btn sm danger" disabled={busy} onClick={() => { const n = prompt('سبب الرفض (يظهر للتاجر):'); if (n) run(() => api(`/admin/products/${p.id}/review`, { body: { decision: 'reject', notes: n } }), 'تم الرفض').then(() => r.reload()); }}>✖ رفض</button>
          {p.images.length === 0 && <span className="small muted">لا يمكن اعتماد منتج بلا صور</span>}</div>}</div></div></div>)}</div> : <div className="card empty">لا منتجات في هذه الحالة.</div>}</Async></>;
}

function Merchants() {
  const [st, setSt] = useState(''); const r = useFetch<any>('/admin/merchants' + (st ? '?status=' + st : '')); const { run, busy } = useAction();
  const act = (id: string, decision: string, ask = false) => { const reason = ask ? prompt('اكتب السبب:') : undefined; if (ask && !reason) return; run(() => api(`/admin/merchants/${id}/decision`, { body: { decision, reason } }), 'تم').then(() => r.reload()); };
  return <><h1>التجار</h1><div className="chips"><button className={'chip' + (!st ? ' on' : '')} onClick={() => setSt('')}>الكل</button>{Object.entries(MERCHANT_STATUS).map(([k, v]) => <button key={k} className={'chip' + (st === k ? ' on' : '')} onClick={() => setSt(k)}>{v[0]}</button>)}</div>
    <Async r={r}>{d => d.merchants.length ? <div className="tablewrap"><table className="t"><thead><tr><th>المحل</th><th>المالك</th><th>المحافظة</th><th>المنتجات</th><th>الحالة</th><th></th></tr></thead><tbody>{d.merchants.map((m: any) => <tr key={m.id}>
      <td><b>{m.shop_name}</b>{m.is_demo && <span className="badge warn" style={{ marginRight: 4 }}>تجريبي</span>}<div className="muted small">{dt(m.created_at)}</div></td><td>{m.full_name}<div className="num small muted" dir="ltr">{m.phone}</div></td><td>{m.governorate || '—'}</td><td className="num">{m.products}</td><td><Status map={MERCHANT_STATUS} v={m.status} /></td>
      <td><div className="row">{['pending', 'rejected'].includes(m.status) && <button className="btn sm" disabled={busy} onClick={() => act(m.id, 'approve')}>قبول</button>}{m.status === 'pending' && <button className="btn sm danger" disabled={busy} onClick={() => act(m.id, 'reject', true)}>رفض</button>}
        {m.status === 'approved' && <button className="btn sm ghost" disabled={busy} onClick={() => act(m.id, 'suspend', true)}>إيقاف</button>}{m.status === 'suspended' && <button className="btn sm" disabled={busy} onClick={() => act(m.id, 'reactivate')}>تفعيل</button>}</div></td></tr>)}</tbody></table></div> : <div className="card empty">لا تجار.</div>}</Async></>;
}

function Categories() {
  const r = useFetch<any>('/admin/categories'); const { run, busy } = useAction(); const [edit, setEdit] = useState<any>(null);
  const cats: any[] = r.data?.categories || []; const kids = (id: string | null) => cats.filter(c => c.parent_id === id);
  const rows = (id: string | null, d = 0): any[] => kids(id).flatMap(c => [{ ...c, d }, ...rows(c.id, d + 1)]);
  const save = async (e: React.FormEvent) => { e.preventDefault(); const b = { name_ar: edit.name_ar, slug: edit.slug, parent_id: edit.parent_id || null, sort_order: Number(edit.sort_order) || 0, is_active: edit.is_active, show_on_home: edit.show_on_home, is_restricted: edit.is_restricted, requires_license: edit.requires_license };
    const ok = await run(() => edit.id ? api('/admin/categories/' + edit.id, { method: 'PATCH', body: b }) : api('/admin/categories', { body: b }), 'تم الحفظ'); if (ok) { setEdit(null); r.reload(); } };
  return <><div className="row between"><h1>الأقسام</h1><button className="btn" onClick={() => setEdit({ name_ar: '', slug: '', parent_id: '', sort_order: 0, is_active: true, show_on_home: false, is_restricted: false, requires_license: false })}>＋ قسم جديد</button></div>
    <Async r={r}>{() => <div className="tablewrap"><table className="t"><thead><tr><th>القسم</th><th>المنتجات</th><th>الظهور</th><th>الترتيب</th><th></th></tr></thead><tbody>{rows(null).map(c => <tr key={c.id}><td style={{ paddingRight: 12 + c.d * 22 }}>{c.d ? '↳ ' : ''}<b>{c.name_ar}</b> <span className="muted small">{c.slug}</span>{c.is_restricted && <span className="badge bad" style={{ marginRight: 6 }}>مقيّد</span>}</td>
      <td className="num">{c.products}</td><td>{c.is_active ? <span className="badge ok">ظاهر</span> : <span className="badge">مخفي</span>}{c.show_on_home && <span className="badge info" style={{ marginRight: 4 }}>الرئيسية</span>}</td><td className="num">{c.sort_order}</td>
      <td><div className="row"><button className="btn sm secondary" onClick={() => setEdit({ ...c })}>تعديل</button><button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('/admin/categories/' + c.id, { method: 'PATCH', body: { is_active: !c.is_active } }), 'تم').then(() => r.reload())}>{c.is_active ? 'إخفاء' : 'إظهار'}</button>
        <button className="btn sm danger" disabled={busy} onClick={() => confirm('حذف القسم نهائياً؟ (لا يُسمح إن كان فيه منتجات)') && run(() => api('/admin/categories/' + c.id, { method: 'DELETE' }), 'تم الحذف').then(() => r.reload())}>حذف</button></div></td></tr>)}</tbody></table></div>}</Async>
    {edit && <Modal title={edit.id ? 'تعديل القسم' : 'قسم جديد'} onClose={() => setEdit(null)}><form className="stack" onSubmit={save}>
      <Field label="الاسم"><Input required value={edit.name_ar} onChange={e => setEdit({ ...edit, name_ar: e.target.value })} /></Field>
      <Field label="المعرّف (إنجليزي)" hint="أحرف صغيرة وأرقام وشرطات"><Input required dir="ltr" pattern="[a-z0-9-]+" value={edit.slug} onChange={e => setEdit({ ...edit, slug: e.target.value })} /></Field>
      <Field label="القسم الأب"><select className="input" value={edit.parent_id || ''} onChange={e => setEdit({ ...edit, parent_id: e.target.value })}><option value="">— رئيسي —</option>{cats.filter(c => c.id !== edit.id).map(c => <option key={c.id} value={c.id}>{c.name_ar}</option>)}</select></Field>
      <Field label="الترتيب"><Input type="number" dir="ltr" value={edit.sort_order} onChange={e => setEdit({ ...edit, sort_order: e.target.value })} /></Field>
      {([['is_active', 'ظاهر للمستخدمين'], ['show_on_home', 'يظهر في الصفحة الرئيسية'], ['is_restricted', 'قسم مقيّد (أدوية/منتجات تحتاج ترخيصاً)'], ['requires_license', 'يتطلب ترخيصاً']] as const).map(([k, l]) => <label key={k} className="row"><input type="checkbox" checked={!!edit[k]} onChange={e => setEdit({ ...edit, [k]: e.target.checked })} /> {l}</label>)}
      <button className="btn" disabled={busy}>حفظ</button></form></Modal>}</>;
}

function Pricing() {
  const r = useFetch<any>('/admin/pricing'); const { run, busy } = useAction(); const [pct, setPct] = useState(''); const [rate, setRate] = useState({ from: 'SAR', to: 'YER', v: '' });
  return <><h1>التسعير وأسعار الصرف</h1><Async r={r}>{d => <div className="stack">
    <div className="alert">السعر النهائي = سعر التاجر + (سعر التاجر × النسبة). القاعدة الأكثر تخصيصاً تُعتمد: منتج ← قسم ← تاجر ← عام. تغيير النسبة <b>لا يغيّر</b> أسعار المنتجات المنشورة إلا بقرار «إعادة تسعير» صريح.</div>
    <div className="card stack"><h3>قاعدة عامة جديدة</h3><div className="row"><Input style={{ maxWidth: 160 }} type="number" min="0" step="any" dir="ltr" placeholder="النسبة %" value={pct} onChange={e => setPct(e.target.value)} />
      <button className="btn" disabled={!pct || busy} onClick={() => run(() => api('/admin/pricing/rules', { body: { scope: 'global', markup_percent: Number(pct) } }), 'تمت الإضافة').then(() => { setPct(''); r.reload(); })}>إضافة</button>
      <button className="btn accent" disabled={busy} onClick={() => confirm('إعادة تسعير كل المنتجات المنشورة وفق القواعد الحالية؟ سيتغير ما يراه المشترون.') && run(() => api('/admin/pricing/reprice', { body: { all_approved: true } }), 'تمت إعادة التسعير').then(() => r.reload())}>إعادة تسعير كل المنتجات المنشورة</button></div></div>
    <h3>القواعد</h3><div className="tablewrap"><table className="t"><thead><tr><th>النطاق</th><th>الهدف</th><th>النسبة</th><th>الحالة</th><th></th></tr></thead><tbody>{d.rules.map((x: any) => <tr key={x.id}><td>{({ global: 'عام', merchant: 'تاجر', category: 'قسم', product: 'منتج' } as any)[x.scope]}</td><td>{x.shop_name || x.category || x.product || 'كل المنتجات'}</td>
      <td className="num">{x.is_excluded ? 'استثناء' : x.fixed_final_price ? `سعر ثابت ${x.fixed_final_price}` : `${Number(x.markup_percent)}%`}</td><td>{x.is_active ? <span className="badge ok">فعالة</span> : <span className="badge">معطلة</span>}</td>
      <td><button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('/admin/pricing/rules/' + x.id, { method: 'PATCH', body: { is_active: !x.is_active } }), 'تم').then(() => r.reload())}>{x.is_active ? 'تعطيل' : 'تفعيل'}</button></td></tr>)}</tbody></table></div>
    <h3>أسعار الصرف</h3><div className="card stack"><div className="row"><span>1</span><select className="input" style={{ width: 'auto' }} value={rate.from} onChange={e => setRate({ ...rate, from: e.target.value })}>{d.currencies.map((c: any) => <option key={c.code}>{c.code}</option>)}</select><span>=</span>
      <Input style={{ maxWidth: 140 }} type="number" min="0" step="any" dir="ltr" value={rate.v} onChange={e => setRate({ ...rate, v: e.target.value })} /><select className="input" style={{ width: 'auto' }} value={rate.to} onChange={e => setRate({ ...rate, to: e.target.value })}>{d.currencies.map((c: any) => <option key={c.code}>{c.code}</option>)}</select>
      <button className="btn" disabled={!rate.v || rate.from === rate.to || busy} onClick={() => run(() => api('/admin/exchange-rates', { body: { from_currency: rate.from, to_currency: rate.to, rate: Number(rate.v) } }), 'تم تسجيل السعر').then(() => { setRate({ ...rate, v: '' }); r.reload(); })}>تسجيل</button></div>
      <div className="hint">السعر الجديد يُنهي السابق ولا يغيّر الطلبات القديمة؛ تحتفظ كل طلبية بسعر الصرف وقت إنشائها.</div></div>
    <div className="tablewrap"><table className="t"><thead><tr><th>من</th><th>إلى</th><th>السعر</th><th>من تاريخ</th><th>حتى</th><th>بواسطة</th></tr></thead><tbody>{d.rates.map((x: any) => <tr key={x.id}><td>{x.from_currency}</td><td>{x.to_currency}</td><td className="num">{Number(x.rate)}</td><td>{dt(x.valid_from)}</td><td>{x.valid_to ? dt(x.valid_to) : <span className="badge ok">ساري</span>}</td><td>{x.by || '—'}</td></tr>)}</tbody></table></div></div>}</Async></>;
}

function Accounting() {
  const r = useFetch<any>('/admin/accounting'); const { me } = useMe(); const { run, busy } = useAction(); const [pay, setPay] = useState<any>(null);
  return <><h1>المحاسبة والمستحقات</h1><Async r={r}>{d => <div className="stack">
    <h3>أرباح المنصة (دفتر وسيطك)</h3><div className="grid g3">{d.platform.map((p: any) => <Stat key={p.kind + p.currency} v={money(p.total, p.currency)} l={({ markup_revenue: 'ربح الزيادة على المنتجات', delivery_fee: 'رسوم التوصيل', markup_reversal: 'عكس ربح (مرتجع)', adjustment: 'قيود تصحيحية' } as any)[p.kind] || p.kind} />)}{!d.platform.length && <div className="card empty">لا حركات بعد.</div>}</div>
    <h3>مستحقات التجار</h3>{d.balances.length ? <div className="tablewrap"><table className="t"><thead><tr><th>التاجر</th><th>إجمالي المبيعات</th><th>المدفوع</th><th>المتبقي</th><th></th></tr></thead><tbody>{d.balances.map((b: any) => <tr key={b.merchant_id + b.currency}><td><b>{b.shop_name}</b></td><td className="num">{money(b.total_sales_credit, b.currency)}</td><td className="num">{money(b.total_paid || 0, b.currency)}</td><td className="num bold">{money(b.balance, b.currency)}</td>
      <td>{me?.user?.permissions.includes('payouts.create') && Number(b.balance) > 0 && <button className="btn sm" onClick={() => setPay({ merchant_id: b.merchant_id, shop: b.shop_name, currency: b.currency, max: b.balance, amount: '', method: 'cash', reason: 'صرف مستحقات', key: 'pv-' + crypto.randomUUID() })}>صرف مستحقات</button>}</td></tr>)}</tbody></table></div> : <div className="card empty">لا مستحقات بعد.</div>}
    <h3>سندات الصرف والقبض</h3><div className="tablewrap"><table className="t"><thead><tr><th>السند</th><th>التاجر</th><th>المبلغ</th><th>الطريقة</th><th>المنفذ</th><th>سند القبض</th></tr></thead><tbody>{d.vouchers.map((v: any) => <tr key={v.id}><td className="num">{v.voucher_number}<div className="muted small">{dt(v.created_at)}</div></td><td>{v.shop_name}</td><td className="num">{money(v.amount, v.currency)}</td><td>{v.method === 'cash' ? 'نقداً' : 'تحويل'}</td><td>{v.issued_by}</td><td>{v.receipt_number ? <span className="badge ok">{v.receipt_number}</span> : <span className="badge warn">بانتظار تأكيد التاجر</span>}</td></tr>)}</tbody></table></div></div>}</Async>
    {pay && <Modal title={`صرف مستحقات — ${pay.shop}`} onClose={() => setPay(null)}><form className="stack" onSubmit={async e => { e.preventDefault(); const ok = await run(() => api('/admin/payouts', { body: { merchant_id: pay.merchant_id, amount: Number(pay.amount), currency: pay.currency, method: pay.method, reason: pay.reason, idempotency_key: pay.key } }), 'تم إصدار سند الصرف'); if (ok) { setPay(null); r.reload(); } }}>
      <div className="alert">المتبقي: <b className="num">{money(pay.max, pay.currency)}</b> — يمكن صرف جزء أو الكل. لا تُعدّ المستحقات مسددة نهائياً قبل تأكيد التاجر الاستلام.</div>
      <Field label="المبلغ"><Input required type="number" min="1" max={pay.max} step="any" dir="ltr" value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} /></Field>
      <Field label="الطريقة"><select className="input" value={pay.method} onChange={e => setPay({ ...pay, method: e.target.value })}><option value="cash">نقداً</option><option value="bank_transfer">تحويل مالي</option></select></Field>
      <Field label="السبب"><Input required value={pay.reason} onChange={e => setPay({ ...pay, reason: e.target.value })} /></Field><button className="btn" disabled={busy}>إصدار سند الصرف</button></form></Modal>}</>;
}

function Users() {
  const [role, setRole] = useState(''); const r = useFetch<any>('/admin/users' + (role ? '?role=' + role : '')); const { run, busy } = useAction(); const [nu, setNu] = useState<any>(null); const { me } = useMe();
  return <><div className="row between"><h1>المستخدمون والموظفون</h1><button className="btn" onClick={() => setNu({ role: 'order_staff', full_name: '', phone: '', password: '' })}>＋ موظف / مندوب</button></div>
    <div className="alert" style={{ margin: '8px 0' }}>حسابات الإدارة والموظفين والمندوبين تُنشأ من هنا فقط، ولا يمكن إنشاؤها من التسجيل العام.</div>
    <select className="input" style={{ maxWidth: 260, marginBottom: 10 }} value={role} onChange={e => setRole(e.target.value)} aria-label="الدور"><option value="">كل الأدوار</option>{r.data?.roles.map((x: any) => <option key={x.code} value={x.code}>{x.name_ar}</option>)}<option value="merchant">التاجر</option><option value="buyer">المشتري</option></select>
    <Async r={r}>{d => <div className="tablewrap"><table className="t"><thead><tr><th>الاسم</th><th>الهاتف</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th></th></tr></thead><tbody>{d.users.map((u: any) => <tr key={u.id}><td><b>{u.full_name}</b>{u.is_demo && <span className="badge warn" style={{ marginRight: 4 }}>تجريبي</span>}</td><td className="num" dir="ltr">{u.phone}</td><td>{u.role_name}</td><td>{u.status === 'active' ? <span className="badge ok">فعال</span> : <span className="badge bad">موقوف</span>}</td><td>{u.last_login_at ? dt(u.last_login_at) : '—'}</td>
      <td>{u.id !== me?.user?.id && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api('/admin/users/' + u.id, { method: 'PATCH', body: { status: u.status === 'active' ? 'suspended' : 'active' } }), 'تم').then(() => r.reload())}>{u.status === 'active' ? 'إيقاف' : 'تفعيل'}</button>}</td></tr>)}</tbody></table></div>}</Async>
    {nu && <Modal title="حساب جديد" onClose={() => setNu(null)}><form className="stack" onSubmit={async e => { e.preventDefault(); const ok = await run(() => api('/admin/users', { body: nu }), 'تم إنشاء الحساب'); if (ok) { setNu(null); r.reload(); } }}>
      <Field label="الدور"><select className="input" value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>{r.data?.roles.map((x: any) => <option key={x.code} value={x.code}>{x.name_ar}</option>)}</select></Field>
      <Field label="الاسم"><Input required value={nu.full_name} onChange={e => setNu({ ...nu, full_name: e.target.value })} /></Field><Field label="الهاتف"><Input required dir="ltr" value={nu.phone} onChange={e => setNu({ ...nu, phone: e.target.value })} /></Field>
      <Field label="كلمة مرور مؤقتة" hint="8 أحرف على الأقل. سلّمها للموظف مباشرة وليس عبر الدردشة."><Input required type="password" minLength={8} value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} /></Field><button className="btn" disabled={busy}>إنشاء</button></form></Modal>}</>;
}

const READY: Record<string, [string, string]> = { complete: ['مكتملة وجاهزة', 'ok'], db_ready: ['قاعدة البيانات جاهزة', 'info'], not_implemented: ['لم تُنفَّذ بعد', 'bad'] };
function Modules() {
  const r = useFetch<any>('/admin/modules'); const { run, busy } = useAction();
  return <><h1>إدارة وحدات النظام والميزات</h1><div className="alert" style={{ marginBottom: 12 }}>لا تُفعَّل وحدة لم تكتمل. التعطيل يخفي الوظائف ولا يحذف أي بيانات. تُفحص الاعتماديات قبل التفعيل أو التعطيل.</div>
    <Async r={r}>{d => <div className="grid g2">{d.modules.map((m: any) => <div key={m.code} className="card stack"><div className="row between"><h3 style={{ margin: 0 }}>{m.name_ar}</h3>{m.is_core ? <span className="badge">أساسية</span> : <span className={'badge ' + (m.status === 'enabled' ? 'ok' : '')}>{m.status === 'enabled' ? 'مفعّلة' : 'معطّلة'}</span>}</div>
      <div className="small muted">{m.description}</div><div className="row"><Status map={READY} v={m.readiness} />{m.depends_on.length > 0 && <span className="small muted">تعتمد على: {m.depends_on.join('، ')}</span>}</div>
      {m.requirements && <div className="small">{m.requirements}</div>}
      {!m.is_core && <button className={'btn sm ' + (m.status === 'enabled' ? 'ghost' : '')} disabled={busy || (m.status !== 'enabled' && m.readiness === 'not_implemented')} onClick={() => run(() => api('/admin/modules/' + m.code, { body: { enabled: m.status !== 'enabled' } }), 'تم').then(() => r.reload())}>
        {m.status === 'enabled' ? 'تعطيل' : m.readiness === 'not_implemented' ? 'غير جاهزة للتفعيل' : 'تفعيل'}</button>}</div>)}</div>}</Async></>;
}

function Audit() {
  const r = useFetch<any>('/admin/audit');
  return <><h1>سجل التدقيق</h1><Async r={r}>{d => <div className="tablewrap"><table className="t"><thead><tr><th>الوقت</th><th>المنفذ</th><th>العملية</th><th>الكيان</th><th>التفاصيل</th></tr></thead><tbody>{d.logs.map((l: any) => <tr key={l.id}><td>{dt(l.created_at)}</td><td>{l.actor || 'النظام'}</td><td><code>{l.action}</code></td><td>{l.entity}</td><td className="small muted" dir="ltr" style={{ maxWidth: 320, wordBreak: 'break-all' }}>{l.data}</td></tr>)}</tbody></table></div>}</Async></>;
}
