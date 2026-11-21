// إنشاء حساب مدير النظام الأول (مرة واحدة). كلمة المرور من متغير بيئة محلي أو من الإدخال التفاعلي، لا من المحادثة.
//   ADMIN_PHONE=+9677xxxxxxx ADMIN_NAME="الاسم" ADMIN_PASSWORD='…' DATABASE_URL=… npx tsx scripts/create-admin.ts
import readline from 'node:readline/promises';
import { getDb } from '../src/server/db';
import { hashPassword, normalizePhone } from '../src/server/core';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const phone = normalizePhone(process.env.ADMIN_PHONE || await rl.question('هاتف المدير (+967…): '));
const name = process.env.ADMIN_NAME || await rl.question('اسم المدير: ');
const pw = process.env.ADMIN_PASSWORD || await rl.question('كلمة المرور (8 أحرف على الأقل): ');
rl.close();
if (pw.length < 8) { console.error('كلمة المرور قصيرة'); process.exit(1); }
const db = await getDb();
const exists = (await db.query(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'super_admin' AND NOT u.is_demo LIMIT 1`)).rows[0];
if (exists && !process.env.FORCE) { console.error('يوجد مدير نظام بالفعل. (FORCE=1 لإضافة آخر)'); await db.close(); process.exit(1); }
await db.query(`INSERT INTO users(role_id, full_name, phone, password_hash) SELECT id, $1, $2, $3 FROM roles WHERE code = 'super_admin'`, [name, phone, await hashPassword(pw)]);
console.log('تم إنشاء مدير النظام:', phone);
await db.close();
