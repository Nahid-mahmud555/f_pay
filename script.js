/* ═══════════════════════════════════════════════════════════════════════
   F PAY — Demo application script
   ═══════════════════════════════════════════════════════════════════════
   Demo only. PINs are toy-hashed. Balance lives in localStorage.
   Production F Pay requires a server (see master prompt §3 and §7).
   ═══════════════════════════════════════════════════════════════════════ */

/* ---------- Tailwind config (must run before app code) ---------- */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        cream:     '#FAF8F2',
        surface:   '#FFFFFF',
        ink:       '#202124',
        muted:     '#777777',
        forest:    '#176B52',
        champagne: '#E9E0CF',
        line:      '#EAE7DF',
        warn:      '#B8860B',
        danger:    '#B3261E',
        ok:        '#1E7A4E',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
};

/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */
function toyHash(s){
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return 'demo$' + (h >>> 0).toString(16);
}

const STORAGE_KEY = 'fpay_demo_cny_v2';

const APP = {
  // persistent profile (kept across logout)
  profile: null,            // { name, phone, favHash, pinHash, backupPhone, backupVerified }
  duplicatePinHash: null,   // persistent

  // session-only state (cleared on logout)
  session: null,            // { activeWallet: 'normal' | 'sandbox' }
  reportsUnlocked: false,
  pinGateAction: null,
  pendingTxn: null,
  pendingOtp: null,
  pendingSignup: null,
  currentLayer: null,
  planDraft: null,
  lastReportPeriod: 30,
  hideBalance: false,

  // screen + view for router
  screen: 'welcome',        // auth screens
  view: 'dashboard',        // in-app views

  // wallets (persistent)
  wallets: { normal: null, sandbox: null },
};

const MIN_TRANSFER = 20;
const SANDBOX_START = 1;

/* ═══════════════════════════════════════════════════════════════════════
   Wallet factory
   ═══════════════════════════════════════════════════════════════════════ */
function emptyWallet(mode){
  const layers = Array.from({length:30}, (_, i) => ({
    n: i+1, title: '', desc: '', allocated: 0, locked: true,
  }));
  return {
    mode,
    balance: mode === 'sandbox' ? SANDBOX_START : 10000,
    layers,
    plans: [],
    transactions: mode === 'sandbox' ? seedSandboxTxn() : [],
  };
}

function seedSandboxTxn(){
  const now = Date.now();
  const rows = [
    ['Netflix Subscription', 500,  4],
    ['Food Delivery',        250,  8],
    ['Mobile Recharge',      100,  2],
    ['Shopping',             700,  11],
    ['Monthly Savings',      1000, 12],
  ];
  return rows.map((r, i) => ({
    ref: 'DEMO-SEED-' + (1000 + i),
    purpose: r[0], amount: r[1], layer: r[2],
    recipient: '01XXXXXXXXX', status: 'completed',
    isDemo: true, isSeed: true, ts: now - (i+1) * 86400000,
    planned: null, diff: null, planTitle: null,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════
   Persistence — profile, duplicatePinHash, wallets persist.
   Session state (activeWallet) does NOT persist.
   ═══════════════════════════════════════════════════════════════════════ */
function save(){
  if (!APP.profile) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    profile: APP.profile,
    duplicatePinHash: APP.duplicatePinHash,
    wallets: APP.wallets,
  }));
}

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    APP.profile = d.profile || null;
    APP.duplicatePinHash = d.duplicatePinHash || null;
    APP.wallets = {
      normal:  d.wallets?.normal  || emptyWallet('normal'),
      sandbox: d.wallets?.sandbox || emptyWallet('sandbox'),
    };
    if (!APP.wallets.sandbox || typeof APP.wallets.sandbox.balance !== 'number'){
      APP.wallets.sandbox = emptyWallet('sandbox');
    }
    return true;
  } catch { return false; }
}

/* ═══════════════════════════════════════════════════════════════════════
   Session helpers
   ═══════════════════════════════════════════════════════════════════════ */
function isLoggedIn(){
  return !!(APP.session && APP.session.activeWallet);
}
function activeWalletId(){
  return APP.session ? APP.session.activeWallet : null;
}
function isSandbox(){
  return activeWalletId() === 'sandbox';
}
function wallet(){
  if (!isLoggedIn()) return null;
  return APP.wallets[activeWalletId()] || null;
}

/* ═══════════════════════════════════════════════════════════════════════
   Formatting — CNY
   ═══════════════════════════════════════════════════════════════════════ */
function fmt(n){
  const num = Number(n) || 0;
  return '¥' + num.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2});
}
function mask(phone){
  if (!phone || phone.length < 6) return phone || '';
  return phone.slice(0,3) + '•'.repeat(phone.length - 5) + phone.slice(-2);
}

/* ═══════════════════════════════════════════════════════════════════════
   Toast
   ═══════════════════════════════════════════════════════════════════════ */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ═══════════════════════════════════════════════════════════════════════
   Budget matching
   ═══════════════════════════════════════════════════════════════════════ */
