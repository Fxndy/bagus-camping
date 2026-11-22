(() => {
  const $ = selector => document.querySelector(selector);
  const { modal, request } = window.BagusUI;
  let currentUser = null;
  let mode = 'login';
  let busy = false;
  let revision = 0;
  const message = text => { $('#authMessage').textContent = text; };
  const updateProfileMenu = () => {
    const menu = $('#profileMenu');
    const button = $('#accountButton');
    if (!menu || !button) return;
    menu.innerHTML = currentUser
      ? `<p class="profile-name" title="${String(currentUser.fullName).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}">${String(currentUser.fullName).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</p><button type="button" role="menuitem" data-profile-action="orders">Pesanan Saya</button><button type="button" role="menuitem" data-profile-action="logout">Keluar</button>`
      : '<button type="button" role="menuitem" data-profile-action="login">Masuk</button><button type="button" role="menuitem" data-profile-action="register">Daftar</button>';
    button.setAttribute('aria-label', currentUser ? `Profil ${currentUser.fullName}` : 'Profil dan masuk');
    button.title = currentUser ? `Profil ${currentUser.fullName}` : 'Profil dan masuk';
  };
  const setUser = user => {
    const previousUser = currentUser;
    currentUser = user || null;
    updateProfileMenu();
    const button = $('#accountButton');
    button.setAttribute('aria-expanded', 'false');
    $('#profileMenu').hidden = true;
    const name = $('#checkoutForm [name="fullName"]');
    if (name && !name.value && currentUser) name.value = currentUser.fullName;
    document.dispatchEvent(new CustomEvent('bagus:auth-change', { detail: { user: currentUser, previousUser } }));
  };
  const verify = async () => {
    const version = ++revision;
    try {
      const data = await request('/api/auth/me');
      if (version === revision) setUser(data.user);
    } catch {
      if (version === revision) setUser(null);
    }
    return currentUser;
  };
  const setMode = next => {
    if (busy) return;
    mode = next === 'register' ? 'register' : 'login';
    document.querySelectorAll('[data-auth-mode]').forEach(button => {
      const selected = button.dataset.authMode === mode;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const register = mode === 'register';
    $('#fullNameField').hidden = !register;
    $('#confirmField').hidden = !register;
    $('#fullNameField input').required = register;
    $('#confirmField input').required = register;
    $('#fullNameField input').disabled = !register;
    $('#confirmField input').disabled = !register;
    $('#authTitle').textContent = register ? 'Buat akun' : 'Selamat datang';
    $('#authSubmit').textContent = register ? 'Daftar akun' : 'Masuk';
    const password = $('#authForm [name="password"]');
    password.autocomplete = register ? 'new-password' : 'current-password';
    password.minLength = register ? 8 : 1;
    message('');
  };
  const open = initialMode => {
    setMode(initialMode);
    modal.open('authOverlay', close, '#authForm [name="username"]');
  };
  const close = () => modal.close('authOverlay');
  $('#accountButton').addEventListener('click', event => {
    event.stopPropagation();
    const menu = $('#profileMenu');
    menu.hidden = !menu.hidden;
    $('#accountButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.profile-control')) return;
    $('#profileMenu').hidden = true;
    $('#accountButton').setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || $('#profileMenu').hidden) return;
    $('#profileMenu').hidden = true;
    $('#accountButton').setAttribute('aria-expanded', 'false');
    $('#accountButton').focus();
  });
  $('#profileMenu').addEventListener('click', async event => {
    const action = event.target.closest('[data-profile-action]')?.dataset.profileAction;
    if (!action) return;
    if (action === 'login' || action === 'register') { $('#profileMenu').hidden = true; $('#accountButton').setAttribute('aria-expanded', 'false'); open(action); return; }
    if (action === 'orders') { $('#profileMenu').hidden = true; $('#accountButton').setAttribute('aria-expanded', 'false'); window.OrderUI?.loadMyOrders(); return; }
    if (action === 'admin') return;
    if (action !== 'logout' || busy) return;
    if (window.Cart?.isSubmitting()) { window.showToast('Tunggu sampai penyimpanan pesanan selesai sebelum keluar.'); return; }
    busy = true; revision++;
    try {
      await request('/api/auth/logout', { method: 'POST' });
      setUser(null);
      $('#authForm').reset();
      window.showToast('Anda telah keluar. Tampilan pesanan pribadi ditutup.');
    } catch (error) { window.showToast(error.message); }
    finally { busy = false; }
  });
  updateProfileMenu();
  document.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.authMode)));
  document.querySelectorAll('[data-close-auth]').forEach(button => button.addEventListener('click', close));
  $('#authOverlay').addEventListener('click', event => { if (event.target === $('#authOverlay')) close(); });
  $('#authForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const submittedMode = mode;
    const payload = { username: String(values.get('username') || '').trim(), password: String(values.get('password') || '') };
    if (submittedMode === 'register') {
      payload.fullName = String(values.get('fullName') || '').trim();
      if (payload.password !== String(values.get('confirmPassword') || '')) { message('Konfirmasi kata sandi belum cocok.'); return; }
      if (payload.fullName.length < 2 || payload.fullName.length > 80) { message('Nama lengkap harus berisi 2–80 karakter.'); return; }
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(payload.username)) { message('Username harus 3–24 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.'); return; }
      if (payload.password.length < 8 || payload.password.length > 72) { message('Kata sandi baru harus berisi 8–72 karakter.'); return; }
    }
    busy = true;
    revision++;
    form.setAttribute('aria-busy', 'true');
    $('#authSubmit').disabled = true;
    $('#authSubmit').textContent = 'Memproses…';
    document.querySelectorAll('[data-auth-mode]').forEach(button => { button.disabled = true; });
    message('');
    try {
      const data = await request(`/api/auth/${submittedMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      setUser(data.user);
      form.reset();
      close();
      window.showToast(submittedMode === 'register' ? 'Akun berhasil dibuat.' : 'Berhasil masuk.');
    } catch (error) { message(error.message); }
    finally {
      busy = false;
      form.setAttribute('aria-busy', 'false');
      $('#authSubmit').disabled = false;
      $('#authSubmit').textContent = mode === 'register' ? 'Daftar akun' : 'Masuk';
      document.querySelectorAll('[data-auth-mode]').forEach(button => { button.disabled = false; });
    }
  });
  window.Auth = { open, close, verify, get user() { return currentUser; } };
  setMode('login');
  window.Auth.ready = verify();
})();
