import React, { useState } from 'react';
import { Link, useRoute, useMe, api } from './common';

export interface NavItem { href: string; icon: string; label: string; section?: string }
export function DashShell({ title, nav, children, badge }: { title: string; nav: NavItem[]; children: React.ReactNode; badge?: React.ReactNode }) {
  const { path, go } = useRoute(); const { me, refresh } = useMe(); const [open, setOpen] = useState(false);
  let last = '';
  return <div className="shell">
    {open && <div className="scrim" onClick={() => setOpen(false)} />}
    <aside className={'side' + (open ? ' open' : '')} aria-label="القائمة الجانبية">
      <Link href="/" className="logo">وسيط<b>ك</b> <span className="small" style={{ opacity: .7, fontWeight: 500 }}>{title}</span></Link>
      {nav.map(n => { const head = n.section && n.section !== last ? (last = n.section, <div key={'s' + n.section} className="sec">{n.section}</div>) : null;
        return <React.Fragment key={n.href}>{head}<Link href={n.href} className={path === n.href || (n.href.length > 9 && path.startsWith(n.href + '/')) ? 'on' : ''} onClick={() => setOpen(false)}><span aria-hidden>{n.icon}</span>{n.label}</Link></React.Fragment>; })}
      <div className="sec">الحساب</div>
      <div style={{ padding: '4px 12px', fontSize: '.85rem' }}>{me?.user?.full_name}{me?.user?.is_demo && <span className="badge warn" style={{ marginRight: 6 }}>تجريبي</span>}</div>
      <a href="#" onClick={async e => { e.preventDefault(); await api('/auth/logout', { method: 'POST', body: {} }); await refresh(); go('/login'); }}>🚪 تسجيل الخروج</a>
    </aside>
    <div style={{ minWidth: 0 }}>
      <div className="mtop"><button aria-label="القائمة" onClick={() => setOpen(true)}>☰</button><b>وسيطك · {title}</b>{badge}</div>
      <div className="main">{children}</div></div></div>;
}
