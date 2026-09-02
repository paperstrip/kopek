import {
  auth,
  db,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  collection,
  addDoc,
  getDocs,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  Timestamp,
} from './firebase-config.js';

// =============================================================
// 💰 CONSTANTES MÉTIER (CONTRAT NESSY)
// =============================================================
const SOCCLE_FLAT = 2000;
const SOCCLE_HOURS_MAX = 25;
const RATE_REGIE_80 = 80;
const RATE_REGIE_95 = 95;
const MIN_GARANTI_PHASE1 = 3500; // mois 1-12
const MIN_GARANTI_PHASE2 = 3000; // mois 13-24
const PHASE1_HOURS_EQ = 43.75;
const PHASE2_HOURS_EQ = 37.5;
const AVANCE_START_MONTH = 3;   // index 0-based : mois 4
const AVANCE_END_MONTH = 10;    // index 0-based : mois 11
const AVANCE_DEDUCTION = 625;
const TVA_RATE = 0.21;
const CREDIT_TVA_LEASING = 56.40; // € HT, crédit mensuel
const INASTI_RATE = 0.18;
const IPP_RATE = 0.25;
const CHARGES_FIXES = {
  leasing: 650,
  logement: 625,
  gsm_cc: 125,
  comptable: 125,
};
const TOTAL_CHARGES = Object.values(CHARGES_FIXES).reduce((a, b) => a + b, 0);

const CATEGORIES = {
  socle:    { label: 'Forfait Socle',     rate: null, color: 'text-indigo-300',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/30' },
  regie_80: { label: 'Régie Dev 80€/h',   rate: RATE_REGIE_80, color: 'text-sky-300',  bg: 'bg-sky-500/10',     border: 'border-sky-500/30' },
  regie_95: { label: 'Régie Lead 95€/h',  rate: RATE_REGIE_95, color: 'text-violet-300', bg: 'bg-violet-500/10',  border: 'border-violet-500/30' },
  forfait:  { label: 'Forfait Projet Spe',rate: null, color: 'text-amber-300', bg: 'bg-amber-500/10',    border: 'border-amber-500/30' },
};

// =============================================================
// 🗓️ ÉTAT GLOBAL
// =============================================================
const STATE = {
  user: null,
  entries: [],
  selectedMonth: new Date().getMonth(), // 0-11
  selectedYear: new Date().getFullYear(),
  contractStart: firstDayOfMonth(new Date().getFullYear(), new Date().getMonth()), // default, editable via var below
  // TIMER
  timerStartTs: null,
  timerElapsedMs: 0,
  timerInterval: null,
  timerIsRunning: false,
};

// Start contract at the first entry month or override:
// STATE.contractStart = new Date('2025-01-01T00:00:00');

// =============================================================
// 🧩 UTILITAIRES
// =============================================================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const EUR = (n, digits = 0) => `${Math.round(n).toLocaleString('fr-BE')} €`;
const EUR2 = (n) => `${n.toLocaleString('fr-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const HH = (h) => `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
function firstDayOfMonth(y, m) { return new Date(y, m, 1, 0, 0, 0, 0); }
function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0, 23, 59, 59, 999); }
function fmtDateBE(tsOrDate) {
  const d = tsOrDate instanceof Timestamp ? tsOrDate.toDate() : new Date(tsOrDate);
  return d.toLocaleDateString('fr-BE', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateInput(tsOrDate) {
  const d = tsOrDate instanceof Timestamp ? tsOrDate.toDate() : new Date(tsOrDate);
  return d.toISOString().slice(0, 10);
}
function roundUp15Min(minutes) {
  return Math.ceil(minutes / 15) * 15;
}
function toast(msg, icon = 'check') {
  const t = $('#toast');
  const i = lucide.icons[icon] ? `<i data-lucide="${icon}" class="w-4 h-4 text-emerald-400"></i>` : '';
  t.innerHTML = `${i}<span>${msg}</span>`;
  lucide.createIcons();
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// =============================================================
// 🔐 AUTHENTIFICATION
// =============================================================
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast('Connexion réussie', 'check');
  } catch (ex) {
    let msg = 'Erreur de connexion.';
    if (ex.code === 'auth/invalid-credential' || ex.code === 'auth/wrong-password' || ex.code === 'auth/user-not-found')
      msg = 'Identifiants incorrects.';
    else if (ex.code === 'auth/invalid-email') msg = 'Email invalide.';
    else if (ex.code === 'auth/too-many-requests') msg = 'Trop de tentatives — réessayez plus tard.';
    err.textContent = msg;
    err.classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await signOut(auth); toast('Déconnecté', 'log-out'); }
  catch { /* ignore */ }
});

