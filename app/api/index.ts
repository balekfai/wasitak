// دالة Vercel واحدة لكل مسارات /api (معيار Web: Request → Response). غير مختبرة على Vercel بعد؛ منطقها هو نفسه المختبر محلياً.
import { dispatch } from '../src/server/index';
const handler = (req: Request) => dispatch(req);
export const GET = handler, POST = handler, PUT = handler, PATCH = handler, DELETE = handler;
