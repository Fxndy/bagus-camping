const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { filePath, currentRequest } = require('./database');
const { maxUploadBytes } = require('./settings');

const DEFAULT_PRODUCT_IMAGE = '/assets/images/product-default.webp';
const uploadsDir = path.join(path.dirname(filePath), 'uploads');
const error = (status, message) => Object.assign(new Error(message), { status });
function imageUpload(fieldName) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 10, fieldSize: 12 * 1024, parts: 12 },
    fileFilter(req, file, done) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return done(error(400, 'Gunakan gambar JPG, PNG, atau WebP.'));
      done(null, true);
    }
  }).single(fieldName);
  return (req, res, next) => upload(req, res, err => {
    if (err instanceof multer.MulterError) return next(error(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran gambar maksimal 4 MB.' : 'Unggah satu gambar dengan data formulir yang valid.'));
    next(err);
  });
}
async function saveImage(file, kind) {
  if (!['products', 'proofs'].includes(kind)) throw new Error('Jenis penyimpanan tidak valid.');
  if (!file?.buffer?.length) throw error(400, kind === 'proofs' ? 'Bukti pembayaran wajib diunggah sebelum memesan.' : 'Pilih satu gambar produk.');
  if (file.buffer.length > maxUploadBytes) throw error(413, 'Ukuran gambar maksimal 4 MB.');
  const buffer = file.buffer;
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) throw error(400, 'Isi berkas harus berupa gambar JPG, PNG, atau WebP yang valid.');
  let image;
  try {
    const input = sharp(buffer, { limitInputPixels: 24000000, failOn: 'warning' });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || metadata.pages > 1) throw new Error('Format gambar tidak didukung');
    image = await input.rotate().resize({ width: kind === 'proofs' ? 2400 : 1600, height: kind === 'proofs' ? 2400 : 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch { throw error(400, 'Gambar rusak, terlalu besar, atau formatnya tidak didukung. Gunakan JPG, PNG, atau WebP tanpa animasi.'); }
  const filename = `${crypto.randomBytes(24).toString('hex')}.webp`;
  const destination = path.join(uploadsDir, kind, filename);
  const store = currentRequest()?.media;
  if (store) await store.set(`${kind}/${filename}`, new Blob([image], { type: 'image/webp' }));
  else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, image, { flag: 'wx', mode: 0o600 });
  }
  return { filename, path: destination, kind, url: kind === 'products' ? `/uploads/products/${filename}` : null, uploadedAt: new Date().toISOString() };
}
async function removeImage(record) {
  if (!record) return;
  let kind = record.kind;
  let filename = record.filename;
  const url = typeof record === 'string' ? record : record.url;
  const match = typeof url === 'string' && /^\/assets\/uploads\/products\/([a-f0-9]{48}\.webp)$/.exec(url);
  if (match) { kind = 'products'; filename = match[1]; }
  if (!['products', 'proofs'].includes(kind) || !/^[a-f0-9]{48}\.webp$/.test(filename || '')) return;
  const store = currentRequest()?.media;
  if (store) await store.delete(`${kind}/${filename}`);
  else await fs.rm(path.join(uploadsDir, kind, filename), { force: true });
}
async function readImage(kind, filename) {
  if (!['products', 'proofs'].includes(kind) || !/^[a-f0-9]{48}\.webp$/.test(filename)) return null;
  const store = currentRequest()?.media;
  if (store) {
    const image = await store.get(`${kind}/${filename}`, { type: 'arrayBuffer' });
    return image ? Buffer.from(image instanceof Blob ? await image.arrayBuffer() : image) : null;
  }
  try { return await fs.readFile(path.join(uploadsDir, kind, filename)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
module.exports = { imageUpload, saveImage, removeImage, readImage, DEFAULT_PRODUCT_IMAGE, uploadsDir };