onAuthStateChanged(auth, (user) => {
  STATE.user = user;
  if (user) {
    $('#login-screen').classList.add('hidden');
    $('#dashboard-screen').classList.remove('hidden');
    initApp();
  } else {
    $('#dashboard-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    stopTimerInterval();
  }
  if (window.lucide) lucide.createIcons();
});

// =============================================================
// 🚀 INIT APP (UNE FOIS AUTHENTIFIÉ)
// =============================================================
function initApp() {
  buildMonthYearSelectors();
  bindTopBar();
  bindTimer();
  bindManualForm();
  bindExportModal();
  bindCategoryForfaitToggle();
  refreshPeriod();
  lucide.createIcons();
}

// =============================================================
// 🗓️ TOP BAR : MOIS / ANNÉE
// =============================================================
function buildMonthYearSelectors() {
  const mSel = $('#month-select');
  const ySel = $('#year-select');
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  if (!mSel.options.length) {
    months.forEach((label, i) => {
      const o = document.createElement('option');
      o.value = String(i); o.textContent = label;
      mSel.appendChild(o);
    });
  }
  const curY = new Date().getFullYear();
  if (!ySel.options.length) {
    for (let y = curY - 3; y <= curY + 2; y++) {
      const o = document.createElement('option');
      o.value = String(y); o.textContent = y;
      ySel.appendChild(o);
    }
  }
  mSel.value = String(STATE.selectedMonth);
  ySel.value = String(STATE.selectedYear);
}

function bindTopBar() {
  const mSel = $('#month-select');
  const ySel = $('#year-select');
  mSel.onchange = () => { STATE.selectedMonth = +mSel.value; refreshPeriod(); };
  ySel.onchange = () => { STATE.selectedYear = +ySel.value; refreshPeriod(); };
  $('#prev-month').onclick = () => navigateMonth(-1);
  $('#next-month').onclick = () => navigateMonth(+1);
}

function navigateMonth(delta) {
  let m = STATE.selectedMonth + delta;
  let y = STATE.selectedYear;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  STATE.selectedMonth = m;
  STATE.selectedYear = y;
  $('#month-select').value = String(m);
  $('#year-select').value = String(y);
  refreshPeriod();
}

// =============================================================
// ⏱️ TIMER
// =============================================================
function bindTimer() {
  $('#btn-timer-start').onclick = startTimer;
  $('#btn-timer-stop').onclick  = stopTimerAndSave;
}
function fmtHHMMSS(ms) {
  const total = Math.floor(ms / 1000);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function startTimer() {
  if (STATE.timerIsRunning) return;
  STATE.timerIsRunning = true;
  STATE.timerStartTs = Date.now() - STATE.timerElapsedMs;
  renderTimerControls(true);
  STATE.timerInterval = setInterval(() => {
    STATE.timerElapsedMs = Date.now() - STATE.timerStartTs;
    $('#timer-display').textContent = fmtHHMMSS(STATE.timerElapsedMs);
  }, 250);
}
function stopTimerInterval() {
  if (STATE.timerInterval) { clearInterval(STATE.timerInterval); STATE.timerInterval = null; }
}
function renderTimerControls(running) {
  const start = $('#btn-timer-start');
  const stop = $('#btn-timer-stop');
  const status = $('#timer-status');
  const play = start.querySelector('svg');
  const dot = status.querySelector('span:first-child');
  if (running) {
    start.classList.add('hidden');
    stop.classList.remove('hidden');
    stop.disabled = false;
    status.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 timer-running"></span> En cours…`;
  } else {
    start.classList.remove('hidden');
    stop.classList.add('hidden');
    status.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-500"></span> En pause`;
  }
}
async function stopTimerAndSave() {
  stopTimerInterval();
  STATE.timerIsRunning = false;
  const ms = STATE.timerElapsedMs;
  renderTimerControls(false);
  if (ms < 60 * 1000) { // < 1 min
    $('#timer-display').textContent = '00:00:00';
    STATE.timerElapsedMs = 0;
    toast('Durée inférieure à 1 minute ignorée', 'info');
    return;
  }
  const minutes = roundUp15Min(ms / 60000);
  const category = $('#timer-category').value;
  const description = $('#timer-desc').value.trim() || CATEGORIES[category].label;
  await createEntry({
    category,
    duration_minutes: minutes,
    description,
    date: new Date(),
    forfait_budget: category === 'forfait' ? 0 : null,
    project_name: '',
  });
  STATE.timerElapsedMs = 0;
  $('#timer-display').textContent = '00:00:00';
  $('#timer-desc').value = '';
  refreshPeriod();
}

// =============================================================
// ➕ SAISIE MANUELLE
// =============================================================
function bindManualForm() {
  $('#manual-date').value = fmtDateInput(new Date());
  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#manual-error');
    err.classList.add('hidden');
    const dateVal = $('#manual-date').value;
    const category = $('#manual-category').value;
    const hours = parseFloat($('#manual-duration').value);
    const description = $('#manual-desc').value.trim() || CATEGORIES[category].label;
    const forfaitBudget = category === 'forfait' ? parseFloat($('#manual-forfait-budget').value || '0') : null;
    if (!dateVal || isNaN(hours) || hours <= 0) {
      err.textContent = 'Veuillez renseigner une date et une durée valides.';
      err.classList.remove('hidden');
      return;
    }
    if (category === 'forfait' && (!forfaitBudget || forfaitBudget <= 0)) {
      err.textContent = 'Pour un forfait, indiquez le budget HTVA.';
      err.classList.remove('hidden');
      return;
    }
    const minutes = roundUp15Min(hours * 60);
    await createEntry({
      category,
      duration_minutes: minutes,
      description,
      date: new Date(dateVal + 'T12:00:00'),
      forfait_budget: forfaitBudget,
      project_name: '',
    });
    $('#manual-form').reset();
    $('#manual-date').value = fmtDateInput(new Date());
    $('#manual-category').value = 'regie_80';
    bindCategoryForfaitToggle();
    refreshPeriod();
  });
}
function bindCategoryForfaitToggle() {
  const on = () => {
    const cat = $('#manual-category').value;
    $('#forfait-budget-wrap').classList.toggle('hidden', cat !== 'forfait');
  };
  on();
  $('#manual-category').onchange = on;
}

