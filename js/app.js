(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0});
  let selectedCategory='Semua';
  let availability = new Map();
  let pendingAdd = null;
  let inventoryRefresh;
  const loadAvailability = async () => {
    try { const [data, catalog] = await Promise.all([window.BagusUI.request('/api/inventory'), window.BagusUI.request('/api/products')]); availability = new Map(data.inventory.map(item => [item.id, item])); window.PRODUCTS = catalog.products.map(product => ({...product, pricePerDay: product.pricePerDay ?? product.price, image: product.image || window.productImageFallback()})); window.categoryNames = [...new Set(window.PRODUCTS.map(product => product.category))]; renderCategories(); renderFilters(); renderProducts(); }
    catch { availability = new Map(); renderProducts(); }
  };
  const addToCart = id => { const button = document.querySelector(`[data-add="${id}"]`); if (button && !button.disabled) button.click(); };
  const requestLoginForCart = id => { pendingAdd = id; window.showToast('Masuk atau daftar terlebih dahulu untuk menambah alat ke keranjang.'); window.Auth.open('login'); };
  const signedInAdd = event => {
    const add = event.target.closest('[data-add]');
    if (add && !window.Auth?.user) { event.preventDefault(); event.stopImmediatePropagation(); requestLoginForCart(Number(add.dataset.add)); }
  };
  document.addEventListener('click', signedInAdd, true);
  document.addEventListener('bagus:auth-change', event => {
    if (event.detail.user && pendingAdd) { const id = pendingAdd; pendingAdd = null; setTimeout(() => addToCart(id), 0); }
  });
  document.addEventListener('bagus:inventory-updated', loadAvailability);
  window.addEventListener('focus', loadAvailability);
  inventoryRefresh = setInterval(() => { if (!document.hidden) loadAvailability(); }, 30000);
  window.addEventListener('beforeunload', () => clearInterval(inventoryRefresh));
  if (location.pathname.replace(/\/$/, '') === '/admin') document.body.classList.add('admin-route');
  if (document.body.classList.contains('admin-route')) {
    document.querySelectorAll('main > section:not(#adminPanel), footer').forEach(node => node.hidden = true);
    document.querySelector('#adminPanel').hidden = false;
    document.querySelector('#adminPanel').innerHTML = '<div class="account-head"><div><p class="eyebrow">ADMINISTRATOR</p><h1 id="adminRouteTitle">Dashboard Bagus Adventure</h1></div><p id="adminRouteMessage" role="status">Memeriksa akses administrator…</p></div>';
  }
  window.addEventListener('load', () => {
    if (document.body.classList.contains('admin-route')) window.Auth?.ready?.then(() => window.Auth.user?.role === 'admin' ? window.OrderUI.loadAdmin({ keepPosition: true }) : (document.querySelector('#adminRouteMessage').textContent = 'Masuk menggunakan akun administrator untuk membuka dashboard.', window.Auth.open('login')));
  });
  window.addEventListener('storage', event => { if (event.key === 'bagus-inventory-refresh') loadAvailability(); });
  window.dispatchEvent(new Event('bagus:app-ready'));
  window.adminRoute = document.body.classList.contains('admin-route');
  window.addEventListener('popstate', () => { if (location.pathname === '/admin') location.reload(); });
  window.showAdminRoute = () => { location.assign('/admin'); };
  window.showCatalogRoute = () => { location.assign('/'); };
  
  const categorySymbols={'Tenda':'T','Sleeping Bag':'S','Carrier':'C','Matras':'M','Alat Masak':'A','Lampu Camping':'L','Meja & Kursi':'K','Perlengkapan Lainnya':'+'};
  const setCategory = category => { selectedCategory=category; renderCategories();renderFilters();renderProducts();document.querySelector('#katalog').scrollIntoView({behavior:'smooth',block:'start'}); };
  let toastTimer;
  window.showToast=text=>{const node=$('#toast');node.textContent=text;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),2600);};
  const categoryMarkup = category => `<button class="category-tile ${selectedCategory===category?'active':''}" type="button" data-category="${escapeHtml(category)}"><span class="category-art" aria-hidden="true">${categorySymbols[category]||'+'}</span><span>${escapeHtml(category)}</span></button>`;
  const renderCategories = () => { $('#categoryList').innerHTML=window.categoryNames.map(categoryMarkup).join(''); };
  const renderFilters = () => { $('#filterRow').innerHTML=['Semua',...window.categoryNames].map(category=>`<button class="filter-chip ${selectedCategory===category?'active':''}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join(''); };
  const renderProducts = () => {
    const search=$('#searchInput');
    const query=search ? search.value.trim().toLocaleLowerCase('id-ID') : '';
    const items=window.PRODUCTS.filter(product=>(selectedCategory==='Semua'||product.category===selectedCategory)&&`${product.name} ${product.category} ${product.description}`.toLocaleLowerCase('id-ID').includes(query));
    $('#productGrid').innerHTML=items.map(product=>{const stock=availability.get(product.id);const count=stock?.available??0;return `<article class="product-card"><div class="product-photo"><img src="${escapeHtml(product.image)}" data-fallback="${escapeHtml(window.productImageFallback(product))}" alt="${escapeHtml(product.name)} untuk disewa" loading="lazy" width="800" height="580" onerror="this.onerror=null;this.src=this.dataset.fallback"></div><div class="product-info"><p class="product-category">${escapeHtml(product.category)}</p><h3>${escapeHtml(product.name)}</h3><p class="product-description">${escapeHtml(product.description)}</p><p class="stock-status ${count?'stock-available':'stock-empty'}" aria-live="polite">${stock?count?`Tersedia ${count} unit`:'Stok habis':'Memuat ketersediaan…'}</p><div class="product-bottom"><span class="product-price">${money.format(product.pricePerDay)} <small>/ hari</small></span><button class="add-button" type="button" data-add="${product.id}" ${!stock||count<1?'disabled':''}>${count?'Tambah ke keranjang':'Tidak tersedia'}</button></div></div></article>`;}).join('');
    $('#emptyProducts').hidden=items.length!==0;
  };
  document.addEventListener('click',event=>{const button=event.target.closest('[data-category]');if(button)setCategory(button.dataset.category);});
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-profile-action]')?.dataset.profileAction;
    if (action === 'login' || action === 'register') window.Auth.open(action);
    if (action === 'orders') window.OrderUI.loadMyOrders();
    if (action === 'admin') window.showAdminRoute();
  });
  $('#searchInput').addEventListener('input',renderProducts);
  $('#menuToggle').addEventListener('click',()=>{const nav=$('#mainNav');const open=!nav.classList.contains('open');nav.classList.toggle('open',open);$('#menuToggle').setAttribute('aria-expanded',String(open));});
  $('#mainNav').addEventListener('click',event=>{if(event.target.closest('a')){$('#mainNav').classList.remove('open');$('#menuToggle').setAttribute('aria-expanded','false');}});
  $('#contactLink').href=`https://wa.me/${window.APP_CONFIG.whatsappNumber.replace(/\D/g,'')}?text=${encodeURIComponent('Halo admin Bagus Adventure, saya ingin bertanya tentang penyewaan alat camping.')}`;
  document.querySelectorAll('#cara-sewa .steps h3').forEach((node,index)=>{node.textContent=['Pilih peralatan','Atur durasi sewa','Kirim permintaan pesanan','Konfirmasi pengambilan'][index]||node.textContent;});
  const rentalStep = document.querySelectorAll('#cara-sewa .steps p');
  if(rentalStep[1])rentalStep[1].textContent='Pilih jumlah hari; waktu sewa dimulai saat barang diambil.';
  if(rentalStep[2])rentalStep[2].textContent='Pilih pembayaran dan simpan invoice dengan tautan pribadi.';
  if(rentalStep[3])rentalStep[3].textContent='Admin memeriksa pesanan dan pembayaran secara terpisah.';
  document.querySelectorAll('#cara-sewa .steps article>span').forEach((node,index)=>{node.textContent=String(index+1).padStart(2,'0');});
  const rentalFaq=document.querySelector('#faq details');
  if(rentalFaq){rentalFaq.querySelector('summary').textContent='Kapan hitungan sewa dimulai?';rentalFaq.querySelector('p').textContent='Masa sewa dimulai ketika admin mengonfirmasi barang telah diambil. Durasi yang Anda pilih menentukan batas pengembalian; hitung mundur tidak mengubah status pesanan.';}
  const bookingFaq=document.querySelectorAll('#faq details');
  if(bookingFaq[1])bookingFaq[1].querySelector('p').textContent='Pesanan menunggu persetujuan. Ketersediaan dan pengambilan dikonfirmasi admin sebelum masa sewa dimulai.';
  if(bookingFaq[2])bookingFaq[2].querySelector('p').textContent='Pilih SeaBank atau GoPay, transfer ke nomor tujuan, lalu unggah bukti pembayaran sebelum mengirim pesanan. Pembayaran menunggu verifikasi manual admin.';
  document.querySelectorAll('[data-business]').forEach(node=>node.textContent=window.APP_CONFIG.businessName);
  document.querySelectorAll('[data-phone]').forEach(node=>node.textContent=window.APP_CONFIG.contactPhone);
  document.querySelectorAll('[data-address]').forEach(node=>node.textContent=window.APP_CONFIG.address);
  $('#year').textContent=new Date().getFullYear();
  window.showToast=text=>{const node=$('#toast');node.textContent=text;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),2600);};
  const focusable = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  let activeModal = null;
  const modal = {
    open(id, close, focusSelector) {
      if (activeModal?.id === id) return;
      if (activeModal) activeModal.close();
      const overlay = document.getElementById(id);
      const trigger = document.activeElement;
      overlay.hidden = false;
      activeModal = { id, close, trigger };
      document.body.classList.add('no-scroll');
      document.querySelectorAll('body > header, body > main, body > footer').forEach(node => { node.inert = true; });
      const target = overlay.querySelector(focusSelector || focusable) || overlay.querySelector('[role="dialog"]');
      target?.focus({ preventScroll: true });
    },
    close(id) {
      document.getElementById(id).hidden = true;
      if (activeModal?.id !== id) return;
      const trigger = activeModal.trigger;
      activeModal = null;
      document.body.classList.remove('no-scroll');
      document.querySelectorAll('body > header, body > main, body > footer').forEach(node => { node.inert = false; });
      if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus({ preventScroll: true });
    }
  };
  document.addEventListener('keydown', event => {
    if (!activeModal) {
      if (event.key === 'Escape') {
        $('#mainNav').classList.remove('open');
        $('#menuToggle').setAttribute('aria-expanded', 'false');
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); activeModal.close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...document.getElementById(activeModal.id).querySelectorAll(focusable)].filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  let clock = { server: Date.now(), local: performance.now() };
  const timestamp = value => {
    if (!value) return NaN;
    if (typeof value === 'number') return value;
    const text = String(value);
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:/.test(text) ? text.replace(' ', 'T') + 'Z' : text);
  };
  const calibrate = value => {
    const time = timestamp(value);
    if (Number.isFinite(time)) clock = { server: time, local: performance.now() };
  };
  const now = () => clock.server + performance.now() - clock.local;
  const dateFormatter = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const date = value => {
    const time = timestamp(value);
    return Number.isFinite(time) ? `${dateFormatter.format(time)} WIB` : 'Belum tercatat';
  };
  const request = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('Jawaban server tidak dapat dibaca. Coba lagi.'); }
      if (!response.ok) {
        const error = new Error(data.error || 'Permintaan belum berhasil. Silakan coba lagi.');
        error.status = response.status;
        throw error;
      }
      calibrate(data.serverNow);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Server belum merespons. Periksa koneksi lalu coba lagi.');
      if (error instanceof TypeError) throw new Error('Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.');
      throw error;
    } finally { clearTimeout(timeout); }
  };
  window.BagusUI = { esc: escapeHtml, money: value => money.format(Number(value) || 0), modal, request, timestamp, date, calibrate, now };
  renderCategories();renderFilters();renderProducts();
  loadAvailability();
  document.querySelector('[data-open-admin]')?.addEventListener('click', () => window.showAdminRoute());
  if (window.adminRoute) $('#adminPanel').hidden = false;
})();
