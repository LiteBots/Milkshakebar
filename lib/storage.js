'use strict';
// Zdjęcia z panelu. Gdy są ustawione zmienne S3_* (np. Cloudflare R2 albo AWS S3), zdjęcia trafiają do chmury
// i nie znikają przy wdrożeniu. Bez nich zapisujemy je w folderze uploads/ (na Railway: podepnij wolumen).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Typ pliku sprawdzamy po pierwszych bajtach, a nie po nagłówku od przeglądarki (ten łatwo podrobić)
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: '.jpg', type: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: '.png', type: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return { ext: '.gif', type: 'image/gif' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: '.webp', type: 'image/webp' };
  return null;
}

function createStorage({ uploadsDir, env = process.env }) {
  const s3 = env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? {
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT || undefined, // R2: https://<konto>.r2.cloudflarestorage.com
    region: env.S3_REGION || 'auto',
    publicUrl: String(env.S3_PUBLIC_URL || '').replace(/\/$/, ''), // adres, pod którym pliki są widoczne publicznie
    prefix: env.S3_PREFIX || 'uploads/'
  } : null;
  let client = null;
  const getClient = () => {
    if (!client) {
      const { S3Client } = require('@aws-sdk/client-s3');
      client = new S3Client({
        region: s3.region, endpoint: s3.endpoint, forcePathStyle: Boolean(s3.endpoint),
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
      });
    }
    return client;
  };

  async function saveImage(buffer) {
    const kind = sniffImage(buffer);
    if (!kind) throw Object.assign(new Error('To nie jest zdjęcie JPG, PNG, WebP ani GIF.'), { status: 400 });
    const name = `menu-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${kind.ext}`;
    if (s3) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const key = `${s3.prefix}${name}`;
      await getClient().send(new PutObjectCommand({
        Bucket: s3.bucket, Key: key, Body: buffer, ContentType: kind.type, CacheControl: 'public, max-age=31536000, immutable'
      }));
      return { url: s3.publicUrl ? `${s3.publicUrl}/${key}` : `/uploads/${name}`, stored: 's3' };
    }
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, name), buffer);
    return { url: `/uploads/${name}`, stored: 'disk' };
  }

  return { saveImage, mode: s3 ? 's3' : 'disk', publicUrl: s3 ? s3.publicUrl : '' };
}

module.exports = { createStorage, sniffImage };