// =============================================================
// 📦 FIRESTORE CRUD (time_entries)
// =============================================================
function entryCollectionRef() {
  return collection(db, 'time_entries');
}
async function createEntry({ category, duration_minutes, description, date, forfait_budget, project_name }) {
  if (!STATE.user) return;
  try {
    await addDoc(entryCollectionRef(), {
      userId: STATE.user.uid,
      category,
      duration_minutes,
      description,
      date: Timestamp.fromDate(date),
      forfait_budget: forfait_budget ?? null,
      project_name: project_name || '',
      createdAt: Timestamp.now(),
    });
    toast('Entrée enregistrée', 'check');
  } catch (ex) {
    console.error(ex);
    toast('Erreur Firestore', 'alert-circle');
  }
}
async function deleteEntryById(id) {
  if (!STATE.user) return;
  try {
    await deleteDoc(doc(db, 'time_entries', id));
    toast('Entrée supprimée', 'trash-2');
    refreshPeriod();
  } catch {
    toast('Erreur suppression', 'alert-circle');
  }
}
async function updateEntryById(id, patch) {
  if (!STATE.user) return;
  try {
    const norm = { ...patch };
    if (norm.date && !(norm.date instanceof Timestamp)) norm.date = Timestamp.fromDate(norm.date);
    await updateDoc(doc(db, 'time_entries', id), norm);
    toast('Entrée modifiée', 'check');
    refreshPeriod();
  } catch {
    toast('Erreur mise à jour', 'alert-circle');
  }
}
async function loadEntriesForMonth() {
  if (!STATE.user) return [];
  const start = firstDayOfMonth(STATE.selectedYear, STATE.selectedMonth);
  const end   = lastDayOfMonth(STATE.selectedYear, STATE.selectedMonth);
  const q = query(
    entryCollectionRef(),
    where('userId', '==', STATE.user.uid),
    where('date', '>=', Timestamp.fromDate(start)),
    where('date', '<=', Timestamp.fromDate(end)),
    orderBy('date', 'asc')
  );
  try {
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    STATE.entries = list;
    return list;
  } catch (ex) {
    console.warn(ex);
    STATE.entries = [];
    return [];
  }
}

// =============================================================
// 📊 CALCULS MÉTIER
// =============================================================
function computeContractMonthIndex() {
  const start = STATE.contractStart;
  const y1 = start.getFullYear(), m1 = start.getMonth();
  const y2 = STATE.selectedYear, m2 = STATE.selectedMonth;
  return (y2 - y1) * 12 + (m2 - m1);
}
function getGuaranteedMinimum(monthIdx) {
  if (monthIdx >= 12) return MIN_GARANTI_PHASE2;
  return MIN_GARANTI_PHASE1;
}
function getGuaranteedHoursEq(monthIdx) {
  return monthIdx >= 12 ? PHASE2_HOURS_EQ : PHASE1_HOURS_EQ;
}
function isAvanceDeductionMonth(monthIdx) {
  return monthIdx >= AVANCE_START_MONTH && monthIdx <= AVANCE_END_MONTH;
}

