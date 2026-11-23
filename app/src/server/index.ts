// نقطة التجميع: استيراد المعالجات يسجل المسارات. في Next.js:
//   app/api/[...path]/route.ts  →  import { dispatch } from '@/server'; export const GET = dispatch, POST = dispatch, ...
import './handlers/public.js';
import './handlers/buyer.js';
import './handlers/merchant.js';
import './handlers/admin.js'; import './handlers/ads.js';
import './handlers/agent.js';
export { dispatch } from './core.js';
