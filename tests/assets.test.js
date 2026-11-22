const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const defaultImage = '/assets/images/product-default.webp';
function browserCatalog() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/products.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/config.js'), 'utf8'), context);
  return context.window;
}

test('inventory edits mutate the durable product collection across module restarts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-product-reference-'));
  const env = { ...process.env, DATA_DIR: directory };
  const file = path.join(directory, 'database.json');
  fs.writeFileSync(file, JSON.stringify({ products: [{ id: 1, name: 'Tenda uji', category: 'Tenda', pricePerDay: 25000, image: defaultImage }] }));
  try {
    const edit = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { state, persist } = require('./server/database');
      const inventory = require('./server/inventory');
      inventory.initialize();
      assert.strictEqual(inventory.products, state.products);
      assert.strictEqual(inventory.products[0], state.products[0]);
      assert.equal(state.products[0].price, 25000);
      Object.assign(inventory.products[0], { name: 'Tenda diperbarui', price: 30000, pricePerDay: 30000 });
      inventory.products.push({ id: 2, name: 'Produk tambahan', price: 10000, pricePerDay: 10000, image: '${defaultImage}' });
      persist().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(edit.status, 0, edit.stderr);
    const restart = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { state, persist } = require('./server/database');
      const inventory = require('./server/inventory');
      inventory.initialize();
      assert.equal(inventory.products[0].name, 'Tenda diperbarui');
      assert.equal(inventory.products[0].price, 30000);
      assert.equal(inventory.products.length, 2);
      inventory.products.splice(1, 1);
      persist().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).products;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Tenda diperbarui');
    assert.equal(saved[0].price, 30000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('startup migrates legacy image references without replacing local uploads', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-image-migration-'));
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'assets/images/sources.json'), 'utf8')).sources.filter(source => !source.files.includes('/assets/images/hero-camping.webp'));
  const cases = sources.flatMap(source => [
    { image: source.url, photo: '', expected: source.files[0] },
    { image: '', photo: new URL(source.url).pathname.slice(1), expected: source.files[0] }
  ]).concat([
    { image: '', photo: '', expected: defaultImage },
    { image: '  ', photo: null, expected: defaultImage },
    { image: 'https://unknown.example/image.jpg', photo: 'https://unknown.example/fallback.jpg', expected: defaultImage },
    { image: '//unknown.example/image.jpg', photo: '', expected: defaultImage },
    { image: 'data:image/svg+xml,unsafe', photo: '', expected: defaultImage },
    { image: '/assets/uploads/products/upload-kept.webp', photo: 'photo-1504280390367-361c6d9f38f4', expected: '/assets/uploads/products/upload-kept.webp' },
    { image: 'assets/images/tenda-dome.webp', photo: '', expected: '/assets/images/tenda-dome.webp' }
  ]);
  const products = cases.map((item, index) => ({ id: index + 1, name: `Produk uji ${index + 1}`, category: 'Tenda', pricePerDay: 10000, image: item.image, photo: item.photo }));
  const file = path.join(directory, 'database.json');
  fs.writeFileSync(file, JSON.stringify({ products }));
  try {
    const result = spawnSync(process.execPath, ['-e', `
      const { persist } = require('./server/database');
      const inventory = require('./server/inventory');
      inventory.initialize();
      process.stdout.write(JSON.stringify(inventory.products));
      persist().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const migrated = JSON.parse(result.stdout);
    assert.deepEqual(migrated.map(product => product.image), cases.map(item => item.expected));
    assert.ok(migrated.every(product => !product.photo));
    assert.doesNotMatch(JSON.stringify(migrated), /https?:|data:|photo-\d/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).products, migrated);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('public API keeps local images and product CRUD after a server restart', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-assets-api-'));
  const password = crypto.randomBytes(24).toString('hex');
  const env = { ...process.env, DATA_DIR: directory, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_USERNAME: 'assetadmin', ADMIN_PASSWORD: password, COOKIE_SECURE: 'false' };
  let child, base;
  async function stop() {
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  }
  async function start() {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server readiness timed out: ${errors}`)), 15000);
      child.stdout.on('data', data => { if (String(data).includes('berjalan')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }
  async function request(url, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${base}${url}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    await start();
    const catalog = await request('/api/products');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.products.length, 12);
    assert.ok(catalog.data.products.every(product => product.image === defaultImage && !product.photo));
    const browser = browserCatalog();
    for (const image of new Set([defaultImage, browser.APP_CONFIG.heroImage, ...browser.PRODUCTS.map(product => product.image)])) {
      const response = await fetch(`${base}${image}`);
      assert.equal(response.status, 200, image);
      assert.match(response.headers.get('content-type'), /^image\/webp/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.equals(fs.readFileSync(path.join(root, image.slice(1)))));
    }
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'assetadmin', password } });
    assert.equal(login.status, 200);
    const cookie = login.cookie;
    const create = await request('/api/admin/products', { method: 'POST', cookie, body: { name: 'Produk uji aset', category: 'Tenda', description: '', price: 17000, image: defaultImage } });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    const id = create.data.product.id;
    assert.equal(create.data.product.image, defaultImage);
    const update = await request(`/api/admin/products/${id}`, { method: 'PATCH', cookie, body: { name: 'Produk uji diperbarui', category: 'Tenda', description: 'Verifikasi restart', price: 19000, image: defaultImage } });
    assert.equal(update.status, 200, JSON.stringify(update.data));
    assert.equal((await request('/api/admin/products/12', { method: 'DELETE', cookie })).status, 200);
    await stop();
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'database.json'), 'utf8')).products;
    assert.equal(saved.find(product => product.id === id).price, 19000);
    assert.ok(!saved.some(product => product.id === 12));
    await start();
    const restarted = await request('/api/products');
    assert.equal(restarted.status, 200);
    assert.deepEqual(restarted.data.products.map(({ photo, ...product }) => product), saved.map(({ photo, ...product }) => product));
    assert.ok(restarted.data.products.every(product => product.image === defaultImage && !product.photo));
    assert.doesNotMatch(JSON.stringify(restarted.data), /https?:|data:|photo-\d/);
  } finally { await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('catalog refresh replaces empty API images with the shared default', async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', value: '', classList: { contains: () => false, add() {}, remove() {} }, addEventListener() {} });
    return nodes.get(selector);
  };
  const window = { addEventListener() {}, dispatchEvent() {} };
  const context = vm.createContext({
    window,
    document: { body: node('body'), querySelector: selector => selector === '#faq details' ? null : node(selector), querySelectorAll: () => [], addEventListener() {} },
    location: { pathname: '/' }, performance, Event, AbortController, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async url => ({ ok: true, json: async () => url === '/api/inventory' ? { inventory: [{ id: 1, available: 1 }] } : { products: [{ id: 1, name: 'Produk tanpa gambar', category: 'Tenda', description: '', price: 10000, image: '' }] } })
  });
  for (const file of ['js/products.js', 'js/config.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.PRODUCTS.length, 1);
  assert.equal(window.PRODUCTS[0].image, defaultImage);
  assert.match(node('#productGrid').innerHTML, /src="\/assets\/images\/product-default\.webp"/);
  assert.doesNotMatch(node('#productGrid').innerHTML, /src=""|images\.unsplash\.com/);
});

test('browser images and fallbacks never request a remote image', () => {
  const browser = browserCatalog();
  assert.equal(browser.productImageFallback({ photo: 'photo-1504280390367-361c6d9f38f4' }), defaultImage);
  assert.equal(browser.productImageFallback({ image: '', photo: '' }), defaultImage);
  assert.equal(browser.productImageFallback(), defaultImage);
  assert.equal(browser.APP_CONFIG.heroImageFallback, browser.APP_CONFIG.heroImage);
  for (const product of browser.PRODUCTS) {
    assert.match(product.image, /^\/assets\/images\/[a-z0-9-]+\.webp$/);
    assert.ok(!product.photo);
  }
  for (const file of ['js/products.js', 'js/config.js', 'js/app.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /images\.unsplash\.com|photo-\d/);
  }
});

test('asset image lookup supports common raster extensions and rejects unsupported suffixes', () => {
  const { localImage } = require('../server/inventory');
  for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
    assert.equal(localImage(`/assets/images/catalog.${extension}`), `/assets/images/catalog.${extension}`);
    assert.equal(localImage(`/assets/uploads/products/catalog.${extension}`), `/assets/uploads/products/catalog.${extension}`);
  }
  for (const extension of ['svg', 'gif', 'avif']) assert.equal(localImage(`/assets/images/catalog.${extension}`), null);
});

test('catalog, hero and shared default images are real local WebP files', async () => {
  const browser = browserCatalog();
  const images = new Set([...browser.PRODUCTS.map(product => product.image), browser.APP_CONFIG.heroImage, defaultImage]);
  for (const image of images) {
    assert.match(image, /^\/?assets\/images\/[a-z0-9-]+\.webp$/);
    const file = path.join(root, image.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `Missing local image: ${image}`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > 1000, `Empty image: ${image}`);
    const sharp = require('sharp');
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'webp');
    assert.ok(metadata.width >= 100 && metadata.height >= 100);
    await sharp(bytes).raw().toBuffer();
  }
});