function aggregateMonthEntries() {
  let socleHours = 0;
  let regieHours80 = 0;
  let regieHours95 = 0;
  let forfaitHours = 0;
  const forfaitBudgets = []; // per entry (unique per forfait line)
  for (const e of STATE.entries) {
    const h = (e.duration_minutes || 0) / 60;
    if (e.category === 'socle') socleHours += h;
    else if (e.category === 'regie_80') regieHours80 += h;
    else if (e.category === 'regie_95') regieHours95 += h;
    else if (e.category === 'forfait') {
      forfaitHours += h;
      if (e.forfait_budget && +e.forfait_budget > 0) forfaitBudgets.push(+e.forfait_budget);
    }
  }
  const socleRevenue = SOCCLE_FLAT;
  const regieRevenue = regieHours80 * RATE_REGIE_80 + regieHours95 * RATE_REGIE_95;
  const forfaitRevenue = forfaitBudgets.reduce((a, b) => a + b, 0);
  const totalRevenus = socleRevenue + regieRevenue + forfaitRevenue;

  const monthIdx = computeContractMonthIndex();
  const minGaranti = getGuaranteedMinimum(monthIdx);
  const CA_HTVA = Math.max(minGaranti, totalRevenus);
  const isMinGarantiApplied = totalRevenus < minGaranti;

  // WATERFALL
  const TVA_collectee = CA_HTVA * TVA_RATE;
  const TVA_nete = Math.max(0, TVA_collectee - CREDIT_TVA_LEASING);
  const INASTI = CA_HTVA * INASTI_RATE;
  const CA_apres_INASTI = CA_HTVA - INASTI;
  const IPP = CA_apres_INASTI * IPP_RATE;
  const provisions = INASTI + IPP;
  const avance = isAvanceDeductionMonth(monthIdx) ? AVANCE_DEDUCTION : 0;

  // Reste NET = (CA + TVA) - TVA_nete - Charges - INASTI - IPP - avance
  // Simplifié : CA + CREDIT_TVA - Charges - INASTI - IPP - avance
  const NET = CA_HTVA + CREDIT_TVA_LEASING - TOTAL_CHARGES - INASTI - IPP - avance;

  const totalHours = socleHours + regieHours80 + regieHours95 + forfaitHours;

  return {
    socleHours, socleRevenue,
    regieHours80, regieHours95,
    regieRevenue,
    forfaitHours, forfaitRevenue,
    totalHours,
    totalRevenus,
    minGaranti, isMinGarantiApplied,
    CA_HTVA,
    TVA_collectee, TVA_nete,
    INASTI, IPP, provisions,
    avance, monthIdx,
    TOTAL_CHARGES,
    NET,
  };
}

// =============================================================
// 🎨 RENDU PRINCIPAL
// =============================================================
async function refreshPeriod() {
  await loadEntriesForMonth();
  const agg = aggregateMonthEntries();
  renderTitles(agg);
  renderGauge(agg);
  renderMetrics(agg);
  renderWaterfall(agg);
  renderLogs(agg);
  renderExport(agg);
  lucide.createIcons();
}

function renderTitles(agg) {
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const label = `${months[STATE.selectedMonth]} ${STATE.selectedYear}`;
  $('#period-title').textContent = label;

  const idx = agg.monthIdx;
  const phase = idx < 0 ? `Pré-démarrage (M${idx})`
              : idx < 12 ? `Phase 1 — Mois ${idx + 1} / 24`
              : idx < 24 ? `Phase 2 — Mois ${idx + 1} / 24`
              : `Post-contrat (M${idx + 1})`;
  $('#contract-phase').textContent = phase;

  const badgePhase = $('#badge-phase');
  if (idx < 12) {
    badgePhase.innerHTML = `<i data-lucide="shield-check" class="w-3.5 h-3.5"></i> Phase 1 · Min ${EUR(MIN_GARANTI_PHASE1)}`;
    badgePhase.className = 'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/30';
  } else if (idx < 24) {
    badgePhase.innerHTML = `<i data-lucide="shield-check" class="w-3.5 h-3.5"></i> Phase 2 · Min ${EUR(MIN_GARANTI_PHASE2)}`;
    badgePhase.className = 'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/30';
  } else {
    badgePhase.innerHTML = `<i data-lucide="sunset" class="w-3.5 h-3.5"></i> Post-contrat`;
    badgePhase.className = 'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full bg-slate-500/10 text-slate-300 border border-slate-500/30';
  }

  const badgeAv = $('#badge-avance');
  if (agg.avance > 0) {
    badgeAv.classList.remove('hidden');
    badgeAv.innerHTML = `<i data-lucide="piggy-bank" class="w-3.5 h-3.5"></i> Remb. Avance · -${EUR(AVANCE_DEDUCTION)}`;
  } else {
    badgeAv.classList.add('hidden');
  }
}

