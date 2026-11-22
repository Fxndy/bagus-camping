(() => {
  const STORAGE_KEY = 'rimba-rental-cart-v1';
  const REQUEST_KEY = 'bagus-checkout-request-v1';
  const $ = selector => document.querySelector(selector);
  const { esc, money, modal, request } = window.BagusUI;
  const productFor = id => window.PRODUCTS.find(product => product.id === id);
  const validItems = items => Array.isArray(items) && items.length > 0 && items.every(item => productFor(item.id) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 99);
  let cart = [];
  let pending = null;
  let config = null;
  let busy = false;
  let pendingProof = null;
  let previewUrl = null;
  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('#proofPreview').removeAttribute('src');
    $('#proofPreview').hidden = true;
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    cart = validItems(saved) ? saved : [];
  } catch { /* A blocked storage area must not prevent browsing the catalog. */ }
  try {
    const saved = JSON.parse(sessionStorage.getItem(REQUEST_KEY) || 'null');
    if (saved && /^[a-f0-9]{64}$/.test(saved.key) && typeof saved.payload === 'string') {
      const payload = JSON.parse(saved.payload);
      if (validItems(payload.items)) { pending = saved; cart = payload.items; }
    }
  } catch { pending = null; }
  const days = () => Number($('#rentalDays').value);
  const safeDays = () => Number.isInteger(days()) && days() > 0 ? days() : 1;
  const persistCart = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); } catch { /* Checkout remains server-backed without the convenience cart. */ }
  };
  const lockControls = () => {
    const locked = busy || Boolean(pending);
    $('#checkoutForm').querySelectorAll('input,textarea,fieldset,select').forEach(node => { node.disabled = locked; });
    $('#paymentProof').disabled = busy;
    $('#retryCheckoutRequest').disabled = busy || (Boolean(pending) && !pendingProof);
    $('#cartItems').querySelectorAll('button').forEach(node => { node.disabled = locked; });
    $('#checkoutSubmit').disabled = locked || !config;
    $('#checkoutSubmit').textContent = busy ? 'Menyimpan pesanan…' : 'Simpan pesanan & buka WhatsApp';
    $('#checkoutRetry').hidden = !pending;
    $('#retryCheckoutRequest').disabled = busy || (Boolean(pending) && !pendingProof);
    $('#retryCheckoutRequest').textContent = busy ? 'Memeriksa pesanan yang sama…' : pending && !pendingProof ? 'Pilih ulang bukti sebelum mencoba' : 'Coba simpan pesanan yang sama';
    $('#checkoutForm').setAttribute('aria-busy', String(busy));
  };
  const render = () => {
    $('#cartCount').textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
    $('#cartItems').innerHTML = cart.map(item => {
      const product = productFor(item.id);
      return `<article class="cart-item"><img src="${esc(product.image)}" data-fallback="${esc(window.productImageFallback(product))}" alt="${esc(product.name)}" width="64" height="64"><div><h3>${esc(product.name)}</h3><p>${money(product.pricePerDay)} / hari</p><div class="quantity-control"><button type="button" data-qty="-1" data-id="${product.id}" aria-label="Kurangi ${esc(product.name)}">−</button><span>${item.quantity}</span><button type="button" data-qty="1" data-id="${product.id}" aria-label="Tambah ${esc(product.name)}">+</button></div></div><div class="cart-item-end"><strong>${money(product.pricePerDay * item.quantity * safeDays())}</strong><button class="remove-item" type="button" data-remove="${product.id}" aria-label="Hapus ${esc(product.name)}">Hapus</button></div></article>`;
    }).join('');
    $('#cartItems').querySelectorAll('img').forEach(image => image.addEventListener('error', () => { image.src = image.dataset.fallback; }, { once: true }));
    $('#cartEmpty').hidden = cart.length > 0;
    $('#checkoutPanel').hidden = cart.length === 0;
    $('#cartTotal').textContent = money(cart.reduce((sum, item) => sum + productFor(item.id).pricePerDay * item.quantity * safeDays(), 0));
    $('#durationLine').textContent = `Durasi 1–${config?.maxRentalDays || 30} hari. Masa sewa dimulai saat admin mengonfirmasi pengambilan barang, bukan saat checkout.`;
    lockControls();
  };
  const renderInstructions = () => {
    const value = $('#checkoutForm [name="paymentMethod"]:checked')?.value;
    $('#paymentInstructions').innerHTML = window.OrderUI.paymentInstructions(value);
  };
  const loadConfig = async () => {
    $('#retryCheckoutConfig').hidden = true;
    try {
      config = await window.OrderUI.getCheckoutConfig();
      const daysSelect = $('#rentalDays');
      const savedPayload = pending ? JSON.parse(pending.payload) : null;
      const selectedDays = savedPayload?.rentalDays || Number(daysSelect.value) || 1;
      daysSelect.innerHTML = Array.from({ length: config.maxRentalDays }, (_, index) => index + 1).map(day => `<option value="${day}" ${day === Math.min(selectedDays, config.maxRentalDays) ? 'selected' : ''}>${day} ${day === 1 ? 'hari' : 'hari'}</option>`).join('');
      const selected = savedPayload ? savedPayload.paymentMethod : $('#checkoutForm [name="paymentMethod"]:checked')?.value;
      $('#paymentOptions').innerHTML = config.paymentMethods.map((method, index) => `<label class="payment-option"><input type="radio" name="paymentMethod" value="${esc(method.value)}" required ${selected === method.value || (!selected && index === 0) ? 'checked' : ''}><span>${esc(method.label)}${!method.configured ? '<small>Informasi pembayaran belum tersedia</small>' : ''}</span></label>`).join('');
      renderInstructions();
    } catch (error) {
      $('#paymentInstructions').textContent = error.message;
      $('#retryCheckoutConfig').hidden = false;
    }
    render();
  };
  const open = () => {
    render();
    modal.open('cartOverlay', close, '[data-close-cart]');
    $('#cartOpen').setAttribute('aria-expanded', 'true');
    if (!config) loadConfig();
  };
  const close = () => {
    modal.close('cartOverlay');
    $('#cartOpen').setAttribute('aria-expanded', 'false');
  };
  const reservePopup = () => {
    let popup = null;
    try {
      popup = window.open('about:blank', '_blank');
      if (popup) {
        popup.opener = null;
        popup.document.title = 'Menyimpan pesanan — Bagus Adventure';
        popup.document.body.textContent = 'Pesanan sedang disimpan. WhatsApp akan dibuka setelah invoice tersedia. Jangan tutup halaman pesanan.';
      }
    } catch { /* A visible invoice link is the fallback when popups are blocked. */ }
    return popup;
  };
  const submitPending = async () => {
    if (busy || !pending) return;
    const popup = reservePopup();
    busy = true;
    lockControls();
    const message = $('#checkoutMessage');
    message.classList.remove('success');
    message.textContent = 'Menyimpan pesanan. Jangan mengirim ulang dari tab lain.';
    try {
      let body = pending.payload;
      const headers = { 'Idempotency-Key': pending.key };
      if (pendingProof) {
        body = new FormData(); body.set('payload', pending.payload); body.set('paymentProof', pendingProof);
      } else headers['Content-Type'] = 'application/json';
      const data = await request('/api/orders', { method: 'POST', headers, body });
      if (!data.order?.invoice_id || !/^[a-f0-9]{64}$/.test(data.accessToken)) throw new Error('Jawaban pesanan belum lengkap atau token invoice tidak valid. Coba lagi dengan kunci yang sama.');
      window.OrderUI.rememberAccess(data.order.invoice_id, data.accessToken);
      const whatsappUrl = window.OrderUI.whatsappUrl(data.order, 'order');
      let popupOpened = false;
      try { if (popup && !popup.closed) { popup.location.replace(whatsappUrl); popupOpened = true; } } catch { /* Retry is available on the saved invoice, never as another order POST. */ }
      pending = null;
      pendingProof = null;
      clearPreview();
      try { sessionStorage.removeItem(REQUEST_KEY); } catch { /* The in-memory request has already been completed. */ }
      cart = [];
      persistCart();
      $('#checkoutForm').reset();
      close();
      window.OrderUI.showInvoice(data.order, { accessToken: data.accessToken, serverNow: data.serverNow, saved: true, popupOpened });
      window.OrderUI.refreshVisible();
      message.textContent = '';
      window.showToast('Pesanan tersimpan. Simpan tautan pribadi invoice Anda.');
    } catch (error) {
      try { if (popup && !popup.closed) popup.close(); } catch { /* Browsers may already have detached the blank tab. */ }
      const canDiscard = [401, 403, 404, 409, 413, 422, 429].includes(error.status);
      if (canDiscard) {
        pending = null;
        try { sessionStorage.removeItem(REQUEST_KEY); } catch { /* Keep the error visible even when storage is unavailable. */ }
      }
      message.textContent = `${error.message}${pending ? ' Rincian dikunci sementara. Gunakan tombol coba lagi di bawah; kunci permintaan tetap sama.' : ''}`;
    } finally { busy = false; render(); }
  };
  $('#checkoutForm').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || pending || !config) return;
    if (!window.Auth?.user) { $('#checkoutMessage').textContent = 'Masuk atau daftar terlebih dahulu sebelum membuat pesanan.'; window.Auth?.open('login'); return; }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const payload = { fullName: String(values.get('fullName') || '').trim(), phone: String(values.get('phone') || '').trim(), rentalDays: Number(values.get('rentalDays')), paymentMethod: String(values.get('paymentMethod') || ''), note: String(values.get('note') || '').trim(), items: cart.map(item => ({ id: item.id, quantity: item.quantity })).sort((a, b) => a.id - b.id) };
    const message = $('#checkoutMessage');
    const proof = values.get('paymentProof');
    if (!(proof instanceof File) || !proof.size) { message.textContent = 'Bukti pembayaran wajib diunggah sebelum memesan.'; return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(proof.type) || proof.size > config.maxUploadBytes) { message.textContent = 'Gunakan JPG, PNG, atau WebP maksimal 4 MB.'; return; }
    if (!validItems(payload.items)) { message.textContent = 'Pilih perlengkapan terlebih dahulu.'; return; }
    if (payload.fullName.length < 2 || payload.fullName.length > 80) { message.textContent = 'Nama lengkap harus berisi 2–80 karakter.'; return; }
    if (!/^[+0-9][0-9\s().-]{7,19}$/.test(payload.phone)) { message.textContent = 'Masukkan nomor WhatsApp yang valid.'; return; }
    if (!Number.isInteger(payload.rentalDays) || payload.rentalDays < 1 || payload.rentalDays > config.maxRentalDays) { message.textContent = `Durasi sewa harus 1–${config.maxRentalDays} hari.`; return; }
    if (!config.paymentMethods.some(method => method.value === payload.paymentMethod)) { message.textContent = 'Pilih metode pembayaran.'; return; }
    try {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const record = { key: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''), payload: JSON.stringify(payload) };
      sessionStorage.setItem(REQUEST_KEY, JSON.stringify(record));
      pending = record;
      pendingProof = proof;
    } catch {
      message.textContent = 'Penyimpanan sesi tidak tersedia. Izinkan penyimpanan situs agar pengiriman ulang tidak membuat pesanan ganda. Pesanan belum dikirim.';
      return;
    }
    submitPending();
  });
  document.addEventListener('click', event => {
    const add = event.target.closest('[data-add]');
    const quantity = event.target.closest('[data-qty]');
    const remove = event.target.closest('[data-remove]');
    if (add || quantity || remove) {
      if (busy || pending) { window.showToast('Selesaikan pengiriman pesanan sebelumnya sebelum mengubah keranjang.'); return; }
      const id = Number(add?.dataset.add || quantity?.dataset.id || remove?.dataset.remove);
      const product = productFor(id);
      if (!product) return;
      const item = cart.find(entry => entry.id === id);
      if (add) {
        if (item) item.quantity = Math.min(99, item.quantity + 1); else cart.push({ id, quantity: 1 });
        window.showToast(`${product.name} ditambahkan ke keranjang.`);
      } else if (quantity && item) item.quantity = Math.min(99, Math.max(0, item.quantity + Number(quantity.dataset.qty)));
      else if (remove) cart = cart.filter(entry => entry.id !== id);
      cart = cart.filter(entry => entry.quantity > 0);
      persistCart(); render();
    }
    if (event.target.closest('#cartOpen')) open();
    if (event.target.closest('[data-close-cart]') || event.target === $('#cartOverlay')) close();
  });
  $('#rentalDays').addEventListener('input', render);
  $('#paymentOptions').addEventListener('change', renderInstructions);
  $('#paymentProof').addEventListener('change', event => {
    clearPreview();
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > (config?.maxUploadBytes || 4 * 1024 * 1024)) {
      event.target.value = ''; $('#checkoutMessage').textContent = 'Gunakan JPG, PNG, atau WebP maksimal 4 MB.'; return;
    }
    pendingProof = file;
    $('#checkoutMessage').textContent = pending ? 'Bukti dipilih. Kirim ulang dengan kunci yang sama agar tidak membuat pesanan ganda.' : '';
    previewUrl = URL.createObjectURL(file);
    $('#proofPreview').src = previewUrl; $('#proofPreview').hidden = false;
    lockControls();
  });
  window.addEventListener('beforeunload', clearPreview);
  $('#retryCheckoutConfig').addEventListener('click', loadConfig);
  $('#retryCheckoutRequest').addEventListener('click', submitPending);
  if (pending) {
    const payload = JSON.parse(pending.payload);
    ['fullName', 'phone', 'rentalDays', 'note'].forEach(name => { $('#checkoutForm').elements.namedItem(name).value = payload[name] || ''; });
    $('#checkoutMessage').textContent = 'Pengiriman sebelumnya belum dikonfirmasi. Coba lagi dengan rincian yang sama untuk mengambil hasilnya.';
  }
  window.Cart = { render, open, close, isSubmitting: () => busy };
  render();
  loadConfig();
})();