function norm(s){
  return (s || '').toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function matchPlan(purpose, plans){
  const p = norm(purpose);
  if (!p) return { kind:'none' };

  const exact = plans.filter(pl => norm(pl.title) === p);
  if (exact.length === 1) return { kind:'unique', plan: exact[0] };
  if (exact.length > 1)   return { kind:'ambiguous', plans: exact };

  const toks = p.split(' ');
  const sub = plans.filter(pl => {
    const t = norm(pl.title).split(' ');
    return toks.every(x => t.includes(x));
  });
  if (sub.length === 1) return { kind:'unique', plan: sub[0] };
  if (sub.length > 1)   return { kind:'ambiguous', plans: sub };

  return { kind:'none' };
}

function budgetCheck(purpose, amount, plans){
  const m = matchPlan(purpose, plans);
  if (m.kind === 'ambiguous') return { severity:'ambiguous', plans: m.plans };
  if (m.kind !== 'unique' || m.plan.plannedAmount == null) return { severity:'unlinked' };
  const planned = m.plan.plannedAmount;
  const diff = amount - planned;
  return {
    severity: diff > 0 ? 'over' : diff < 0 ? 'under' : 'on',
    plan: m.plan, planned, diff,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   Router
   ═══════════════════════════════════════════════════════════════════════ */
function render(){
  const root = document.getElementById('root');

  if (!isLoggedIn()){
    // Auth flow
    if (APP.screen === 'welcome')          root.innerHTML = viewWelcome();
    else if (APP.screen === 'login')       root.innerHTML = viewLogin();
    else if (APP.screen === 'signup')      root.innerHTML = viewSignup();
    else if (APP.screen === 'signupOtp')   root.innerHTML = viewSignupOtp();
    else if (APP.screen === 'backupSetup') root.innerHTML = viewBackupSetup();
    else if (APP.screen === 'forgot')      root.innerHTML = viewForgot();
    else { APP.screen = 'welcome';         root.innerHTML = viewWelcome(); }
    lucide.createIcons();
    wireAuth();
    return;
  }

  // In-app
  root.innerHTML = viewAppShell();
  renderInner();
  lucide.createIcons();
  wireApp();
}

function renderInner(){
  const el = document.getElementById('inner-view');
  if (!el) return;

  const w = wallet();
  if (!w){
    el.innerHTML = `<div class="card p-8 text-center text-muted text-sm">No active wallet. Please log in.</div>`;
    return;
  }

  let html = '';
  switch (APP.view){
    case 'dashboard':   html = viewDashboard();    break;
    case 'layers':      html = viewLayers();       break;
    case 'layerDetail': html = viewLayerDetail();  break;
    case 'send':        html = viewSend();         break;
    case 'sendReview':  html = viewSendReview();   break;
    case 'sendOtp':     html = viewSendOtp();      break;
    case 'sendResult':  html = viewSendResult();   break;
    case 'aiSub':       html = viewAiSub();        break;
    case 'planEdit':    html = viewPlanEdit();     break;
    case 'insights':    html = viewInsights();     break;
    case 'history':     html = viewHistory();      break;
    case 'settings':    html = viewSettings();     break;
    case 'backup':      html = viewBackupSettings();   break;
    case 'recovery':    html = viewRecoverySettings(); break;
    case 'duplicate':   html = viewDuplicatePin(); break;
    case 'security':    html = viewSecurity();     break;
    case 'webank':      html = viewWeBank();       break;
    default:            html = viewDashboard();
  }
  el.innerHTML = html;
  lucide.createIcons();
  wireApp();
}

/* ═══════════════════════════════════════════════════════════════════════
   Auth screens
   ═══════════════════════════════════════════════════════════════════════ */
function authShell(inner){
  return `<div class="min-h-[88vh] flex items-center justify-center px-5 py-10">
    <div class="w-full max-w-sm">${inner}</div>
  </div>`;
}

function viewWelcome(){
  return authShell(`
    <div class="text-center">
      <div class="mx-auto w-16 h-16 rounded-2xl bg-forest text-white flex items-center justify-center mb-6">
        <i data-lucide="wallet" class="w-8 h-8"></i>
      </div>
      <h1 class="text-3xl font-bold tracking-tight">F Pay</h1>
      <p class="text-muted mt-2 mb-10 text-[15px]">Your Money. Your Rules.</p>
      <button class="btn btn-primary w-full mb-3" data-act="go" data-screen="login">Login</button>
      <button class="btn btn-ghost w-full mb-6" data-act="go" data-screen="signup">Sign Up</button>
      <button class="text-sm text-muted hover:text-ink underline-offset-4 hover:underline" data-act="go" data-screen="forgot">Forgot PIN?</button>
      <p class="text-[11px] text-muted mt-12 leading-relaxed">
        Demo build. All amounts shown in CNY (¥). No real money moves.<br>
        Data stays in this browser only.
      </p>
    </div>
  `);
}

function viewLogin(){
  return authShell(`
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="go" data-screen="welcome">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Back
    </button>
    <h2 class="text-2xl font-bold mb-1">Welcome back</h2>
    <p class="text-muted text-sm mb-8">Sign in to your F Pay wallet.</p>
    <form id="login-form" class="space-y-4">
      <div>
        <label class="text-sm font-medium block mb-1.5">Mobile number</label>
        <input class="input" name="phone" inputmode="numeric" placeholder="01XXXXXXXXX" autocomplete="tel">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">PIN</label>
        <input class="input" name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
      </div>
      <div id="login-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Login</button>
    </form>
    <div class="text-center mt-6">
      <button class="text-sm text-muted hover:text-ink" data-act="go" data-screen="forgot">Forgot PIN?</button>
    </div>
  `);
}

function viewSignup(){
  return authShell(`
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="go" data-screen="welcome">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Back
    </button>
    <h2 class="text-2xl font-bold mb-1">Create account</h2>
    <p class="text-muted text-sm mb-8">The demo OTP will be shown on screen.</p>
    <form id="signup-form" class="space-y-4">
      <div>
        <label class="text-sm font-medium block mb-1.5">Full name</label>
        <input class="input" name="name" placeholder="Your name" autocomplete="name">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Mobile number</label>
        <input class="input" name="phone" inputmode="numeric" placeholder="01XXXXXXXXX" autocomplete="tel">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Favourite sentence <span class="text-muted font-normal">(recovery signal)</span></label>
        <input class="input" name="fav" placeholder="e.g. my first pet's name">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">PIN (4–6 digits)</label>
        <input class="input" name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Confirm PIN</label>
        <input class="input" name="pin2" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
      </div>
      <div id="signup-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Create Account</button>
    </form>
  `);
}

function viewSignupOtp(){
  const o = APP.pendingSignup || {};
  return authShell(`
    <h2 class="text-2xl font-bold mb-1">Verify your number</h2>
    <p class="text-muted text-sm mb-6">Enter the 5-digit code sent to ${mask(o.phone || '')}.</p>
    <div class="card p-4 mb-6 bg-amber-50 border-amber-200">
      <div class="flex items-start gap-2">
        <i data-lucide="info" class="w-4 h-4 text-amber-700 mt-0.5"></i>
        <div class="text-xs text-amber-900 leading-relaxed">
          <strong>Demo OTP:</strong>
          <span class="font-mono font-bold tracking-widest">${o.otp || '-----'}</span><br>
          Simulated — not a real SMS.
        </div>
      </div>
    </div>
    <form id="otp-form" class="space-y-4">
      <input class="input text-center text-2xl tracking-[0.5em] font-mono" name="otp" inputmode="numeric" maxlength="5" placeholder="─────">
      <div id="otp-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Verify</button>
    </form>
    <button class="text-sm text-muted mt-6 block mx-auto" data-act="cancelSignup">Cancel</button>
  `);
}

function viewBackupSetup(){
  return authShell(`
    <div class="text-center mb-8">
      <div class="mx-auto w-12 h-12 rounded-xl bg-champagne flex items-center justify-center mb-4">
        <i data-lucide="shield-check" class="w-6 h-6 text-forest"></i>
      </div>
      <h2 class="text-xl font-bold mb-1">Add a backup number?</h2>
      <p class="text-muted text-sm">Optional. Used only for account recovery.</p>
    </div>
    <form id="backup-form" class="space-y-4">
      <input class="input" name="phone" inputmode="numeric" placeholder="Backup mobile number (optional)">
      <div class="flex gap-2">
        <button type="button" class="btn btn-ghost flex-1" data-act="skipBackup">Skip for now</button>
        <button type="submit" class="btn btn-primary flex-1">Add number</button>
      </div>
    </form>
  `);
}

function viewForgot(){
  return authShell(`
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="go" data-screen="login">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Back
    </button>
    <h2 class="text-2xl font-bold mb-1">Reset your PIN</h2>
    <p class="text-muted text-sm mb-8">Enter your registered mobile number.</p>
    <form id="forgot-form" class="space-y-4">
      <input class="input" name="phone" inputmode="numeric" placeholder="01XXXXXXXXX">
      <div id="forgot-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Send verification code</button>
    </form>
    <p class="text-[11px] text-muted mt-8 leading-relaxed">
      Real F Pay requires server-verified SMS + favourite-sentence check.
      This demo does not reset your PIN.
    </p>
  `);
}

/* ═══════════════════════════════════════════════════════════════════════
   App shell
   ═══════════════════════════════════════════════════════════════════════ */
function viewAppShell(){
  const sandbox = isSandbox();
  const nav = [
    ['dashboard', 'Home',     'home'],
    ['layers',    'Layers',   'layers'],
    ['send',      'Send',     'send'],
    ['aiSub',     'AI Sub',   'sparkles'],
    ['insights',  'Insights', 'bar-chart-3'],
    ['webank',    'WeBank',   'landmark'],
  ];
  return `
  <div class="flex min-h-[calc(100vh-30px)]">
    <aside class="desk-nav hidden md:flex flex-col w-64 bg-white border-r border-line p-5 fixed h-[calc(100vh-30px)]">
      <div class="flex items-center gap-2 mb-8 px-2">
        <div class="w-9 h-9 rounded-xl bg-forest text-white flex items-center justify-center">
          <i data-lucide="wallet" class="w-4 h-4"></i>
        </div>
        <div>
          <div class="font-bold text-[15px]">F Pay</div>
          <div class="text-[10px] text-muted -mt-0.5">${sandbox ? 'SANDBOX' : 'PERSONAL'}</div>
        </div>
      </div>
      <nav class="space-y-1 flex-1">
        ${nav.map(([k, l, i]) => `
          <div class="nav-item ${APP.view === k ? 'active' : ''}" data-act="view" data-view="${k}">
            <i data-lucide="${i}" class="w-4 h-4"></i> ${l}
          </div>`).join('')}
      </nav>
      <div class="space-y-1 pt-4 border-t border-line">
        <div class="nav-item" data-act="view" data-view="settings"><i data-lucide="settings" class="w-4 h-4"></i> Settings</div>
        <div class="nav-item" data-act="logout"><i data-lucide="log-out" class="w-4 h-4"></i> Log out</div>
      </div>
    </aside>

    <main class="with-sidebar ml-0 md:ml-64 flex-1 p-5 md:p-8 w-full">
      <header class="flex items-center justify-between mb-6 gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="md:hidden w-9 h-9 rounded-xl bg-forest text-white flex items-center justify-center shrink-0">
            <i data-lucide="wallet" class="w-4 h-4"></i>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted truncate">${sandbox ? 'Sandbox wallet (CNY demo)' : 'Personal wallet (CNY)'}</div>
            <div class="font-semibold text-sm truncate">${APP.profile.name}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${sandbox ? '<span class="pill pill-demo">DEMO ¥1</span>' : ''}
          <button class="btn btn-ghost !p-2.5 relative" data-act="menu-toggle" aria-label="Account menu">
            <i data-lucide="more-vertical" class="w-4 h-4"></i>
          </button>
          <div id="menu-pop" class="hidden absolute right-5 top-16 bg-white border border-line rounded-xl shadow-lg p-1.5 z-40 w-52">
            <div class="nav-item" data-act="view" data-view="settings"><i data-lucide="user" class="w-4 h-4"></i> Account Settings</div>
            <div class="nav-item" data-act="view" data-view="backup"><i data-lucide="phone" class="w-4 h-4"></i> Backup Number</div>
            <div class="nav-item" data-act="view" data-view="recovery"><i data-lucide="key-round" class="w-4 h-4"></i> Recovery Method</div>
            <div class="nav-item" data-act="view" data-view="duplicate"><i data-lucide="copy" class="w-4 h-4"></i> Duplicate PIN</div>
            <div class="nav-item" data-act="view" data-view="security"><i data-lucide="shield" class="w-4 h-4"></i> Security</div>
            <div class="nav-item" data-act="view" data-view="history"><i data-lucide="receipt" class="w-4 h-4"></i> Transaction History</div>
            <div class="nav-item" data-act="logout"><i data-lucide="log-out" class="w-4 h-4"></i> Logout</div>
          </div>
        </div>
      </header>
      <div id="inner-view"></div>
    </main>

    <nav class="mob-nav fixed bottom-0 left-0 right-0 bg-white border-t border-line flex justify-around py-2 z-30">
      ${nav.map(([k, l, i]) => `
        <button class="flex flex-col items-center gap-0.5 px-2 py-1 ${APP.view === k ? 'text-forest' : 'text-muted'}" data-act="view" data-view="${k}">
          <i data-lucide="${i}" class="w-5 h-5"></i>
          <span class="text-[10px] font-medium">${l}</span>
        </button>`).join('')}
    </nav>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */
function viewDashboard(){
  const w = wallet();
  const allocated = w.layers.reduce((s, l) => s + l.allocated, 0);
  const unallocated = w.balance - allocated;
  const sandbox = isSandbox();
  return `
    <div class="card p-6 mb-6 bg-gradient-to-br from-forest to-emerald-800 text-white border-0">
      <div class="flex items-center justify-between mb-2">
        <span class="text-white/70 text-xs uppercase tracking-wider font-medium">
          ${sandbox ? 'Sandbox Balance (CNY Demo)' : 'Main Balance (CNY)'}
        </span>
        <button class="text-white/70 hover:text-white" data-act="toggle-balance" aria-label="Toggle balance">
          <i data-lucide="${APP.hideBalance ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>
        </button>
      </div>
      <div class="text-3xl font-bold tracking-tight mb-4">${APP.hideBalance ? '¥•••••' : fmt(w.balance)}</div>
      <div class="grid grid-cols-2 gap-4 pt-4 border-t border-white/15">
        <div>
          <div class="text-white/60 text-[11px] uppercase tracking-wider">Allocated</div>
          <div class="font-semibold mt-0.5">${APP.hideBalance ? '••••' : fmt(allocated)}</div>
        </div>
        <div>
          <div class="text-white/60 text-[11px] uppercase tracking-wider">Unallocated</div>
          <div class="font-semibold mt-0.5">${APP.hideBalance ? '••••' : fmt(unallocated)}</div>
        </div>
      </div>
      ${sandbox ? `
        <div class="mt-4 pt-4 border-t border-white/15 text-xs text-white/80 leading-relaxed">
          The sandbox always holds ¥1 by design. Transfers below ¥20 are rejected.
          Use the demo replay to preview a completed transaction without changing this balance.
        </div>
      ` : ''}
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <button class="card p-4 text-left hover:border-forest transition" data-act="view" data-view="send">
        <i data-lucide="send" class="w-5 h-5 text-forest mb-2"></i>
        <div class="font-semibold text-sm">Send Money</div>
        <div class="text-xs text-muted">Min ¥${MIN_TRANSFER}</div>
      </button>
      <button class="card p-4 text-left hover:border-forest transition" data-act="view" data-view="aiSub">
        <i data-lucide="sparkles" class="w-5 h-5 text-forest mb-2"></i>
        <div class="font-semibold text-sm">AI Sub</div>
        <div class="text-xs text-muted">${w.plans.length} plan${w.plans.length === 1 ? '' : 's'}</div>
      </button>
      <button class="card p-4 text-left hover:border-forest transition" data-act="view" data-view="insights">
        <i data-lucide="bar-chart-3" class="w-5 h-5 text-forest mb-2"></i>
        <div class="font-semibold text-sm">Insights</div>
        <div class="text-xs text-muted">PIN protected</div>
      </button>
      <button class="card p-4 text-left hover:border-forest transition" data-act="view" data-view="webank">
        <i data-lucide="landmark" class="w-5 h-5 text-forest mb-2"></i>
        <div class="font-semibold text-sm">WeBank</div>
        <div class="text-xs text-muted">Invest / save</div>
      </button>
    </div>

    <div class="flex items-center justify-between mb-4">
      <h2 class="font-semibold text-lg">Money Layers</h2>
      <button class="text-sm text-forest font-medium" data-act="view" data-view="layers">View all 30</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
      ${w.layers.slice(0, 10).map(layerTile).join('')}
    </div>
  `;
}

function layerTile(l){
  const configured = !!l.title;
  return `
    <button class="layer-tile ${configured ? '' : 'empty'}" data-act="open-layer" data-n="${l.n}">
      <div class="flex items-center justify-between w-full">
        <span class="text-[11px] text-muted font-mono">L${String(l.n).padStart(2, '0')}</span>
        <i data-lucide="${configured ? 'lock' : 'plus'}" class="w-3.5 h-3.5 ${configured ? 'text-warn' : 'text-muted'}"></i>
      </div>
      <div class="mt-auto">
        <div class="text-[13px] font-semibold truncate ${configured ? 'text-ink' : 'text-muted'}">${configured ? l.title : 'Empty layer'}</div>
        <div class="text-[11px] text-muted mt-0.5">${configured ? fmt(l.allocated) : 'Tap to set up'}</div>
      </div>
    </button>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   Layers
   ═══════════════════════════════════════════════════════════════════════ */
function viewLayers(){
  const w = wallet();
  return `
    <div class="mb-6">
      <h1 class="text-2xl font-bold mb-1">All 30 Money Layers</h1>
      <p class="text-sm text-muted">Virtual budget compartments — not separate bank accounts. Amounts in CNY (¥).</p>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      ${w.layers.map(layerTile).join('')}
    </div>
  `;
}

function viewLayerDetail(){
  const w = wallet();
  const l = w.layers.find(x => x.n === APP.currentLayer);
  if (!l) return `<p class="text-muted">Layer not found.</p>`;
  const configured = !!l.title;
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="layers">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> All layers
    </button>
    <div class="mb-6">
      <div class="text-xs text-muted font-mono mb-1">LAYER ${String(l.n).padStart(2, '0')}</div>
      <h1 class="text-2xl font-bold">${configured ? l.title : 'Unconfigured layer'}</h1>
      ${configured && l.desc ? `<p class="text-sm text-muted mt-1">${l.desc}</p>` : ''}
    </div>

    ${configured ? `
      <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="card p-4">
          <div class="text-xs text-muted uppercase tracking-wider">Allocated</div>
          <div class="text-xl font-bold mt-1">${fmt(l.allocated)}</div>
        </div>
        <div class="card p-4">
          <div class="text-xs text-muted uppercase tracking-wider">Remaining</div>
          <div class="text-xl font-bold mt-1">${fmt(layerRemaining(l))}</div>
        </div>
      </div>

      <div class="flex gap-2 mb-6">
        <button class="btn btn-primary flex-1" data-act="edit-layer">Edit / Adjust</button>
        <button class="btn btn-ghost flex-1" data-act="release-layer">Release</button>
      </div>

      <h3 class="font-semibold mb-3">Layer history</h3>
      ${layerTransactions(l).length ? `
        <div class="space-y-2">${layerTransactions(l).map(txnRow).join('')}</div>
      ` : `
        <div class="card p-8 text-center">
          <i data-lucide="inbox" class="w-8 h-8 text-muted mx-auto mb-2"></i>
          <p class="text-sm text-muted">No activity in this layer yet.</p>
        </div>
      `}
    ` : `
      <form id="allocate-form" class="card p-5 space-y-4">
        <div>
          <label class="text-sm font-medium block mb-1.5">Layer title</label>
          <input class="input" name="title" placeholder="e.g. Netflix Subscription" maxlength="40">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Amount to allocate (¥)</label>
          <input class="input" name="amount" inputmode="decimal" placeholder="500">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Description <span class="text-muted font-normal">(optional)</span></label>
          <textarea class="input" name="desc" rows="2" placeholder="Notes" maxlength="120"></textarea>
        </div>
        <div id="allocate-error" class="text-danger text-sm hidden"></div>
        <div class="flex gap-2 pt-2">
          <button type="button" class="btn btn-ghost flex-1" data-act="view" data-view="layers">Cancel</button>
          <button type="submit" class="btn btn-primary flex-1">Save allocation</button>
        </div>
      </form>
    `}
  `;
}

function layerRemaining(l){
  const w = wallet();
  const spent = w.transactions
    .filter(t => t.layer === l.n && t.status === 'completed')
    .reduce((s, t) => s + t.amount, 0);
  return Math.max(0, l.allocated - spent);
}
function layerTransactions(l){
  return wallet().transactions.filter(t => t.layer === l.n).slice().sort((a, b) => b.ts - a.ts);
}

/* ═══════════════════════════════════════════════════════════════════════
   Send money
   ═══════════════════════════════════════════════════════════════════════ */
function viewSend(){
  const w = wallet();
  const sandbox = isSandbox();
  const configured = w.layers.filter(l => l.title);

  if (sandbox){
    return `
      <div class="mb-6">
        <h1 class="text-2xl font-bold mb-1">Send Money</h1>
        <p class="text-sm text-muted">Sandbox — simulation only.</p>
      </div>
      <div class="card p-6 mb-4 border-amber-200 bg-amber-50">
        <div class="flex items-start gap-3">
          <i data-lucide="alert-triangle" class="w-5 h-5 text-amber-700 mt-0.5"></i>
          <div>
            <div class="font-semibold text-amber-900 text-sm mb-1">Sandbox balance is ¥1 — below the ¥${MIN_TRANSFER} minimum</div>
            <p class="text-xs text-amber-900 leading-relaxed">
              This is intentional. The sandbox keeps ¥1 at all times so you can explore the
              interface and the seeded transaction history without creating fake successful transfers.
            </p>
          </div>
        </div>
      </div>
      <div class="card p-5">
        <h3 class="font-semibold text-sm mb-2">Preview a demo transfer</h3>
        <p class="text-xs text-muted mb-4 leading-relaxed">
          This appends a clearly-labeled fictional transaction to your sandbox history.
          It does not change your ¥1 balance and is not a real transfer.
        </p>
        <button class="btn btn-ghost w-full" data-act="demo-replay">Run demo replay</button>
      </div>
    `;
  }

  return `
    <div class="mb-6">
      <h1 class="text-2xl font-bold mb-1">Send Money</h1>
      <p class="text-sm text-muted">Simulated transfer in CNY. Minimum ¥${MIN_TRANSFER}.</p>
    </div>
    ${configured.length === 0 ? `
      <div class="card p-8 text-center">
        <i data-lucide="layers" class="w-10 h-10 text-muted mx-auto mb-3"></i>
        <h3 class="font-semibold mb-1">No configured layers</h3>
        <p class="text-sm text-muted mb-5">Set up a money layer before sending.</p>
        <button class="btn btn-primary" data-act="view" data-view="layers">Configure a layer</button>
      </div>
    ` : `
      <form id="send-form" class="card p-5 space-y-4">
        <div>
          <label class="text-sm font-medium block mb-1.5">Recipient number</label>
          <input class="input" name="phone" inputmode="numeric" placeholder="01XXXXXXXXX">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Purpose / title</label>
          <input class="input" name="purpose" placeholder="e.g. Netflix Subscription">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Source layer</label>
          <select class="input" name="layer">
            <option value="">Select layer…</option>
            ${configured.map(l => `<option value="${l.n}">Layer ${String(l.n).padStart(2, '0')} — ${l.title} (${fmt(layerRemaining(l))} left)</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Amount (¥)</label>
          <input class="input" name="amount" inputmode="decimal" placeholder="500">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">PIN</label>
          <input class="input" name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
        </div>
        <div id="send-error" class="text-danger text-sm hidden"></div>
        <button type="submit" class="btn btn-primary w-full">Continue to Review</button>
      </form>
    `}
  `;
}

function viewSendReview(){
  const t = APP.pendingTxn;
  if (!t) return `<p class="text-muted">No pending transaction.</p>`;
  const bc = t.budget;
  let warning = '';
  if (bc.severity === 'over'){
    warning = `<div class="card p-4 bg-amber-50 border-amber-200 mb-4">
      <div class="flex gap-2 items-start">
        <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-700 mt-0.5"></i>
        <div>
          <div class="font-semibold text-sm text-amber-900">Budget alert</div>
          <p class="text-xs text-amber-900 mt-1 leading-relaxed">
            You planned ${fmt(bc.planned)} for "${bc.plan.title}", but this transaction is ${fmt(t.amount)}.
            That is ${fmt(bc.diff)} above your planned amount. Review before continuing.
          </p>
          <p class="text-[11px] text-amber-800 mt-2 leading-relaxed">
            Informational only — you're still in control.
          </p>
        </div>
      </div>
    </div>`;
  } else if (bc.severity === 'under'){
    warning = `<div class="card p-4 bg-emerald-50 border-emerald-200 mb-4">
      <div class="text-xs text-emerald-900">
        This transaction is ${fmt(Math.abs(bc.diff))} below your planned amount.
      </div>
    </div>`;
  } else if (bc.severity === 'on'){
    warning = `<div class="card p-4 bg-emerald-50 border-emerald-200 mb-4">
      <div class="text-xs text-emerald-900">Matches your planned amount exactly.</div>
    </div>`;
  } else if (bc.severity === 'unlinked'){
    warning = `<div class="card p-4 mb-4">
      <div class="text-xs text-muted">Not linked to a saved budget plan.</div>
    </div>`;
  } else if (bc.severity === 'ambiguous'){
    warning = `<div class="card p-4 mb-4">
      <div class="text-xs text-muted">
        Multiple plans match "${t.purpose}". No automatic budget comparison was applied.
      </div>
    </div>`;
  }
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="send">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Back
    </button>
    <h1 class="text-2xl font-bold mb-6">Review</h1>
    ${warning}
    <div class="card p-5 mb-4 space-y-3">
      ${reviewRow('Recipient', t.recipient)}
      ${reviewRow('Purpose', t.purpose)}
      ${reviewRow('Source layer', 'Layer ' + String(t.layer).padStart(2, '0'))}
      ${reviewRow('Amount', fmt(t.amount), true)}
    </div>
    <div class="flex flex-col gap-2">
      <button class="btn btn-primary w-full" data-act="confirm-send">Confirm & Send</button>
      <button class="btn btn-ghost w-full" data-act="cancel-send">Cancel Transaction</button>
    </div>
  `;
}
function reviewRow(k, v, big){
  return `<div class="flex items-center justify-between">
    <span class="text-sm text-muted">${k}</span>
    <span class="${big ? 'font-bold text-lg' : 'font-medium'}">${v}</span>
  </div>`;
}

function viewSendOtp(){
  const t = APP.pendingOtp;
  if (!t) return `<p class="text-muted">No pending verification.</p>`;
  return `
    <h1 class="text-2xl font-bold mb-1">Confirm transfer</h1>
    <p class="text-sm text-muted mb-6">Enter the 5-digit code for ${fmt(APP.pendingTxn?.amount || 0)}.</p>
    <div class="card p-4 bg-amber-50 border-amber-200 mb-6">
      <div class="text-xs text-amber-900">
        <strong>Demo OTP:</strong> <span class="font-mono font-bold tracking-widest">${t.code}</span><br>
        Simulated — not a real SMS.
      </div>
    </div>
    <form id="send-otp-form" class="space-y-4">
      <input class="input text-center text-2xl tracking-[0.5em] font-mono" name="otp" inputmode="numeric" maxlength="5" placeholder="─────">
      <div id="send-otp-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Verify & Send</button>
      <button type="button" class="btn btn-ghost w-full" data-act="cancel-send">Cancel</button>
    </form>
  `;
}

function viewSendResult(){
  const t = APP.pendingTxn;
  if (!t || !t.result) return `<p class="text-muted">No result.</p>`;
  const ok = t.result === 'success';
  return `
    <div class="text-center py-8">
      <div class="mx-auto w-16 h-16 rounded-full ${ok ? 'bg-emerald-100' : 'bg-red-100'} flex items-center justify-center mb-5">
        <i data-lucide="${ok ? 'check' : 'x'}" class="w-8 h-8 ${ok ? 'text-emerald-700' : 'text-red-700'}"></i>
      </div>
      <h1 class="text-xl font-bold mb-1">${ok ? 'Transfer complete' : 'Transfer failed'}</h1>
      <p class="text-sm text-muted mb-6">
        ${ok ? 'Simulated transaction in CNY — no real money moved.' : 'Verification did not succeed. No balance was changed.'}
      </p>
      ${ok ? `
        <div class="card p-5 text-left mb-6 space-y-3">
          ${reviewRow('Reference', t.ref)}
          ${reviewRow('Amount', fmt(t.amount))}
          ${reviewRow('To', t.recipient)}
          ${reviewRow('From layer', 'Layer ' + String(t.layer).padStart(2, '0'))}
        </div>
      ` : ''}
      <button class="btn btn-primary w-full" data-act="view" data-view="dashboard">Back to Wallet</button>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   AI Sub
   ═══════════════════════════════════════════════════════════════════════ */
function viewAiSub(){
  const w = wallet();
  return `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold mb-1">AI Sub</h1>
        <p class="text-sm text-muted">Deterministic rule-based plans — not a real AI model.</p>
      </div>
      <button class="btn btn-primary" data-act="new-plan">New Plan</button>
    </div>
    ${w.plans.length === 0 ? `
      <div class="card p-10 text-center">
        <i data-lucide="sparkles" class="w-10 h-10 text-muted mx-auto mb-3"></i>
        <h3 class="font-semibold mb-1">No plans yet</h3>
        <p class="text-sm text-muted mb-5 max-w-sm mx-auto">Create a plan to receive spending warnings on matching transactions.</p>
        <button class="btn btn-primary" data-act="new-plan">Create your first plan</button>
      </div>
    ` : `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${w.plans.map(planCard).join('')}
      </div>
    `}
  `;
}
function planCard(p){
  const layer = p.layer ? wallet().layers.find(x => x.n === p.layer) : null;
  return `
    <div class="card p-5">
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="font-semibold">${p.title}</div>
          ${p.desc ? `<div class="text-xs text-muted mt-0.5">${p.desc}</div>` : ''}
        </div>
        <span class="pill pill-demo">${p.interval}d</span>
      </div>
      <div class="flex items-center gap-4 text-sm mb-4">
        <div>
          <div class="text-[10px] text-muted uppercase tracking-wider">Planned</div>
          <div class="font-semibold">${p.plannedAmount != null ? fmt(p.plannedAmount) : '—'}</div>
        </div>
        <div>
          <div class="text-[10px] text-muted uppercase tracking-wider">Layer</div>
          <div class="font-semibold">${layer ? ('L' + String(layer.n).padStart(2, '0')) : '—'}</div>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-ghost flex-1 !py-2 !text-xs" data-act="edit-plan" data-id="${p.id}">Edit</button>
        <button class="btn btn-danger flex-1 !py-2 !text-xs" data-act="delete-plan" data-id="${p.id}">Delete</button>
      </div>
    </div>`;
}

function viewPlanEdit(){
  const p = APP.planDraft;
  const w = wallet();
  const configured = w.layers.filter(l => l.title);
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="aiSub">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> AI Sub
    </button>
    <h1 class="text-2xl font-bold mb-6">${p.id ? 'Edit plan' : 'New budget plan'}</h1>
    <form id="plan-form" class="card p-5 space-y-4">
      <div>
        <label class="text-sm font-medium block mb-1.5">Plan title</label>
        <input class="input" name="title" value="${p.title || ''}" placeholder="e.g. Netflix Subscription">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Description <span class="text-muted font-normal">(optional)</span></label>
        <input class="input" name="desc" value="${p.desc || ''}" placeholder="Notes">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Money layer <span class="text-muted font-normal">(optional)</span></label>
        <select class="input" name="layer">
          <option value="">None</option>
          ${configured.map(l => `<option value="${l.n}" ${p.layer === l.n ? 'selected' : ''}>Layer ${String(l.n).padStart(2, '0')} — ${l.title}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Planned amount (¥) <span class="text-muted font-normal">(optional)</span></label>
        <input class="input" name="amount" inputmode="decimal" value="${p.plannedAmount != null ? p.plannedAmount : ''}" placeholder="500">
      </div>
      <div>
        <label class="text-sm font-medium block mb-1.5">Reporting interval</label>
        <div class="grid grid-cols-3 gap-2">
          ${[7, 15, 30].map(d => `
            <button type="button" class="btn ${p.interval === d ? 'btn-primary' : 'btn-ghost'} !py-2.5 !text-sm" data-act="set-interval" data-d="${d}">${d} days</button>
          `).join('')}
        </div>
      </div>
      <div id="plan-error" class="text-danger text-sm hidden"></div>
      <div class="flex gap-2 pt-2">
        <button type="button" class="btn btn-ghost flex-1" data-act="view" data-view="aiSub">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1">Save plan</button>
      </div>
    </form>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   Insights
   ═══════════════════════════════════════════════════════════════════════ */
function viewInsights(){
  if (!APP.reportsUnlocked){
    return `
      <div class="max-w-sm mx-auto mt-10 text-center">
        <div class="mx-auto w-14 h-14 rounded-2xl bg-champagne flex items-center justify-center mb-5">
          <i data-lucide="lock" class="w-6 h-6 text-forest"></i>
        </div>
        <h1 class="text-xl font-bold mb-1">Insights are locked</h1>
        <p class="text-sm text-muted mb-6">Enter your PIN to view financial reports.</p>
        <form id="unlock-form" class="space-y-4 text-left">
          <input class="input text-center tracking-[0.4em] font-mono" name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
          <div id="unlock-error" class="text-danger text-sm hidden"></div>
          <button class="btn btn-primary w-full" type="submit">Unlock</button>
        </form>
      </div>`;
  }
  const w = wallet();
  const period = APP.lastReportPeriod;
  const since = Date.now() - period * 86400000;
  const txns = w.transactions.filter(t => t.status === 'completed' && t.ts >= since);
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const plannedTotal = w.plans.filter(p => p.plannedAmount != null).reduce((s, p) => s + p.plannedAmount, 0);
  const allocated = w.layers.reduce((s, l) => s + l.allocated, 0);
  const byLayer = {};
  txns.forEach(t => { byLayer[t.layer] = (byLayer[t.layer] || 0) + t.amount; });
  const over = txns.filter(t => t.diff != null && t.diff > 0);
  const under = txns.filter(t => t.diff != null && t.diff < 0);
  const unplanned = txns.filter(t => t.planned == null);
  const maxLayer = Object.entries(byLayer).sort((a, b) => b[1] - a[1])[0];

  return `
    <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold mb-1">Insights</h1>
        <p class="text-sm text-muted">Informational only — you stay in control.</p>
      </div>
      <div class="flex gap-1 bg-white border border-line rounded-xl p-1">
        ${[7, 15, 30].map(d => `
          <button class="btn ${period === d ? 'btn-primary' : '!bg-transparent !text-muted'} !py-1.5 !px-3 !text-xs" data-act="set-period" data-d="${d}">${d}d</button>
        `).join('')}
      </div>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <div class="card p-4">
        <div class="text-[10px] text-muted uppercase tracking-wider">Wallet</div>
        <div class="font-bold text-lg mt-1">${fmt(w.balance)}</div>
      </div>
      <div class="card p-4">
        <div class="text-[10px] text-muted uppercase tracking-wider">Allocated</div>
        <div class="font-bold text-lg mt-1">${fmt(allocated)}</div>
      </div>
      <div class="card p-4">
        <div class="text-[10px] text-muted uppercase tracking-wider">Spent (${period}d)</div>
        <div class="font-bold text-lg mt-1">${fmt(totalSpent)}</div>
      </div>
      <div class="card p-4">
        <div class="text-[10px] text-muted uppercase tracking-wider">Planned budget</div>
        <div class="font-bold text-lg mt-1">${fmt(plannedTotal)}</div>
      </div>
    </div>

    <div class="card p-5 mb-6">
      <h3 class="font-semibold mb-4">Report — last ${period} days</h3>
      <div class="space-y-3 text-sm">
        <div class="flex justify-between"><span class="text-muted">Total spent</span><span class="font-semibold">${fmt(totalSpent)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Planned budget</span><span class="font-semibold">${fmt(plannedTotal)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Remaining vs plan</span><span class="font-semibold ${plannedTotal - totalSpent < 0 ? 'text-danger' : 'text-ok'}">${fmt(plannedTotal - totalSpent)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Over-budget</span><span class="font-semibold">${over.length}</span></div>
        <div class="flex justify-between"><span class="text-muted">Under-budget</span><span class="font-semibold">${under.length}</span></div>
        <div class="flex justify-between"><span class="text-muted">Unplanned</span><span class="font-semibold">${unplanned.length}</span></div>
      </div>
    </div>

    ${Object.keys(byLayer).length ? `
      <div class="card p-5 mb-6">
        <h3 class="font-semibold mb-4">Spending by layer</h3>
        <div class="space-y-3">
          ${Object.entries(byLayer).sort((a, b) => b[1] - a[1]).map(([n, amt]) => {
            const layer = w.layers.find(x => x.n == n);
            const pct = totalSpent ? Math.round(amt / totalSpent * 100) : 0;
            return `
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span>L${String(n).padStart(2, '0')} · ${layer?.title || 'Unnamed'}</span>
                  <span class="font-semibold">${fmt(amt)} · ${pct}%</span>
                </div>
                <div class="h-2 bg-cream rounded-full overflow-hidden">
                  <div class="h-full bg-forest rounded-full" style="width:${pct}%"></div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>
    ` : ''}

    <div class="card p-5">
      <h3 class="font-semibold mb-3">Insights</h3>
      <ul class="text-sm space-y-2 text-muted">
        ${totalSpent > plannedTotal && plannedTotal > 0
          ? `<li>• You spent <strong>${fmt(totalSpent - plannedTotal)}</strong> more than planned in the last ${period} days.</li>` : ''}
        ${unplanned.length ? `<li>• <strong>${unplanned.length}</strong> transaction${unplanned.length === 1 ? ' was' : 's were'} not linked to a saved plan.</li>` : ''}
        ${over.length && maxLayer ? `<li>• L${String(maxLayer[0]).padStart(2, '0')} was your highest-spend layer at ${fmt(maxLayer[1])}.</li>` : ''}
        ${!totalSpent ? `<li>No completed transactions in this period.</li>` : ''}
      </ul>
      <p class="text-[11px] text-muted mt-4 pt-4 border-t border-line leading-relaxed">
        Recommendations are informational only. Final decisions remain yours.
      </p>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   History
   ═══════════════════════════════════════════════════════════════════════ */
function viewHistory(){
  const w = wallet();
  const txns = w.transactions.slice().sort((a, b) => b.ts - a.ts);
  return `
    <h1 class="text-2xl font-bold mb-1">Transaction History</h1>
    <p class="text-sm text-muted mb-6">
      ${isSandbox() ? 'Sandbox — all entries fictional. Balance remains ¥1.' : 'All simulated transactions in CNY.'}
    </p>
    ${txns.length === 0 ? `
      <div class="card p-10 text-center">
        <i data-lucide="receipt" class="w-10 h-10 text-muted mx-auto mb-3"></i>
        <p class="text-sm text-muted">No transactions yet.</p>
      </div>
    ` : `
      <div class="space-y-2">${txns.map(txnRow).join('')}</div>
    `}
  `;
}
function txnRow(t){
  const isSeed = t.isSeed ? '<span class="pill pill-demo ml-2">SAMPLE</span>' : '';
  const isDemo = t.isDemo && !t.isSeed ? '<span class="pill pill-demo ml-2">DEMO</span>' : '';
  const date = new Date(t.ts).toLocaleString();
  const diffBadge =
    t.diff != null && t.diff > 0 ? `<span class="pill pill-warn ml-2">+${fmt(t.diff)}</span>` :
    t.diff != null && t.diff < 0 ? `<span class="pill pill-ok ml-2">−${fmt(Math.abs(t.diff))}</span>` : '';
  return `
    <div class="card p-4 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="font-medium text-sm truncate">${t.purpose}${isSeed}${isDemo}${diffBadge}</div>
        <div class="text-xs text-muted mt-0.5">${date} · L${String(t.layer).padStart(2, '0')} · ${t.ref}</div>
      </div>
      <div class="font-semibold whitespace-nowrap">${fmt(t.amount)}</div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   Settings
   ═══════════════════════════════════════════════════════════════════════ */
function viewSettings(){
  const w = wallet();
  return `
    <h1 class="text-2xl font-bold mb-6">Account Settings</h1>
    <div class="card p-5 mb-4">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-full bg-forest text-white flex items-center justify-center font-bold text-lg">
          ${(APP.profile.name || '?').charAt(0).toUpperCase()}
        </div>
        <div>
          <div class="font-semibold">${APP.profile.name}</div>
          <div class="text-sm text-muted">${mask(APP.profile.phone)}</div>
        </div>
      </div>
      ${isSandbox() ? `
        <div class="mt-4 pt-4 border-t border-line text-xs text-amber-900 bg-amber-50 rounded-lg p-3">
          You are in the <strong>sandbox demo wallet</strong>. Balance is fixed at ¥1.
          Your normal wallet is unaffected.
        </div>
      ` : ''}
    </div>
    <div class="card divide-y divide-line">
      ${settingRow('phone', 'Backup Phone Number', APP.profile.backupPhone ? mask(APP.profile.backupPhone) : 'Not set', 'backup')}
      ${settingRow('key-round', 'Recovery Method', APP.profile.backupPhone ? 'Backup number' : 'Primary number only', 'recovery')}
      ${settingRow('copy', 'Duplicate PIN', APP.duplicatePinHash ? 'Enabled' : 'Not set', 'duplicate')}
      ${settingRow('shield', 'Security', 'PIN, sessions, attempt limits', 'security')}
      ${settingRow('landmark', 'WeBank', 'Invest / save with WeBank', 'webank')}
      ${settingRow('receipt', 'Transaction History', w.transactions.length + ' record' + (w.transactions.length === 1 ? '' : 's'), 'history')}
    </div>
    <button class="btn btn-danger w-full mt-6" data-act="logout">Log out</button>
    <p class="text-[11px] text-muted mt-6 text-center leading-relaxed">
      Demo data is stored only in this browser.
    </p>
  `;
}
function settingRow(icon, label, sub, view){
  return `
    <button class="w-full p-4 flex items-center gap-4 hover:bg-cream transition text-left" data-act="view" data-view="${view}">
      <i data-lucide="${icon}" class="w-5 h-5 text-forest"></i>
      <div class="flex-1 min-w-0">
        <div class="font-medium text-sm">${label}</div>
        <div class="text-xs text-muted truncate">${sub}</div>
      </div>
      <i data-lucide="chevron-right" class="w-4 h-4 text-muted"></i>
    </button>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   WeBank
   ═══════════════════════════════════════════════════════════════════════ */
function viewWeBank(){
  return `
    <div class="max-w-xl">
      <div class="flex items-center gap-3 mb-6">
        <div class="w-12 h-12 rounded-xl bg-forest text-white flex items-center justify-center">
          <i data-lucide="landmark" class="w-6 h-6"></i>
        </div>
        <div>
          <h1 class="text-2xl font-bold">WeBank</h1>
          <p class="text-sm text-muted">Invest and save — with WeBank's rules.</p>
        </div>
      </div>

      <div class="card p-6 mb-4">
        <p class="text-[15px] leading-relaxed text-ink">
          Here you can invest or deposit funds following WeBank's rules.
          All amounts are handled in CNY (¥).
        </p>
      </div>

      <div class="card p-6 text-center bg-cream">
        <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-line">
          <i data-lucide="clock" class="w-4 h-4 text-forest"></i>
          <span class="text-sm font-semibold text-forest">Coming Soon</span>
        </div>
        <p class="text-xs text-muted mt-4 leading-relaxed max-w-sm mx-auto">
          WeBank integration is not yet available in this demo build.
          This screen is a placeholder for the upcoming investment and savings module.
        </p>
        <button class="btn btn-ghost mt-5" data-act="view" data-view="dashboard">
          <i data-lucide="chevron-left" class="w-4 h-4"></i> Back to Wallet
        </button>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   Backup / Recovery / Duplicate / Security
   ═══════════════════════════════════════════════════════════════════════ */
function viewBackupSettings(){
  const b = APP.profile.backupPhone;
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="settings">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Settings
    </button>
    <h1 class="text-2xl font-bold mb-1">Backup Phone Number</h1>
    <p class="text-sm text-muted mb-6">Used only for account recovery.</p>
    ${b ? `
      <div class="card p-5 mb-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs text-muted uppercase tracking-wider">Current backup</div>
            <div class="font-mono font-semibold mt-1">${mask(b)}</div>
          </div>
          <span class="pill ${APP.profile.backupVerified ? 'pill-ok' : 'pill-warn'}">${APP.profile.backupVerified ? 'VERIFIED' : 'UNVERIFIED'}</span>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-ghost flex-1" data-act="change-backup">Change</button>
        <button class="btn btn-danger flex-1" data-act="remove-backup">Remove</button>
      </div>
    ` : `
      <form id="add-backup-form" class="card p-5 space-y-4">
        <input class="input" name="phone" inputmode="numeric" placeholder="Backup number">
        <div id="backup-error" class="text-danger text-sm hidden"></div>
        <button class="btn btn-primary w-full" type="submit">Add backup number</button>
      </form>
    `}
  `;
}

function viewRecoverySettings(){
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="settings">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Settings
    </button>
    <h1 class="text-2xl font-bold mb-1">Recovery Method</h1>
    <p class="text-sm text-muted mb-6">How you regain access if you forget your PIN.</p>
    <div class="card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-medium text-sm">Primary number</div>
          <div class="text-xs text-muted font-mono mt-0.5">${mask(APP.profile.phone)}</div>
        </div>
        <i data-lucide="check-circle-2" class="w-5 h-5 text-ok"></i>
      </div>
      <div class="border-t border-line pt-3 flex items-center justify-between">
        <div>
          <div class="font-medium text-sm">Backup number</div>
          <div class="text-xs text-muted font-mono mt-0.5">${APP.profile.backupPhone ? mask(APP.profile.backupPhone) : 'Not configured'}</div>
        </div>
        ${APP.profile.backupVerified ? '<i data-lucide="check-circle-2" class="w-5 h-5 text-ok"></i>' : '<span class="text-xs text-muted">—</span>'}
      </div>
    </div>
  `;
}

function viewDuplicatePin(){
  const has = !!APP.duplicatePinHash;
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="settings">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Settings
    </button>
    <h1 class="text-2xl font-bold mb-1">Duplicate PIN</h1>
    <p class="text-sm text-muted mb-6 leading-relaxed">
      Your Duplicate PIN opens a separate simulated F Pay wallet (¥1)
      for demonstrations. It never grants access to your normal wallet.
    </p>
    ${has ? `
      <div class="card p-5 mb-4">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">Status</span>
          <span class="pill pill-ok">ENABLED</span>
        </div>
        <p class="text-xs text-muted mt-3 leading-relaxed">
          Log out, then log in with this PIN. You will always land in the
          sandbox wallet with ¥1, no matter what.
        </p>
      </div>
      <button class="btn btn-danger w-full" data-act="disable-duplicate">Disable Duplicate PIN</button>
    ` : `
      <form id="dup-pin-form" class="card p-5 space-y-4">
        <div>
          <label class="text-sm font-medium block mb-1.5">Regular PIN (to verify)</label>
          <input class="input" name="regPin" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">New Duplicate PIN</label>
          <input class="input" name="dup" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
        </div>
        <div>
          <label class="text-sm font-medium block mb-1.5">Confirm Duplicate PIN</label>
          <input class="input" name="dup2" type="password" inputmode="numeric" maxlength="6" placeholder="••••">
        </div>
        <div id="dup-error" class="text-danger text-sm hidden"></div>
        <button class="btn btn-primary w-full" type="submit">Save Duplicate PIN</button>
      </form>
    `}
  `;
}

function viewSecurity(){
  return `
    <button class="text-sm text-muted flex items-center gap-1 mb-6" data-act="view" data-view="settings">
      <i data-lucide="chevron-left" class="w-4 h-4"></i> Settings
    </button>
    <h1 class="text-2xl font-bold mb-6">Security</h1>
    <div class="card p-5 mb-4 space-y-4 text-sm">
      <div class="flex justify-between"><span class="text-muted">PIN policy</span><span class="font-medium">4–6 digits</span></div>
      <div class="flex justify-between"><span class="text-muted">Duplicate PIN</span><span class="font-medium">${APP.duplicatePinHash ? 'Enabled' : 'Disabled'}</span></div>
      <div class="flex justify-between"><span class="text-muted">Sandbox isolation</span><span class="font-medium">Enforced</span></div>
      <div class="flex justify-between"><span class="text-muted">Currency</span><span class="font-medium">CNY (¥)</span></div>
      <div class="flex justify-between"><span class="text-muted">Session</span><span class="font-medium">Browser-local (demo)</span></div>
    </div>
    <div class="card p-5">
      <h3 class="font-semibold text-sm mb-2">Demo notice</h3>
      <p class="text-xs text-muted leading-relaxed">
        This build hashes PINs with a toy algorithm for demonstration.
        Production F Pay uses server-side Argon2id, rate limiting, and single-use OTP challenges.
      </p>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   Wiring — auth screens
   ═══════════════════════════════════════════════════════════════════════ */
function wireAuth(){
  document.querySelectorAll('[data-act]').forEach(el => {
    el.onclick = (e) => { e.preventDefault(); handleAuthAction(el.dataset.act, el.dataset); };
  });
  const hook = (id, fn) => { const f = document.getElementById(id); if (f) f.onsubmit = fn; };
  hook('login-form',     handleLogin);
  hook('signup-form',    handleSignup);
  hook('otp-form',       handleSignupOtp);
  hook('backup-form',    handleBackupSetup);
  hook('forgot-form',    handleForgot);
}

function handleAuthAction(act, data){
  if (act === 'go'){ APP.screen = data.screen; render(); }
  else if (act === 'cancelSignup'){ APP.pendingSignup = null; APP.screen = 'welcome'; render(); }
  else if (act === 'skipBackup'){ finishSignup(null); }
}

/* ═══════════════════════════════════════════════════════════════════════
   Wiring — in-app screens
   ═══════════════════════════════════════════════════════════════════════ */
function wireApp(){
  document.querySelectorAll('[data-act]').forEach(el => {
    el.onclick = (e) => { e.preventDefault(); handleAppAction(el.dataset.act, el.dataset); };
  });
  const hook = (id, fn) => { const f = document.getElementById(id); if (f) f.onsubmit = fn; };
  hook('allocate-form',   handleAllocate);
  hook('send-form',       handleSendContinue);
  hook('send-otp-form',   handleSendOtp);
  hook('plan-form',       handleSavePlan);
  hook('unlock-form',     handleUnlock);
  hook('dup-pin-form',    handleSaveDuplicate);
  hook('add-backup-form', handleAddBackup);
}

function handleAppAction(act, data){
  switch (act){
    case 'view':
      APP.view = data.view;
      if (data.view === 'insights') APP.reportsUnlocked = false;
      if (data.view === 'layerDetail') APP.currentLayer = parseInt(data.n);
      render();
      break;

    case 'toggle-balance':
      APP.hideBalance = !APP.hideBalance;
      render();
      break;

    case 'open-layer': {
      const n = parseInt(data.n);
      const l = wallet().layers.find(x => x.n === n);
      if (l.title){
        requirePin(() => { APP.currentLayer = n; APP.view = 'layerDetail'; render(); });
      } else {
        APP.currentLayer = n; APP.view = 'layerDetail'; render();
      }
      break;
    }

    case 'edit-layer':
      openEditLayer();
      break;

    case 'release-layer': {
      const l = wallet().layers.find(x => x.n === APP.currentLayer);
      confirmDialog('Release this layer?', 'The remaining amount returns to your unallocated balance.', () => {
        const remaining = layerRemaining(l);
        const w = wallet();
        w.balance += remaining;
        l.allocated = 0; l.title = ''; l.desc = ''; l.locked = true;
        save(); toast('Layer released'); APP.view = 'layers'; render();
      });
      break;
    }

    case 'menu-toggle': {
      const pop = document.getElementById('menu-pop');
      if (pop) pop.classList.toggle('hidden');
      break;
    }

    case 'logout':
      doLogout();
      break;

    case 'cancel-send':
      APP.pendingTxn = null; APP.pendingOtp = null;
      APP.view = 'dashboard'; render();
      break;

    case 'confirm-send':
      startSendOtp();
      break;

    case 'new-plan':
      APP.planDraft = { id:null, title:'', desc:'', layer:'', plannedAmount:null, interval:30 };
      APP.view = 'planEdit'; render();
      break;

    case 'edit-plan': {
      const p = wallet().plans.find(x => x.id === data.id);
      if (p) APP.planDraft = { ...p, layer: p.layer || '' };
      APP.view = 'planEdit'; render();
      break;
    }

    case 'delete-plan': {
      confirmDialog('Delete this plan?', 'Warnings for matching transactions will stop.', () => {
        wallet().plans = wallet().plans.filter(x => x.id !== data.id);
        save(); toast('Plan deleted'); render();
      });
      break;
    }

    case 'set-interval': {
      if (APP.planDraft){ APP.planDraft.interval = parseInt(data.d); render(); }
      break;
    }

    case 'set-period':
      APP.lastReportPeriod = parseInt(data.d); render();
      break;

    case 'change-backup':
      APP.profile.backupPhone = null; APP.profile.backupVerified = false;
      save(); render();
      break;

    case 'remove-backup':
      confirmDialog('Remove backup number?', 'You will lose backup-based recovery.', () => {
        APP.profile.backupPhone = null; APP.profile.backupVerified = false;
        save(); toast('Backup removed'); render();
      });
      break;

    case 'disable-duplicate':
      confirmDialog('Disable Duplicate PIN?', 'Sandbox access via Duplicate PIN will stop.', () => {
        APP.duplicatePinHash = null;
        save(); toast('Duplicate PIN disabled'); render();
      });
      break;

    case 'demo-replay':
      demoReplay();
      break;
  }
}

function requirePin(after){
  APP.pinGateAction = after;
  openModal(`
    <h3 class="font-bold text-lg mb-1">Enter PIN</h3>
    <p class="text-sm text-muted mb-4">Required to open this locked layer.</p>
    <form id="gate-form" class="space-y-3">
      <input class="input text-center tracking-[0.4em] font-mono" name="pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autofocus>
      <div id="gate-error" class="text-danger text-sm hidden"></div>
      <button class="btn btn-primary w-full" type="submit">Unlock</button>
      <button type="button" class="btn btn-ghost w-full" data-act="close-modal">Cancel</button>
    </form>
  `);
  const form = document.getElementById('gate-form');
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const pin = form.pin.value;
    if (toyHash(pin) !== APP.profile.pinHash){ showError('gate-error', 'Incorrect PIN'); return; }
    closeModal();
    const fn = APP.pinGateAction; APP.pinGateAction = null;
    if (fn) fn();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   Auth handlers
   ═══════════════════════════════════════════════════════════════════════ */
function showError(id, msg){
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function handleLogin(e){
  e.preventDefault();
  const f = e.target;
  const phone = f.phone.value.trim();
  const pin = f.pin.value.trim();
  if (!/^\d{10,15}$/.test(phone)) return showError('login-error', 'Enter a valid mobile number.');
  if (!/^\d{4,6}$/.test(pin)) return showError('login-error', 'PIN must be 4–6 digits.');
  if (!APP.profile) return showError('login-error', 'No account on this device. Please sign up.');
  if (APP.profile.phone !== phone) return showError('login-error', 'Incorrect credentials.');

  const regMatch = toyHash(pin) === APP.profile.pinHash;
  const dupMatch = !!APP.duplicatePinHash && toyHash(pin) === APP.duplicatePinHash;

  if (regMatch){
    APP.session = { activeWallet: 'normal' };
    APP.view = 'dashboard';
    APP.reportsUnlocked = false;
    render();
    toast('Signed in — personal wallet');
  } else if (dupMatch){
    APP.session = { activeWallet: 'sandbox' };
    if (!APP.wallets.sandbox) APP.wallets.sandbox = emptyWallet('sandbox');
    APP.view = 'dashboard';
    APP.reportsUnlocked = false;
    render();
    toast('Signed in — sandbox wallet (¥1 demo)');
  } else {
    showError('login-error', 'Incorrect credentials.');
  }
}

function handleSignup(e){
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim();
  const phone = f.phone.value.trim();
  const fav = f.fav.value.trim();
  const pin = f.pin.value.trim();
  const pin2 = f.pin2.value.trim();
  if (name.length < 2) return showError('signup-error', 'Please enter your full name.');
  if (!/^\d{10,15}$/.test(phone)) return showError('signup-error', 'Enter a valid mobile number.');
  if (fav.length < 3) return showError('signup-error', 'Favourite sentence must be at least 3 characters.');
  if (!/^\d{4,6}$/.test(pin)) return showError('signup-error', 'PIN must be 4–6 digits.');
  if (pin !== pin2) return showError('signup-error', 'PINs do not match.');

  const otp = String(Math.floor(10000 + Math.random() * 90000));
  APP.pendingSignup = {
    name, phone,
    favHash: toyHash(fav.toLowerCase()),
    pinHash: toyHash(pin),
    otp,
  };
  APP.screen = 'signupOtp';
  render();
}

function handleSignupOtp(e){
  e.preventDefault();
  const f = e.target;
  const otp = f.otp.value.trim();
  if (otp !== APP.pendingSignup.otp) return showError('otp-error', 'Incorrect code.');
  APP.screen = 'backupSetup';
  render();
}

function handleBackupSetup(e){
  e.preventDefault();
  const phone = e.target.phone.value.trim();
  if (phone && !/^\d{10,15}$/.test(phone)) return toast('Invalid backup number');
  finishSignup(phone || null);
}

function finishSignup(backupPhone){
  const p = APP.pendingSignup;
  APP.profile = {
    name: p.name,
    phone: p.phone,
    favHash: p.favHash,
    pinHash: p.pinHash,
    backupPhone: backupPhone,
    backupVerified: !!backupPhone,
  };
  APP.wallets = { normal: emptyWallet('normal'), sandbox: emptyWallet('sandbox') };
  APP.duplicatePinHash = null;
  APP.pendingSignup = null;
  APP.session = { activeWallet: 'normal' };
  APP.view = 'dashboard';
  save(); render();
  toast('Account created');
}

function handleForgot(e){
  e.preventDefault();
  const phone = e.target.phone.value.trim();
  if (!APP.profile || APP.profile.phone !== phone) return showError('forgot-error', 'No matching account.');
  toast('Demo: no real SMS is sent. Try logging in with your PIN.');
  APP.screen = 'login'; render();
}

function handleAddBackup(e){
  e.preventDefault();
  const phone = e.target.phone.value.trim();
  if (!/^\d{10,15}$/.test(phone)) return showError('backup-error', 'Enter a valid number.');
  APP.profile.backupPhone = phone;
  APP.profile.backupVerified = true;
  save(); toast('Backup number added'); render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Layer allocation
   ═══════════════════════════════════════════════════════════════════════ */
function handleAllocate(e){
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  const amount = parseFloat(f.amount.value);
  const desc = f.desc.value.trim();
  if (!title) return showError('allocate-error', 'Title is required.');
  if (!(amount > 0)) return showError('allocate-error', 'Enter a positive amount.');
  const w = wallet();
  const allocated = w.layers.reduce((s, l) => s + l.allocated, 0);
  const unallocated = w.balance - allocated;
  if (amount > unallocated){
    return showError('allocate-error', `Insufficient available balance. You have ${fmt(unallocated)} unallocated.`);
  }
  const l = w.layers.find(x => x.n === APP.currentLayer);
  l.title = title; l.desc = desc; l.allocated = amount;
  save(); toast('Layer saved'); APP.view = 'layerDetail'; render();
}

function openEditLayer(){
  const l = wallet().layers.find(x => x.n === APP.currentLayer);
  openModal(`
    <h3 class="font-bold text-lg mb-4">Edit Layer ${String(l.n).padStart(2, '0')}</h3>
    <form id="edit-form" class="space-y-3">
      <input class="input" name="title" value="${l.title || ''}" placeholder="Title">
      <input class="input" name="amount" inputmode="decimal" value="${l.allocated}" placeholder="Amount">
      <input class="input" name="desc" value="${l.desc || ''}" placeholder="Description">
      <div id="edit-error" class="text-danger text-sm hidden"></div>
      <div class="flex gap-2 pt-2">
        <button type="button" class="btn btn-ghost flex-1" data-act="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary flex-1">Save</button>
      </div>
    </form>
  `);
  const f = document.getElementById('edit-form');
  f.onsubmit = (e) => {
    e.preventDefault();
    const title = f.title.value.trim();
    const amount = parseFloat(f.amount.value);
    if (!title) return showError('edit-error', 'Title required.');
    if (!(amount >= 0)) return showError('edit-error', 'Invalid amount.');
    const w = wallet();
    const allocatedOther = w.layers.filter(x => x.n !== l.n).reduce((s, x) => s + x.allocated, 0);
    const unallocated = w.balance - allocatedOther;
    if (amount > unallocated) return showError('edit-error', `Only ${fmt(unallocated)} available.`);
    l.title = title; l.allocated = amount; l.desc = f.desc.value.trim();
    save(); closeModal(); toast('Layer updated'); render();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   Send money — with Smart Budget Alert popup
   ═══════════════════════════════════════════════════════════════════════ */
function handleSendContinue(e){
  e.preventDefault();
  const f = e.target;
  const recipient = f.phone.value.trim();
  const purpose = f.purpose.value.trim();
  const layerN = parseInt(f.layer.value);
  const amount = parseFloat(f.amount.value);
  const pin = f.pin.value.trim();

  if (!/^\d{10,15}$/.test(recipient)) return showError('send-error', 'Enter a valid recipient number.');
  if (purpose.length < 2) return showError('send-error', 'Enter a purpose.');
  if (!layerN) return showError('send-error', 'Select a source layer.');
  if (!(amount > 0)) return showError('send-error', 'Enter a valid amount.');
  if (amount < MIN_TRANSFER) return showError('send-error', `The minimum send amount is ¥${MIN_TRANSFER}.`);
  if (toyHash(pin) !== APP.profile.pinHash) return showError('send-error', 'Incorrect PIN.');

  const w = wallet();
  const l = w.layers.find(x => x.n === layerN);
  const remaining = layerRemaining(l);
  if (amount > remaining){
    return showError('send-error', `Layer ${String(layerN).padStart(2, '0')} has only ${fmt(remaining)} available.`);
  }

  const budget = budgetCheck(purpose, amount, w.plans);

  const buildPending = () => {
    APP.pendingTxn = { recipient, purpose, layer: layerN, amount, budget, isDemo: true, ts: Date.now() };
  };

  // If the purpose matched a saved AI Sub plan, show the popup first.
  if (budget.severity === 'over' || budget.severity === 'under' || budget.severity === 'on'){
    showBudgetAlert({
      planTitle: budget.plan.title,
      planned:   budget.planned,
      amount:    amount,
      diff:      budget.diff,
      onDismiss: () => { /* stay on form */ },
      onContinue: () => { buildPending(); APP.view = 'sendReview'; render(); },
    });
    return;
  }

  // No exact match → proceed straight to review
  buildPending();
  APP.view = 'sendReview';
  render();
}

/* ───────────────────────────────────────────────────────────────────────
   Smart Budget Alert popup
   Informational only. Cross / Edit Amount = dismiss. Continue = proceed.
   ─────────────────────────────────────────────────────────────────────── */
function showBudgetAlert({ planTitle, planned, amount, diff, onDismiss, onContinue }){
  const over = diff > 0;
  const under = diff < 0;

  const headline = over
    ? `Heads up — this is above your plan`
    : under
    ? `This is below your plan`
    : `This matches your plan`;

  const bodyLine = over
    ? `You set <strong>${fmt(planned)}</strong> for <em>${planTitle}</em> in AI Sub, but you're about to spend <strong>${fmt(amount)}</strong>. That's <strong>${fmt(diff)}</strong> more than planned.`
    : under
    ? `You set <strong>${fmt(planned)}</strong> for <em>${planTitle}</em>. This spend of <strong>${fmt(amount)}</strong> is <strong>${fmt(Math.abs(diff))}</strong> below that plan.`
    : `You set <strong>${fmt(planned)}</strong> for <em>${planTitle}</em> and this spend matches it exactly.`;

  const tone = over
    ? { bg:'bg-amber-50', border:'border-amber-200', icon:'alert-triangle', iconColor:'text-amber-700', headColor:'text-amber-900', bodyColor:'text-amber-900' }
    : { bg:'bg-emerald-50', border:'border-emerald-200', icon:'info', iconColor:'text-emerald-700', headColor:'text-emerald-900', bodyColor:'text-emerald-900' };

  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal">
      <div class="modal-card" style="max-width:440px;">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="flex items-center gap-2">
            <div class="w-9 h-9 rounded-xl ${tone.bg} ${tone.border} border flex items-center justify-center">
              <i data-lucide="${tone.icon}" class="w-4 h-4 ${tone.iconColor}"></i>
            </div>
            <div>
              <div class="font-semibold text-[15px] ${tone.headColor}">${headline}</div>
              <div class="text-[11px] text-muted">Budget check · AI Sub</div>
            </div>
          </div>
          <button id="budget-alert-x" class="btn btn-ghost !p-2 !rounded-lg" aria-label="Dismiss">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="card p-4 ${tone.bg} ${tone.border} mb-4">
          <p class="text-xs leading-relaxed ${tone.bodyColor}">${bodyLine}</p>
        </div>

        <div class="card p-4 mb-4 space-y-2 text-sm">
          <div class="flex justify-between">
            <span class="text-muted">Planned</span>
            <span class="font-semibold">${fmt(planned)}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted">This transaction</span>
            <span class="font-semibold">${fmt(amount)}</span>
          </div>
          <div class="flex justify-between border-t border-line pt-2 mt-2">
            <span class="text-muted">Difference</span>
            <span class="font-semibold ${over ? 'text-warn' : under ? 'text-ok' : 'text-ink'}">
              ${over ? '+' : under ? '−' : ''}${fmt(Math.abs(diff))}
            </span>
          </div>
        </div>

        <p class="text-[11px] text-muted leading-relaxed mb-4">
          This is just a friendly heads-up — you're still in control.
          Tap the cross to keep editing, or continue to review.
        </p>

        <div class="flex gap-2">
          <button class="btn btn-ghost flex-1" id="budget-alert-continue">Continue to Review</button>
          <button class="btn btn-primary flex-1" id="budget-alert-edit">Edit Amount</button>
        </div>
      </div>
    </div>
  `;
  lucide.createIcons();

  document.getElementById('budget-alert-x').onclick = () => {
    closeModal();
    if (onDismiss) onDismiss();
  };
  document.getElementById('budget-alert-edit').onclick = () => {
    closeModal();
    if (onDismiss) onDismiss();
  };
  document.getElementById('budget-alert-continue').onclick = () => {
    closeModal();
    if (onContinue) onContinue();
  };
  root.querySelector('.modal').onclick = (e) => {
    if (e.target.classList.contains('modal')){
      closeModal();
      if (onDismiss) onDismiss();
    }
  };
}

function startSendOtp(){
  const code = String(Math.floor(10000 + Math.random() * 90000));
  APP.pendingOtp = { code, expires: Date.now() + 5*60*1000, attempts: 0 };
  APP.view = 'sendOtp'; render();
}

function handleSendOtp(e){
  e.preventDefault();
  const f = e.target;
  const code = f.otp.value.trim();
  const o = APP.pendingOtp;
  if (!o) return;
  if (Date.now() > o.expires) return showError('send-otp-error', 'Code expired. Cancel and retry.');
  if (o.attempts >= 5) return showError('send-otp-error', 'Too many attempts.');
  o.attempts++;
  if (code !== o.code) return showError('send-otp-error', 'Incorrect code.');

  const t = APP.pendingTxn;
  const w = wallet();
  const l = w.layers.find(x => x.n === t.layer);
  const remaining = layerRemaining(l);
  if (t.amount > remaining){
    APP.pendingTxn = { ...t, result: 'failed' };
    APP.view = 'sendResult'; render(); return;
  }

  const bc = t.budget;
  const ref = 'FPAY-' + Date.now().toString(36).toUpperCase();
  const txn = {
    ref, purpose: t.purpose, amount: t.amount, layer: t.layer,
    recipient: t.recipient, status: 'completed',
    isDemo: true, isSeed: false, ts: Date.now(),
    planned: (bc.severity === 'over' || bc.severity === 'under' || bc.severity === 'on') ? bc.planned : null,
    diff:    (bc.severity === 'over' || bc.severity === 'under' || bc.severity === 'on') ? bc.diff    : null,
    planTitle: bc.plan ? bc.plan.title : null,
  };
  w.transactions.push(txn);
  APP.pendingTxn = { ...txn, result: 'success' };
  APP.pendingOtp = null;
  save();
  APP.view = 'sendResult'; render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Plan handlers
   ═══════════════════════════════════════════════════════════════════════ */
function handleSavePlan(e){
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  const desc = f.desc.value.trim();
  const layer = f.layer.value ? parseInt(f.layer.value) : null;
  const amountRaw = f.amount.value.trim();
  const amount = amountRaw ? parseFloat(amountRaw) : null;
  if (!title) return showError('plan-error', 'Title required.');
  if (amount != null && !(amount >= 0)) return showError('plan-error', 'Invalid amount.');
  const p = APP.planDraft;
  const w = wallet();
  if (p.id){
    const existing = w.plans.find(x => x.id === p.id);
    Object.assign(existing, { title, desc, layer, plannedAmount: amount, interval: p.interval });
  } else {
    w.plans.push({
      id: 'plan_' + Date.now().toString(36),
      title, desc, layer, plannedAmount: amount, interval: p.interval,
    });
  }
  save(); toast('Plan saved');
  APP.planDraft = null; APP.view = 'aiSub'; render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Insights unlock
   ═══════════════════════════════════════════════════════════════════════ */
function handleUnlock(e){
  e.preventDefault();
  const pin = e.target.pin.value.trim();
  if (toyHash(pin) !== APP.profile.pinHash) return showError('unlock-error', 'Incorrect PIN.');
  APP.reportsUnlocked = true;
  render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Duplicate PIN
   ═══════════════════════════════════════════════════════════════════════ */
function handleSaveDuplicate(e){
  e.preventDefault();
  const f = e.target;
  const reg = f.regPin.value.trim();
  const dup = f.dup.value.trim();
  const dup2 = f.dup2.value.trim();
  if (toyHash(reg) !== APP.profile.pinHash) return showError('dup-error', 'Regular PIN incorrect.');
  if (!/^\d{4,6}$/.test(dup)) return showError('dup-error', 'Duplicate PIN must be 4–6 digits.');
  if (dup !== dup2) return showError('dup-error', 'PINs do not match.');
  if (dup === reg) return showError('dup-error', 'Duplicate PIN cannot match your regular PIN.');
  APP.duplicatePinHash = toyHash(dup);
  save(); toast('Duplicate PIN saved — use it at login to enter the sandbox'); render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Logout — full session reset, returns to Welcome
   ═══════════════════════════════════════════════════════════════════════ */
function doLogout(){
  confirmDialog('Log out?', 'You can sign back in with your PIN.', () => {
    APP.session = null;
    APP.screen = 'welcome';
    APP.view = 'dashboard';
    APP.reportsUnlocked = false;
    APP.pendingTxn = null;
    APP.pendingOtp = null;
    APP.pendingSignup = null;
    APP.currentLayer = null;
    APP.planDraft = null;
    APP.hideBalance = false;
    render();
    toast('Logged out');
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   Demo replay — sandbox only (since ¥1 < ¥20)
   ═══════════════════════════════════════════════════════════════════════ */
function demoReplay(){
  if (!isSandbox()) return toast('Demo replay is sandbox only.');
  const w = wallet();
  const ref = 'FPAY-REPLAY-' + Date.now().toString(36).toUpperCase();
  w.transactions.push({
    ref, purpose: 'Demo Replay — Netflix Subscription', amount: 500, layer: 4,
    recipient: '01XXXXXXXXX', status: 'completed',
    isDemo: true, isSeed: false, ts: Date.now(),
    planned: 500, diff: 0, planTitle: 'Netflix Subscription',
  });
  save();
  toast('Demo replay added — balance unchanged (¥1)');
  APP.view = 'history'; render();
}

/* ═══════════════════════════════════════════════════════════════════════
   Modals
   ═══════════════════════════════════════════════════════════════════════ */
function openModal(inner){
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal"><div class="modal-card">${inner}</div></div>`;
  lucide.createIcons();
  root.querySelectorAll('[data-act="close-modal"]').forEach(b => b.onclick = closeModal);
  root.querySelector('.modal').onclick = (e) => { if (e.target.classList.contains('modal')) closeModal(); };
}
function closeModal(){
  document.getElementById('modal-root').innerHTML = '';
}
function confirmDialog(title, body, onYes){
  openModal(`
    <h3 class="font-bold text-lg mb-2">${title}</h3>
    <p class="text-sm text-muted mb-5">${body}</p>
    <div class="flex gap-2">
      <button class="btn btn-ghost flex-1" data-act="close-modal">Cancel</button>
      <button class="btn btn-primary flex-1" id="confirm-yes">Confirm</button>
    </div>
  `);
  document.getElementById('confirm-yes').onclick = () => { closeModal(); onYes(); };
}

/* ═══════════════════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════════════════ */
(function boot(){
  load();
  APP.session = null;   // never auto-login
  APP.screen = 'welcome';
  render();
})();