function renderGauge(agg) {
  const targetHours = getGuaranteedHoursEq(agg.monthIdx);
  const hours = agg.totalHours;
  const pct = Math.min(100, (hours / targetHours) * 100);
  const pctDisplay = pct.toFixed(1);
  const bar = $('#gauge-bar');
  bar.style.width = `${pctDisplay}%`;
  const surplus = hours > targetHours;
  bar.className = `h-full rounded-full transition-all duration-500 ease-out ${surplus ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : 'bg-gradient-to-r from-brand-500 to-brand-400'}`;
  $('#gauge-hours').innerHTML = `${HH(hours)} <span class="text-slate-400 text-base font-normal">·</span> <span class="text-lg ${surplus ? 'text-emerald-400' : 'text-slate-300'} font-medium">${pctDisplay}%</span>`;
  $('#gauge-target').textContent = `sur ${HH(targetHours)} équivalence minimum garanti`;
  $('#gauge-midpoint').textContent = `${HH(targetHours / 2)} · ${EUR(agg.minGaranti / 2)}`;
  $('#gauge-end').textContent = `${HH(targetHours)} · ${EUR(agg.minGaranti)}`;

  const subtitle = $('#gauge-subtitle');
  subtitle.textContent = `Toutes prestations (Socle ${agg.socleHours.toFixed(1)}h + Régie ${(agg.regieHours80 + agg.regieHours95).toFixed(1)}h + Forfaits ${agg.forfaitHours.toFixed(1)}h)`;

  const status = $('#gauge-status');
  const diff = agg.totalRevenus - agg.minGaranti;
  if (agg.isMinGarantiApplied) {
    status.className = 'mt-4 text-sm rounded-lg px-4 py-2.5 flex items-start gap-2.5 bg-brand-500/10 text-brand-200 border border-brand-500/30';
    status.innerHTML = `<i data-lucide="info" class="w-4 h-4 mt-0.5 flex-none"></i>
      <div>Minimum garanti appliqué · <strong>${EUR(agg.minGaranti)}</strong> facturés au lieu de ${EUR(agg.totalRevenus)} calculés.<br>
      <span class="text-brand-300/80 text-xs">Encore ${EUR(agg.minGaranti - agg.totalRevenus)} de prestations avant seuil de rentabilité.</span></div>`;
  } else if (surplus) {
    status.className = 'mt-4 text-sm rounded-lg px-4 py-2.5 flex items-start gap-2.5 bg-emerald-500/10 text-emerald-200 border border-emerald-500/30';
    status.innerHTML = `<i data-lucide="trending-up" class="w-4 h-4 mt-0.5 flex-none"></i>
      <div><strong>Surplus facturable atteint !</strong> CA réel de <strong>${EUR(agg.CA_HTVA)}</strong> (soit ${EUR(diff)} au-delà du seuil).<br>
      <span class="text-emerald-300/80 text-xs">Chaque heure supplémentaire en Régie est directement du surplus facturable.</span></div>`;
  } else {
    status.className = 'mt-4 text-sm rounded-lg px-4 py-2.5 flex items-start gap-2.5 bg-slate-700/40 text-slate-200 border border-slate-600';
    status.innerHTML = `<i data-lucide="activity" class="w-4 h-4 mt-0.5 flex-none"></i>
      <div>En dessous du seuil du minimum garanti. CA réel = <strong>${EUR(agg.totalRevenus)}</strong> · Encore ${EUR(agg.minGaranti - agg.totalRevenus)} pour dépasser le min garanti.</div>`;
  }
}

function renderMetrics(agg) {
  $('#metric-ca').textContent = EUR(agg.CA_HTVA);
  const caParts = [];
  caParts.push(`Socle ${EUR(agg.socleRevenue)}`);
  caParts.push(`Régie ${EUR(agg.regieRevenue)}`);
  if (agg.forfaitRevenue > 0) caParts.push(`Forfaits ${EUR(agg.forfaitRevenue)}`);
  if (agg.isMinGarantiApplied) caParts.push(`<span class="text-brand-300">+ complément min ${EUR(agg.minGaranti - agg.totalRevenus)}</span>`);
  $('#metric-ca-detail').innerHTML = caParts.join(' · ');

  $('#metric-tva').textContent = EUR2(agg.TVA_nete);
  $('#metric-tva-detail').innerHTML = `Collectée ${EUR2(agg.TVA_collectee)} · <span class="text-emerald-300/80">− crédit leasing ${EUR2(CREDIT_TVA_LEASING)}</span>`;

  $('#metric-provisions').textContent = EUR(agg.provisions);
  $('#metric-provisions-detail').innerHTML = `INASTI ${EUR(agg.INASTI)} · IPP ${EUR(agg.IPP)}`;

  $('#metric-net').textContent = EUR(agg.NET);
  const netParts = [];
  if (agg.avance > 0) netParts.push(`<span class="text-amber-300">−${EUR(agg.avance)} remb. avance</span>`);
  netParts.push(`Charges ${EUR(agg.TOTAL_CHARGES)} incluses`);
  $('#metric-net-detail').innerHTML = netParts.join(' · ');
}

