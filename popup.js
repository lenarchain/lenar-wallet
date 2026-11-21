(function () {
  "use strict";
  const ADDR_PREFIX = 'rx';
  let tokenSymbol = 'LP';
  let networkCfg = { id: 'default', name: 'Alpha', type: 'mainnet', url: '', chainId: 1, symbol: 'LP' };
  let networkList = [];
  let editingNetId = null;

  function go(name) {
    if (name !== 'export-key') {
      const k = document.getElementById('exportKeyValue');
      if (k) k.value = '';
    }
    if (name !== 'reveal-phrase') {
      revealedMnemonic = null;
      const g = document.getElementById('revealGrid');
      if (g) g.textContent = '';
    }
    if (name !== 'sign') {
      const m = document.getElementById('signMessageInput');
      if (m) m.value = '';
      const pv = document.getElementById('signProofValue');
      if (pv) pv.value = '';
      const r = document.getElementById('signResult');
      if (r) r.style.display = 'none';
      const se = document.getElementById('signError');
      if (se) se.style.display = 'none';
    }
    if (name !== 'verify') {
      ['verifyMessageInput', 'verifyProofInput', 'verifyAddressValue', 'verifyPubkeyValue'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const vr = document.getElementById('verifyResult');
      if (vr) vr.style.display = 'none';
      const ve = document.getElementById('verifyError');
      if (ve) ve.style.display = 'none';
    }
    if (!['import', 'set-password'].includes(name)) {
      const ip = document.getElementById('importPhrase');
      if (ip) ip.value = '';
    }
    if (!['create-2', 'set-password'].includes(name)) {
      ['word4', 'word9'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    }
    if (!['set-password', 'unlock'].includes(name)) clearPasswordFields();
    if (['home', 'welcome', 'unlock', 'accounts', 'add-wallet'].includes(name)) {
      addMode = false;
      pendingMnemonic = null;
    }
    if (name !== 'confirm-tx') pendingTx = null;
    if (name === 'settings') refreshNetworkLabel();
    if (name === 'explorer') explorerEnter(); else explorerLeave();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.querySelector('.screen[data-screen="' + name + '"]');
    if (target) { target.classList.add('active'); target.scrollTop = 0; }
  }

  document.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => go(el.dataset.go));
  });

  const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (res === undefined || res === null) {
            return reject(new Error('No response from the wallet. Close and reopen the popup, then try again.'));
          }
          if ('error' in res) {
            const err = new Error(String(res.error || 'Unknown error'));
            if (res.code) err.code = res.code;
            if (res.txHash) err.txHash = res.txHash;
            if (res.code === 'LOCKED') handleLocked();
            return reject(err);
          }
          resolve(res);
        });
      } catch (e) {
        reject(new Error('Failed to send message to background: ' + e.message));
      }
    });
  }

  function resetSensitiveUi() {
    reqGen++;
    currentAddress = null;
    currentName = 'Main Wallet';
    balanceRaw = 0n;
    feeRaw = 0n;
    trafficCache = null;
    pendingTx = null;
    pendingMnemonic = null;
    addMode = false;
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('homeAddress', '-');
    set('homeBalance', '0');
    set('homeAccountName', currentName);
    set('walletList', '');
    ['sendTo', 'sendAmount'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderHistory([]);
    renderSendBalance();
    setCopyable('txDetailSender', 'txDetailSenderCopy', '');
    setCopyable('txDetailTo', 'txDetailToCopy', '');
    setCopyable('txDetailHash', 'txDetailHashCopy', '');
    explorerReset();
  }

  let lockHandledAt = 0;
  function handleLocked() {
    const active = document.querySelector('.screen.active');
    if (active && active.dataset.screen === 'unlock') return;
    if (Date.now() - lockHandledAt < 1000) return;
    lockHandledAt = Date.now();
    resetSensitiveUi();
    clearPasswordFields();
    go('unlock');
    showAlert('The wallet was locked. Unlock it to continue.', 'Locked', 'warning');
  }

  let pendingMnemonic = null;
  let currentAddress = null;
  let currentName = 'Main Wallet';
  let addMode = false;
  let trafficCache = null;
  let balanceRaw = 0n;
  let reqGen = 0;
  let feeRaw = 0n;
  let selectedTip = 'low';
  let pendingTx = null;
  let revealedMnemonic = null;

  const withPrefix = (a) => a ? ADDR_PREFIX + String(a).replace(new RegExp('^' + ADDR_PREFIX, 'i'), '') : '';
  const stripAddr  = (a) => String(a || '').replace(new RegExp('^' + ADDR_PREFIX, 'i'), '');

  const shortAddr = (a) => {
    if (!a) return '-';
    const full = withPrefix(a);
    return full.length > 14 ? full.slice(0, 8) + '...' + full.slice(-6) : full;
  };

  function formatUnits(baseUnitsStr, decimals = 18) {
    if (baseUnitsStr == null) return '-';
    let v;
    try { v = BigInt(baseUnitsStr); } catch { return String(baseUnitsStr); }
    const s = v.toString().padStart(decimals + 1, '0');
    const intPart = s.slice(0, -decimals);
    const fracPart = s.slice(-decimals).replace(/0+$/, '');
    return fracPart ? `${intPart}.${fracPart}` : intPart;
  }

  function parseAmountToUnits(str, decimals = 18) {
    const s = String(str).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid amount.');
    const [intPart, fracRaw = ''] = s.split('.');
    if (fracRaw.length > decimals) throw new Error(`Maximum ${decimals} decimal places.`);
    const frac = fracRaw.padEnd(decimals, '0');
    return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(frac);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text || '');
      return true;
    } catch {
      await showAlert('Failed to copy to clipboard.', 'Failed', 'error');
      return false;
    }
  }

  function clearPasswordFields() {
    ['pw1', 'pw2', 'unlockPw'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  let modalQueue = Promise.resolve();
  function showModal(options) {
    const run = () => showModalNow(options);
    const result = modalQueue.then(run, run);
    modalQueue = result.then(() => {}, () => {});
    return result;
  }

  function showModalNow({ title, message, showInput, isPassword, showCancel }) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('modalOverlay');
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalMessage').textContent = message;
      const inputEl = document.getElementById('modalInput');
      inputEl.style.display = showInput ? 'block' : 'none';
      inputEl.type = isPassword ? 'password' : 'text';
      inputEl.value = '';
      const okBtn = document.getElementById('modalOkBtn');
      const cancelBtn = document.getElementById('modalCancelBtn');
      cancelBtn.style.display = showCancel ? 'inline-flex' : 'none';
      const previousFocus = document.activeElement;
      overlay.classList.add('active');
      setTimeout(() => (showInput ? inputEl : okBtn).focus(), 50);

      function cleanup(result) {
        overlay.classList.remove('active');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKeydown, true);
        inputEl.value = '';
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        resolve(result);
      }
      function onOk() { cleanup({ confirmed: true, value: inputEl.value }); }
      function onCancel() { cleanup({ confirmed: false, value: null }); }
      function onKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }       // works even when the input is hidden
        if (e.key === 'Enter' && e.target === inputEl) { e.preventDefault(); onOk(); return; }
        if (e.key !== 'Tab') return;
        // Focus trap: Tab / Shift+Tab cycle inside the dialog.
        const items = [inputEl, cancelBtn, okBtn].filter((el) => el.style.display !== 'none' && !el.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKeydown, true);
    });
  }

  const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
    error: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.86l-8.2 14.2A1 1 0 0 0 3 19.8h18a1 1 0 0 0 .9-1.74l-8.2-14.2a1 1 0 0 0-1.8 0Z"/></svg>',
  };
  const TOAST_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const STATUS_SVG_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  const STATUS_SVG = {
    success: '<svg ' + STATUS_SVG_ATTR + '><path d="m5 12 5 5 9-10"/></svg>',
    danger:  '<svg ' + STATUS_SVG_ATTR + '><path d="M6 6l12 12M18 6 6 18"/></svg>',
    pending: '<svg ' + STATUS_SVG_ATTR + '><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };
  const TOAST_MS = { success: 4000, warning: 5500, error: 6500 };

  function dismissToast(el) {
    if (!el || el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }

  function mountToast(el, ms) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = TOAST_CLOSE;
    closeBtn.addEventListener('click', () => dismissToast(el));
    el.appendChild(closeBtn);
    document.getElementById('toastLayer').appendChild(el);
    if (ms) setTimeout(() => dismissToast(el), ms);
  }

  function showAlert(message, title = 'Notice', type = 'warning') {
    if (!TOAST_ICONS[type]) type = 'warning';
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const ico = document.createElement('div');
    ico.className = 'toast-ico';
    ico.innerHTML = TOAST_ICONS[type];

    const body = document.createElement('div');
    body.className = 'toast-body';
    const t = document.createElement('div');
    t.className = 'toast-title';
    t.textContent = title;
    const m = document.createElement('div');
    m.className = 'toast-msg';
    m.textContent = message;
    body.append(t, m);

    el.append(ico, body);
    mountToast(el, TOAST_MS[type]);
    return Promise.resolve();
  }

  function showTxSuccess(txHash) {
    const el = document.createElement('div');
    el.className = 'toast success tx';
    el.setAttribute('role', 'status');

    const check = document.createElement('div');
    check.className = 'toast-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = STATUS_SVG.success;

    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = 'Success';

    const wrap = document.createElement('div');
    wrap.className = 'input-wrap';
    wrap.innerHTML =
      '<span class="lead"><svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/></svg></span>' +
      '<input class="input compact has-copy" readonly spellcheck="false" autocomplete="off" aria-label="Transaction hash">' +
      '<button type="button" class="copy-btn" aria-label="Copy tx hash"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>';
    const input = wrap.querySelector('input');
    input.value = txHash || '';
    const copyBtn = wrap.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => copyWithFeedback(input.value, copyBtn));

    el.append(check, title, wrap);
    mountToast(el, 0);
    input.scrollLeft = 0;
  }
  async function showPrompt(message, title = 'Enter Password') {
    const result = await showModal({ title, message, showInput: true, isPassword: true, showCancel: true });
    return result.confirmed ? result.value : null;
  }

  function renderMnemonic(phrase, gridId = 'mnemonicGrid') {
    const grid = document.getElementById(gridId);
    grid.textContent = '';
    phrase.trim().split(/\s+/).forEach((w, i) => {
      const cell = document.createElement('div');
      cell.className = 'mnemonic-word';
      const idx = document.createElement('span');
      idx.textContent = (i + 1) + '.';
      cell.append(idx, w);
      grid.appendChild(cell);
    });
  }

  const phraseToText = (p) => String(p || '').trim().split(/\s+/).join(' ');

  function flashCopied(btn) {
    if (!btn || btn.dataset.flashing) return;
    btn.dataset.flashing = '1';
    const svg = btn.querySelector('svg');
    const lbl = btn.querySelector('.lbl');
    const oldSvg = svg ? svg.innerHTML : '';
    const oldLbl = lbl ? lbl.textContent : '';
    if (svg) svg.innerHTML = CHECK_SVG;
    if (lbl) lbl.textContent = 'Copied';
    btn.classList.add('ok');
    setTimeout(() => {
      if (svg) svg.innerHTML = oldSvg;
      if (lbl) lbl.textContent = oldLbl;
      btn.classList.remove('ok');
      delete btn.dataset.flashing;
    }, 1400);
  }
  async function copyWithFeedback(text, btn) {
    try {
      await navigator.clipboard.writeText(text || '');
      flashCopied(btn);
      return true;
    } catch {
      await showAlert('Failed to copy to clipboard.', 'Failed', 'error');
      return false;
    }
  }
  const warnClipboard = () =>
    showAlert('Phrase/key copied to clipboard. Paste it somewhere safe, then copy other text to overwrite it.', 'Warning', 'warning');

  function renderHome() {
    document.getElementById('homeAccountName').textContent = currentName;
    document.getElementById('homeAddress').textContent = shortAddr(currentAddress);
    document.getElementById('homeSymbol').textContent = tokenSymbol;
    document.getElementById('homeChain').textContent = networkCfg.name;
    document.getElementById('homeNetwork').textContent = typeLabel(networkCfg.type);
    document.getElementById('homeDot').classList.toggle('testnet', networkCfg.type === 'testnet');
    document.getElementById('sendTitleSym').textContent = tokenSymbol;
  }

  const typeLabel = (t) => (t === 'testnet' ? 'Testnet' : 'Mainnet');
  function setNetwork(cfg) {
    networkCfg = { id: cfg.id, name: cfg.name, type: cfg.type, url: cfg.url, chainId: cfg.chainId, symbol: cfg.symbol };
    if (Array.isArray(cfg.networks)) networkList = cfg.networks;
    tokenSymbol = cfg.symbol;
    renderHome();
    renderSendBalance();
  }

  function applyNetworkConfig(cfg) {
    const prev = JSON.stringify(networkCfg);
    setNetwork(cfg);
    if (JSON.stringify(networkCfg) !== prev) onNetworkChanged(cfg);
  }
  function onNetworkChanged(cfg) {
    reqGen++;
    setNetwork(cfg);
    balanceRaw = 0n;
    feeRaw = 0n;
    trafficCache = null;
    explorerReset();
    const bal = document.getElementById('homeBalance');
    if (bal) bal.textContent = '0';
    renderHistory([]);
    if (currentAddress) loadHistoryAndRender();
  }

  function formatBalance(raw) {
    const s = formatUnits(raw);
    if (s === '-' || !s.includes('.')) return s;
    const [i, f] = s.split('.');
    return i + '.' + f.slice(0, 6);
  }
  async function loadBalance() {
    const el = document.getElementById('homeBalance');
    if (!el || !currentAddress) return;
    const g = reqGen;
    const addr = currentAddress;
    try {
      const { account } = await send({ type: 'GET_ACCOUNT', address: addr });
      if (g !== reqGen) return;
      if (account && account.balance != null) { try { balanceRaw = BigInt(account.balance); } catch {} }
      el.textContent = account && account.balance != null ? formatBalance(account.balance) : '0';
    } catch (e) {
      if (g !== reqGen) return;
      console.warn('Failed to fetch balance:', e.message);
      el.textContent = '0';
      balanceRaw = 0n;
      renderSendBalance();
    }
  }

  async function startCreateFlow() {
    try {
      const { mnemonic } = await send({ type: 'PREVIEW_NEW_WALLET' });
      pendingMnemonic = mnemonic;
      renderMnemonic(mnemonic);
      document.getElementById('word4').value = '';
      document.getElementById('word9').value = '';
      document.getElementById('confirmError').style.display = 'none';
      go('create-1');
    } catch (e) {
      await showAlert('Failed to generate phrase: ' + e.message, 'Failed', 'error');
    }
  }
  document.getElementById('btnCreate').onclick = () => { addMode = false; startCreateFlow(); };

  const btnCopyCreatePhrase = document.getElementById('btnCopyCreatePhrase');
  if (btnCopyCreatePhrase) btnCopyCreatePhrase.onclick = async () => {
    if (await copyWithFeedback(phraseToText(pendingMnemonic), btnCopyCreatePhrase)) warnClipboard();
  };

  document.getElementById('btnImportSubmit').onclick = async () => {
    const phrase = document.getElementById('importPhrase').value.trim().replace(/\s+/g, ' ');
    if (!phrase) { await showAlert('Enter your recovery phrase.', 'Incomplete', 'warning'); return; }
    try {
      const { valid } = await send({ type: 'VALIDATE_MNEMONIC', mnemonic: phrase });
      if (!valid) {
        await showAlert('This recovery phrase is not valid. Check the words, their order and the number of words.', 'Invalid Phrase', 'error');
        return;
      }
    } catch (e) {
      await showAlert(e.message, 'Failed', 'error');
      return;
    }
    if (addMode) { await addWalletFlow(phrase); return; }
    pendingMnemonic = phrase;
    setPasswordMode('import');
    go('set-password');
  };

  function setPasswordMode(mode) {
    document.getElementById('setPasswordMode').value = mode;
    document.getElementById('btnSetPassword').textContent = mode === 'import' ? 'Import Wallet' : 'Create Wallet';
  }

  document.getElementById('btnConfirmWords').onclick = async () => {
    if (!pendingMnemonic) {
      await showAlert('The phrase session was lost, please start creating the wallet again.', 'Session Expired', 'warning');
      go(addMode ? 'add-wallet' : 'welcome');
      return;
    }
    const words = pendingMnemonic.trim().split(/\s+/);
    const w4 = document.getElementById('word4').value.trim();
    const w9 = document.getElementById('word9').value.trim();
    const err = document.getElementById('confirmError');
    if (w4 !== words[3] || w9 !== words[8]) { err.style.display = 'block'; return; }
    err.style.display = 'none';
    if (addMode) { await addWalletFlow(pendingMnemonic); return; }
    setPasswordMode('create');
    go('set-password');
  };

  document.querySelectorAll('[data-social]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.social;
      if (!url) return;
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
      else window.open(url, '_blank', 'noopener');
    });
  });

  document.getElementById('btnCreate1Back').onclick = () => go(addMode ? 'add-wallet' : 'welcome');
  document.getElementById('btnImportBack').onclick = () => go(addMode ? 'add-wallet' : 'welcome');

  document.getElementById('btnPwBack').onclick = () => {
    const mode = document.getElementById('setPasswordMode').value;
    document.getElementById('pwError').style.display = 'none';
    go(mode === 'import' ? 'import' : 'create-2');
  };

  document.getElementById('btnSetPassword').onclick = async () => {
    const p1 = document.getElementById('pw1').value;
    const p2 = document.getElementById('pw2').value;
    const err = document.getElementById('pwError');
    if (p1.length < 10) { err.textContent = 'Minimum 10 characters.'; err.style.display = 'block'; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
    if (!pendingMnemonic) {
      err.textContent = 'The phrase session was lost, please start over.';
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    const mode = document.getElementById('setPasswordMode').value;
    try {
      const msgType = mode === 'import' ? 'IMPORT_WALLET' : 'FINALIZE_WALLET';
      const { address, name } = await send({ type: msgType, mnemonic: pendingMnemonic, password: p1 });
      currentAddress = address;
      currentName = name || currentName;
      pendingMnemonic = null;
      clearPasswordFields();
      renderHome();
      loadHistoryAndRender();
      go('home');
    } catch (e) {
      err.textContent = e.message || 'Failed to save wallet.';
      err.style.display = 'block';
    }
  };
 
  document.getElementById('btnUnlock').onclick = async () => {
    const pw = document.getElementById('unlockPw').value;
    const err = document.getElementById('unlockError');
    err.style.display = 'none';
    try {
      const { address, name } = await send({ type: 'UNLOCK', password: pw });
      currentAddress = address;
      currentName = name || currentName;
      clearPasswordFields();
      renderHome();
      loadHistoryAndRender();
      go('home');
    } catch (e) {
      err.textContent = e.message || 'Incorrect password.';
      err.style.display = 'block';
    }
  };

  ['btnImportSubmit', 'btnConfirmWords', 'btnSetPassword', 'btnUnlock'].forEach((id) => {
    const el = document.getElementById(id);
    const handler = el.onclick;
    el.onclick = async (ev) => {
      if (el.disabled) return;
      el.disabled = true;
      try { await handler.call(el, ev); } finally { el.disabled = false; }
    };
  });

  document.getElementById('btnLock').onclick = async () => {
    try {
      await send({ type: 'LOCK' });
    } catch (e) {
      console.warn('Failed to send LOCK:', e.message);
    }
    resetSensitiveUi();
    clearPasswordFields();
    go('unlock');
  };

  const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
  const WALLET_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-4a2 2 0 0 1 0-4h4Z"/></svg>';

  function renderWalletList(wallets, activeId) {
    const list = document.getElementById('walletList');
    list.textContent = '';
    wallets.forEach(w => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.style.cursor = 'pointer';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      const ico = document.createElement('div');
      ico.className = 'ico';
      ico.innerHTML = WALLET_ICON;

      const main = document.createElement('div');
      main.className = 'main';
      const t1 = document.createElement('div');
      t1.className = 't1';
      t1.textContent = w.name;
      const t2 = document.createElement('div');
      t2.className = 't2';
      t2.textContent = shortAddr(w.address);
      main.append(t1, t2);

      const chev = document.createElement('div');
      chev.className = 'chev';
      if (w.id === activeId) { chev.innerHTML = CHECK_ICON; chev.style.color = 'var(--accent-dark)'; }

      row.append(ico, main, chev);
      const choose = () => switchToWallet(w.id, w.id === activeId);
      row.onclick = choose;
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      list.appendChild(row);
    });
  }

  async function openAccounts() {
    try {
      const { wallets, activeId } = await send({ type: 'GET_WALLETS' });
      renderWalletList(wallets, activeId);
      go('accounts');
    } catch (e) {
      await showAlert(e.message, 'Failed', 'error');
    }
  }

  async function switchToWallet(id, alreadyActive) {
    if (alreadyActive) { go('home'); return; }
    try {
      const { address, name } = await send({ type: 'SWITCH_WALLET', id });
      applyActiveWallet(address, name);
      go('home');
    } catch (e) {
      await showAlert(e.message, 'Failed', 'error');
    }
  }

  function applyActiveWallet(address, name) {
    reqGen++;
    currentAddress = address;
    currentName = name || currentName;
    balanceRaw = 0n;
    document.getElementById('homeBalance').textContent = '0';
    renderHistory([]);
    renderHome();
    loadHistoryAndRender();
  }

  async function addWalletFlow(mnemonic) {
    const pw = await showPrompt('Enter your password to add this wallet.', 'Confirm Password');
    if (pw === null) return;
    if (!pw) { await showAlert('Password cannot be empty.', 'Incomplete', 'warning'); return; }
    try {
      const { address, name } = await send({ type: 'ADD_WALLET', mnemonic, password: pw });
      document.getElementById('importPhrase').value = '';
      go('home');
      applyActiveWallet(address, name);
      showAlert('"' + name + '" was added and is now active.', 'Wallet Added', 'success');
    } catch (e) {
      await showAlert(e.message, 'Failed', 'error');
    }
  }

  document.getElementById('btnAccount').onclick = openAccounts;
  document.getElementById('btnAddWallet').onclick = () => go('add-wallet');
  document.getElementById('btnAddCreate').onclick = () => { addMode = true; startCreateFlow(); };
  document.getElementById('btnAddImport').onclick = () => {
    addMode = true;
    pendingMnemonic = null;
    document.getElementById('importPhrase').value = '';
    go('import');
  };

  const hostLabel = (url) => { try { return new URL(url).host; } catch { return url; } };

  async function refreshNetworkLabel() {
    try {
      const cfg = await send({ type: 'GET_NETWORK' });
      document.getElementById('settingsNetworkSub').textContent = cfg.name + ' · ' + typeLabel(cfg.type);
    } catch { /* leave label as is */ }
  }

  const NET_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18"/></svg>';
  const TICK_ICON = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const PEN_ICON = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';

  function netEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function renderNetworkList() {
    const list = document.getElementById('netList');
    list.textContent = '';
    networkList.forEach((n) => {
      const active = n.id === networkCfg.id;
      const row = netEl('div', 'row-item net-row' + (active ? ' active' : ''));
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.dataset.netId = n.id;
      const ico = netEl('div', 'ico'); ico.innerHTML = NET_ICON;   // static markup
      const main = netEl('div', 'main');
      const t1 = netEl('div', 't1');
      t1.append(netEl('span', 'nm', n.name), netEl('span', 'net-tag ' + n.type, typeLabel(n.type)));
      main.append(t1, netEl('div', 't2', hostLabel(n.url) + ' · ' + n.symbol + ' · Chain ' + n.chainId));
      row.append(ico, main);
      if (active) { const t = netEl('span', 'tick'); t.innerHTML = TICK_ICON; t.setAttribute('aria-label', 'Selected'); row.append(t); }
      if (!n.builtin) {
        const eb = netEl('button', 'edit-btn');
        eb.type = 'button';
        eb.setAttribute('aria-label', 'Edit ' + n.name);
        eb.innerHTML = PEN_ICON;
        eb.addEventListener('click', (e) => { e.stopPropagation(); openNetworkEdit(n); });
        row.append(eb);
      }
      const choose = () => selectNetwork(n.id);
      row.addEventListener('click', choose);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      list.appendChild(row);
    });
  }

  async function selectNetwork(id) {
    if (id === networkCfg.id) return;
    try {
      applyNetworkConfig(await send({ type: 'SWITCH_NETWORK', id }));
      renderNetworkList();
    } catch (e) {
      showAlert(e.message, 'Network', 'error');
    }
  }

  async function openNetworks(from) {
    document.getElementById('btnNetBack').dataset.go = from || 'settings';
    go('network');
    try { setNetwork(await send({ type: 'GET_NETWORK' })); } catch (e) { console.warn('GET_NETWORK failed:', e.message); }
    renderNetworkList();
  }

  function setNetType(type) {
    document.querySelectorAll('#netTypeSeg .seg-btn').forEach((b) => {
      const on = b.dataset.type === type;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  const getNetType = () => {
    const b = document.querySelector('#netTypeSeg .seg-btn.on');
    return b ? b.dataset.type : 'mainnet';
  };

  function setRpcStatus(text, kind) {   // kind: 'ok' | 'err' | undefined
    const el = document.getElementById('rpcStatus');
    el.textContent = text;
    el.className = 'subtitle' + (kind === 'err' ? ' err-text' : '');
    el.style.color = kind === 'ok' ? 'var(--success)' : '';
  }
  const describeRpc = (i) => 'Connected · Chain ID ' + i.chainid + ' · Block ' + i.blockNumber + ' · ' + i.latencyMs + ' ms';

  function setRpcBusy(busy) {
    ['btnRpcSave', 'btnRpcTest', 'btnNetDelete'].forEach(id => { document.getElementById(id).disabled = busy; });
  }

  function rpcOrigin(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error('Invalid URL. Example: https://alpha.lenarchain.xyz'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL must start with http:// or https://');
    return u.origin;
  }
  const isLoopback = (raw) => {
    const h = new URL(raw).hostname;
    return h === 'localhost' || h === '[::1]' || /^127\./.test(h);
  };

  async function ensureHostPermission(origin) {
    if (!chrome.permissions || !chrome.permissions.request) return true;
    return chrome.permissions.request({ origins: [origin + '/*'] });
  }

  function openNetworkEdit(net) {
    editingNetId = net ? net.id : null;
    document.getElementById('netEditTitle').textContent = net ? 'Edit Network' : 'Add Network';
    document.getElementById('netNameInput').value = net ? net.name : '';
    setNetType(net ? net.type : 'mainnet');
    document.getElementById('rpcUrlInput').value = net ? net.url : '';
    document.getElementById('chainIdInput').value = net ? String(net.chainId) : '';
    document.getElementById('symbolInput').value = net ? net.symbol : '';
    document.getElementById('btnNetDelete').style.display = net ? '' : 'none';
    setRpcStatus('');
    setRpcBusy(false);
    go('network-edit');
  }

  const U32_MAX = 0xFFFFFFFF;

  async function applyRpc(save) {
    const raw = document.getElementById('rpcUrlInput').value.trim();
    let origin;
    try { origin = rpcOrigin(raw); } catch (e) { setRpcStatus(e.message, 'err'); return; }

    const name = document.getElementById('netNameInput').value.replace(/\s+/g, ' ').trim();
    if (save && !name) { setRpcStatus('Enter a network name.', 'err'); return; }

    const chainIdEl = document.getElementById('chainIdInput');
    const chainIdRaw = chainIdEl.value.trim();
    let chainId = null;
    if (chainIdRaw !== '') {
      if (!/^\d{1,10}$/.test(chainIdRaw) || Number(chainIdRaw) > U32_MAX) {
        setRpcStatus('Chain ID must be a whole number between 0 and ' + U32_MAX + '.', 'err');
        return;
      }
      chainId = Number(chainIdRaw);
    }
    const symbolEl = document.getElementById('symbolInput');
    const symbol = symbolEl.value.trim();
    if (save && !/^[A-Za-z0-9]{1,12}$/.test(symbol)) {
      setRpcStatus('Symbol must be 1-12 letters or digits (A-Z, 0-9).', 'err');
      return;
    }

    let granted = false;
    try { granted = await ensureHostPermission(origin); } catch { granted = false; }
    if (!granted) {
      setRpcStatus('Access to ' + origin + ' was denied. Without permission, the wallet cannot connect to this node.', 'err');
      return;
    }

    if (save && /^http:/i.test(raw) && !isLoopback(raw)) {
      const r = await showModal({
        title: 'Insecure Connection',
        message: 'This address uses http:// (unencrypted). Others on the network can see which addresses you check, or forge node responses (for example, balances). Your wallet keys stay safe on this device. Continue?',
        showCancel: true,
      });
      if (!r.confirmed) return;
    }

    setRpcBusy(true);
    try {
      setRpcStatus('Checking connection…');
      if (save) {
        const info = await send({ type: 'SAVE_NETWORK', id: editingNetId, name, netType: getNetType(), url: raw, chainId, symbol });
        applyNetworkConfig(info.config);
        renderNetworkList();
        go('network');
        showAlert(editingNetId ? 'Network updated.' : 'Network added and selected.', 'Network', 'success');
      } else {
        const info = await send({ type: 'TEST_NETWORK', url: raw, chainId });
        if (chainId === null) chainIdEl.value = String(info.chainid); // auto-detected from the node
        setRpcStatus(describeRpc(info), 'ok');
      }
    } catch (e) {
      setRpcStatus(e.message, 'err');
    } finally {
      setRpcBusy(false);
    }
  }

  async function deleteEditingNetwork() {
    if (!editingNetId) return;
    const net = networkList.find((n) => n.id === editingNetId);
    const r = await showModal({
      title: 'Delete Network',
      message: 'Delete "' + (net ? net.name : 'this network') + '"? ' +
        (editingNetId === networkCfg.id ? 'The wallet will switch back to ' + (networkList[0] ? networkList[0].name : 'the default network') + '. ' : '') +
        'Your wallet keys are not affected.',
      showCancel: true,
    });
    if (!r.confirmed) return;
    setRpcBusy(true);
    try {
      applyNetworkConfig(await send({ type: 'DELETE_NETWORK', id: editingNetId }));
      renderNetworkList();
      go('network');
    } catch (e) {
      setRpcStatus(e.message, 'err');
    } finally {
      setRpcBusy(false);
    }
  }

  document.getElementById('btnNetwork').onclick = () => openNetworks('settings');
  document.getElementById('btnNetAdd').onclick = () => openNetworkEdit(null);
  document.getElementById('btnRpcSave').onclick = () => applyRpc(true);
  document.getElementById('btnRpcTest').onclick = () => applyRpc(false);
  document.getElementById('btnNetDelete').onclick = deleteEditingNetwork;
  document.querySelectorAll('#netTypeSeg .seg-btn').forEach((b) => { b.onclick = () => setNetType(b.dataset.type); });
  const homeNetBtn = document.getElementById('btnHomeNetwork');
  homeNetBtn.addEventListener('click', () => openNetworks('home'));

  const btnCopyAddr = document.getElementById('btnCopyAddr');
  const COPY_SVG = '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>';
  const CHECK_SVG = '<path d="m5 12 5 5 9-10"/>';
  if (btnCopyAddr) btnCopyAddr.onclick = async () => {
    if (!(await copyToClipboard(withPrefix(currentAddress)))) return; // no check mark when the copy failed
    const icon = document.getElementById('copyIcon');
    btnCopyAddr.classList.add('ok');
    icon.innerHTML = CHECK_SVG;
    setTimeout(() => { btnCopyAddr.classList.remove('ok'); icon.innerHTML = COPY_SVG; }, 1400);
  };
  const TIP_KEYS = ['low', 'medium', 'fast'];
  const TIP_EL_ID = { low: 'tipLow', medium: 'tipMedium', fast: 'tipFast' };

  function renderSendBalance() {
    const el = document.getElementById('sendBalance');
    if (el) el.textContent = formatBalance(balanceRaw.toString());
    const sym = document.getElementById('sendBalanceSym');
    if (sym) sym.textContent = tokenSymbol;
  }

  function currentTipRaw() {
    try { return trafficCache && trafficCache[selectedTip] != null ? BigInt(trafficCache[selectedTip]) : 0n; }
    catch { return 0n; }
  }

  function fillAmountFromBalance(pct) {
    const amtEl = document.getElementById('sendAmount');
    const costs = feeRaw + currentTipRaw();
    const spendable = balanceRaw > costs ? balanceRaw - costs : 0n;
    let raw = pct >= 100 ? spendable : (balanceRaw * BigInt(pct)) / 100n;
    if (raw > spendable) raw = spendable;
    amtEl.value = formatUnits(raw.toString());
  }

  function selectTip(key) {
    selectedTip = key;
    document.querySelectorAll('.tip-btn').forEach(b =>
      b.classList.toggle('selected', b.dataset.tip === key));
  }

  function renderTipAmounts() {
    TIP_KEYS.forEach(k => {
      const el = document.getElementById(TIP_EL_ID[k]);
      if (el) el.textContent = trafficCache && trafficCache[k] != null ? formatUnits(trafficCache[k]) : '0';
    });
  }

  document.querySelectorAll('.pct-btn').forEach(b =>
    b.addEventListener('click', () => fillAmountFromBalance(Number(b.dataset.pct))));
  document.getElementById('btnMax').addEventListener('click', () => fillAmountFromBalance(100));
  document.querySelectorAll('.tip-btn').forEach(b =>
    b.addEventListener('click', () => selectTip(b.dataset.tip)));

  document.getElementById('btnGoSend').onclick = async () => {
    const toEl = document.getElementById('sendTo');
    const amtEl = document.getElementById('sendAmount');
    const se = document.getElementById('sendError');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    if (se) se.style.display = 'none';
    selectTip('low');
    trafficCache = null;
    feeRaw = 0n;
    renderTipAmounts();
    renderSendBalance();
    go('send');
    const g = reqGen;
    const addr = currentAddress;

    send({ type: 'GET_ACCOUNT', address: addr }).then(({ account }) => {
      if (g !== reqGen) return;
      if (account && account.balance != null) balanceRaw = BigInt(account.balance);
      renderSendBalance();
    }).catch(e => console.warn('Failed to fetch balance:', e.message));

    send({ type: 'GET_FEE_INFO' }).then(({ info }) => {
      if (g !== reqGen) return;
      if (info && info.fee != null) feeRaw = BigInt(info.fee);
    }).catch(e => console.warn('Failed to fetch fee:', e.message));

    try {
      const { traffic } = await send({ type: 'GET_TRAFFIC' });
      if (g !== reqGen) return;
      trafficCache = traffic;
      renderTipAmounts();
      if (traffic && traffic.capped) {
        showAlert('The node suggested a tip above the wallet limit. It was lowered to the maximum the wallet allows.', 'Tip capped', 'warning');
      }
    } catch (e) {
      console.warn('Failed to fetch traffic:', e.message);
      trafficCache = null;
    }
  };

  document.getElementById('btnReviewSend').onclick = async () => {
    const err = document.getElementById('sendError');
    err.style.display = 'none';
    const toRaw = document.getElementById('sendTo').value.trim();
    if (/^0x/i.test(toRaw)) {
      err.textContent = 'The 0x prefix is no longer supported. Addresses on this network use the rx prefix.';
      err.style.display = 'block';
      return;
    }
    const to = stripAddr(toRaw);
    if (!/^rx/i.test(toRaw) || !/^[0-9a-fA-F]{40}$/.test(to)) {
      err.textContent = 'Destination address must start with rx followed by 40 hex characters (20 bytes).';
      err.style.display = 'block';
      return;
    }
    const amountStr = document.getElementById('sendAmount').value.trim();

    if (!/^[0-9a-fA-F]{40}$/.test(to)) {
      err.textContent = 'Destination address must be 20 bytes of hex (40 characters).';
      err.style.display = 'block';
      return;
    }

    let amountUnit;
    try {
      amountUnit = parseAmountToUnits(amountStr, 18);
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block'; return;
    }
    if (!(amountUnit > 0n)) {
      err.textContent = 'Amount must be greater than 0.'; err.style.display = 'block'; return;
    }

    const tipVal = trafficCache && trafficCache[selectedTip];
    if (tipVal == null) {
      err.textContent = 'Network tip estimates are not available yet, wait a moment and try again.';
      err.style.display = 'block';
      return;
    }
    const tip = String(tipVal);

    if (!(feeRaw > 0n)) {
      err.textContent = 'Fee info is not available yet, wait a moment and try again.';
      err.style.display = 'block';
      return;
    }
    const total = amountUnit + BigInt(tip) + feeRaw;
    if (total > balanceRaw) {
      err.textContent = 'Insufficient balance for amount + tip + fee.';
      err.style.display = 'block';
      return;
    }

    pendingTx = { to, amount: amountUnit.toString(), tip };
    document.getElementById('confirmTo').textContent = ADDR_PREFIX + to; // the whole address, wrapped: nothing hidden
    document.getElementById('confirmAmount').textContent = formatUnits(amountUnit.toString());
    document.getElementById('confirmFee').textContent = formatUnits(feeRaw.toString());
    document.getElementById('confirmTip').textContent = formatUnits(tip);
    document.getElementById('confirmTotal').textContent = formatUnits(total.toString());
    document.getElementById('confirmTxError').style.display = 'none';
    go('confirm-tx');
  };


  document.getElementById('btnConfirmBack').onclick = () => go('send');
  document.getElementById('btnConfirmCancel').onclick = () => go('send');

  document.getElementById('btnConfirmSend').onclick = async () => {
    const tx = pendingTx;
    const err = document.getElementById('confirmTxError');
    if (!tx) { go('send'); return; }
    err.style.display = 'none';

    const btn = document.getElementById('btnConfirmSend');
    const cancel = document.getElementById('btnConfirmCancel');
    const back = document.getElementById('btnConfirmBack');
    const prev = btn.textContent;
    btn.disabled = cancel.disabled = back.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const { txHash, status, powerWarning } = await send({ type: 'SEND_TX', tx });

      if (status === 'success') {
        showTxSuccess(txHash);
      } else if (status === 'failed') {
        showAlert(`The network failed to process the transaction.\nHash: ${txHash}`, 'Failed', 'error');
      } else {
        showAlert(`Transaction status: ${status}\nHash: ${txHash}`, 'Transaction Sent', 'warning');
      }
      if (powerWarning) showAlert(powerWarning, 'Power mismatch', 'warning');
      loadHistoryAndRender();
      go('home');
    } catch (e) {
      if (e.code === 'BROADCAST_UNCERTAIN' || e.code === 'PREVIOUS_TX_ACCEPTED') {
        // The transfer may already be on the network: leave this screen so Send cannot be pressed again blindly.
        pendingTx = null;
        loadHistoryAndRender();
        go('home');
        await showModal({
          title: e.code === 'BROADCAST_UNCERTAIN' ? 'Check Status First' : 'Already Sent',
          message: e.message,
          showCancel: false,
        });
      } else {
        err.textContent = 'Failed: ' + e.message;
        err.style.display = 'block';
      }
    } finally {
      btn.disabled = cancel.disabled = back.disabled = false;
      btn.textContent = prev;
    }
  };

  document.getElementById('btnRevealPhrase').onclick = async () => {
    const pw = await showPrompt('Enter your password to reveal the recovery phrase:', 'Reveal Recovery Phrase');
    if (!pw) return;
    try {
      const { mnemonic } = await send({ type: 'REVEAL_MNEMONIC', password: pw });
      renderMnemonic(mnemonic, 'revealGrid');
      go('reveal-phrase');
      revealedMnemonic = mnemonic;
    } catch (e) {
      await showAlert(e.message || 'Incorrect password.', 'Failed', 'error');
    }
  };

  document.getElementById('btnExportKey').onclick = async () => {
    const pw = await showPrompt('Enter your password to export the private key:', 'Export Private Key');
    if (!pw) return;
    try {
      const { privateKey } = await send({ type: 'EXPORT_PRIVATE_KEY', password: pw });
      go('export-key');
      const keyEl = document.getElementById('exportKeyValue');
      keyEl.value = privateKey;
      keyEl.scrollLeft = 0;
    } catch (e) {
      await showAlert(e.message || 'Incorrect password.', 'Failed', 'error');
    }
  };

  const btnCopyRevealPhrase = document.getElementById('btnCopyRevealPhrase');
  if (btnCopyRevealPhrase) btnCopyRevealPhrase.onclick = async () => {
    if (await copyWithFeedback(phraseToText(revealedMnemonic), btnCopyRevealPhrase)) warnClipboard();
  };
  const btnRevealOk = document.getElementById('btnRevealOk');
  if (btnRevealOk) btnRevealOk.onclick = () => go('settings');
  const btnCopyPrivKey = document.getElementById('btnCopyPrivKey');
  if (btnCopyPrivKey) btnCopyPrivKey.onclick = async () => {
    if (await copyWithFeedback(document.getElementById('exportKeyValue').value, btnCopyPrivKey)) warnClipboard();
  };

  const MAX_SIGN_MSG_BYTES = 1024;
  const btnSignMessage = document.getElementById('btnSignMessage');
  btnSignMessage.onclick = async () => {
    const msgEl = document.getElementById('signMessageInput');
    const err = document.getElementById('signError');
    const result = document.getElementById('signResult');
    err.style.display = 'none';
    result.style.display = 'none';

    const message = msgEl.value;
    if (!message.trim()) {
      err.textContent = 'Message cannot be empty.'; err.style.display = 'block'; return;
    }
    if (new TextEncoder().encode(message).length > MAX_SIGN_MSG_BYTES) {
      err.textContent = 'Message is too long (max ' + MAX_SIGN_MSG_BYTES + ' bytes).'; err.style.display = 'block'; return;
    }

    const confirmSign = await showModal({
      title: 'Sign Message?',
      message: 'Do not sign messages from sources you do not trust. The signature is made with the active wallet key and cannot be undone.',
      showCancel: true,
    });
    if (!confirmSign.confirmed) return;

    const prev = btnSignMessage.textContent;
    btnSignMessage.disabled = true; btnSignMessage.textContent = 'Signing…';
    try {
      const { proof } = await send({ type: 'SIGN_MESSAGE', message });
      const out = document.getElementById('signProofValue');
      out.value = proof;
      out.scrollLeft = 0;
      result.style.display = 'block';
    } catch (e) {
      err.textContent = 'Failed: ' + e.message; err.style.display = 'block';
    } finally {
      btnSignMessage.disabled = false; btnSignMessage.textContent = prev;
    }
  };

  const btnCopyProof = document.getElementById('btnCopyProof');
  if (btnCopyProof) btnCopyProof.onclick = () =>
    copyWithFeedback(document.getElementById('signProofValue').value, btnCopyProof);

  const PROOF_HEX_LEN = 208; // 104 bytes
  const FUTURE_SKEW_SEC = 300n;
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>';
  const ICON_BAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>';

  const btnVerifyMessage = document.getElementById('btnVerifyMessage');
  btnVerifyMessage.onclick = async () => {
    const err = document.getElementById('verifyError');
    const result = document.getElementById('verifyResult');
    err.style.display = 'none';
    result.style.display = 'none';

    const message = document.getElementById('verifyMessageInput').value;
    let proof = document.getElementById('verifyProofInput').value.replace(/\s+/g, '');
    const fail = (t) => { err.textContent = t; err.style.display = 'block'; };

    if (/^0x/i.test(proof)) return fail('The 0x prefix is not supported. Paste the proof as plain hex (an rx prefix is fine).');
    proof = proof.replace(/^rx/i, '');
    if (!message.trim()) return fail('Message cannot be empty.');
    if (new TextEncoder().encode(message).length > MAX_SIGN_MSG_BYTES) return fail('Message is too long (max ' + MAX_SIGN_MSG_BYTES + ' bytes).');
    if (!proof) return fail('Proof cannot be empty.');
    if (!/^[0-9a-fA-F]+$/.test(proof) || proof.length !== PROOF_HEX_LEN) return fail('Proof must be ' + PROOF_HEX_LEN + ' hex characters (104 bytes).');

    const prev = btnVerifyMessage.textContent;
    btnVerifyMessage.disabled = true; btnVerifyMessage.textContent = 'Verifying…';
    try {
      const { valid, signer } = await send({ type: 'VERIFY_MESSAGE', message, proof });
      const status = document.getElementById('verifyStatus');
      const detail = document.getElementById('verifyDetail');
      const hint = document.getElementById('verifyHint');
      status.className = 'verify-status ' + (valid ? 'ok' : 'bad');
      document.getElementById('verifyStatusIcon').innerHTML = valid ? ICON_OK : ICON_BAD;
      document.getElementById('verifyStatusText').textContent = valid
        ? 'Valid — this message was signed by the owner of the address below.'
        : 'Invalid — the message and proof do not match.';
      if (valid && signer) {
        const addrEl = document.getElementById('verifyAddressValue');
        addrEl.value = signer.address;
        addrEl.scrollLeft = 0;
        const pk = document.getElementById('verifyPubkeyValue');
        pk.value = signer.publicKey;
        pk.scrollLeft = 0;
        const mine = !!currentAddress && signer.address.toLowerCase() === withPrefix(currentAddress).toLowerCase();
        const tsSec = BigInt(signer.timestamp);
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const inFuture = tsSec > nowSec + FUTURE_SKEW_SEC;
        const when = tsSec <= 8640000000000n
          ? new Date(Number(tsSec) * 1000).toLocaleString('en-US') + (inFuture ? '' : ' (' + timeAgo(Number(tsSec)) + ')')
          : 'timestamp ' + tsSec.toString();
        document.getElementById('verifyTime').textContent =
          (mine ? 'This is your active wallet. ' : '') + 'Signed: ' + when;
        const warn = document.getElementById('verifyWarn');
        warn.textContent = 'This signature is dated in the future. A genuine signer cannot do that: treat it with suspicion.';
        warn.style.display = inFuture ? 'block' : 'none';
        hint.style.display = 'none';
        detail.style.display = 'block';
      } else {
        detail.style.display = 'none';
        hint.textContent = 'Check that the message is exactly the same (every character counts). The signature also covers the Chain ID, and ' +
          'this check uses the active network (' + networkCfg.name + ', Chain ID ' + networkCfg.chainId + '): if the proof was made on another network, switch to it and try again.';
        hint.style.display = 'block';
      }
      result.style.display = 'block';
    } catch (e) {
      fail('Failed: ' + e.message);
    } finally {
      btnVerifyMessage.disabled = false; btnVerifyMessage.textContent = prev;
    }
  };

  const btnCopyVerifyAddress = document.getElementById('btnCopyVerifyAddress');
  if (btnCopyVerifyAddress) btnCopyVerifyAddress.onclick = () =>
    copyWithFeedback(document.getElementById('verifyAddressValue').value, btnCopyVerifyAddress);
  const btnCopyVerifyPubkey = document.getElementById('btnCopyVerifyPubkey');
  if (btnCopyVerifyPubkey) btnCopyVerifyPubkey.onclick = () =>
    copyWithFeedback(document.getElementById('verifyPubkeyValue').value, btnCopyVerifyPubkey);

  function statusMeta(status) {
    if (status === 'success') return { icon: STATUS_SVG.success, label: 'Success', cls: 'success' };
    if (status === 'failed') return { icon: STATUS_SVG.danger, label: 'Failed', cls: 'danger' };
    if (status === 'unconfirmed') return { icon: STATUS_SVG.pending, label: 'Unconfirmed', cls: 'pending' };
    return { icon: STATUS_SVG.pending, label: 'Pending', cls: 'pending' };
  }

  const ICON_SENT = '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>';
  const BADGE_ICON = {
    success: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
    danger: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    pending: '<svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/></svg>',
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  function formatDateTime(ts) {
    if (!ts) return '-';
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d)) return '-';
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const longAddr = (a) => {
    const full = withPrefix(a);
    return full.length > 22 ? full.slice(0, 10) + '....' + full.slice(-8) : (full || '-');
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderHistory(list) {
    const emptyEl = document.getElementById('historyEmpty');
    const listEl = document.getElementById('historyList');
    if (!list || list.length === 0) {
      emptyEl.style.display = 'flex';
      listEl.style.display = 'none';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = list.map((tx, i) => {
      const meta = statusMeta(tx.unverifiedAt && tx.status === 'pending' ? 'unconfirmed' : tx.status);
      const chip = meta.cls === 'success' ? '' : `<span class="h-chip ${meta.cls}">${meta.label}</span>`;
      return `<div class="h-tx" data-idx="${i}" role="button" tabindex="0">
        <div class="h-ava ${meta.cls === 'danger' ? 'danger' : ''}">${ICON_SENT}<span class="h-badge ${meta.cls}">${BADGE_ICON[meta.cls]}</span></div>
        <div class="h-txmain">
          <div class="h-lbl">Sent to</div>
          <div class="h-to">${esc(longAddr(tx.to))}</div>
          <div class="h-time">${esc(formatDateTime(tx.timestamp))}</div>
        </div>
        <div class="h-val"><b>-${esc(formatUnits(tx.amount))}</b>${chip}</div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.h-tx').forEach((card) => {
      const open = () => showTxDetail(list[Number(card.dataset.idx)]);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  const shortMid = (s) => (s && s.length > 22) ? s.slice(0, 10) + '....' + s.slice(-8) : (s || '-');

  function setCopyable(valueId, btnId, full) {
    const v = document.getElementById(valueId);
    const b = document.getElementById(btnId);
    if (v) v.textContent = full ? shortMid(full) : '-';
    if (b) { b.dataset.copy = full || ''; b.style.display = full ? 'inline-flex' : 'none'; }
  }

  function senderForDisplay(sender) {
    const h = stripAddr(sender);
    return /^[0-9a-fA-F]{40}$/.test(h) ? withPrefix(h) : '';
  }

  function renderTxDetailFields(tx) {
    const meta = statusMeta(tx.unverifiedAt && tx.status === 'pending' ? 'unconfirmed' : tx.status);
    document.getElementById('txDetailIcon').innerHTML = meta.icon;
    document.getElementById('txDetailIcon').className = 'tx-detail-icon ' + meta.cls;
    document.getElementById('txDetailStatus').textContent = meta.label;
    document.getElementById('txDetailStatus').className = 'tx-detail-status-label ' + meta.cls;
    document.getElementById('txDetailAmount').textContent = formatUnits(tx.amount) + ' ' + tokenSymbol;

    setCopyable('txDetailSender', 'txDetailSenderCopy', senderForDisplay(tx.sender != null ? tx.sender : tx.from));
    setCopyable('txDetailTo', 'txDetailToCopy', senderForDisplay(tx.to));
    setCopyable('txDetailHash', 'txDetailHashCopy', tx.txHash || '');

    document.getElementById('txDetailBlock').textContent = tx.blockNumber != null ? String(tx.blockNumber) : '-';
    document.getElementById('txDetailFee').textContent = tx.fee != null ? formatUnits(tx.fee) : '-';
    document.getElementById('txDetailTip').textContent = tx.tip != null ? formatUnits(tx.tip) : '-';
    document.getElementById('txDetailTime').textContent = formatDateTime(tx.timestamp);
  }

  async function showTxDetail(tx) {
    renderTxDetailFields(tx);
    go('tx-detail');

    if (tx && tx.txHash) {
      try {
        const { detail } = await send({ type: 'GET_TX_DETAIL', txHash: tx.txHash });
        renderTxDetailFields({
          status: detail.txStatusText,
          amount: detail.amount,
          to: detail.to,
          txHash: tx.txHash,
          fee: detail.fee,
          tip: detail.tip,
          timestamp: detail.timestamp,
          sender: detail.sender && detail.sender.address,
          nonce: detail.nonce,
          blockNumber: detail.blockNumber,
        });
        if (detail.txStatusText !== tx.status) {
          send({ type: 'GET_HISTORY' }).then(({ history }) => renderHistory(history)).catch(() => {});
        }
      } catch (e) {
        console.warn('Failed to fetch on-chain detail, using local data:', e.message);
      }
    }
  }

  async function loadHistoryAndRender() {
    loadBalance();
    try {
      const { history } = await send({ type: 'GET_HISTORY' });
      renderHistory(history);
    } catch (e) {
      console.warn('Failed to fetch history:', e.message);
      renderHistory([]);
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('.copy-mini');
    if (b && b.dataset.copy) copyWithFeedback(b.dataset.copy, b);
  });

  const $ = (id) => document.getElementById(id);
  const EX_POLL_MS = 2500;
  const EX_LIST_SIZE = 10;
  const EX_TX_PAGE = 50;

  const ICON_EX_BLOCK = '<svg viewBox="0 0 24 24"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>';
  const ICON_EX_TX = '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>';

  let exTimer = null;
  let exBusy = false;
  let exHead = null;
  let exBlocks = new Map();
  let exSeen = new Set();
  let exCurrentBlock = null;
  let exTxShown = 0;

  const toastErr = (e) => showAlert(e && e.message ? e.message : String(e), 'Failed', 'error');

  function exEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function timeAgo(ts) {
    const t = Number(ts);
    if (!t) return '-';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function kvRow({ k, text, copy, onClick, short }) {
    const row = exEl('div', 'kv-row');
    row.appendChild(exEl('span', 'k', k));
    const v = exEl('span', 'v');
    const shown = text == null || text === '' ? '-' : String(text);
    let node;
    if (onClick && shown !== '-') {
      node = exEl('button', 'link');
      node.type = 'button';
      node.addEventListener('click', onClick);
    } else {
      node = exEl('span');
    }
    node.textContent = short ? shortMid(shown) : shown;
    v.appendChild(node);
    if (copy) {
      const btn = exEl('button', 'copy-mini');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Copy ' + k.toLowerCase());
      btn.dataset.copy = copy;
      btn.innerHTML = '<svg viewBox="0 0 24 24">' + COPY_SVG + '</svg>';
      v.appendChild(btn);
    }
    row.appendChild(v);
    return row;
  }

  function fillKV(containerId, rows) {
    const c = $(containerId);
    c.textContent = '';
    rows.forEach((r) => c.appendChild(kvRow(r)));
  }

  function exRow({ icon, title, sub, right, onClick, isNew }) {
    const b = exEl('button', 'ex-row' + (isNew ? ' new' : ''));
    b.type = 'button';
    const ico = exEl('span', 'ex-ico');
    ico.innerHTML = icon; // static markup defined above
    const main = exEl('span', 'main');
    main.append(exEl('div', 't1', title), exEl('div', 't2', sub));
    b.append(ico, main, exEl('span', 'ago', right || ''));
    b.addEventListener('click', onClick);
    return b;
  }

  function exSetLive(online, text) {
    $('exDot').classList.toggle('off', !online);
    $('exLiveLabel').textContent = online ? 'Latest block' : 'Disconnected';
    $('exLiveSub').textContent = text;
  }

  function renderExplorerList() {
    const list = $('exBlocks');
    const blocks = [...exBlocks.values()].sort((a, b) => {
      const x = BigInt(a.number);
      const y = BigInt(b.number);
      return x < y ? 1 : x > y ? -1 : 0;
    });
    $('exHead').textContent = exHead === null ? '-' : exHead.toString();
    $('exBlocksEmpty').style.display = blocks.length ? 'none' : 'block';
    const hadRows = exSeen.size > 0;
    list.textContent = '';
    blocks.forEach((b) => {
      list.appendChild(exRow({
        icon: ICON_EX_BLOCK,
        title: 'Block #' + b.number,
        sub: b.txCount + ' tx · ' + shortAddr(b.workerAddress),
        right: timeAgo(b.timestamp),
        isNew: hadRows && !exSeen.has(b.number),
        onClick: () => openBlock(b.number).catch(toastErr),
      }));
    });
    exSeen = new Set(blocks.map((b) => b.number));
  }

  async function exTick() {
    if (exBusy) return;
    exBusy = true;
    try {
      const { blockNumber } = await send({ type: 'EXPLORER_HEAD' });
      const head = BigInt(blockNumber);
      exHead = head;
      const size = BigInt(EX_LIST_SIZE);
      const low = head >= size - 1n ? head - (size - 1n) : 0n;
      const want = [];
      for (let n = head; n >= low; n--) want.push(n.toString());
      for (const key of [...exBlocks.keys()]) if (!want.includes(key)) exBlocks.delete(key);
      const missing = want.filter((n) => !exBlocks.has(n));
      if (missing.length) {
        const { blocks } = await send({ type: 'EXPLORER_BLOCKS', numbers: missing });
        blocks.forEach((b) => exBlocks.set(b.number, b));
      }
      exSetLive(true, 'Updates every ' + (EX_POLL_MS / 1000) + ' s');
    } catch (e) {
      exSetLive(false, e.message);
    } finally {
      exBusy = false;
    }
    renderExplorerList();
  }

  function explorerEnter() {
    if (exTimer) return;
    $('exError').style.display = 'none';
    renderExplorerList();
    exTick();
    exTimer = setInterval(exTick, EX_POLL_MS);
  }

  function explorerLeave() {
    if (exTimer) { clearInterval(exTimer); exTimer = null; }
  }

  function explorerReset() {
    exHead = null;
    exBlocks = new Map();
    exSeen = new Set();
    exCurrentBlock = null;
    exTxShown = 0;
    renderExplorerList();
    exSetLive(true, 'Connecting…');
  }

  function classifyQuery(raw) {
    const q = String(raw || '').trim();
    if (!q) throw new Error('Enter a tx hash, block number or address.');
    if (/^0x/i.test(q)) throw new Error('The 0x prefix is not supported. Hashes and addresses use the rx prefix.');
    const hasRx = /^rx/i.test(q);
    const body = q.replace(/^rx/i, '');
    if (!hasRx && /^\d{1,20}$/.test(q)) return { kind: 'block', value: q };
    if (/^[0-9a-fA-F]{64}$/.test(body)) return { kind: 'tx', value: 'rx' + body.toLowerCase() };
    if (/^[0-9a-fA-F]{40}$/.test(body)) return { kind: 'account', value: 'rx' + body.toLowerCase() };
    throw new Error('Not recognised. Use a block number, a tx hash (rx + 64 hex) or an address (rx + 40 hex).');
  }

  async function runExplorerSearch() {
    const err = $('exError');
    err.style.display = 'none';
    let q;
    try { q = classifyQuery($('exSearch').value); }
    catch (e) { err.textContent = e.message; err.style.display = 'block'; return; }
    const btn = $('btnExSearch');
    btn.disabled = true;
    try {
      if (q.kind === 'block') await openBlock(q.value);
      else if (q.kind === 'tx') await openTx(q.value);
      else await openAccount(q.value);
      $('exSearch').value = '';
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  }

  async function openBlock(number) {
    const { block } = await send({ type: 'EXPLORER_BLOCK', number: String(number) });
    renderBlock(block);
    go('explorer-block');
  }

  async function openTx(hash) {
    const { detail } = await send({ type: 'GET_TX_DETAIL', txHash: hash });
    renderExplorerTx(detail, hash);
    go('explorer-tx');
  }

  async function openAccount(address) {
    const { account } = await send({ type: 'EXPLORER_ACCOUNT', address });
    renderExplorerAccount(account);
    go('explorer-account');
  }

  const accountLink = (addr) => addr ? () => openAccount(addr).catch(toastErr) : null;

  function renderBlock(b) {
    exCurrentBlock = b;
    const n = BigInt(b.number);
    $('exBlockNum').textContent = '#' + b.number;
    const st = $('exBlockStatus');
    st.textContent = b.statusText.charAt(0).toUpperCase() + b.statusText.slice(1);
    st.className = 'tx-detail-status-label ' + (b.statusText === 'finalized' ? 'success' : 'pending');
    $('btnExPrev').disabled = n === 0n;
    $('btnExNext').disabled = exHead !== null && n >= exHead;
    send({ type: 'EXPLORER_HEAD' }).then(({ blockNumber }) => {   // the head may have moved since the list was drawn
      const head = BigInt(blockNumber);
      if (exHead === null || head > exHead) exHead = head;
      if (exCurrentBlock === b) $('btnExNext').disabled = n >= head;
    }).catch(() => {});
    const worker = b.workerAddress ? withPrefix(b.workerAddress) : '';
    fillKV('exBlockKV', [
      { k: 'Hash', text: b.hash, short: true, copy: b.hash },
      { k: 'Time', text: formatDateTime(b.timestamp) },
      { k: 'Worker', text: worker, short: true, copy: worker, onClick: accountLink(worker) },
      { k: 'Parent', text: n > 0n ? '#' + (n - 1n).toString() : '', copy: n > 0n ? b.previousHash : '',
        onClick: () => openBlock((n - 1n).toString()).catch(toastErr) },
      { k: 'Transactions', text: String(b.txCount) },
      { k: 'Power', text: b.powerUsed + ' / ' + b.powerLimit },
      { k: 'Fees', text: formatUnits(b.feesCollected) + ' ' + tokenSymbol },
      { k: 'Tips', text: formatUnits(b.tipsCollected) + ' ' + tokenSymbol },
      { k: 'State root', text: b.stateRoot, short: true, copy: b.stateRoot },
      { k: 'Tx root', text: b.transactionRoot, short: true, copy: b.transactionRoot },
    ]);
    $('exBlockTxTitle').textContent = 'Transactions (' + b.txCount + ')';
    $('exBlockTxs').textContent = '';
    exTxShown = 0;
    renderMoreBlockTxs();
  }

  function renderMoreBlockTxs() {
    const b = exCurrentBlock;
    if (!b) return;
    const list = $('exBlockTxs');
    b.transactions.slice(exTxShown, exTxShown + EX_TX_PAGE).forEach((h, i) => {
      list.appendChild(exRow({
        icon: ICON_EX_TX,
        title: shortMid(h),
        sub: 'Position ' + (exTxShown + i),
        right: '',
        onClick: () => openTx(h).catch(toastErr),
      }));
    });
    exTxShown = Math.min(b.transactions.length, exTxShown + EX_TX_PAGE);
    $('btnExMoreTx').style.display = exTxShown < b.transactions.length ? 'inline-flex' : 'none';
  }

  function renderExplorerTx(d, fallbackHash) {
    const meta = statusMeta(d.txStatusText);
    $('exTxIcon').innerHTML = meta.icon;
    $('exTxIcon').className = 'tx-detail-icon ' + meta.cls;
    $('exTxStatus').textContent = meta.label;
    $('exTxStatus').className = 'tx-detail-status-label ' + meta.cls;
    $('exTxAmount').textContent = formatUnits(d.amount) + ' ' + tokenSymbol;
    const hash = d.hash || fallbackHash;
    const from = d.sender && d.sender.address ? withPrefix(d.sender.address) : '';
    const to = d.to ? withPrefix(d.to) : '';
    fillKV('exTxKV', [
      { k: 'Hash', text: hash, short: true, copy: hash },
      { k: 'Block', text: d.blockNumber != null ? '#' + d.blockNumber : '', onClick: () => openBlock(d.blockNumber).catch(toastErr) },
      { k: 'Position', text: d.position != null ? String(d.position) : '' },
      { k: 'Time', text: formatDateTime(d.timestamp) },
      { k: 'From', text: from, short: true, copy: from, onClick: accountLink(from) },
      { k: 'To', text: to, short: true, copy: to, onClick: accountLink(to) },
      { k: 'Fee', text: formatUnits(d.fee) + ' ' + tokenSymbol },
      { k: 'Tip', text: formatUnits(d.tip) + ' ' + tokenSymbol },
      { k: 'Nonce', text: d.nonce },
      { k: 'Power', text: d.powerUsed + ' / ' + d.powerLimit },
      { k: 'Price / power', text: formatUnits(d.pricePerPower) + ' ' + tokenSymbol },
      { k: 'Action', text: d.action === 0 ? 'Transfer (0)' : (d.action != null ? String(d.action) : '') },
      { k: 'Event', text: d.event, short: true },
      { k: 'Packet', text: d.packet, short: true },
    ]);
  }

  function renderExplorerAccount(a) {
    $('exAccBalance').textContent = formatUnits(a.balance) + ' ' + tokenSymbol;
    const mine = !!currentAddress && a.address.toLowerCase() === withPrefix(currentAddress).toLowerCase();
    $('exAccTag').style.display = mine ? 'block' : 'none';
    $('exAccNote').style.display = a.found ? 'none' : 'flex';
    fillKV('exAccKV', [
      { k: 'Address', text: a.address, copy: a.address },
      { k: 'Balance', text: formatUnits(a.balance) + ' ' + tokenSymbol },
      { k: 'Nonce', text: a.nonce },
      { k: 'Pending nonce', text: a.pendingNonce },
    ]);
  }

  async function stepBlock(delta) {
    if (!exCurrentBlock) return;
    const n = BigInt(exCurrentBlock.number) + delta;
    if (n < 0n) return;
    try { await openBlock(n.toString()); } catch (e) { toastErr(e); }
  }

  $('btnGoExplorer').onclick = () => go('explorer');
  $('btnExSearch').onclick = runExplorerSearch;
  $('exSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') runExplorerSearch(); });
  $('btnExPrev').onclick = () => stepBlock(-1n);
  $('btnExNext').onclick = () => stepBlock(1n);
  $('btnExMoreTx').onclick = renderMoreBlockTxs;

  $('rpcUrlInput').addEventListener('input', () => { $('chainIdInput').value = ''; });

  (async () => {
    if (!isExtension) {
      const banner = document.getElementById('demoBanner');
      if (banner) {
        banner.style.display = 'flex';
        banner.textContent =
          'This page only works when run as a real Chrome extension (it needs background.js).';
      }
      go('welcome');
      return;
    }
    try { setNetwork(await send({ type: 'GET_NETWORK' })); }
    catch (e) { console.warn('GET_NETWORK failed:', e.message); }
    try {
      const { exists } = await send({ type: 'HAS_WALLET' });
      if (!exists) { go('welcome'); return; }

      let session = { unlocked: false };
      try { session = await send({ type: 'GET_SESSION' }); } catch (e) { console.warn('GET_SESSION failed:', e.message); }
      if (session && session.unlocked && session.address) {
        currentAddress = session.address;
        currentName = session.name || currentName;
        renderHome();
        loadHistoryAndRender();
        go('home');
      } else {
        go('unlock');
      }
    } catch (e) {
      console.warn('HAS_WALLET failed:', e.message);
      go('welcome');
    }
  })();

})();
