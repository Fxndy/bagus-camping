(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format;
  const dateFormatter = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const readableDate = value => {
    if (!value) return 'Belum tercatat';
    const time = Date.parse(value);
    return Number.isFinite(time) ? `${dateFormatter.format(time)} WIB` : 'Tanggal tidak valid';
  };
  let user = null;
  let page = 1;
  let search = '';
  let status = '';
  let paymentStatus = '';
  let detailId = null;
  const labels = { pending_approval: 'Menunggu persetujuan', approved: 'Disetujui', waiting_pickup: 'Menunggu penjemputan', active: 'Sedang disewa', completed: 'Selesai', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
  const payLabels = { unpaid: 'Belum dibayar', pending_verification: 'Menunggu verifikasi', paid: 'Terverifikasi', rejected: 'Ditolak' };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Permintaan gagal.'), { status: response.status });
    return data;
  }
  function message(text) { $('#adminLoginMessage').textContent = text; }
  function notice(text, tone = 'success') {
    let node = $('#adminNotice');
    if (!node) { node = document.createElement('div'); node.id = 'adminNotice'; node.className = 'admin-notice'; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); document.body.append(node); }
    node.textContent = text;
    node.dataset.tone = tone;
    node.classList.add('visible');
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => node.classList.remove('visible'), 2800);
  }
  window.addEventListener('admin:notice', event => notice(event.detail?.message || 'Perubahan berhasil disimpan.', event.detail?.tone || 'success'));
  function showLogin(text = '') { $('#adminLoginPanel').hidden = false; $('#adminDashboard').hidden = true; message(text); }
  function statsHtml(stats) {
    const items = [['Total pesanan', stats.totalOrders], ['Menunggu persetujuan', stats.pendingApproval], ['Menunggu penjemputan', stats.waitingPickup], ['Sedang disewa', stats.activeRentals], ['Terlambat dikembalikan', stats.overdue], ['Selesai', stats.completed], ['Pembayaran terverifikasi', stats.confirmedPayments], ['Total terverifikasi', money(stats.confirmedRevenue)]];
    return `<div class="admin-stats">${items.map(([name, value]) => `<article><span>${name}</span><strong>${esc(value ?? 0)}</strong></article>`).join('')}</div>`;
  }
  function inventoryHtml(items) {
    return `<section class="inventory-panel"><h2>Persediaan barang</h2><button class="button button-dark" type="button" id="addProduct">Tambah barang baru</button><div class="inventory-list">${(window.adminProducts||[]).map(product=>`<article class="inventory-row"><strong>${esc(product.name)}</strong><span>${esc(product.category)} · ${money(product.pricePerDay||product.price)}/hari</span><div class="action-row"><button class="button button-quiet" data-edit-product="${product.id}">Edit</button><button class="button button-quiet" data-delete-product="${product.id}">Hapus</button></div></article>`).join('')}</div></section><section class="inventory-panel"><h2>Persediaan barang</h2><p>Pesanan menunggu pengambilan dan sedang disewa mengurangi ketersediaan. Unit kembali tersedia setelah pesanan selesai atau dibatalkan.</p><div class="inventory-list">${items.map(item => `<form class="inventory-row" data-stock-form data-id="${item.id}"><label>${esc(item.name)}<span>Stok fisik</span><input type="number" name="quantity" min="0" max="10000" value="${item.total}" required></label><p>Dipesan/dipakai: ${item.reserved}<br>Tersedia: <strong>${item.available}</strong></p><button class="button button-dark" type="submit">Simpan stok</button></form>`).join('')}</div></section>`;
  }
  function productDialogHtml() {
    return `<dialog id="productDialog" aria-labelledby="productTitle"><form id="productForm">
      <h2 id="productTitle">Tambah barang</h2><input type="hidden" name="id"><input type="hidden" name="resetImage" value="false">
      <label>Nama<input name="name" required minlength="2" maxlength="80"></label>
      <label>Kategori<input name="category" required minlength="2" maxlength="50"></label>
      <label>Harga per hari<input name="price" type="number" min="1" max="100000000" step="1" required></label>
      <label>Deskripsi<textarea name="description" maxlength="300"></textarea></label>
      <div class="product-photo-editor">
        <img id="productImagePreview" src="/assets/images/product-default.webp" alt="Pratinjau foto produk" width="240" height="180">
        <div class="product-photo-controls"><label for="productImage">Foto produk<input id="productImage" type="file" name="image" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" aria-describedby="productImageHint"></label>
        <p id="productImageHint">Satu foto JPG, PNG, atau WebP, maksimal 4 MB. Tanpa unggahan, foto saat ini tetap dipakai.</p>
        <button type="button" class="button button-quiet" id="resetProductImage">Gunakan foto bawaan</button></div>
      </div>
      <div class="action-row"><button type="button" class="button button-dark" id="saveProduct">Simpan</button><button type="button" class="button button-quiet" data-close-dialog>Tutup</button></div>
      <p role="status" aria-live="polite" id="productMessage"></p>
    </form></dialog>`;
  }
  let productPreviewUrl = null;
  function resetProductPreview(image = '/assets/images/product-default.webp') {
    const preview = $('#productImagePreview');
    if (!preview) return;
    if (productPreviewUrl) URL.revokeObjectURL(productPreviewUrl);
    productPreviewUrl = null;
    preview.src = image;
    $('#productImage').value = '';
    $('#productForm').elements.resetImage.value = image === '/assets/images/product-default.webp' ? 'true' : 'false';
  }
  async function saveProduct(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const form = event.currentTarget, button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const id = form.elements.id.value, body = new FormData(form);
    body.delete('id');
    if (!form.elements.image.files.length) body.delete('image');
    button.disabled = true;
    $('#productMessage').textContent = 'Menyimpan barang…';
    try {
      await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PATCH' : 'POST', body });
      window.dispatchEvent(new CustomEvent('admin:notice', { detail: { message: id ? 'Perubahan barang berhasil disimpan.' : 'Barang baru berhasil ditambahkan.', tone: 'success' } }));
      form.closest('dialog').close();
      await loadOrders();
      window.dispatchEvent(new Event('bagus:inventory-updated'));
    } catch (error) { $('#productMessage').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function loadOrders() {
        const query = new URLSearchParams({ page: String(page), search, status, paymentStatus });
    const [stats, result, stock, catalog] = await Promise.all([api('/api/admin/stats'), api(`/api/admin/orders?${query}`), api('/api/inventory'), api('/api/admin/products')]);
    window.adminProducts = catalog.products;
    $('#adminDashboard').innerHTML = `${productDialogHtml()}<header class="admin-head"><div><p class="eyebrow">BAGUS ADVENTURE</p><h1>Dashboard Admin</h1></div><div><button type="button" class="button button-quiet" id="logoutAdmin">Keluar</button></div></header>${statsHtml(stats)}${inventoryHtml(stock.inventory)}<section class="admin-order-section"><h2>Pesanan</h2><form id="filterOrders" class="admin-controls"><label>Cari invoice / nama / WhatsApp<input name="search" value="${esc(search)}" type="search" maxlength="100"></label><label>Status sewa<select name="status"><option value="">Semua status</option>${Object.entries(labels).map(([key, label]) => `<option value="${key}" ${status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Status pembayaran<select name="paymentStatus"><option value="">Semua pembayaran</option>${Object.entries(payLabels).filter(([key]) => key !== 'paid').map(([key, label]) => `<option value="${key}" ${paymentStatus === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button class="button button-dark">Cari</button></form><p id="adminMessage" role="status"></p>${result.orders.map(order => `<article class="admin-order-card"><header><strong>${esc(order.invoice_id)}</strong><span>${esc(order.statusLabel)} · ${esc(order.paymentStatusLabel)}</span></header><p>${esc(order.customer_name)} · ${esc(order.customer_phone)}</p><p>${order.items.map(item => `${esc(item.productName)} × ${item.quantity}`).join(', ')} · ${order.rental_days} hari</p><p>${esc(order.payment_method)} · ${money(order.total_amount)}</p>${order.overdue ? '<p class="overdue-label">Terlambat dikembalikan</p>' : ''}${order.order_status === 'active' && order.rental_end_at ? `<p class="rental-clock">Waktu pengembalian: <strong data-countdown="${esc(order.rental_end_at)}"></strong></p>` : ''}<button class="button button-quiet" data-detail="${order.id}">Kelola pesanan</button></article>`).join('') || '<p>Belum ada pesanan yang cocok.</p>'}<div class="action-row"><button type="button" class="button button-quiet" id="previousPage" ${page <= 1 ? 'disabled' : ''}>Sebelumnya</button><span>Halaman ${page}</span><button type="button" class="button button-quiet" id="nextPage" ${page * result.pageSize >= result.total ? 'disabled' : ''}>Berikutnya</button></div></section>${detailId ? await detailHtml(detailId) : ''}`;
    $('#adminLoginPanel').hidden = true;
    $('#adminDashboard').hidden = false;
    if (detailId) $('#adminDashboard .admin-detail')?.showModal();
  }
  async function detailHtml(id) {
    const { order } = await api(`/api/admin/orders/${id}`);
    const proofUrl = typeof order.paymentProofUrl === 'string' && /^\/api\/orders\/[a-zA-Z0-9_-]+\/payment-proof$/.test(order.paymentProofUrl) ? order.paymentProofUrl : null;
    const receipt = proofUrl ? `<section class="admin-payment-proof"><h3>Bukti pembayaran</h3><p>Periksa bukti dan mutasi rekening sebelum memverifikasi pembayaran.</p><a href="${esc(proofUrl)}" target="_blank" rel="noopener noreferrer"><img src="${esc(proofUrl)}" alt="Bukti pembayaran ${esc(order.invoice_id)}" width="480" height="360"><span>Buka bukti ukuran penuh</span></a></section>` : '<p class="admin-proof-missing">Bukti pembayaran belum tersedia.</p>';
    const button = (action, label) => `<button class="button button-dark" data-order-action="${action}" data-id="${id}">${label}</button>`;
    let actions = '';
    if (order.order_status === 'pending_approval') actions += button('approve', 'ACC Pesanan') + button('reject', 'Tolak Pesanan');
    if (order.order_status === 'approved') actions += button('ready-pickup', 'Siap Diambil');
    if (order.order_status === 'waiting_pickup') actions += button('confirm-pickup', 'Konfirmasi Barang Diambil');
    if (order.order_status === 'active') actions += button('confirm-return', 'Konfirmasi Pengembalian');
    if (['pending_approval', 'approved', 'waiting_pickup'].includes(order.order_status)) actions += button('cancel', 'Batalkan pesanan');
    const paymentActions = order.payment_status === 'pending_verification' ? `<button class="button button-quiet" data-payment-action="confirm" data-id="${id}">Verifikasi Pembayaran</button><button class="button button-quiet" data-payment-action="reject" data-id="${id}">Tolak Konfirmasi Pembayaran</button>` : '';
    return `<dialog class="admin-detail"><h2>${esc(order.invoice_id)} · Detail</h2><button class="button button-quiet" id="closeDetail">Tutup detail</button><p>${esc(order.statusLabel)} · ${esc(order.paymentStatusLabel)}</p><p>${esc(order.customer_name)} · ${esc(order.customer_phone)}</p><p>${order.rental_days} hari · ${esc(order.payment_method)} · ${money(order.total_amount)}</p><ul>${order.items.map(item => `<li>${esc(item.productName)} × ${item.quantity} — ${money(item.subtotal)}</li>`).join('')}</ul><p>Diambil: ${esc(readableDate(order.picked_up_at))} · Tenggat: ${esc(readableDate(order.rental_end_at))} · Kembali: ${esc(readableDate(order.returned_at))}</p><div class="action-row">${actions}</div><h3>Pembayaran terpisah</h3><p>Persetujuan pesanan tidak mengubah status pembayaran.</p>${receipt}<div class="action-row">${paymentActions || '<span>Tidak ada laporan pembayaran yang menunggu verifikasi.</span>'}</div></dialog>`;
  }
  async function refresh() {
    try {
      const result = await api('/api/auth/me'); user = result.user;
      if (!user || user.role !== 'admin') { showLogin(user ? 'Akun ini bukan admin.' : 'Masuk memakai akun admin untuk membuka dashboard.'); return; }
      await loadOrders();
    } catch (error) { showLogin(error.message); }
  }
  $('#adminLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; message('Memeriksa akun…');
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
      if (result.user.role !== 'admin') { await api('/api/auth/logout', { method: 'POST' }); throw new Error('Akun ini bukan administrator.'); }
      user = result.user; await loadOrders();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  $('#adminDashboard').addEventListener('click', event => {
    const saveButton = event.target.closest('#saveProduct');
    if (!saveButton) return;
    event.preventDefault();
    const form = $('#productForm');
    const button = saveButton;
    if (button.disabled) return;
    button.disabled = true;
    const id = form.elements.id.value;
    const body = new FormData(form);
    body.delete('id');
    if (!form.elements.image.files.length) body.delete('image');
    $('#productMessage').textContent = 'Menyimpan barang…';
    api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PATCH' : 'POST', body })
      .then(async () => {
        window.dispatchEvent(new CustomEvent('admin:notice', { detail: { message: id ? 'Perubahan barang berhasil disimpan.' : 'Barang baru berhasil ditambahkan.', tone: 'success' } }));
        form.closest('dialog').close();
        await loadOrders();
        window.dispatchEvent(new Event('bagus:inventory-updated'));
      })
      .catch(error => { $('#productMessage').textContent = error.message; })
      .finally(() => { if (button.isConnected) button.disabled = false; });
  });
  document.addEventListener('submit', async event => {
    if (event.target.id === 'filterOrders') { event.preventDefault(); const values = new FormData(event.target); search = String(values.get('search') || '').trim(); status = String(values.get('status') || ''); paymentStatus = String(values.get('paymentStatus') || ''); page = 1; await loadOrders(); }
    if (event.target.matches('[data-stock-form]')) {
      event.preventDefault(); const form = event.target; const quantity = Number(new FormData(form).get('quantity'));
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      try {
        await api(`/api/admin/inventory/${form.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
        await loadOrders();
        window.dispatchEvent(new CustomEvent('admin:notice', { detail: { message: 'Stok berhasil disimpan.', tone: 'success' } }));
      } catch (error) { $('#adminMessage').textContent = error.message; window.dispatchEvent(new CustomEvent('admin:notice', { detail: { message: `Gagal menyimpan stok: ${error.message}`, tone: 'error' } })); }
      finally { if (button.isConnected) button.disabled = false; }
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id !== 'productImage') return;
    const file = event.target.files[0];
    $('#productMessage').textContent = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      event.target.value = '';
      $('#productMessage').textContent = 'Pilih satu gambar JPG, PNG, atau WebP maksimal 4 MB.';
      return;
    }
    if (productPreviewUrl) URL.revokeObjectURL(productPreviewUrl);
    productPreviewUrl = URL.createObjectURL(file);
    $('#productImagePreview').src = productPreviewUrl;
    $('#productForm').elements.resetImage.value = 'false';
  });
  document.addEventListener('click', async event => {
    if (event.target.id === 'addProduct') { const form=$('#productForm'); form.reset(); form.elements.id.value=''; resetProductPreview(); $('#productTitle').textContent='Tambah barang'; $('#productDialog').showModal(); }
    if (event.target.id === 'resetProductImage') resetProductPreview();
    const edit=event.target.closest('[data-edit-product]'); if(edit){const product=window.adminProducts.find(item=>item.id===Number(edit.dataset.editProduct));const form=$('#productForm');form.reset();for(const key of ['id','name','category','description'])form.elements[key].value=product[key]||'';form.elements.price.value=product.pricePerDay||product.price;resetProductPreview(product.image||'/assets/images/product-default.webp');form.elements.resetImage.value='false';$('#productMessage').textContent='';$('#productTitle').textContent='Edit barang';$('#productDialog').showModal();}
    const remove=event.target.closest('[data-delete-product]'); if(remove&&window.confirm('Hapus barang ini?')){try{await api(`/api/admin/products/${remove.dataset.deleteProduct}`,{method:'DELETE'});await loadOrders();window.dispatchEvent(new Event('bagus:inventory-updated'));window.dispatchEvent(new CustomEvent('admin:notice',{detail:{message:'Barang berhasil dihapus.',tone:'success'}}));}catch(error){$('#adminMessage').textContent=error.message;window.dispatchEvent(new CustomEvent('admin:notice',{detail:{message:`Gagal menghapus barang: ${error.message}`,tone:'error'}}));}}
    if (event.target.matches('[data-close-dialog]')) event.target.closest('dialog').close();
    if (event.target.id === 'refreshAdmin') await refresh();
    if (event.target.id === 'logoutAdmin') { await api('/api/auth/logout', { method: 'POST' }); user = null; detailId = null; showLogin('Anda telah keluar.'); }
    if (event.target.id === 'previousPage' && page > 1) { page--; await loadOrders(); }
    if (event.target.id === 'nextPage') { page++; await loadOrders(); }
    if (event.target.id === 'closeDetail') { detailId = null; await loadOrders(); }
    if (event.target.matches('[data-detail]')) { detailId = Number(event.target.dataset.detail); await loadOrders(); }
    const action = event.target.closest('[data-order-action]');
    if (action) {
      const kind = action.dataset.orderAction;
      if (kind === 'reject' && !window.confirm('Tolak pesanan yang menunggu persetujuan ini?')) return;
      if (kind === 'confirm-pickup' && !window.confirm('Barang sudah benar-benar diambil? Timer sewa akan dimulai sekarang.')) return;
      try { await api(`/api/admin/orders/${action.dataset.id}/${kind}`, { method: 'PATCH', body: '{}' }); await loadOrders(); }
      catch (error) { $('#adminMessage').textContent = error.message; }
    }
    const payment = event.target.closest('[data-payment-action]');
    if (payment) {
      let reason = '';
      if (payment.dataset.paymentAction === 'reject') { reason = window.prompt('Alasan penolakan pembayaran:') || ''; if (reason.trim().length < 3) return; }
      try { await api(`/api/admin/orders/${payment.dataset.id}/payment`, { method: 'PATCH', body: JSON.stringify({ action: payment.dataset.paymentAction, reason }) }); await loadOrders(); }
      catch (error) { $('#adminMessage').textContent = error.message; }
    }
  });
  if (!location.pathname.replace(/\/$/, '').endsWith('/admin')) { document.body.hidden = true; location.replace('/admin'); }
  refresh();
  timer = setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach(node => {
      const left = Math.max(0, Date.parse(node.dataset.countdown) - Date.now());
      const s = Math.floor(left / 1000); node.textContent = left ? `${Math.floor(s / 86400)} hari ${String(Math.floor(s % 86400 / 3600)).padStart(2,'0')}:${String(Math.floor(s % 3600 / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}` : 'Terlambat dikembalikan';
    });
  }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