function renderWaterfall(agg) {
  const rows = [
    { label: 'CA HTVA Facturé', value: agg.CA_HTVA, type: 'in',  icon: 'euro' },
    { label: `TVA Collectée (${Math.round(TVA_RATE * 100)}%)`, value: agg.TVA_collectee, type: 'neutral', icon: 'percent', sub: '+ encaissée du client' },
    { label: `TVA Nette à Reverser (− crédit leasing ${EUR2(CREDIT_TVA_LEASING)})`, value: -agg.TVA_nete, type: 'out', icon: 'arrow-down-right' },
    { label: `Provision INASTI (${Math.round(INASTI_RATE * 100)}% CA)`, value: -agg.INASTI, type: 'out', icon: 'building-2' },
    { label: `Provision IPP (${Math.round(IPP_RATE * 100)}% CA − INASTI)`, value: -agg.IPP, type: 'out', icon: 'landmark' },
    { label: 'Charges Fixes (Leasing + Logement + GSM + Comptable)', value: -agg.TOTAL_CHARGES, type: 'out', icon: 'layers', sub: `Leasing ${EUR(CHARGES_FIXES.leasing)} · Logement ${EUR(CHARGES_FIXES.logement)} · GSM/CC ${EUR(CHARGES_FIXES.gsm_cc)} · Compta ${EUR(CHARGES_FIXES.comptable)}` },
  ];
  if (agg.avance > 0) {
    rows.push({ label: 'Remboursement Avance de Démarrage (Mois 4→11)', value: -agg.avance, type: 'out', icon: 'piggy-bank' });
  }
  rows.push({ label: 'RESTE NET DANS LA POCHE', value: agg.NET, type: 'net', icon: 'wallet' });

  const html = rows.map(r => {
    const isNet = r.type === 'net';
    const valueCls = r.type === 'in' ? 'text-white' : r.type === 'out' ? 'text-rose-300' : r.type === 'net' ? 'text-emerald-300' : 'text-amber-300';
    const sign = r.value >= 0 ? '' : '−';
    const absVal = Math.abs(r.value);
    const valText = isNet ? EUR(absVal) : EUR(absVal);
    const barBg = r.type === 'net' ? 'bg-emerald-600/30 border border-emerald-500/40' : r.type === 'out' ? 'bg-rose-500/5 border border-rose-500/20' : r.type === 'in' ? 'bg-brand-500/5 border border-brand-500/20' : 'bg-slate-700/40 border border-slate-600';
    const containerCls = isNet ? 'mt-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30' : '';
    return `
      <div class="flex items-center gap-3 ${barBg} rounded-lg px-3 py-2.5 ${containerCls}">
        <div class="w-8 h-8 flex-none rounded-lg ${isNet ? 'bg-emerald-500/20 text-emerald-300' : r.type === 'out' ? 'bg-rose-500/15 text-rose-400' : r.type === 'in' ? 'bg-brand-500/15 text-brand-400' : 'bg-slate-600/40 text-slate-300'} flex items-center justify-center">
          <i data-lucide="${r.icon}" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm ${isNet ? 'font-semibold text-emerald-200' : ''}">${r.label}</div>
          ${r.sub ? `<div class="text-[11px] text-slate-400 mt-0.5">${r.sub}</div>` : ''}
        </div>
        <div class="font-mono font-semibold tabular-nums ${valueCls} ${isNet ? 'text-lg' : ''}">${sign}${valText}</div>
      </div>`;
  }).join('');
  $('#waterfall').innerHTML = html;
}

