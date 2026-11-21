// تخزين الصور. محلياً: مجلد uploads. في Vercel: يُستبدل بـ @vercel/blob (put) دون تغيير واجهة saveImage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './core.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), '.uploads');

function sniff(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

export async function saveImage(buf: Buffer, name: string): Promise<string> {
  const kind = sniff(buf);
  if (!kind) throw new HttpError(400, 'الملف ليس صورة مدعومة (JPG أو PNG أو WebP)');
  let out = buf; let ext: string = kind;
  try {
    const sharp = (await import('sharp' as string)).default;   // اختياري: ضغط وتصغير وإزالة بيانات EXIF (خصوصية الموقع)
    out = await sharp(buf).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    ext = 'webp';
  } catch { /* sharp غير متوفر: نحفظ الأصل بعد التحقق من نوعه */ }
  if (process.env.BLOB_READ_WRITE_TOKEN) {   // Vercel Blob (خطة Hobby المجانية): غير مختبر محلياً، يُتحقق منه عند النشر
    const { put } = await import('@vercel/blob' as string);
    const r = await put(`products/${name}.${ext}`, out, { access: 'public', contentType: ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg', addRandomSuffix: false });
    return r.url as string;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, `${name}.${ext}`), out);
  return `/uploads/${name}.${ext}`;
}

export async function readUpload(file: string): Promise<{ data: Buffer; type: string } | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return null;
  try {
    const data = await fs.readFile(path.join(UPLOAD_DIR, file));
    return { data, type: file.endsWith('.webp') ? 'image/webp' : file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch { return null; }
}
