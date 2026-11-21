import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { RouterProvider, MeProvider, ToastProvider, CartProvider, useRoute, useMe, homeFor, match, Loading, Link } from './common';
import { BuyerLayout, Home, Shop, ProductPage, CartPage, Checkout, Orders, OrderDetail, Account, AuthPage } from './buyer';
import { MerchantApp } from './merchant';
import { AdminApp } from './admin';
import { AgentApp } from './agent';

function App() {
  const { path, go } = useRoute(); const { me } = useMe(); const u = me?.user;
  // توجيه تلقائي حسب نوع الحساب: الموظف/التاجر/المندوب لا يتصفحون واجهة المشتري من الجذر
  useEffect(() => { if (u && path === '/login') go(homeFor(u), true); }, [u, path]);
  if (!me) return <div className="wrap" style={{ paddingTop: 40 }}><Loading /></div>;
  if (path.startsWith('/admin')) return <AdminApp />;
  if (path.startsWith('/merchant')) return <MerchantApp />;
  if (path.startsWith('/agent')) return <AgentApp />;
  let m: any, page: React.ReactNode;
  if (path === '/') page = <Home />;
  else if (path === '/shop') page = <Shop />;
  else if ((m = match('/product/:id', path))) page = <ProductPage id={m.id} key={m.id} />;
  else if (path === '/cart') page = <CartPage />;
  else if (path === '/checkout') page = <Checkout />;
  else if (path === '/orders') page = <Orders />;
  else if ((m = match('/orders/:id', path))) page = <OrderDetail id={m.id} />;
  else if (path === '/account') page = <Account />;
  else if (path === '/login') page = <AuthPage initial="login" key="l" />;
  else if (path === '/register') page = <AuthPage initial="register" key="r" />;
  else page = <div className="card empty"><h2>الصفحة غير موجودة</h2><Link href="/" className="btn">العودة للرئيسية</Link></div>;
  return <BuyerLayout>{page}</BuyerLayout>;
}

createRoot(document.getElementById('root')!).render(
  <RouterProvider><ToastProvider><MeProvider><CartProvider><App /></CartProvider></MeProvider></ToastProvider></RouterProvider>);

// PWA: تسجيل عامل الخدمة (تثبيت التطبيق على الهاتف)
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