// =============================================================
// 📋 TABLEAU DES LOGS (ÉDITION / SUPPRESSION)
// =============================================================
function renderLogs(agg) {
  const tbody = $('#log-tbody');
  const tfoot = $('#log-tfoot');
  const empty = $('#log-empty');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';
  $('#log-count').textContent = STATE.entries.length ? `· ${STATE.entries.length} entrée${STATE.entries.length > 1 ? 's' : ''}` : '';

  if (!STATE.entries.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Group / total per category
  const totalsCat = { socle: { h: 0, eur: 0 }, regie_80: { h: 0, eur: 0 }, regie_95: { h: 0, eur: 0 }, forfait: { h: 0, eur: 0 } };

  tbody.innerHTML = STATE.entries.map(e => {
    const h = (e.duration_minutes || 0) / 60;
    const cat = CATEGORIES[e.category];
    let eur = 0;
    if (e.category === 'socle') eur = agg.socleRevenue * (h / Math.max(0.0001, agg.socleHours)) || 0;
    else if (e.category === 'regie_80') eur = h * RATE_REGIE_80;
    else if (e.category === 'regie_95') eur = h * RATE_REGIE_95;
    else if (e.category === 'forfait') eur = +(e.forfait_budget || 0);

    totalsCat[e.category].h += h;
    totalsCat[e.category].eur += eur;

    const realRate = e.category === 'forfait' && eur > 0 ? eur / Math.max(0.0001, h) : null;
    const hoverDesc = realRate ? ` title="Taux horaire réel : ${EUR(realRate)}/h (budget ${EUR(eur)} / ${h.toFixed(2)}h)"` : '';

    return `
      <tr data-id="${e.id}" class="hover:bg-slate-900/40 transition group">
        <td class="px-5 py-3 whitespace-nowrap text-slate-300">
          <input type="date" value="${fmtDateInput(e.date)}" data-field="date" class="bg-transparent border border-transparent hover:border-slate-700 focus:border-brand-500 focus:bg-slate-900 rounded px-2 py-1 text-sm outline-none w-full" />
        </td>
        <td class="px-5 py-3 min-w-[240px]">
          <input type="text" value="${escapeAttr(e.description || '')}" data-field="description" class="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-brand-500 focus:bg-slate-900 rounded px-2 py-1 text-sm outline-none" />
          ${e.category === 'forfait' ? `<div class="mt-1">
            <div class="flex items-center gap-1.5 text-[11px] text-amber-300/80">
              <i data-lucide="coins" class="w-3 h-3"></i> Budget forfait
              <input type="number" min="0" step="50" value="${e.forfait_budget ?? 0}" data-field="forfait_budget" class="bg-slate-900/70 border border-amber-500/30 focus:border-amber-400 rounded px-2 py-0.5 w-24 outline-none text-amber-200" /> €
              ${realRate ? `<span class="text-slate-400 ml-1">· taux réel <strong>${EUR(realRate)}/h</strong></span>` : ''}
            </div>
          </div>` : ''}
        </td>
        <td class="px-5 py-3">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md ${cat.bg} ${cat.color} ${cat.border} border">
            ${cat.label}
          </span>
        </td>
        <td class="px-5 py-3 text-right whitespace-nowrap">
          <div class="inline-flex items-center gap-2">
            <input type="number" min="0.25" step="0.25" value="${h.toFixed(2)}" data-field="hours" class="w-20 bg-transparent text-right border border-transparent hover:border-slate-700 focus:border-brand-500 focus:bg-slate-900 rounded px-2 py-1 text-sm outline-none tabular-nums" />
            <span class="text-slate-400 text-xs">h</span>
          </div>
        </td>
        <td class="px-5 py-3 text-right hidden sm:table-cell tabular-nums text-slate-200${hoverDesc ? '"' : ''}">${EUR(eur)}</td>
        <td class="px-5 py-3 text-right w-16">
          <div class="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition">
            <button data-save class="p-1.5 hover:bg-brand-500/20 text-brand-300 rounded" title="Enregistrer">
              <i data-lucide="save" class="w-4 h-4"></i>
            </button>
            <button data-del class="p-1.5 hover:bg-red-500/20 text-red-400 rounded" title="Supprimer">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  // Totals
  const catRows = Object.entries(totalsCat)
    .filter(([, v]) => v.h > 0 || v.eur > 0)
    .map(([k, v]) => {
      const c = CATEGORIES[k];
      return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md ${c.bg} ${c.color} ${c.border} border text-xs font-medium">
        ${c.label} · <span class="tabular-nums">${HH(v.h)}</span> · <span class="tabular-nums">${EUR(v.eur)}</span></span>`;
    }).join(' ');
  tfoot.innerHTML = `
    <tr>
      <td class="px-5 py-3" colspan="3">${catRows || '<span class="text-slate-400 text-xs">Aucun total</span>'}</td>
      <td class="px-5 py-3 text-right tabular-nums">${HH(agg.totalHours)}</td>
      <td class="px-5 py-3 text-right hidden sm:table-cell tabular-nums text-white">${EUR(agg.totalRevenus)}</td>
      <td class="hidden sm:table-cell"></td>
    </tr>`;

  // Attach actions
  $$('#log-tbody tr').forEach(tr => {
    const id = tr.dataset.id;
    const entry = STATE.entries.find(x => x.id === id);
    if (!entry) return;
    tr.querySelector('[data-del]').addEventListener('click', () => {
      if (confirm('Supprimer cette entrée ?')) deleteEntryById(id);
    });
    tr.querySelector('[data-save]').addEventListener('click', async () => {
      const patch = {};
      const dateStr = tr.querySelector('[data-field="date"]').value;
      if (dateStr) patch.date = new Date(dateStr + 'T12:00:00');
      const desc = tr.querySelector('[data-field="description"]').value;
      if (desc != null) patch.description = desc;
      const hStr = tr.querySelector('[data-field="hours"]').value;
      const h = parseFloat(hStr);
      if (!isNaN(h) && h > 0) patch.duration_minutes = roundUp15Min(h * 60);
      const fb = tr.querySelector('[data-field="forfait_budget"]');
      if (fb) patch.forfait_budget = parseFloat(fb.value || '0') || 0;
      await updateEntryById(id, patch);
    });
  });
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================================
// 📤 EXPORT MODAL (TIMESHEET NETTOYÉ)
// =============================================================
let exportAggCache = null;
function bindExportModal() {
  const open = () => { $('#export-modal').classList.remove('hidden'); lucide.createIcons(); };
  const close = () => $('#export-modal').classList.add('hidden');
  $('#btn-export').addEventListener('click', open);
  $('#btn-export-sm').addEventListener('click', open);
  $$('[data-close-modal]').forEach(el => el.addEventListener('click', close));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#btn-print').addEventListener('click', () => {
    const w = window.open('', '_blank');
    w.document.write(`
      <!doctype html><html><head><meta charset="utf-8"><title>Timesheet</title>
      <style>body{font-family:Inter,Arial,sans-serif;color:#111;padding:32px;}
      h1{font-size:20px;margin:0 0 4px;}h2{font-size:14px;color:#555;margin:0 0 24px;font-weight:normal;}
      table{width:100%;border-collapse:collapse;font-size:13px;}
      th,td{border:1px solid #ddd;padding:8px 10px;text-align:left;}
      th{background:#f5f5f7;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}
      td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
      tfoot td{font-weight:600;background:#fafafa;}
      .meta{display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:#444;margin-bottom:20px;}
      .meta span b{color:#111;}
      @media print{body{padding:0;}}</style></head><body>
      ${$('#export-body').innerHTML}
      </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 250);
  });
  $('#btn-csv').addEventListener('click', () => {
    if (!exportAggCache) return;
    const rows = [['Date', 'Description', 'Catégorie', 'Durée (h)', 'Durée (min)', '€ HTVA']];
    for (const e of STATE.entries) {
      const h = (e.duration_minutes || 0) / 60;
      let eur = 0;
      if (e.category === 'regie_80') eur = h * RATE_REGIE_80;
      else if (e.category === 'regie_95') eur = h * RATE_REGIE_95;
      else if (e.category === 'forfait') eur = +(e.forfait_budget || 0);
      rows.push([
        fmtDateBE(e.date),
        (e.description || '').replace(/"/g, '""'),
        CATEGORIES[e.category].label,
        h.toFixed(2),
        String(e.duration_minutes || 0),
        eur.toFixed(2),
      ]);
    }
    rows.push([]);
    rows.push(['TOTAL', '', '', (exportAggCache.totalHours).toFixed(2), '', exportAggCache.totalRevenus.toFixed(2)]);
    rows.push(['CA FACTURÉ (HTVA, min garanti appliqué)', '', '', '', '', exportAggCache.CA_HTVA.toFixed(2)]);
    const csv = rows.map(r => r.map(c => {
      const s = String(c ?? '');
      return /[,";\n]/.test(s) ? `"${s}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const mm = String(STATE.selectedMonth + 1).padStart(2, '0');
    a.href = url;
    a.download = `timesheet_nessy_${STATE.selectedYear}-${mm}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('CSV téléchargé', 'download');
  });
}

function renderExport(agg) {
  exportAggCache = agg;
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  $('#export-period').textContent = `${months[STATE.selectedMonth]} ${STATE.selectedYear} · ${STATE.entries.length} entrées · ${HH(agg.totalHours)}`;
  const body = STATE.entries.map(e => {
    const h = (e.duration_minutes || 0) / 60;
    const cat = CATEGORIES[e.category];
    let eur = 0;
    if (e.category === 'regie_80') eur = h * RATE_REGIE_80;
    else if (e.category === 'regie_95') eur = h * RATE_REGIE_95;
    else if (e.category === 'forfait') eur = +(e.forfait_budget || 0);
    return `<tr>
      <td>${fmtDateBE(e.date)}</td>
      <td>${escapeAttr(e.description || '')}</td>
      <td>${cat.label}</td>
      <td class="num">${h.toFixed(2)} h</td>
      <td class="num">${EUR(eur)}</td>
    </tr>`;
  }).join('');

  const totalRow = `
    <tr>
      <td colspan="3" style="text-align:right;"><strong>TOTAL</strong></td>
      <td class="num"><strong>${HH(agg.totalHours)}</strong></td>
      <td class="num"><strong>${EUR(agg.totalRevenus)}</strong></td>
    </tr>
    <tr>
      <td colspan="3" style="text-align:right;">CA HTVA Facturé (min garanti appliqué)</td>
      <td class="num"></td>
      <td class="num" style="background:#f0fdf4;"><strong>${EUR(agg.CA_HTVA)}</strong></td>
    </tr>`;

  const meta = `
    <div class="meta">
      <span>👤 <b>${escapeAttr(STATE.user?.email || 'Freelance')}</b></span>
      <span>📅 Période : <b>${months[STATE.selectedMonth]} ${STATE.selectedYear}</b></span>
      <span>🏷️ Phase contrat : <b>${agg.monthIdx < 12 ? 'Phase 1' : agg.monthIdx < 24 ? 'Phase 2' : 'Post-contrat'}</b></span>
      <span>💶 Min garanti : <b>${EUR(agg.minGaranti)}</b></span>
      <span>⏱️ Total heures : <b>${HH(agg.totalHours)}</b></span>
    </div>`;

  const table = `
    <h1 style="font-size:22px;margin:0 0 4px;">Timesheet · Contrat NESSY</h1>
    <h2 style="font-size:14px;color:#64748b;margin:0 0 24px;">Document à joindre à la facture mensuelle</h2>
    ${meta}
    <table>
      <thead><tr>
        <th style="width:120px;">Date</th><th>Description</th>
        <th style="width:200px;">Catégorie</th>
        <th class="num" style="width:110px;">Durée</th>
        <th class="num" style="width:120px;">€ HTVA</th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:32px;">Aucune entrée.</td></tr>`}</tbody>
      <tfoot>${totalRow}</tfoot>
    </table>`;
  $('#export-body').innerHTML = table;
}

// =============================================================
// AUTO-INIT LUCIDE AU PREMIER CHARGEMENT
// =============================================================
if (window.lucide) lucide.createIcons();
