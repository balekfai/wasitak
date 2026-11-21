// نقطة التجميع: استيراد المعالجات يسجل المسارات. في Next.js:
//   app/api/[...path]/route.ts  →  import { dispatch } from '@/server'; export const GET = dispatch, POST = dispatch, ...
import './handlers/public';
import './handlers/buyer';
import './handlers/merchant';
import './handlers/admin';
import './handlers/agent';
export { dispatch } from './core';
