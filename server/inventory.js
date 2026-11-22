const { state, persist } = require('./database');
const defaultImage = '/assets/images/product-default.webp';
const localImages = new Map();
for (const source of require('../assets/images/sources.json').sources) {
  localImages.set(source.url, source.files[0]);
  const photo = new URL(source.url).pathname.slice(1);
  if (!localImages.has(photo)) localImages.set(photo, source.files[0]);
}
function localImage(value) {
  if (typeof value !== 'string') return null;
  const image = value.trim();
  if (/^\/?assets\/(?:images|uploads\/products)\/[a-zA-Z0-9_-]+\.(?:webp|png|jpe?g)$/.test(image)) return image.startsWith('/') ? image : `/${image}`;
  if (localImages.has(image)) return localImages.get(image);
  try {
    const url = new URL(image.startsWith('//') ? `https:${image}` : image);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'images.unsplash.com') return localImages.get(url.pathname.slice(1)) || null;
  } catch {}
  return null;
}
const initialProducts = [
  { id: 1, name: 'Tenda Dome 2 Orang' }, { id: 2, name: 'Tenda Dome 4 Orang' },
  { id: 3, name: 'Tenda Kapasitas 6 Orang' }, { id: 4, name: 'Sleeping Bag' },
  { id: 5, name: 'Carrier 60L' }, { id: 6, name: 'Matras Camping' },
  { id: 7, name: 'Kompor Portable' }, { id: 8, name: 'Nesting Cooking Set' },
  { id: 9, name: 'Lampu Camping LED' }, { id: 10, name: 'Kursi Lipat Camping' },
  { id: 11, name: 'Meja Lipat Camping' }, { id: 12, name: 'Trekking Pole' }
];
function initialize() {
  if (!Array.isArray(state.products)) state.products = initialProducts.map((product, index) => ({ ...product, category: ['Tenda','Tenda','Tenda','Sleeping Bag','Carrier','Matras','Alat Masak','Alat Masak','Lampu Camping','Meja & Kursi','Meja & Kursi','Perlengkapan Lainnya'][index], description: '', pricePerDay: [25000,35000,50000,15000,25000,10000,15000,15000,10000,15000,20000,10000][index], image: '', photo: '' }));
  const products = state.products;
  for (const product of products) {
    product.price ??= product.pricePerDay;
    product.image = localImage(product.image) || localImage(product.photo) || defaultImage;
    delete product.photo;
  }
  if (!state.inventory || typeof state.inventory !== 'object' || Array.isArray(state.inventory)) state.inventory = {};
  for (const product of products) if (!Number.isSafeInteger(state.inventory[product.id]) || state.inventory[product.id] < 0) state.inventory[product.id] = 0;
}
const reserved = id => state.orders.filter(order => ['pending_approval','approved','waiting_pickup','active'].includes(order.order_status)).reduce((sum, order) => sum + state.orderItems.filter(item => item.order_id === order.id && item.product_id === id).reduce((qty, item) => qty + item.quantity, 0), 0);
const available = id => Math.max(0, state.inventory[id] - reserved(id));
const list = () => state.products.map(product => ({ id: product.id, name: product.name, total: state.inventory[product.id], reserved: reserved(product.id), available: available(product.id) }));
async function setStock(id, quantity) {
  if (!state.products.some(product => product.id === id)) return { status: 404, error: 'Produk tidak ditemukan.' };
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 10000) return { status: 400, error: 'Stok harus bilangan bulat 0–10000.' };
  const before = state.inventory[id];
  state.inventory[id] = quantity;
  try { await persist(); } catch (error) { state.inventory[id] = before; throw error; }
  return { status: 200, inventory: list() };
}
module.exports = { initialize, list, available, setStock, get products() { return state.products; }, localImage };
