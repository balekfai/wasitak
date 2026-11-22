// دالة Vercel واحدة لكل مسارات /api (معيار Web: Request → Response).
// vercel.json يحوّل /api/* إلى /api/index?__path=... فنقرأ المسار الأصلي من __path.
import { dispatch } from '../src/server/index.js';
const handler = (req: Request) => {
  const p = new URL(req.url).searchParams.get('__path');
  return dispatch(req, p === null ? undefined : '/' + p.replace(/^\/+/, ''));
};
export const GET = handler, POST = handler, PUT = handler, PATCH = handler, DELETE = handler;
