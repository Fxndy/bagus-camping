const express = require('express');
const { state, persist } = require('./database');

const { imageUpload, saveImage, removeImage, DEFAULT_PRODUCT_IMAGE } = require('./media');

const router = express.Router();
let mutationQueue = Promise.resolve();
const mutate = handler => (req, res, next) => {
  const operation = mutationQueue.then(() => handler(req, res));
  mutationQueue = operation.catch(() => {});
  operation.catch(next);
};
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function fields(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const price = Number(body.price);
  if (name.length < 2 || name.length > 80 || category.length < 2 || category.length > 50 || description.length > 300 || !Number.isSafeInteger(price) || price < 1 || price > 100000000) {
    fail(400, 'Isi nama, kategori, deskripsi (maks. 300), dan harga yang valid.');
  }
  return { name, category, description, price, pricePerDay: price };
}

function imageRecord(image) {
  if (typeof image !== 'string') return null;
  const match = /^\/(?:assets\/)?uploads\/products\/([a-f0-9]{48}\.webp)$/.exec(image);
  if (match) return { kind: 'products', filename: match[1], url: `/assets/uploads/products/${match[1]}` };
  if (/^\/assets\/(?:images|uploads\/products)\/[a-zA-Z0-9_-]+\.(?:webp|png|jpe?g)$/.test(image)) return { static: true };
  return null;
}
function productImage(body, file, currentImage = null) {
  if (file) return saveImage(file, 'products').then(record => ({ ...record, url: `/assets/uploads/products/${record.filename}` }));
  if (body.resetImage === 'true' || body.resetImage === true || !currentImage) return DEFAULT_PRODUCT_IMAGE;
  return currentImage;
}
function activeProductOrders(productId) {
  return state.orderItems.some(item => item.product_id === productId && state.orders.some(order => order.id === item.order_id && ['pending_approval', 'approved', 'waiting_pickup', 'active'].includes(order.order_status)));
}
function restoreProduct(product, before) { Object.keys(product).forEach(key => delete product[key]); Object.assign(product, before); }
async function cleanup(image) { const record = imageRecord(image); if (record && !record.static) await removeImage(record); }

router.get('/', (req, res) => res.json({ products: state.products }));
router.post('/', imageUpload('image'), mutate(async (req, res) => {
  const products = state.products;
  const values = fields(req.body || {});
  const image = await productImage(req.body || {}, req.file);
  const product = { id: Math.max(0, ...products.map(item => item.id)) + 1, ...values, image: typeof image === 'string' ? image : image.url };
  products.push(product);
  state.inventory[product.id] = 0;
  try { await persist(); }
  catch (error) {
    products.splice(products.indexOf(product), 1);
    delete state.inventory[product.id];
    if (typeof image !== 'string') await removeImage(image).catch(() => {});
    throw error;
  }
  res.status(201).json({ product });
}));
router.patch('/:id', imageUpload('image'), mutate(async (req, res) => {
  const product = state.products.find(item => item.id === Number(req.params.id));
  if (!product) fail(404, 'Produk tidak ditemukan.');
  const values = fields(req.body || {});
  const before = { ...product };
  const image = await productImage(req.body || {}, req.file, product.image);
  const nextImage = typeof image === 'string' ? image : image.url;
  Object.assign(product, values, { image: nextImage });
  try { await persist(); }
  catch (error) {
    restoreProduct(product, before);
    if (typeof image !== 'string' && nextImage !== before.image) await removeImage(image).catch(() => {});
    throw error;
  }
  if (before.image !== nextImage) await cleanup(before.image).catch(() => {});
  res.json({ product });
}));
router.delete('/:id', mutate(async (req, res) => {
  const products = state.products;
  const index = products.findIndex(item => item.id === Number(req.params.id));
  if (index < 0) fail(404, 'Produk tidak ditemukan.');
  const product = products[index];
  if (activeProductOrders(product.id)) fail(409, 'Produk masih digunakan pesanan aktif dan tidak dapat dihapus.');
  products.splice(index, 1);
  const stock = state.inventory[product.id];
  delete state.inventory[product.id];
  try { await persist(); }
  catch (error) { products.splice(index, 0, product); if (stock !== undefined) state.inventory[product.id] = stock; throw error; }
  await cleanup(product.image).catch(() => {});
  res.json({ ok: true });
}));

module.exports = router;
