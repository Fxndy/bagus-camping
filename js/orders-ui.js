(() => {
  const $ = selector => document.querySelector(selector);
  const { esc, money, modal, request, timestamp, date, calibrate, now } = window.BagusUI;
  const orderLabels = { pending_approval: 'Menunggu persetujuan', approved: 'Disetujui', waiting_pickup: 'Siap diambil', active: 'Sedang disewa', completed: 'Selesai', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
  const paymentLabels = { unpaid: 'Belum dibayar', pending_verification: 'Menunggu verifikasi', paid: 'Terverifikasi', rejected: 'Pembayaran ditolak' };
  const access = new Map();
  let checkoutConfig = null;
  let configPromise = null;
  let currentInvoice = null;
  let epoch = 0;
  let invoiceSequence = 0;
  let mySequence = 0;
  let adminSequence = 0;
  let mutating = false;
  let poll = null;
  let ticking = null;
  let invoiceSignature = '';
  const adminFilter = { search: '', status: '', paymentStatus: '', page: 1 };
  const getCheckoutConfig = async () => {
    if (checkoutConfig) return checkoutConfig;
    if (!configPromise) configPromise = request('/api/checkout-config').then(data => {
      if (!Number.isInteger(data.maxRentalDays) || data.maxRentalDays < 1 || !Array.isArray(data.paymentMethods)) throw new Error('Konfigurasi pembayaran belum lengkap. Hubungi admin atau muat ulang.');
      const methods = ['SeaBank', 'GoPay'];
      if (!methods.every(value => data.paymentMethods.some(method => method.value === value))) throw new Error('Metode pembayaran belum dapat dimuat. Coba lagi.');
      checkoutConfig = { ...data, paymentMethods: data.paymentMethods.filter(method => methods.includes(method.value)) };
      return checkoutConfig;
    }).finally(() => { configPromise = null; });
    return configPromise;
  };
  const paymentInstructions = value => {
    const method = checkoutConfig?.paymentMethods.find(entry => entry.value === value);
    if (!method) return '<p>Informasi pembayaran belum dapat dimuat. Jangan membayar sebelum admin memberikan petunjuk resmi.</p>';
    if (!method.configured) return '<p>Tujuan pembayaran belum tersedia. Hubungi admin sebelum membayar.</p>';
    const number = value === 'SeaBank' ? method.accountNumber : method.phoneNumber;
    return `<strong>Pembayaran ${esc(value)}</strong><dl class="payment-details"><div><dt>${value === 'SeaBank' ? 'Nomor rekening SeaBank' : 'Nomor GoPay'}</dt><dd>${esc(number)}</dd></div>${method.accountHolder ? `<div><dt>Atas nama</dt><dd>${esc(method.accountHolder)}</dd></div>` : ''}</dl><p>Periksa nama penerima sebelum transfer. Unggah bukti pembayaran sebelum memesan. Pembayaran diperiksa manual oleh admin.</p>`;
  };
  const rememberAccess = (invoice, token) => {
    if (!invoice || !token) return;
    access.set(invoice, token);
    try { sessionStorage.setItem(`bagus-order-${invoice}`, token); } catch { /* The visible private link still allows the customer to keep access. */ }
  };
  const tokenFor = invoice => {
    if (access.has(invoice)) return access.get(invoice);
    try { return sessionStorage.getItem(`bagus-order-${invoice}`) || ''; } catch { return ''; }
  };
  const headersFor = invoice => window.Auth?.user ? {} : (tokenFor(invoice) ? { 'x-order-token': tokenFor(invoice) } : {});
  const privateLink = invoice => {
    const token = tokenFor(invoice);
    if (!token) return '';
    const url = new URL(location.pathname, location.origin);
    url.hash = new URLSearchParams({ invoice, token }).toString();
    return url.href;
  };
  const whatsappUrl = (order, purpose = 'order') => {
    const number = String(checkoutConfig?.whatsappNumber || window.APP_CONFIG.whatsappNumber).replace(/\D/g, '');
    const opening = purpose === 'payment' ? 'Halo admin Bagus Adventure, saya ingin mengonfirmasi pembayaran pesanan berikut. Bukti pembayaran telah diunggah di situs.' : 'Halo admin Bagus Adventure, pesanan saya sudah tersimpan. Mohon konfirmasi ketersediaan dan rincian pengambilan.';
    const text = `${opening}\n\nInvoice: ${order.invoice_id}\nNama: ${order.customer_name}\nWhatsApp: ${order.customer_phone}\nDurasi: ${order.rental_days} hari (mulai setelah pengambilan dikonfirmasi)\nMetode pembayaran: ${order.payment_method}\n\nRincian pesanan:\n${(order.items || []).map((item, index) => `${index + 1}. ${item.productName}\n${item.quantity} × ${money(item.dailyPrice)} × ${order.rental_days} hari = ${money(item.subtotal)}`).join('\n')}\n\nTotal: ${money(order.total_amount)}${order.note ? `\nCatatan: ${order.note}` : ''}\nStatus pesanan: ${orderLabels[order.order_status] || order.order_status}\nStatus pembayaran: ${paymentLabels[order.payment_status] || order.payment_status}`;
    return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  };
  const badge = (status, labels, prefix) => `<span class="status-badge status-${esc(prefix)}-${Object.hasOwn(labels, status) ? esc(status) : 'unknown'}">${esc(labels[status] || 'Status belum dikenal')}</span>`;
  const statusHtml = order => `<div class="order-statuses">${badge(order.order_status, orderLabels, 'order')}${badge(order.payment_status, paymentLabels, 'payment')}${order.overdue ? '<span class="status-badge status-overdue">Terlambat dikembalikan</span>' : ''}${order.returned_late ? '<span class="status-badge status-overdue">Dikembalikan terlambat</span>' : ''}</div>`;
  const countdownText = end => {
    const difference = timestamp(end) - now();
    if (!Number.isFinite(difference)) return 'Waktu sewa belum tersedia';
    const seconds = Math.floor(Math.abs(difference) / 1000);
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    return `${difference <= 0 ? 'Melewati batas' : 'Sisa waktu'} ${d} hari ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const rentalHtml = order => {
    if (order.order_status === 'active' && order.rental_end_at) return `<div class="rental-clock"><strong data-countdown="${esc(order.rental_end_at)}" role="timer" aria-live="off">${countdownText(order.rental_end_at)}</strong><span>Batas pengembalian ${esc(date(order.rental_end_at))}</span></div>`;
    if (order.order_status === 'completed') return `<p class="rental-summary">Dikembalikan ${esc(date(order.returned_at))}${order.returned_late ? ' · Pengembalian terlambat' : ''}</p>`;
    if (['rejected', 'cancelled'].includes(order.order_status)) return '<p class="rental-summary">Masa sewa tidak dimulai.</p>';
    return '<p class="rental-summary">Hitungan sewa dimulai saat admin mengonfirmasi barang telah diambil.</p>';
  };
  const tick = () => {
    if (document.hidden) return;
    document.querySelectorAll('[data-countdown]').forEach(node => {
      node.textContent = countdownText(node.dataset.countdown);
      node.classList.toggle('past-due', timestamp(node.dataset.countdown) <= now());
    });
  };
  const itemHtml = order => `<ol class="invoice-items">${(order.items || []).map(item => `<li><div><strong>${esc(item.productName)}</strong><small>${esc(item.quantity)} × ${money(item.dailyPrice)} × ${esc(order.rental_days)} hari</small></div><b>${money(item.subtotal)}</b></li>`).join('')}</ol>`;
  const timelineHtml = order => {
    const fields = [['Dibuat', order.created_at], ['Diambil', order.picked_up_at], ['Batas pengembalian', order.rental_end_at], ['Dikembalikan', order.returned_at]];
    return `<dl class="invoice-dates">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value ? date(value) : label === 'Dibuat' ? 'Belum tercatat' : 'Belum dimulai')}</dd></div>`).join('')}</dl>`;
  };
  const adminActionsHtml = order => {
    const buttons = [];
    const action = (value, label, emphasis = false) => `<button class="button ${emphasis ? 'button-dark' : 'button-quiet'}" type="button" data-order-action="${value}" data-id="${Number(order.id)}">${label}</button>`;
    if (order.order_status === 'pending_approval') buttons.push(action('approve', 'Setujui pesanan', true), action('reject', 'Tolak pesanan'));
    if (order.order_status === 'approved') buttons.push(action('ready-pickup', 'Tandai siap diambil', true));
    if (order.order_status === 'waiting_pickup') buttons.push(action('confirm-pickup', 'Konfirmasi barang diambil', true));
    if (order.order_status === 'active') buttons.push(action('confirm-return', 'Konfirmasi barang kembali', true));
    if (['pending_approval', 'approved', 'waiting_pickup'].includes(order.order_status)) buttons.push(action('cancel', 'Batalkan pesanan'));
    const paymentButton = (value, label) => `<button class="button button-quiet" type="button" data-payment-action="${value}" data-id="${Number(order.id)}">${label}</button>`;
    let paymentActions = '';
    if (order.payment_status === 'pending_verification') paymentActions += paymentButton('confirm', 'Verifikasi pembayaran diterima');
    if (['unpaid', 'rejected'].includes(order.payment_status)) paymentActions += paymentButton('report', 'Catat laporan pembayaran');
    if (order.payment_status === 'pending_verification') paymentActions += paymentButton('reject', 'Tolak laporan pembayaran');
    const history = Array.isArray(order.history) ? order.history : [];
    return `<section class="admin-actions"><h3>Tindakan penyewaan</h3><p>Persetujuan pesanan dan verifikasi pembayaran adalah dua tindakan terpisah.</p><div class="action-row">${buttons.join('') || '<p>Tidak ada perubahan status sewa untuk pesanan ini.</p>'}</div><h3>Verifikasi pembayaran</h3>${order.verified_at ? `<p>Diverifikasi ${esc(date(order.verified_at))} oleh ${esc(order.verifiedByName || 'Admin')}.</p>` : '<p>Periksa bukti dan dana yang diterima sebelum memverifikasi.</p>'}<div class="action-row">${paymentActions || '<p>Pembayaran sudah terverifikasi.</p>'}</div></section><details class="order-history"><summary>Riwayat status (${history.length})</summary>${history.length ? `<ol>${history.map(entry => `<li><strong>${esc(orderLabels[entry.new_status] || paymentLabels[entry.new_status] || entry.new_status)}</strong><span>${entry.previous_status ? `${esc(orderLabels[entry.previous_status] || paymentLabels[entry.previous_status] || entry.previous_status)} → ` : ''}${esc(date(entry.changed_at))}</span><span>${esc(entry.changedByName || 'Sistem')}${entry.notes ? ` · ${esc(entry.notes)}` : ''}</span></li>`).join('')}</ol>` : '<p>Belum ada perubahan status yang tercatat.</p>'}</details>`;
  };
  const invoiceHtml = (order, options) => {
    const link = !options.admin && privateLink(order.invoice_id);
    const normalizedPhone = String(order.customer_phone).replace(/\D/g, '').replace(/^0/, '62');
    return `<div class="invoice-heading"><div><p class="eyebrow">INVOICE BAGUS ADVENTURE</p><h2 id="invoiceTitle" tabindex="-1">${esc(order.invoice_id)}</h2></div><div class="action-row">${!options.admin && !options.saved ? '<button class="button button-quiet" type="button" data-back-orders>Kembali ke pesanan</button>' : ''}<button class="icon-button" type="button" data-close-invoice aria-label="Tutup invoice">×</button></div></div>${options.saved ? `<p class="saved-notice">Pesanan berhasil disimpan.${options.popupOpened ? ' Draf WhatsApp telah dibuka; tekan kirim di WhatsApp untuk menghubungi admin.' : ' WhatsApp belum terbuka. Gunakan tautan di bawah tanpa membuat pesanan lagi.'}</p>` : ''}${statusHtml(order)}<div class="invoice-customer"><strong>${esc(order.customer_name)}</strong><span>WhatsApp: ${esc(order.customer_phone)}</span><span>Durasi: ${esc(order.rental_days)} hari · ${esc(order.payment_method)}</span></div>${timelineHtml(order)}${itemHtml(order)}<div class="total-line"><span>Total pembayaran</span><strong>${money(order.total_amount)}</strong></div>${order.paymentProofUrl ? `<section class="invoice-proof"><h3>Bukti pembayaran</h3><a data-payment-proof class="button button-quiet" href="${esc(order.paymentProofUrl)}" target="_blank" rel="noopener noreferrer">Lihat bukti pembayaran</a><p class="muted">Unggahan tidak berarti pembayaran sudah terverifikasi.</p></section>` : ''}${order.note ? `<p class="order-note"><b>Catatan penyewa:</b> ${esc(order.note)}</p>` : ''}${order.rejection_reason ? `<p class="form-message">Alasan penolakan: ${esc(order.rejection_reason)}</p>` : ''}${options.admin ? `<a class="button button-quiet" target="_blank" rel="noopener noreferrer" href="https://wa.me/${esc(normalizedPhone)}">Hubungi penyewa</a>${adminActionsHtml(order)}` : `<section class="invoice-payment"><h3>Petunjuk pembayaran</h3><div id="invoicePaymentInstructions" class="payment-instructions">${paymentInstructions(order.payment_method)}</div></section><div class="invoice-actions"><a class="button button-dark" data-whatsapp-order target="_blank" rel="noopener noreferrer" href="${esc(whatsappUrl(order, 'order'))}">${options.saved ? 'Buka / kirim ulang WhatsApp pesanan' : 'Hubungi admin tentang pesanan'}</a><a class="button button-quiet" target="_blank" rel="noopener noreferrer" href="${esc(whatsappUrl(order, 'payment'))}">Konfirmasi pembayaran via WhatsApp</a>${['unpaid', 'rejected'].includes(order.payment_status) && !['rejected', 'cancelled'].includes(order.order_status) ? '<button class="text-button" type="button" data-customer-payment-report>Saya sudah membayar — laporkan ke admin</button>' : ''}</div><p class="security-note">Membuka WhatsApp tidak mengubah status dan bukan bukti pesan terkirim atau pembayaran. Tombol laporan hanya mencatat klaim pembayaran; admin tetap harus memverifikasinya.</p>${link ? `<section class="private-invoice"><h3>Simpan akses invoice</h3><p>Tautan ini adalah kunci akses pribadi. Simpan sebelum menutup browser dan jangan bagikan kepada orang lain.</p><label for="privateInvoiceLink">Tautan pribadi invoice</label><input id="privateInvoiceLink" type="text" readonly value="${esc(link)}" spellcheck="false"><div class="action-row"><button class="button button-quiet" type="button" data-copy-invoice>Salin tautan</button><a class="text-button" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Buka tautan pribadi</a></div></section>` : '<p class="security-note">Invoice ini dapat dibuka kembali melalui Pesanan Saya selama Anda masuk dengan akun pemilik.</p>'}`}<div class="invoice-footer"><button class="button button-quiet" type="button" data-refresh-invoice>Perbarui status</button><span class="muted">Pembaruan ${esc(date(order.updated_at || order.created_at))}</span></div><p class="form-message" id="invoiceMessage" role="status" aria-live="polite"></p>`;
  };
  const drawInvoice = () => {
    if (!currentInvoice) return;
    const signature = JSON.stringify(currentInvoice);
    if (signature === invoiceSignature) { tick(); return; }
    const box = $('#invoiceDialog');
    const active = document.activeElement;
    const selector = active?.dataset?.refreshInvoice !== undefined ? '[data-refresh-invoice]' : active?.id === 'privateInvoiceLink' ? '#privateInvoiceLink' : null;
    const scroll = box.scrollTop;
    box.innerHTML = invoiceHtml(currentInvoice.order, currentInvoice.options);
    box.setAttribute('aria-labelledby', 'invoiceTitle');
    box.scrollTop = scroll;
    if (selector) box.querySelector(selector)?.focus({ preventScroll: true });
    invoiceSignature = signature;
    tick();
  };
  const showInvoice = (order, options = {}) => {
    invoiceSequence++;
    calibrate(options.serverNow);
    if (options.accessToken) rememberAccess(order.invoice_id, options.accessToken);
    currentInvoice = { order, options };
    invoiceSignature = '';
    drawInvoice();
    modal.open('invoiceOverlay', closeInvoice, '#invoiceTitle');
    startTimers();
    if (!options.admin && !checkoutConfig) {
      const invoice = order.invoice_id;
      getCheckoutConfig().then(() => {
        if (currentInvoice?.order.invoice_id !== invoice || currentInvoice.options.admin) return;
        invoiceSignature = ''; drawInvoice();
      }).catch(() => {});
    }
  };
  const closeInvoice = () => {
    invoiceSequence++;
    currentInvoice = null;
    invoiceSignature = '';
    modal.close('invoiceOverlay');
    $('#invoiceDialog').replaceChildren();
    stopTimersIfIdle();
  };
  const visible = node => !node.hidden && node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight;
  const refreshInvoice = async (silent = false) => {
    if (!currentInvoice || mutating) return;
    const record = currentInvoice;
    const sequence = ++invoiceSequence, startEpoch = epoch;
    const url = record.options.admin ? `/api/admin/orders/${record.order.id}` : `/api/orders/${encodeURIComponent(record.order.invoice_id)}`;
    if (!silent) $('#invoiceMessage').textContent = 'Memperbarui status pesanan…';
    try {
      const data = await request(url, { headers: record.options.admin ? {} : headersFor(record.order.invoice_id) });
      if (epoch !== startEpoch || sequence !== invoiceSequence || !currentInvoice) return;
      currentInvoice = { order: data.order, options: record.options };
      drawInvoice();
      $('#invoiceMessage').textContent = silent ? '' : 'Status sudah diperbarui.';
    } catch (error) {
      if (epoch !== startEpoch || sequence !== invoiceSequence || !currentInvoice) return;
      if ([401, 403, 404].includes(error.status) && !record.options.admin) { closeInvoice(); window.showToast('Invoice tidak dapat dibuka. Masuk dengan akun pemilik atau periksa kembali tautan pribadi.'); return; }
      $('#invoiceMessage').textContent = `${error.message} Status terakhir tetap ditampilkan.`;
    }
  };
  const loadInvoice = async (invoice, options = {}) => {
    const sequence = ++invoiceSequence, startEpoch = epoch;
    try {
      const data = await request(options.admin ? `/api/admin/orders/${encodeURIComponent(invoice)}` : `/api/orders/${encodeURIComponent(invoice)}`, { headers: options.admin ? {} : headersFor(invoice) });
      if (epoch !== startEpoch || sequence !== invoiceSequence) return;
      showInvoice(data.order, { ...options, serverNow: data.serverNow });
    } catch (error) {
      if (epoch !== startEpoch || sequence !== invoiceSequence) return;
      window.showToast(error.message);
      const message = $('#guestInvoiceMessage');
      if (message) message.textContent = error.message;
    }
  };
  const guestFormHtml = () => `<details class="guest-lookup" ${window.Auth.user ? '' : 'open'}><summary>Buka invoice dengan tautan pribadi</summary><p>Untuk pesanan tanpa akun, gunakan tautan pribadi yang disimpan dari invoice. Nomor invoice saja tidak cukup untuk membuka data penyewa.</p><form id="guestInvoiceForm"><label for="guestInvoiceUrl">Tautan pribadi invoice<input id="guestInvoiceUrl" name="invoiceLink" type="text" autocomplete="off" spellcheck="false" required placeholder="Tempel tautan invoice yang berisi #invoice=…&token=…"></label><button class="button button-dark" type="submit">Buka invoice</button><p class="form-message" id="guestInvoiceMessage" role="status"></p></form></details>`;
  const orderCard = order => `<article class="order-card"><div class="order-card-head"><div><h3>${esc(order.invoice_id)}</h3><p>Dibuat ${esc(date(order.created_at))}</p></div><strong>${money(order.total_amount)}</strong></div>${statusHtml(order)}<p class="order-products">${esc((order.items || []).map(item => `${item.productName} × ${item.quantity}`).join(', '))}</p><p>${esc(order.rental_days)} hari · ${esc(order.payment_method)}</p>${rentalHtml(order)}<button class="button button-quiet" type="button" data-owned-invoice="${esc(order.invoice_id)}" aria-label="Detail pesanan ${esc(order.invoice_id)}">Lihat invoice</button></article>`;
  const prepareOrdersPanel = () => {
    const panel = $('#ordersPanel');
    if (!$('#myOrdersContent')) panel.innerHTML = `<div class="account-head"><div><p class="eyebrow">PENYEWAAN ANDA</p><h2 tabindex="-1" id="ordersTitle">Pesanan Saya</h2></div><div class="action-row"><button class="button button-quiet" type="button" data-refresh-orders>Perbarui</button><button class="icon-button" type="button" data-close-orders aria-label="Tutup pesanan saya">×</button></div></div><p class="muted">Masa sewa, pembayaran, dan pengembalian dapat dipantau di sini.</p><div id="myOrdersContent"></div><div id="guestLookup"></div>`;
    $('#guestLookup').innerHTML = guestFormHtml();
    return panel;
  };
  const loadMyOrders = async (options = {}) => {
    const sequence = ++mySequence, startEpoch = epoch;
    if (!options.silent) {
      $('#adminPanel').hidden = true;
      adminSequence++;
      const panel = prepareOrdersPanel();
      modal.open('ordersOverlay', () => { modal.close('ordersOverlay'); stopTimersIfIdle(); }, '#ordersTitle');
      panel.hidden = false;
      if (!options.keepPosition) $('#ordersTitle').focus({ preventScroll: true });
    }
    if ($('#ordersOverlay').hidden) return;
    const content = $('#myOrdersContent');
    if (!content) return;
    if (!options.silent) content.innerHTML = '<p role="status">Memuat pesanan Anda…</p>';
    startTimers();
    await window.Auth.ready;
    if (epoch !== startEpoch || sequence !== mySequence) return;
    if (!window.Auth.user) {
      content.innerHTML = '<div class="account-empty"><p>Masuk untuk melihat pesanan yang dibuat dengan akun Anda.</p><button class="button button-dark" type="button" data-account-login>Masuk ke akun</button><p>Pesanan tamu tetap dapat dibuka menggunakan tautan pribadi di bawah.</p></div>';
      return;
    }
    try {
      const data = await request('/api/my/orders');
      if (epoch !== startEpoch || sequence !== mySequence || $('#ordersOverlay').hidden) return;
      content.innerHTML = data.orders.length ? `<div class="orders-list">${data.orders.map(orderCard).join('')}</div><p class="muted refresh-note">Status diperiksa setiap 30 detik saat panel terlihat.</p>` : '<div class="account-empty"><p>Belum ada pesanan pada akun ini. Pesanan tamu tidak otomatis masuk ke riwayat akun.</p><a class="button button-dark" href="#katalog">Pilih perlengkapan</a></div>';
      tick();
    } catch (error) {
      if (epoch !== startEpoch || sequence !== mySequence) return;
      content.innerHTML = `<p class="form-message">${esc(error.message)}</p><button class="button button-quiet" type="button" data-refresh-orders>Coba lagi</button>${error.status === 401 ? '<button class="text-button" type="button" data-account-login>Masuk kembali</button>' : ''}`;
    }
  };
  const optionsHtml = (labels, selected) => Object.entries(labels).map(([value, label]) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const prepareAdminPanel = () => {
    const panel = $('#adminPanel');
    if (!$('#adminOrdersContent')) panel.innerHTML = `<div class="account-head"><div><p class="eyebrow">ADMINISTRATOR</p><h2 id="adminTitle" tabindex="-1">Kelola penyewaan</h2></div><div class="action-row"><button class="button button-quiet" type="button" data-refresh-admin>Perbarui</button><button class="icon-button" type="button" data-close-admin aria-label="Tutup panel admin">×</button></div></div><div id="adminStats" class="admin-stats"></div><section id="adminInventory" class="inventory-panel"><h3>Stok perlengkapan</h3><p>Stok awal 0 unit. Atur jumlah fisik; unit pada pesanan aktif/menunggu pengambilan mengurangi ketersediaan.</p><div class="inventory-list">Memuat stok…</div></section><form id="adminFilterForm" class="admin-controls"><label for="adminSearch">Invoice / nama / WhatsApp<input id="adminSearch" type="search" name="search" maxlength="100" value="${esc(adminFilter.search)}" placeholder="Cari pesanan"></label><label for="adminStatus">Status sewa<select id="adminStatus" name="status"><option value="">Semua status sewa</option>${optionsHtml(orderLabels, adminFilter.status)}</select></label><label for="adminPaymentStatus">Status pembayaran<select id="adminPaymentStatus" name="paymentStatus"><option value="">Semua pembayaran</option>${optionsHtml(Object.fromEntries(Object.entries(paymentLabels).filter(([value]) => value !== 'paid')), adminFilter.paymentStatus)}</select></label><button class="button button-dark" type="submit">Terapkan filter</button></form><p class="form-message" id="adminMessage" role="status"></p><div id="adminOrdersContent"></div><div id="adminPagination" class="admin-pagination"></div>`;
    return panel;
  };
  const adminStatsHtml = stats => {
    const values = [['Menunggu persetujuan', stats.pendingApproval], ['Siap diambil', stats.waitingPickup], ['Sedang disewa', stats.activeRentals], ['Terlambat', stats.overdue], ['Selesai', stats.completed], ['Total pesanan', stats.totalOrders], ['Menunggu verifikasi', stats.awaitingVerification], ['Pembayaran terverifikasi', stats.confirmedPayments], ['Pendapatan terkonfirmasi', money(stats.confirmedRevenue)]];
    return values.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value ?? 0)}</dd></div>`).join('');
  };
  const adminRowsHtml = orders => !orders.length ? '<div class="account-empty"><p>Tidak ada pesanan yang cocok. Ubah filter atau perbarui setelah pesanan baru masuk.</p></div>' : `<div class="admin-table-wrap"><table class="admin-table"><caption class="sr-only">Pesanan sewa sesuai filter. Buka detail untuk memeriksa pembayaran dan memproses pengambilan.</caption><thead><tr><th scope="col">Invoice / penyewa</th><th scope="col">Status sewa</th><th scope="col">Pembayaran</th><th scope="col">Durasi / total</th><th scope="col">Tindakan</th></tr></thead><tbody>${orders.map(order => `<tr><td data-label="Invoice / penyewa"><strong>${esc(order.invoice_id)}</strong><span>${esc(order.customer_name)}</span><small>${esc(order.customer_phone)}</small></td><td data-label="Status sewa">${badge(order.order_status, orderLabels, 'order')}${order.overdue ? '<span class="status-badge status-overdue">Terlambat</span>' : ''}${rentalHtml(order)}</td><td data-label="Pembayaran">${badge(order.payment_status, paymentLabels, 'payment')}<small>${esc(order.payment_method)}</small></td><td data-label="Durasi / total"><strong>${money(order.total_amount)}</strong><span>${esc(order.rental_days)} hari</span></td><td data-label="Tindakan"><button class="button button-quiet" type="button" data-admin-detail="${Number(order.id)}" aria-label="Kelola ${esc(order.invoice_id)}">Kelola</button></td></tr>`).join('')}</tbody></table></div>`;
  const loadAdmin = async (options = {}) => {
    const sequence = ++adminSequence, startEpoch = epoch;
    if (!options.silent) {
      $('#ordersPanel').hidden = true;
      mySequence++;
      const panel = prepareAdminPanel();
      panel.hidden = false;
      if (!options.keepPosition) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#adminTitle').focus({ preventScroll: true }); }
    }
    if ($('#adminPanel').hidden) return;
    if (!options.silent) $('#adminMessage').textContent = 'Memuat data penyewaan…';
    await window.Auth.ready;
    if (epoch !== startEpoch || sequence !== adminSequence) return;
    if (window.Auth.user?.role !== 'admin') {
      $('#adminStats').replaceChildren();
      $('#adminOrdersContent').innerHTML = '<p>Akses ini hanya tersedia untuk administrator.</p><button class="button button-dark" type="button" data-account-login>Masuk sebagai admin</button>';
      $('#adminMessage').textContent = '';
      return;
    }
    startTimers();
    const query = new URLSearchParams({ ...adminFilter, page: String(adminFilter.page) });
    try {
      const [stats, result, inventoryResult] = await Promise.all([request('/api/admin/stats'), request(`/api/admin/orders?${query}`), request('/api/inventory')]);
      if (epoch !== startEpoch || sequence !== adminSequence || $('#adminPanel').hidden) return;
      $('#adminStats').innerHTML = `<dl>${adminStatsHtml(stats)}</dl>`;
      $('#adminOrdersContent').innerHTML = adminRowsHtml(result.orders);
      $('#adminInventory .inventory-list').innerHTML = inventoryResult.inventory.map(item => `<form class="inventory-row" data-stock-form data-product-id="${item.id}"><label>${esc(item.name)}<span>Total stok fisik</span><input type="number" name="quantity" min="0" max="10000" value="${item.total}" required></label><p>Dipesan / dipakai: ${item.reserved}<br>Tersedia: <strong>${item.available}</strong></p><button class="button button-dark" type="submit">Simpan stok</button></form>`).join('');
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      $('#adminPagination').innerHTML = `<span>${esc(result.total)} pesanan · Halaman ${esc(result.page)} dari ${pages}</span><div class="action-row"><button type="button" class="button button-quiet" data-admin-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>Sebelumnya</button><button type="button" class="button button-quiet" data-admin-page="${result.page + 1}" ${result.page >= pages ? 'disabled' : ''}>Berikutnya</button></div>`;
      $('#adminMessage').textContent = '';
      tick();
    } catch (error) {
      if (epoch !== startEpoch || sequence !== adminSequence) return;
      if ([401, 403].includes(error.status)) { $('#adminStats').replaceChildren(); $('#adminOrdersContent').replaceChildren(); $('#adminPagination').replaceChildren(); }
      $('#adminMessage').textContent = `${error.message} Gunakan Perbarui untuk mencoba lagi.`;
    }
  };
  const mutateOrder = async (id, action, payment = false) => {
    if (mutating || !currentInvoice?.options.admin || Number(currentInvoice.order.id) !== id) return;
    const confirmations = { approve: 'Setujui pesanan ini? Persetujuan tidak memverifikasi pembayaran.', reject: 'Tolak pesanan ini?', 'ready-pickup': 'Barang sudah siap diambil penyewa?', 'confirm-pickup': 'Barang benar-benar telah diambil? Tindakan ini memulai masa sewa sekarang.', 'confirm-return': 'Semua barang telah diterima kembali? Tindakan ini menyelesaikan sewa.', cancel: 'Batalkan pesanan ini sebelum pengambilan?', confirm: 'Dana sudah diperiksa dan benar-benar diterima? Tandai pembayaran terverifikasi.', report: 'Catat laporan pembayaran untuk diperiksa? Ini belum memverifikasi dana.' };
    let reason = '';
    if (!payment && action === 'reject') {
      const input = window.prompt('Alasan penolakan pesanan (minimal 3 karakter):');
      if (input === null) return;
      reason = input.trim();
      if (reason.length < 3) { $('#invoiceMessage').textContent = 'Alasan penolakan minimal 3 karakter.'; return; }
    } else if (payment && action === 'reject') {
      const input = window.prompt('Alasan penolakan pembayaran (minimal 3 karakter):');
      if (input === null) return;
      reason = input.trim();
      if (reason.length < 3) { $('#invoiceMessage').textContent = 'Alasan penolakan minimal 3 karakter.'; return; }
    } else if (!window.confirm(confirmations[action] || 'Lanjutkan perubahan ini?')) return;
    mutating = true;
    invoiceSequence++;
    adminSequence++;
    const startEpoch = epoch, invoiceId = currentInvoice.order.invoice_id;
    $('#invoiceDialog').querySelectorAll('[data-order-action],[data-payment-action],[data-refresh-invoice]').forEach(button => { button.disabled = true; });
    $('#invoiceMessage').textContent = 'Menyimpan perubahan…';
    try {
      const data = await request(`/api/admin/orders/${id}/${payment ? 'payment' : action}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment ? { action, reason } : {}) });
      if (epoch !== startEpoch) return;
      if (currentInvoice?.order.invoice_id === invoiceId && currentInvoice.options.admin) {
        currentInvoice.order = data.order;
        drawInvoice();
        $('#invoiceMessage').textContent = 'Perubahan berhasil disimpan.';
      }
      window.showToast('Status pesanan diperbarui.');
      if (!$('#adminPanel').hidden) loadAdmin({ silent: true });
    } catch (error) {
      if (epoch === startEpoch && currentInvoice?.order.invoice_id === invoiceId) {
        $('#invoiceMessage').textContent = `${error.message} Perbarui status sebelum mengulangi tindakan.`;
      }
    } finally {
      mutating = false;
      $('#invoiceDialog').querySelectorAll('[data-order-action],[data-payment-action],[data-refresh-invoice]').forEach(button => { button.disabled = false; });
    }
  };
  const reportPayment = async () => {
    if (!currentInvoice || currentInvoice.options.admin || mutating) return;
    if (!window.confirm('Anda sudah benar-benar membayar? Laporan akan menunggu pemeriksaan admin dan bukan verifikasi pembayaran.')) return;
    const order = currentInvoice.order, startEpoch = epoch;
    mutating = true;
    invoiceSequence++;
    const button = $('[data-customer-payment-report]');
    if (button) button.disabled = true;
    $('#invoiceMessage').textContent = 'Mencatat laporan pembayaran…';
    try {
      const result = await request(`/api/orders/${encodeURIComponent(order.invoice_id)}/payment-report`, { method: 'POST', headers: headersFor(order.invoice_id) });
      if (epoch !== startEpoch || currentInvoice?.order.invoice_id !== order.invoice_id) return;
      const data = result.order ? result : await request(`/api/orders/${encodeURIComponent(order.invoice_id)}`, { headers: headersFor(order.invoice_id) });
      if (epoch !== startEpoch || currentInvoice?.order.invoice_id !== order.invoice_id) return;
      currentInvoice.order = data.order;
      drawInvoice();
      $('#invoiceMessage').textContent = 'Laporan dicatat. Pembayaran masih menunggu verifikasi admin.';
    } catch (error) {
      if (epoch === startEpoch && currentInvoice?.order.invoice_id === order.invoice_id) $('#invoiceMessage').textContent = error.message;
    } finally { mutating = false; if (button?.isConnected) button.disabled = false; }
  };
  const refreshVisible = () => {
    if (document.hidden || mutating) return;
    if (currentInvoice) refreshInvoice(true);
    if (visible($('#ordersOverlay')) && window.Auth.user) loadMyOrders({ silent: true });
    if (visible($('#adminPanel')) && window.Auth.user?.role === 'admin') loadAdmin({ silent: true });
  };
  function startTimers() {
    if (!poll) poll = setInterval(refreshVisible, 30000);
    if (!ticking) ticking = setInterval(tick, 1000);
  }
  function stopTimersIfIdle() {
    if (currentInvoice || !$('#ordersOverlay').hidden || !$('#adminPanel').hidden) return;
    clearInterval(poll); clearInterval(ticking); poll = null; ticking = null;
  }
  const parsePrivateLink = value => {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin) throw new Error('Gunakan tautan invoice dari situs Bagus Adventure ini.');
    const hash = new URLSearchParams(url.hash.slice(1));
    const invoice = hash.get('invoice') || '', token = hash.get('token') || '';
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(invoice) || !/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('Tautan pribadi belum lengkap. Pastikan bagian invoice dan token tidak terpotong.');
    return { invoice, token };
  };
  const consumeHash = () => {
    if (!location.hash.startsWith('#invoice=')) return;
    try {
      const { invoice, token } = parsePrivateLink(location.href);
      rememberAccess(invoice, token);
      history.replaceState(null, '', location.pathname + location.search);
      loadInvoice(invoice);
    } catch (error) { window.showToast(error.message); }
  };
  const clearPrivateViews = () => {
    epoch++; mySequence++; adminSequence++; invoiceSequence++;
    closeInvoice();
    ['ordersPanel', 'adminPanel'].forEach(id => { const panel = document.getElementById(id); panel.hidden = true; panel.replaceChildren(); });
    access.clear();
    try { Object.keys(sessionStorage).filter(key => key.startsWith('bagus-order-')).forEach(key => sessionStorage.removeItem(key)); } catch { /* Sensitive panels are closed even if storage cannot be accessed. */ }
    clearInterval(poll); clearInterval(ticking); poll = null; ticking = null;
    adminFilter.search = ''; adminFilter.status = ''; adminFilter.paymentStatus = ''; adminFilter.page = 1;
  };
  document.addEventListener('click', async event => {
    const target = event.target;
    if (target.closest('#accountButton') || target.closest('#cartOpen')) return;
    if (target.closest('[data-close-invoice]') || target === $('#invoiceOverlay')) closeInvoice();
    if (target.closest('[data-back-orders]')) { closeInvoice(); loadMyOrders({ keepPosition: true }); }
    if (target.closest('[data-open-orders],[data-refresh-orders]')) loadMyOrders();
    if (target.closest('[data-open-admin]')) loadAdmin();
    if (target.closest('[data-refresh-admin]')) loadAdmin({ keepPosition: true });
    if (target.closest('[data-close-orders]') || target === $('#ordersOverlay')) { modal.close('ordersOverlay'); mySequence++; stopTimersIfIdle(); $('[data-open-orders]').focus(); }
    if (target.closest('[data-close-admin]')) { $('#adminPanel').hidden = true; adminSequence++; stopTimersIfIdle(); $('[data-open-admin]').focus(); }
    if (target.closest('[data-refresh-invoice]')) refreshInvoice();
    if (target.closest('[data-account-login]')) window.Auth.open('login');
    if (target.closest('[data-customer-payment-report]')) reportPayment();
    const owned = target.closest('[data-owned-invoice]');
    if (owned) loadInvoice(owned.dataset.ownedInvoice);
    const admin = target.closest('[data-admin-detail]');
    if (admin) loadInvoice(admin.dataset.adminDetail, { admin: true });
    const action = target.closest('[data-order-action],[data-payment-action]');
    if (action) mutateOrder(Number(action.dataset.id), action.dataset.orderAction || action.dataset.paymentAction, Boolean(action.dataset.paymentAction));
    const page = target.closest('[data-admin-page]');
    if (page && !page.disabled) { adminFilter.page = Number(page.dataset.adminPage); loadAdmin({ keepPosition: true }); }
    if (target.closest('[data-copy-invoice]')) {
      const input = $('#privateInvoiceLink');
      try { await navigator.clipboard.writeText(input.value); window.showToast('Tautan pribadi disalin. Simpan di tempat yang aman.'); }
      catch { input.focus(); input.select(); window.showToast('Salin tautan yang dipilih melalui menu Salin di perangkat Anda.'); }
    }
  });
  document.addEventListener('submit', event => {
    if (event.target.matches('[data-stock-form]')) {
      event.preventDefault();
      const form = event.target;
      const productId = Number(form.dataset.productId);
      const quantity = Number(new FormData(form).get('quantity'));
      const button = form.querySelector('button[type="submit"]');
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 10000) { window.showToast('Stok harus bilangan bulat 0–10000.'); return; }
      button.disabled = true;
      request(`/api/admin/inventory/${productId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity }) })
        .then(() => { window.showToast('Stok berhasil diperbarui.'); window.dispatchEvent(new Event('bagus:inventory-updated')); return loadAdmin({ keepPosition: true }); })
        .catch(error => window.showToast(error.message))
        .finally(() => { if (button.isConnected) button.disabled = false; });
    }
    if (event.target.id === 'adminFilterForm') {
      event.preventDefault();
      const form = new FormData(event.target);
      adminFilter.search = String(form.get('search') || '').trim();
      adminFilter.status = String(form.get('status') || '');
      adminFilter.paymentStatus = String(form.get('paymentStatus') || '');
      adminFilter.page = 1;
      loadAdmin({ keepPosition: true });
    }
    if (event.target.id === 'guestInvoiceForm') {
      event.preventDefault();
      try {
        const { invoice, token } = parsePrivateLink(new FormData(event.target).get('invoiceLink'));
        rememberAccess(invoice, token);
        $('#guestInvoiceMessage').textContent = 'Memeriksa akses invoice…';
        loadInvoice(invoice);
      } catch (error) { $('#guestInvoiceMessage').textContent = error.message; }
    }
  });
  document.addEventListener('bagus:auth-change', event => {
    if (!event.detail.user && event.detail.previousUser) clearPrivateViews();
    else if (event.detail.user && event.detail.previousUser?.id !== event.detail.user.id) {
      if (event.detail.previousUser) clearPrivateViews();
      if (!$('#ordersOverlay').hidden) loadMyOrders();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refreshVisible(); } });
  window.addEventListener('hashchange', consumeHash);
  window.OrderUI = { showInvoice, closeInvoice, loadMyOrders, loadAdmin, rememberAccess, whatsappUrl, getCheckoutConfig, paymentInstructions, refreshVisible, clearPrivateViews };
  consumeHash();
})();
