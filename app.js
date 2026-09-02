import {
  auth,
  db,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  collection,
  addDoc,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  Timestamp,
  serverTimestamp,
  setDoc,
} from './firebase-config.js';

// =============================================================
// 💰 RÈGLES MÉTIER · CONSTANTES
// =============================================================
const NESSY = {
  socleFlat: 2000,
  socleHours: 25,
  regieRate: 80,
  minGaranti: 3500,
  minHoursEq: 43.75,
  phase2Min: 3000,
  phase2HoursEq: 37.5,
  phase2StartMonth: 12, // Mois 13 (index 12)
  avanceFrom: 3,        // Mois 4 (index 3)
  avanceTo: 10,         // Mois 11 (index 10)
  avanceDeduct: 625,
};

const TRESORERIE = {
  tva: 0.21,
  creditTVA: 56.40,   // € HT crédit leasing 650€ TTC
  inasti: 0.18,
  ipp: 0.25,
  charges: {
    leasing: 650,
    logement: 625,
    outils: 125,
    comptable: 125,
  },
};
const TOTAL_CHARGES = Object.values(TRESORERIE.charges).reduce((a, b) => a + b, 0);

// =============================================================
// 🗓️ ÉTAT GLOBAL
// =============================================================
const STATE = {
  user: null,
  clients: [],          // {id, name, default_rate, is_main_contract}
  logs: [],             // time_logs du mois courant
  selectedMonth: new Date().getMonth(),
  selectedYear: new Date().getFullYear(),
  contractStart: firstDayOfMonth(new Date().getFullYear(), 0), // À override : ex. new Date('2025-01-01')
  editingClientId: null,
};

// =============================================================
// 🧩 UTILITAIRES
// =============================================================
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

function EUR(n, digits = 0) {
  const v = digits === 0 ? Math.round(n) : Number(n).toFixed(digits);
  return Number(v).toLocaleString('fr-BE', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }) + ' €';
}
function HH(totalMinutes, showMinSuffix = true) {
  // Affichage court : 1h15, 2h, 0h30
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  const out = `${h}h${String(m).padStart(2, '0')}`;
  return showMinSuffix ? out : out;
}
function HHdecimal(totalMinutes) {
  return (totalMinutes / 60).toFixed(2);
}
function firstDayOfMonth(y, m) { return new Date(y, m, 1, 0, 0, 0, 0); }
function lastDayOfMonth(y, m)  { return new Date(y, m + 1, 0, 23, 59, 59, 999); }
function fmtDateBE(tsOrDate) {
  const d = tsOrDate instanceof Timestamp ? tsOrDate.toDate() : new Date(tsOrDate);
  return d.toLocaleDateString('fr-BE', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateInput(tsOrDate) {
  const d = tsOrDate instanceof Timestamp ? tsOrDate.toDate() : new Date(tsOrDate);
  return d.toISOString().slice(0, 10);
}
// ★ Règle d'arrondi · 15 min SUPÉRIEURES
function billedMinutes(realMin) {
  if (!realMin || realMin <= 0) return 0;
  return Math.ceil(realMin / 15) * 15;
}
function toast(msg, icon = 'check-circle', variant = 'success') {
  const t = $('#toast');
  const iconCls = variant === 'danger' ? 'text-red-400' : variant === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  t.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 ${iconCls}"></i><span>${msg}</span>`;
  lucide.createIcons();
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

// =============================================================
// 🔐 AUTH
// =============================================================
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast('Connecté · Bienvenue dans kopek ✨', 'sparkles');
  } catch (ex) {
    let msg = 'Identifiants incorrects.';
    if (ex.code === 'auth/invalid-credential' || ex.code === 'auth/wrong-password' || ex.code === 'auth/user-not-found') msg = 'Identifiants incorrects.';
    else if (ex.code === 'auth/invalid-email') msg = 'Email invalide.';
    else if (ex.code === 'auth/too-many-requests') msg = 'Trop de tentatives — attendez quelques instants.';
    err.textContent = msg;
    err.classList.remove('hidden');
  }
});
$('#btn-logout').addEventListener('click', async () => {
  try { await signOut(auth); toast('Déconnecté', 'log-out', 'warn'); } catch { /* ignore */ }
});

onAuthStateChanged(auth, (user) => {
  STATE.user = user;
  if (user) {
    $('#login-screen').classList.add('hidden');
    $('#dashboard-screen').classList.remove('hidden');
    $('#auth-status').classList.remove('hidden');
    $('#auth-status').classList.add('flex');
    $('#auth-email').textContent = user.email || '';
    initApp();
  } else {
    $('#dashboard-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
  }
  if (window.lucide) lucide.createIcons();
});

// =============================================================
// 🚀 INIT APP (après auth)
// =============================================================
function initApp() {
  buildPeriodSelectors();
  bindTopBar();
  bindQuickForm();
  bindModals();
  refreshPeriod();
  lucide.createIcons();
}

// =============================================================
// 🗓️ TOP BAR · MOIS / ANNÉE
// =============================================================
function buildPeriodSelectors() {
  const mSel = $('#month-select');
  const ySel = $('#year-select');
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  if (!mSel.options.length) months.forEach((n, i) => {
    const o = document.createElement('option'); o.value = String(i); o.textContent = n; mSel.appendChild(o);
  });
  const curY = new Date().getFullYear();
  if (!ySel.options.length) {
    for (let y = curY - 3; y <= curY + 2; y++) {
      const o = document.createElement('option'); o.value = String(y); o.textContent = y; ySel.appendChild(o);
    }
  }
  mSel.value = String(STATE.selectedMonth);
  ySel.value = String(STATE.selectedYear);
}
function bindTopBar() {
  $('#month-select').onchange = (e) => { STATE.selectedMonth = +e.target.value; refreshPeriod(); };
  $('#year-select').onchange  = (e) => { STATE.selectedYear  = +e.target.value; refreshPeriod(); };
  $('#prev-month').onclick = () => navigateMonth(-1);
  $('#next-month').onclick = () => navigateMonth(+1);
}
function navigateMonth(delta) {
  let m = STATE.selectedMonth + delta, y = STATE.selectedYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  STATE.selectedMonth = m; STATE.selectedYear = y;
  $('#month-select').value = String(m);
  $('#year-select').value  = String(y);
  refreshPeriod();
}

// =============================================================
// 🗃️ FIRESTORE CRUD
// =============================================================
const colClients   = () => collection(db, 'clients');
const colTimeLogs  = () => collection(db, 'time_logs');

async function ensureDefaultClient() {
  // Charge les clients du user
  const q = query(colClients(), where('userId', '==', STATE.user.uid), orderBy('name', 'asc'));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  STATE.clients = list;
  if (list.length === 0) {
    const nessy = await addDoc(colClients(), {
      userId: STATE.user.uid,
      name: 'NESSY · Contrat Principal',
      default_rate: NESSY.regieRate,
      is_main_contract: true,
      createdAt: serverTimestamp(),
    });
    STATE.clients.push({
      id: nessy.id,
      userId: STATE.user.uid,
      name: 'NESSY · Contrat Principal',
      default_rate: NESSY.regieRate,
      is_main_contract: true,
    });
  }
}
async function loadClients() {
  const q = query(colClients(), where('userId', '==', STATE.user.uid), orderBy('name', 'asc'));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  STATE.clients = list;
  if (list.length === 0) await ensureDefaultClient();
}
async function loadLogsForMonth() {
  if (!STATE.user) return [];
  const start = firstDayOfMonth(STATE.selectedYear, STATE.selectedMonth);
  const end   = lastDayOfMonth(STATE.selectedYear, STATE.selectedMonth);
  const q = query(
    colTimeLogs(),
    where('userId', '==', STATE.user.uid),
    where('date', '>=', Timestamp.fromDate(start)),
    where('date', '<=', Timestamp.fromDate(end)),
    orderBy('date', 'asc')
  );
  try {
    const snap = await getDocs(q);
    const arr = [];
    snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
    STATE.logs = arr;
    return arr;
  } catch (ex) {
    console.warn('loadLogsForMonth', ex);
    STATE.logs = [];
    return [];
  }
}
async function createLog(payload) {
  if (!STATE.user) return null;
  const d = {
    userId: STATE.user.uid,
    custom_price: null,
    project_name: '',
    createdAt: serverTimestamp(),
    ...payload,
    date: payload.date instanceof Timestamp ? payload.date : Timestamp.fromDate(payload.date),
  };
  const ref = await addDoc(colTimeLogs(), d);
  return ref.id;
}
async function updateLog(id, patch) {
  if (!STATE.user) return;
  const norm = { ...patch };
  if (norm.date && !(norm.date instanceof Timestamp)) norm.date = Timestamp.fromDate(norm.date);
  await updateDoc(doc(db, 'time_logs', id), norm);
}
async function deleteLog(id) {
  if (!STATE.user) return;
  await deleteDoc(doc(db, 'time_logs', id));
}
async function createClient(data) {
  if (!STATE.user) return null;
  const payload = {
    userId: STATE.user.uid,
    createdAt: serverTimestamp(),
    ...data,
  };
  // Si is_main_contract, reset les autres
  if (payload.is_main_contract) {
    for (const c of STATE.clients) {
      if (c.is_main_contract) await updateDoc(doc(db, 'clients', c.id), { is_main_contract: false });
    }
  }
  const ref = await addDoc(colClients(), payload);
  return ref.id;
}
async function updateClient(id, patch) {
  if (!STATE.user) return;
  if (patch.is_main_contract) {
    for (const c of STATE.clients) {
      if (c.is_main_contract && c.id !== id)
        await updateDoc(doc(db, 'clients', c.id), { is_main_contract: false });
    }
  }
  await updateDoc(doc(db, 'clients', id), patch);
}
async function deleteClient(id) {
  if (!STATE.user) return;
  // Vérifie qu'il ne reste pas que ce client
  if (STATE.clients.length <= 1) {
    toast('Impossible de supprimer le dernier client', 'alert-circle', 'danger');
    throw new Error('last_client');
  }
  await deleteDoc(doc(db, 'clients', id));
}
function getMainClient() {
  return STATE.clients.find((c) => c.is_main_contract) || STATE.clients[0];
}
function getClient(id) {
  return STATE.clients.find((c) => c.id === id);
}

// =============================================================
// 🧮 MOTEUR CALCUL · FACTURATION NESSY + MULTI-CLIENTS
// =============================================================
function computeContractMonthIdx() {
  const s = STATE.contractStart;
  return (STATE.selectedYear - s.getFullYear()) * 12 + (STATE.selectedMonth - s.getMonth());
}
function getMinGaranti(monthIdx) { return monthIdx >= NESSY.phase2StartMonth ? NESSY.phase2Min : NESSY.minGaranti; }
function getMinHoursEq(monthIdx) { return monthIdx >= NESSY.phase2StartMonth ? NESSY.phase2HoursEq : NESSY.minHoursEq; }
function isAvanceMonth(monthIdx)   { return monthIdx >= NESSY.avanceFrom && monthIdx <= NESSY.avanceTo; }

/**
 * Décompose les heures NESSY en 3 paliers et le CA associé
 * @returns {{tier1:{h:number,eur:number}, tier2:{h:number,eur:number}, tier3:{h:number,eur:number}, rawEur:number, minApplied:boolean, finalCA:number, mainClient:object, mainTotalHours:number}}
 */
function nessyTierBreakdown(mainBilledMinutes, extraMainHourlyEur, flatEntriesFromMain) {
  // Heures facturées totales du client principal (forfaits exclus du décompte paliers → ils s'ajoutent au brut)
  const minutesHourly = mainBilledMinutes; // ne contient déjà que les logs hourly, pas flat
  const hoursHourly = minutesHourly / 60;
  // flat → on ajoute leur € au revenu brut, ils ne participent pas aux paliers
  const flatEur = flatEntriesFromMain.reduce((a, l) => a + (l.custom_price || 0), 0);

  // Palier 1 : Socle 25h · forfait 2000 €
  const t1h = Math.min(hoursHourly, NESSY.socleHours);
  // Palier 2 : Régie Garantie 25h → 43,75h · 80 €/h
  const t2h = Math.min(Math.max(hoursHourly - NESSY.socleHours, 0), getMinHoursEq(0) - NESSY.socleHours);
  // Palier 3 : Surplus · 80 €/h (ou taux custom s'il est précisé)
  const t3h = Math.max(hoursHourly - getMinHoursEq(0), 0);

  const t1eur = hoursHourly > 0 ? NESSY.socleFlat : 0;
  const t2eur = t2h * NESSY.regieRate;
  // T3 utilise le rate moyen (80 €/h en général, mais si certains logs NESSY ont un taux custom on utilise leur € réel)
  const t3eur = extraMainHourlyEur; // taux horaire réel * heures t3 précalculés
  // Note: précision — pour la simplicité, on calcule via le revenu réel ci-dessous :
  // rawHourlyEur depuis les logs hourly :
  return {
    t1: { h: t1h, eur: t1eur },
    t2: { h: t2h, eur: t2eur },
    t3: { h: t3h, eur: t3eur },
    flatEur,
    hours: hoursHourly,
  };
}

/** Calcule tout le mois · objet agrégat */
function aggregateMonth() {
  const monthIdx = computeContractMonthIdx();
  const mainClient = getMainClient();
  const mainClientId = mainClient ? mainClient.id : null;

  // Regroupements par client
  const byClient = new Map(); // id -> { client, realMin, billedMin, eur, count }

  let mainRealMin = 0, mainBilledMin = 0;     // hourly NESSY uniquement
  let mainHourlyLogs = [];                    // logs hourly du client principal
  let mainFlatLogs = [];                      // logs flat du client principal
  let mainHourlyRealEur = 0;                  // (minutes facturées/60) × rate appliqué pour les logs hourly NESSY

  let globalRealMin = 0;
  let globalBilledMin = 0;
  let globalRawEur = 0; // somme brute tous clients (avant application min garanti NESSY)

  for (const l of STATE.logs) {
    const realMin = l.real_minutes || 0;
    const billedMin = l.billed_minutes || 0;
    const rate = l.rate_applied || 0;
    const isFlat = l.custom_price != null && l.custom_price > 0;
    let eur = 0;
    if (isFlat) eur = l.custom_price;
    else eur = (billedMin / 60) * rate;

    globalRealMin += realMin;
    globalBilledMin += billedMin;
    globalRawEur += eur;

    // bucket client
    if (!byClient.has(l.client_id)) {
      byClient.set(l.client_id, {
        client: getClient(l.client_id) || { name: 'Client supprimé', id: l.client_id },
        realMin: 0, billedMin: 0, eur: 0, count: 0, flat: 0, hourly: 0,
      });
    }
    const b = byClient.get(l.client_id);
    b.realMin += realMin; b.billedMin += billedMin; b.eur += eur; b.count++;
    if (isFlat) b.flat += eur; else b.hourly += eur;

    // NESSY
    if (l.client_id === mainClientId) {
      if (isFlat) {
        mainFlatLogs.push(l);
      } else {
        mainRealMin += realMin;
        mainBilledMin += billedMin;
        mainHourlyLogs.push(l);
        mainHourlyRealEur += eur;
      }
    }
  }

  // ---- DÉCOMPOSITION PALIERS NESSY ----
  const hoursHourlyNessy = mainBilledMin / 60;
  const t1h = Math.min(hoursHourlyNessy, NESSY.socleHours);
  const t2h = Math.min(Math.max(hoursHourlyNessy - NESSY.socleHours, 0), NESSY.minHoursEq - NESSY.socleHours);
  const t3h = Math.max(hoursHourlyNessy - NESSY.minHoursEq, 0);
  const t1eur = mainHourlyLogs.length || mainFlatLogs.length ? NESSY.socleFlat : 0;
  const t2eur = t2h * NESSY.regieRate;
  // Pour T3 : € réel hourly Nessy − (socle + t2 @ 80€). Si custom rate (ex 95€) s'applique, on conserve l'excédent.
  const t3eur = Math.max(0, mainHourlyRealEur - NESSY.socleFlat - t2eur);

  const mainFlatEur = mainFlatLogs.reduce((a, l) => a + (l.custom_price || 0), 0);
  const mainRevenusAvantMin = t1eur + t2eur + t3eur + mainFlatEur;
  const minG = getMinGaranti(monthIdx);
  const minApplied = mainRevenusAvantMin < minG && mainHourlyLogs.length + mainFlatLogs.length > 0;
  const mainFinalCA = (mainHourlyLogs.length + mainFlatLogs.length === 0)
    ? 0
    : Math.max(minG, mainRevenusAvantMin);

  // Revenus clients secondaires (brut, sans min garanti)
  let secondaryEur = 0;
  for (const [cid, v] of byClient) {
    if (cid !== mainClientId) secondaryEur += v.eur;
  }
  const globalCA = mainFinalCA + secondaryEur;

  // ---- CASCADE TRÉSORERIE ----
  const tvaCollectee = globalCA * TRESORERIE.tva;
  const tvaNette = Math.max(0, tvaCollectee - TRESORERIE.creditTVA);
  const inasti = globalCA * TRESORERIE.inasti;
  const caApresInasti = globalCA - inasti;
  const ipp = caApresInasti * TRESORERIE.ipp;
  const avance = isAvanceMonth(monthIdx) ? NESSY.avanceDeduct : 0;
  const netPocket = globalCA + TRESORERIE.creditTVA - TOTAL_CHARGES - inasti - ipp - avance;

  // Pour jauge · 0 → minHoursEq = 100% ; max 120% pour que ça déborde visuellement dans la zone surplus
  const gaugeBaseHours = NESSY.minHoursEq;
  const gaugePct = Math.min(120, (hoursHourlyNessy / gaugeBaseHours) * 100);

  return {
    monthIdx, minG, minApplied,
    mainClient,
    tiers: { t1: { h: t1h, eur: t1eur }, t2: { h: t2h, eur: t2eur }, t3: { h: t3h, eur: t3eur } },
    mainFlatEur,
    mainRevenusAvantMin,
    mainFinalCA,
    mainHoursHourly: hoursHourlyNessy,
    mainRealMinutes: mainRealMin,
    mainBilledMinutes: mainBilledMin,
    secondaryEur,
    globalCA,
    globalRealMin,
    globalBilledMin,
    globalRawEur,
    tvaCollectee, tvaNette,
    inasti, ipp,
    provisions: inasti + ipp,
    avance,
    netPocket,
    byClient,
    gaugePct,
    gaugeBaseHours,
  };
}

// =============================================================
// 🎨 RENDU PRINCIPAL
// =============================================================
async function refreshPeriod() {
  await loadClients();
  await loadLogsForMonth();
  const agg = aggregateMonth();
  populateClientSelects();
  renderHeader(agg);
  renderNessyGauge(agg);
  renderMine(agg);
  renderPocket(agg);
  renderMetrics(agg);
  renderWaterfall(agg);
  renderClientsList(agg);
  renderLogs(agg);
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

function renderHeader(agg) {
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  $('#period-title').textContent = `${months[STATE.selectedMonth]} ${STATE.selectedYear}`;
  const idx = agg.monthIdx;
  let phaseTxt = '', phaseBadge = '';
  if (idx < 0) { phaseTxt = `Pré-démarrage (M${idx})`; phaseBadge = 'Pré-démarrage'; }
  else if (idx < NESSY.phase2StartMonth) {
    phaseTxt = `Mois ${idx + 1} / 24 · Phase 1 · Min garanti ${EUR(NESSY.minGaranti)}`;
    phaseBadge = `Phase 1 · Mois ${idx + 1}/24`;
  } else if (idx < 24) {
    phaseTxt = `Mois ${idx + 1} / 24 · Phase 2 · Min garanti ${EUR(NESSY.phase2Min)}`;
    phaseBadge = `Phase 2 · Mois ${idx + 1}/24`;
  } else { phaseTxt = `Post-contrat (M${idx + 1})`; phaseBadge = 'Post-contrat'; }
  if (agg.avance > 0) phaseTxt += ` · Remboursement avance −${EUR(NESSY.avanceDeduct)}`;
  $('#period-sub').textContent = phaseTxt;
  const pb = $('#phase-badge');
  pb.textContent = phaseBadge;
  if (idx < 0) pb.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-800/80 text-zinc-400 text-[10px] font-semibold tracking-wider uppercase border border-zinc-700/70';
  else if (idx < NESSY.phase2StartMonth) pb.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-300 text-[10px] font-semibold tracking-wider uppercase border border-fuchsia-500/30';
  else if (idx < 24) pb.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 text-[10px] font-semibold tracking-wider uppercase border border-cyan-500/30';
  else pb.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 text-[10px] font-semibold tracking-wider uppercase border border-amber-500/30';
  $('#nessy-ca').textContent = EUR(agg.mainFinalCA);
}

function renderNessyGauge(agg) {
  const hoursNessy = agg.mainHoursHourly;          // h facturées sur contrat principal
  const socleH = NESSY.socleHours;                 // 25 h
  const garantieH = NESSY.minHoursEq;              // 43,75 h

  // ============================================================
  // ⚠️ POSITIONS DES ZONES SOCLE / GARANTIE / SURPLUS SONT FIXES EN DUR DANS LE HTML
  //    (fond coloré en filigrane + séparateurs verticaux épais)
  //    Ici on ne fait que positionner le FILL et le CURSEUR sur cette grille fixe.
  // ============================================================
  const pct = agg.gaugePct; // 0..120
  $('#gauge-fill').style.width   = `${pct}%`;
  $('#gauge-cursor').style.left  = `${pct}%`;

  // Titre header : HEURES ENCODÉES / BASE
  const hh = HHdecimal(hoursNessy * 60);           // heures decimal pour affichage
  const beforeSocle = socleH - hoursNessy;
  const beforeGarantie = garantieH - hoursNessy;
  $('#nessy-sub').innerHTML = hoursNessy <= 0
    ? `0 h · encodé sur <b class="text-indigo-300">${socleH.toFixed(2)} h Socle</b> → <b class="text-fuchsia-300">${garantieH.toFixed(2)} h Min Garanti</b>`
    : `<b class="chip font-bold text-white">${hh} h</b> facturées sur le contrat · <span class="text-zinc-500">Base ${garantieH.toFixed(2)} h</span>`;

  // Cards tiers (3 sous-cartes sous la jauge)
  $('#tier1-h').textContent   = `${agg.tiers.t1.h.toFixed(2)} h`;
  $('#tier1-eur').textContent = EUR(agg.tiers.t1.eur);
  $('#tier2-h').textContent   = `${agg.tiers.t2.h.toFixed(2)} h`;
  $('#tier2-eur').textContent = `${EUR(agg.tiers.t2.eur)} @ ${NESSY.regieRate} €/h`;
  $('#tier3-h').textContent   = `${agg.tiers.t3.h.toFixed(2)} h`;
  $('#tier3-eur').textContent = `+ ${EUR(agg.tiers.t3.eur + agg.mainFlatEur)}`;

  // ---- STATUS BAND : position EXPLICITE vs SOCLE puis vs GARANTIE ----
  const st = $('#gauge-status');
  const minGap = agg.minG - agg.mainRevenusAvantMin;

  // Cas 0 · Rien d'encodé
  if (agg.mainFinalCA === 0) {
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-zinc-800 bg-zinc-900/40';
    st.innerHTML = `<i data-lucide="hash" class="w-5 h-5 text-zinc-500 flex-none mt-0.5"></i>
      <div><strong class="text-zinc-200">Heures encodées NESSY · <span class="chip text-zinc-100">0,00 h</span> / ${garantieH.toFixed(2)} h</strong><br>
      <div class="mt-1.5 grid grid-cols-3 gap-3 text-xs font-mono">
        <div class="text-indigo-300/90"><b>0 / 25 h</b><br><span class="text-zinc-500 text-[11px]">Socle 2 000 €</span></div>
        <div class="text-fuchsia-300/90"><b>0 / 18,75 h</b><br><span class="text-zinc-500 text-[11px]">Régie Garantie</span></div>
        <div class="text-emerald-300/90"><b>0 h</b><br><span class="text-zinc-500 text-[11px]">Surplus facturable</span></div>
      </div>
      <span class="text-zinc-500 text-sm mt-2 block">Sélectionnez <b>${agg.mainClient?.name || 'NESSY'}</b> dans la saisie rapide pour activer le palier Socle.</span></div>`;
  }

  // Cas 1 · Dans le SOCLE (0 → 25h)
  else if (hoursNessy < socleH) {
    const pctSocle = Math.min(100, (hoursNessy / socleH) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-indigo-500/40 bg-indigo-500/[0.07]';
    st.innerHTML = `<i data-lucide="move-up-right" class="w-5 h-5 text-indigo-300 flex-none mt-0.5"></i>
      <div class="flex-1"><strong class="text-indigo-100">Zone Socle · <span class="chip">${agg.tiers.t1.h.toFixed(2)} h / 25,00 h</span> effectués</strong>
      <div class="mt-2 h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-indigo-400/80 rounded-full" style="width:${pctSocle}%"></div></div>
      <div class="flex justify-between text-[11px] font-mono mt-1.5 text-indigo-300/80">
        <span>Avancement Socle · ${pctSocle.toFixed(0)}%</span>
        <span>Il manque <b>${beforeSocle.toFixed(2)} h</b> pour remplir le socle</span>
      </div>
      <div class="text-zinc-400 text-[12px] mt-2">
        Palier Socle <b class="text-indigo-300">${EUR(agg.tiers.t1.eur)}</b> · Forfaits ajoutés <b>${EUR(agg.mainFlatEur)}</b> ·
        ${minGap > 0 ? `Pour dépasser le Min Garanti : encore <b class="text-fuchsia-300">${EUR(minGap)}</b> de prestations` : `Min Garanti atteint`}
      </div></div>`;
  }

  // Cas 2 · Dans la RÉGIE GARANTIE (25h → 43,75h)
  else if (hoursNessy < garantieH) {
    const regieH = hoursNessy - socleH;
    const regieMax = garantieH - socleH; // 18,75 h
    const pctRegie = Math.min(100, (regieH / regieMax) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-fuchsia-500/40 bg-fuchsia-500/[0.07]';
    st.innerHTML = `<i data-lucide="shield-check" class="w-5 h-5 text-fuchsia-300 flex-none mt-0.5"></i>
      <div class="flex-1"><strong class="text-fuchsia-100">Socle <span class="text-emerald-300">✓</span> rempli · Zone Régie Garantie · <span class="chip">${regieH.toFixed(2)} h / 18,75 h</span></strong>
      <div class="mt-2 grid grid-cols-2 gap-3">
        <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-indigo-400 rounded-full" style="width:100%"></div></div>
        <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-fuchsia-400/80 rounded-full" style="width:${pctRegie}%"></div></div>
      </div>
      <div class="flex justify-between text-[11px] font-mono mt-1.5 text-zinc-400">
        <span class="text-indigo-300/80">Socle 100% · 25 h · 2 000 €</span>
        <span class="text-fuchsia-300/80">Régie ${pctRegie.toFixed(0)}% · manque <b>${beforeGarantie.toFixed(2)} h</b></span>
      </div>
      <div class="text-zinc-400 text-[12px] mt-2">
        Socle <b class="text-indigo-300">${EUR(agg.tiers.t1.eur)}</b> · Régie Garantie <b class="text-fuchsia-300">${EUR(agg.tiers.t2.eur)}</b> @ ${NESSY.regieRate} €/h · Forfaits <b>${EUR(agg.mainFlatEur)}</b>
        ${agg.minApplied ? `<br><span class="text-amber-300">⚠ Minimum garanti <b>${EUR(agg.minG)}</b> sera appliqué en facturation</span>` : `<br><span class="text-emerald-300">✓ Min Garanti atteint sans top-up</span>`}
      </div></div>`;
  }

  // Cas 3 · SURPLUS (≥ 43,75h)
  else {
    const surplusH = agg.tiers.t3.h;
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-emerald-500/40 bg-emerald-500/[0.07]';
    st.innerHTML = `<i data-lucide="trending-up" class="w-5 h-5 text-emerald-300 flex-none mt-0.5"></i>
      <div class="flex-1"><strong class="text-emerald-100">Socle ✓ · Min Garanti ✓ · Surplus facturable · <span class="chip">+${surplusH.toFixed(2)} h</span></strong>
      <div class="mt-2 grid grid-cols-3 gap-3">
        <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-indigo-400 rounded-full" style="width:100%"></div></div>
        <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-fuchsia-400 rounded-full" style="width:100%"></div></div>
        <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-emerald-400 to-lime-400 rounded-full" style="width:${Math.min(100,(surplusH/8.75)*100)}%"></div></div>
      </div>
      <div class="flex justify-between text-[11px] font-mono mt-1.5 text-zinc-400">
        <span class="text-indigo-300/80">Socle 25 h · 2 000 €</span>
        <span class="text-fuchsia-300/80">Régie 18,75 h · 1 500 €</span>
        <span class="text-emerald-300/80">Surplus · ${surplusH.toFixed(2)} h × 80 €</span>
      </div>
      <div class="text-zinc-400 text-[12px] mt-2">
        Palier Socle <b class="text-indigo-300">${agg.tiers.t1.h.toFixed(2)} h</b> ·
        Palier Régie Garantie <b class="text-fuchsia-300">${agg.tiers.t2.h.toFixed(2)} h</b> ·
        Palier Surplus <b class="text-emerald-300">${agg.tiers.t3.h.toFixed(2)} h</b> ·
        CA principal total <b>${EUR(agg.mainFinalCA)}</b>
        ${agg.tiers.t3.eur + agg.mainFlatEur > 0 ? ` · Surplus encaissé <b class="text-emerald-300">+${EUR(agg.tiers.t3.eur + agg.mainFlatEur)}</b>` : ''}
      </div></div>`;
  }
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

// =================================================================
// 🎮 GAMIFIED · MINE KOPEK 3D + SCOREBOARD
// =================================================================
function renderMine(agg) {
  // ---- DONNÉES NÉCESSAIRES ----
  const socleMaxH = NESSY.socleHours;                            // 25 h
  const garantieMaxH = NESSY.minHoursEq;                         // 43,75 h
  const hoursNessy = agg.mainHoursHourly;                        // h facturées NESSY
  const t1h = agg.tiers.t1.h;
  const t2h = agg.tiers.t2.h;
  const t3h = agg.tiers.t3.h;
  const pctL1 = Math.min(100, (t1h / socleMaxH) * 100);          // 0→25h => 0→100% L1
  const pctL2 = t1h >= socleMaxH ? Math.min(100, (t2h / (garantieMaxH - socleMaxH)) * 100) : 0;
  const pctL3 = hoursNessy >= garantieMaxH ? Math.min(100, Math.min(100, (t3h / 8.75) * 100)) : 0;

  // ---- FILLS HEIGHTS (chaque niveau se remplit depuis le bas) ----
  $('#mine-l1-fill').style.height = `${pctL1}%`;
  $('#mine-l2-fill').style.height = `${pctL2}%`;
  $('#mine-l3-fill').style.height = `${pctL3}%`;

  // ---- SPRITES GÉNÉRATEUR : créer N emojis selon % pour chaque niveau ----
  function fillSprites(containerId, pct, palette, countMax) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    // Combien d'items afficher (proportionnel au pct, mini 0, max countMax)
    const target = Math.round((pct / 100) * countMax);
    const existing = wrap.children.length;
    if (target === existing && target > 0) return; // déjà bon
    wrap.innerHTML = '';
    for (let i = 0; i < target; i++) {
      const span = document.createElement('span');
      const emoji = palette[i % palette.length];
      span.textContent = emoji;
      // rotations / offsets random pour un look "entassé cartoon"
      const rot = (Math.random() * 40 - 20).toFixed(1);
      const ty = (Math.random() * 4).toFixed(1);
      const scale = (0.85 + Math.random() * 0.35).toFixed(2);
      span.style.display = 'inline-block';
      span.style.transform = `rotate(${rot}deg) translateY(${ty}px) scale(${scale})`;
      span.style.filter = `drop-shadow(0 2px 2px rgba(0,0,0,0.35))`;
      wrap.appendChild(span);
    }
  }

  fillSprites('mine-l1-sprites', pctL1, ['🪙','🟠','🟫','🟡','🏺','⚱️'], 24);
  fillSprites('mine-l2-sprites', pctL2, ['🟨','🟧','🥇','🏆','💰','🪙','🪙'], 22);
  fillSprites('mine-l3-sprites', pctL3, ['💎','💠','💚','🟢','👑','💵','🪙'], 24);

  // ---- POSITION DU PERSONNAGE MINER : il se déplace le long du "chemin" de remplissage ----
  // On calcule un "score de progression global" 0..120 (socle 0-57, garantie 57-100, surplus 100-120)
  const globalPct = Math.min(120, (hoursNessy / garantieMaxH) * 100);
  // Position x (-100 → +150), y (0 → -180)
  const minerX = -100 + (globalPct / 120) * 220;
  const minerY = 10 - Math.min(180, (globalPct / 120) * 180);
  const zOffset = 200 + Math.min(40, (globalPct / 120) * 60);
  const minerEl = $('#miner-char');
  const cartEl = $('#miner-cart');
  if (minerEl) minerEl.style.transform = `translate(${minerX}px, ${minerY}px) translateZ(${zOffset}px)`;
  if (cartEl) cartEl.style.transform = `translate(${minerX + 40}px, ${minerY + 20}px) translateZ(${zOffset + 5}px)`;

  // ---- BADGE NIVEAU ----
  let level = 0; let levelName = 'Débutant'; let badgeColor = 'indigo';
  if (hoursNessy >= 0.01) { level = 1; levelName = 'Apprenti Mineur'; badgeColor = 'indigo'; }
  if (hoursNessy >= socleMaxH) { level = 2; levelName = 'Socle Atteint'; badgeColor = 'sky'; }
  if (hoursNessy >= garantieMaxH * 0.9) { level = 3; levelName = 'Bientôt Garanti'; badgeColor = 'fuchsia'; }
  if (hoursNessy >= garantieMaxH) { level = 4; levelName = 'Garanti Validé'; badgeColor = 'amber'; }
  if (t3h >= 5) { level = 5; levelName = 'Surplus Pro'; badgeColor = 'emerald'; }
  if (t3h >= 15) { level = 6; levelName = 'Kopek Magnat'; badgeColor = 'lime'; }
  const badge = $('#mine-level-badge');
  if (badge) {
    const cls = {indigo: 'bg-indigo-500/20 text-indigo-200 border-indigo-400/40', sky:'bg-sky-500/20 text-sky-200 border-sky-400/40', fuchsia:'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/40', amber:'bg-amber-500/20 text-amber-200 border-amber-400/40', emerald:'bg-emerald-500/20 text-emerald-200 border-emerald-400/40', lime:'bg-lime-500/20 text-lime-200 border-lime-400/40'}[badgeColor];
    badge.className = `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wider uppercase border ${cls}`;
    badge.innerHTML = `<i data-lucide="flame" class="w-3 h-3 text-orange-300"></i> Niveau ${level} · ${levelName}`;
  }

  // ---- XP BAR (0 → garantieMaxH) ----
  const xpPct = Math.min(100, (hoursNessy / garantieMaxH) * 100);
  if ($('#mine-xp-fill'))  $('#mine-xp-fill').style.width = `${xpPct}%`;
  if ($('#mine-xp-label')) $('#mine-xp-label').textContent = `XP · ${hoursNessy.toFixed(2).replace('.',',')} / ${garantieMaxH.toFixed(2).replace('.',',')} h`;
  if ($('#mine-xp-pct'))   $('#mine-xp-pct').textContent = `${xpPct.toFixed(0)}%`;

  // ---- BOSS DU MOIS (HP bar = mainFinalCA / minG) ----
  const minG = agg.minG;
  const bossTitle = $('#boss-title');
  const bossHpLabel = $('#boss-hp-label');
  const bossHpFill = $('#boss-hp-fill');
  const bossSummary = $('#boss-summary');
  if (bossTitle) {
    if (hoursNessy <= 0) {
      bossTitle.textContent = 'Réveiller la Machine · Premier Encodage';
    } else if (t1h < socleMaxH) {
      bossTitle.textContent = 'Creuser le Socle · 2 000 €';
    } else if (agg.mainFinalCA < minG) {
      bossTitle.textContent = 'Valider le Min Garanti · 3 500 €';
    } else {
      bossTitle.textContent = '🎊 Boss Battu · Surplus illimité activé';
    }
  }
  if (bossHpLabel) bossHpLabel.textContent = `CA · ${EUR(agg.mainFinalCA)} / ${EUR(minG)}${agg.minApplied ? ' · ⚠ Top-up Min Garanti' : ''}`;
  let bossPct = minG > 0 ? Math.min(100, (agg.mainFinalCA / minG) * 100) : 0;
  // Inversement logique "PV" remplis par boss : on commence à 0%, on attaque le boss (HP 100%) → l'UI sera progress fill : 0% = boss full HP
  // Ici on veut plus : 100% = boss vaincu. Donc notre % = bossPct tel quel.
  if (bossHpFill) {
    bossHpFill.style.width = `${bossPct}%`;
    // Gradient selon phase
    if (bossPct < 40) bossHpFill.style.background = 'linear-gradient(90deg,#f87171,#fb923c)';
    else if (bossPct < 80) bossHpFill.style.background = 'linear-gradient(90deg,#fb923c,#facc15)';
    else bossHpFill.style.background = 'linear-gradient(90deg,#facc15,#34d399,#a3e635)';
  }
  if (bossSummary) {
    if (hoursNessy < socleMaxH) {
      bossSummary.innerHTML = `🔵 Focus : remplir le Socle 25 h. Il manque <b class="text-indigo-300">${(socleMaxH - hoursNessy).toFixed(2)} h</b> (soit ~${Math.max(0, Math.ceil((socleMaxH - hoursNessy) * 4))} quarts d'heure).`;
    } else if (agg.mainFinalCA < minG) {
      const gap = minG - agg.mainFinalCA;
      bossSummary.innerHTML = `🟣 Objectif Min Garanti <b>${EUR(minG)}</b>. Encore <b class="text-fuchsia-300">${EUR(gap)}</b> de prestations à encoder pour éviter le top-up.`;
    } else if (agg.tiers.t3.h > 0) {
      bossSummary.innerHTML = `🟢 <b>Mission réussie !</b> Tu es en Surplus. Chaque heure supplémentaire = <b class="text-emerald-300">${Math.round(agg.tiers.t3.h > 0 ? (agg.tiers.t3.eur / Math.max(0.01, agg.tiers.t3.h)) : NESSY.regieRate)} € nets</b> en plus.`;
    } else {
      bossSummary.innerHTML = `🟢 <b>Min Garanti validé</b>. Le mois est safe. Continue pour déclencher le Surplus !`;
    }
  }

  // ---- SUCCÈS / ACHIEVEMENTS ----
  function setAchievement(key, unlocked, icon, reward) {
    const row = document.querySelector(`#achievements-list [data-ach="${key}"]`);
    if (!row) return;
    const badge = row.children[3] || row.lastElementChild;
    const iconBox = row.children[0];
    if (unlocked) {
      row.classList.remove('opacity-60','bg-zinc-950/40','border-zinc-800');
      row.classList.add('bg-emerald-500/[0.08]','border-emerald-500/40','shadow-[0_0_30px_-10px_rgba(16,185,129,0.5)]');
      if (iconBox) { iconBox.classList.remove('grayscale'); iconBox.classList.add('bg-emerald-500/15','border-emerald-500/40'); iconBox.textContent = icon || iconBox.textContent; }
      if (badge) { badge.textContent = `✓ ${reward || 'Débloqué'}`; badge.className = 'text-[10px] font-mono text-emerald-300 font-bold'; }
    }
  }
  setAchievement('socle',     hoursNessy >= socleMaxH, '🟦', `Socle 25h`);
  setAchievement('garantie',  hoursNessy >= garantieMaxH, '🟨', `Min Garanti OK`);
  setAchievement('surplus',   t3h > 0, '💎', `+${t3h.toFixed(1)} h surplus`);
  setAchievement('secondary', agg.secondaryEur >= 500, '🚀', `${EUR(agg.secondaryEur)} secondaire`);

  // ---- STATS RAPIDES ----
  if ($('#stat-h-rf')) {
    $('#stat-h-rf').textContent = `${HH(agg.mainRealMinutes)} / ${HH(agg.mainBilledMinutes)}`;
    const pctRounded = agg.mainRealMinutes > 0
      ? (((agg.mainBilledMinutes - agg.mainRealMinutes) / agg.mainRealMinutes) * 100)
      : 0;
    const badgeEl = $('#stat-h-pct');
    if (badgeEl) {
      badgeEl.textContent = pctRounded > 0
        ? `+${pctRounded.toFixed(1)} % arrondi auto`
        : `0 % d'arrondi`;
      badgeEl.className = `text-[10px] font-mono mt-0.5 ${pctRounded >= 5 ? 'text-emerald-400 font-bold' : 'text-zinc-500'}`;
    }
  }
  if ($('#stat-days')) {
    const now = new Date();
    const y = STATE.selectedYear, m = STATE.selectedMonth;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let dayElapsed;
    if (now.getFullYear() === y && now.getMonth() === m) dayElapsed = now.getDate();
    else if (y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth())) dayElapsed = daysInMonth;
    else dayElapsed = 0;
    $('#stat-days').textContent = `${dayElapsed} / ${daysInMonth}j`;
    const pace = dayElapsed > 0 ? hoursNessy / dayElapsed : 0;
    const rythmeEl = $('#stat-days-pace');
    if (rythmeEl) {
      const required = garantieMaxH / daysInMonth;
      const delta = pace - required;
      let color = 'text-zinc-500', arrow = '';
      if (delta > 0.1) { color = 'text-emerald-400 font-bold'; arrow = '▲ en avance '; }
      else if (delta < -0.1) { color = 'text-amber-400 font-bold'; arrow = '▼ en retard '; }
      rythmeEl.className = `text-[10px] font-mono mt-0.5 ${color}`;
      rythmeEl.textContent = `Rythme ${pace.toFixed(2)} h/j · ${arrow}${Math.abs(delta).toFixed(2)} h/j vs ${required.toFixed(2)} h/j requis`;
    }
  }

  // Re-render les icônes lucide car on a modifié innerHTML
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

function renderPocket(agg) {
  $('#pocket-amount').textContent = EUR(agg.netPocket);
  const charges = TOTAL_CHARGES + agg.inasti + agg.ipp + agg.avance;
  $('#pocket-ca').textContent = EUR(agg.globalCA);
  $('#pocket-charges').textContent = `−${EUR(charges)}`;
  const lines = [
    `<div>TVA collectée +${EUR(agg.tvaCollectee, 2)} · Crédit leasing ${EUR(TRESORERIE.creditTVA, 2)}</div>`,
    `<div>INASTI ${EUR(agg.inasti)} · IPP ${EUR(agg.ipp)}${agg.avance ? ` · Avance −${EUR(agg.avance)}` : ''}</div>`,
    `<div>Charges fixes ${EUR(TOTAL_CHARGES)} (Voiture 650 · Logement 625 · Outils 125 · Compta 125)</div>`,
  ];
  $('#pocket-detail').innerHTML = lines.join('');
}

function renderMetrics(agg) {
  $('#m-ca').textContent = EUR(agg.globalCA);
  $('#m-ca-detail').textContent = `Principal ${EUR(agg.mainFinalCA)} · Autres ${EUR(agg.secondaryEur)}`;
  $('#m-tva').textContent = EUR(agg.tvaNette, 2);
  $('#m-tva-detail').textContent = `Collectée ${EUR(agg.tvaCollectee, 2)} · Crédit −${EUR(TRESORERIE.creditTVA, 2)}`;
  $('#m-impots').textContent = EUR(agg.provisions);
  $('#m-impots-detail').textContent = `INASTI ${EUR(agg.inasti)} · IPP ${EUR(agg.ipp)}`;
  $('#m-hours').textContent = `${HH(agg.globalBilledMin)}`;
  $('#m-hours-detail').textContent = `Réel ${HH(agg.globalRealMin)} · Facturé ${HHdecimal(agg.globalBilledMin)} h`;
}

function renderWaterfall(agg) {
  const rows = [
    { label: 'CA HTVA Cumulé (Tous clients)', val: agg.globalCA, type: 'in', icon: 'banknote', sub: `Principal ${EUR(agg.mainFinalCA)} · Autres ${EUR(agg.secondaryEur)}` },
    { label: `TVA Collectée (${Math.round(TRESORERIE.tva * 100)}%)`, val: agg.tvaCollectee, type: 'neutral', icon: 'percent', sub: `Encaissée du client · 21% sur le CA` },
    { label: `TVA Nette à reverser (${EUR(TRESORERIE.creditTVA, 2)} de crédit leasing déduit)`, val: -agg.tvaNette, type: 'out', icon: 'arrow-down-right' },
    { label: `Provision INASTI · ${Math.round(TRESORERIE.inasti * 100)}% CA HTVA`, val: -agg.inasti, type: 'out', icon: 'building-2' },
    { label: `Provision IPP · ${Math.round(TRESORERIE.ipp * 100)}% (CA − INASTI)`, val: -agg.ipp, type: 'out', icon: 'landmark' },
    { label: `Charges Fixes · Structure + Perso (4 postes)`, val: -TOTAL_CHARGES, type: 'out', icon: 'layers', sub: `Leasing 650 · Logement 625 · Outils 125 · Comptable 125` },
  ];
  if (agg.avance > 0) rows.push({ label: `Remboursement Avance Démarrage (Mois ${NESSY.avanceFrom + 1}→${NESSY.avanceTo + 1})`, val: -agg.avance, type: 'out', icon: 'piggy-bank' });
  rows.push({ label: 'RESTE NET DANS LA POCHE', val: agg.netPocket, type: 'net', icon: 'wallet' });

  const html = rows.map((r) => {
    const sign = r.val >= 0 ? '' : '−';
    const abs = Math.abs(r.val);
    const cls = {
      in:  { row: 'bg-indigo-500/5 border border-indigo-500/20', val: 'text-white', icon: 'text-indigo-300 bg-indigo-500/15 border border-indigo-500/30' },
      neutral: { row: 'bg-zinc-900/50 border border-zinc-800', val: 'text-amber-300', icon: 'text-amber-300 bg-amber-500/15 border border-amber-500/30' },
      out: { row: 'bg-rose-500/5 border border-rose-500/20', val: 'text-rose-300', icon: 'text-rose-300 bg-rose-500/15 border border-rose-500/30' },
      net: { row: 'bg-emerald-500/10 border border-emerald-500/30', val: 'glow-gradient-text font-bold', icon: 'text-emerald-300 bg-emerald-500/20 border border-emerald-500/40 shadow-pocket' },
    }[r.type];
    const isNet = r.type === 'net';
    return `<div class="rounded-lg px-3 py-2.5 ${cls.row} flex items-center gap-3 ${isNet ? 'mt-2' : ''}">
      <div class="w-8 h-8 flex-none rounded-lg flex items-center justify-center ${cls.icon}"><i data-lucide="${r.icon}" class="w-4 h-4"></i></div>
      <div class="flex-1 min-w-0">
        <div class="text-sm ${isNet ? 'font-semibold text-emerald-100' : ''}">${r.label}</div>
        ${r.sub ? `<div class="text-[11px] text-zinc-500 mt-0.5">${r.sub}</div>` : ''}
      </div>
      <div class="font-mono font-semibold chip ${cls.val} ${isNet ? 'text-xl' : ''}">${sign}${EUR(abs)}</div>
    </div>`;
  }).join('');
  $('#waterfall').innerHTML = html;
}

function renderClientsList(agg) {
  const mainId = agg.mainClient?.id;
  const entries = Array.from(agg.byClient.entries());
  if (entries.length === 0) {
    $('#clients-list').innerHTML = `<div class="text-xs text-zinc-500 p-4 border border-dashed border-zinc-800 rounded-xl text-center">Aucun encodage ce mois-ci.<br>Créez un client via le bouton <b>"+ Nouveau Client"</b>.</div>`;
    return;
  }
  entries.sort((a, b) => b[1].eur - a[1].eur);
  const totalEur = entries.reduce((s, [, v]) => s + v.eur, 0) || 1;
  const html = entries.map(([cid, v]) => {
    const isMain = cid === mainId;
    const pct = Math.max(6, (v.eur / totalEur) * 100);
    const grad = isMain
      ? 'from-indigo-500/80 via-fuchsia-500/70 to-emerald-400/70'
      : 'from-zinc-500/60 via-zinc-400/60 to-zinc-300/50';
    return `<div class="rounded-xl p-3 border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/60 transition">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-0.5">
            <div class="font-semibold text-sm truncate">${v.client?.name || 'N/A'}</div>
            ${isMain ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase bg-gradient-to-r from-indigo-500/20 to-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-500/30"><i data-lucide="crown" class="w-2.5 h-2.5"></i> Principal</span>` : ''}
          </div>
          <div class="text-[11px] text-zinc-500">${v.count} entrée${v.count > 1 ? 's' : ''} · ${HH(v.realMin)} réel · ${HHdecimal(v.billedMin)} h facturé</div>
        </div>
        <div class="text-right flex-none">
          <div class="font-mono font-bold chip">${EUR(v.eur)}</div>
          ${v.flat > 0 ? `<div class="text-[10px] text-amber-300/80 font-mono mt-0.5">incl. forfait ${EUR(v.flat)}</div>` : ''}
        </div>
      </div>
      <div class="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div class="h-full bg-gradient-to-r ${grad}" style="width:${pct}%;"></div>
      </div>
    </div>`;
  }).join('');
  $('#clients-list').innerHTML = html;
}

// =============================================================
// 📋 LOGS TABLE · INLINE ACTIONS (edit / delete)
// =============================================================
function renderLogs(agg) {
  const tbody = $('#log-tbody');
  const tfoot = $('#log-tfoot');
  const empty = $('#log-empty');
  tbody.innerHTML = ''; tfoot.innerHTML = '';
  $('#log-count').textContent = STATE.logs.length ? `· ${STATE.logs.length} encodage${STATE.logs.length > 1 ? 's' : ''}` : '';
  if (!STATE.logs.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  let mainBilled = 0, mainEur = 0, otherEur = 0, realMin = 0;
  tbody.innerHTML = STATE.logs.map((l) => {
    const rm = l.real_minutes || 0, bm = l.billed_minutes || 0;
    realMin += rm;
    const isFlat = l.custom_price != null && l.custom_price > 0;
    let eur = isFlat ? l.custom_price : (bm / 60) * (l.rate_applied || 0);
    const isMain = l.client_id === agg.mainClient?.id;
    if (isMain) { mainBilled += bm; mainEur += eur; } else otherEur += eur;
    const client = getClient(l.client_id);
    const diff = bm - rm;
    const roundedPct = diff > 0;
    const badge = roundedPct
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-semibold"><i data-lucide="arrow-up" class="w-2.5 h-2.5"></i>+${diff} min arrondi</span>`
      : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-400 border border-zinc-700 text-[10px] font-semibold">sans arrondi</span>`;
    return `<tr data-id="${l.id}" class="hover:bg-zinc-900/40 transition group">
      <td class="px-4 sm:px-5 py-3 whitespace-nowrap text-zinc-300">${fmtDateBE(l.date)}</td>
      <td class="px-4 sm:px-5 py-3 min-w-[160px]">
        <div class="flex items-center gap-2">
          <div class="w-1 h-1.5 rounded-full ${isMain ? 'bg-fuchsia-400' : 'bg-zinc-600'}"></div>
          <span class="text-sm truncate ${isMain ? 'text-zinc-100 font-medium' : 'text-zinc-300'}">${client?.name || 'Client supprimé'}</span>
        </div>
      </td>
      <td class="px-4 sm:px-5 py-3 min-w-[220px] text-sm text-zinc-200"><span class="truncate inline-block max-w-full">${l.description || ''}</span></td>
      <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap">
        <div class="inline-flex flex-col items-end gap-0.5">
          <div class="font-mono chip text-xs text-zinc-400">${HHdecimal(rm)} h · réel</div>
          <div class="font-mono chip text-sm text-white font-semibold">${HHdecimal(bm)} h · fact</div>
          ${badge}
        </div>
      </td>
      <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap text-sm">
        ${isFlat
          ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 font-mono chip">Forfait · ${EUR(eur)}</span>`
          : `<span class="font-mono chip">${EUR(l.rate_applied || 0)}<span class="text-zinc-500 text-xs">/h</span></span>`}
      </td>
      <td class="px-4 sm:px-5 py-3 text-right hidden sm:table-cell whitespace-nowrap font-mono chip font-semibold">${EUR(eur)}</td>
      <td class="px-4 sm:px-5 py-3 text-right w-16">
        <div class="flex items-center justify-end gap-1 opacity-50 group-hover:opacity-100 transition">
          <button data-edit class="p-1.5 hover:bg-indigo-500/20 text-indigo-300 rounded" title="Modifier">
            <i data-lucide="edit-3" class="w-4 h-4"></i>
          </button>
          <button data-del class="p-1.5 hover:bg-red-500/20 text-red-400 rounded" title="Supprimer">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td class="px-4 sm:px-5 py-3" colspan="3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold"><i data-lucide="crown" class="w-3 h-3"></i> Principal · ${HHdecimal(mainBilled)} h · ${EUR(mainEur)}</span>
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/80 text-zinc-300 border border-zinc-700 text-[11px] font-semibold">Autres clients · ${EUR(otherEur)}</span>
      </div>
    </td>
    <td class="px-4 sm:px-5 py-3 text-right whitespace-nowrap">
      <div class="inline-flex flex-col items-end gap-0.5">
        <div class="font-mono chip text-xs text-zinc-400">${HHdecimal(realMin)} h réel</div>
        <div class="font-mono chip text-sm font-bold">${HHdecimal(agg.globalBilledMin)} h fact</div>
      </div>
    </td>
    <td class="px-4 sm:px-5 py-3"></td>
    <td class="px-4 sm:px-5 py-3 text-right hidden sm:table-cell whitespace-nowrap font-mono chip font-bold text-lg">${EUR(agg.globalCA)}</td>
    <td></td>
  </tr>`;

  // Actions
  $$('#log-tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const log = STATE.logs.find((l) => l.id === id);
    if (!log) return;
    tr.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm('Supprimer cet encodage ?')) return;
      try {
        await deleteLog(id);
        toast('Encodage supprimé', 'trash-2', 'warn');
        refreshPeriod();
      } catch { toast('Erreur suppression', 'alert-circle', 'danger'); }
    });
    tr.querySelector('[data-edit]').addEventListener('click', () => openEditLog(log));
  });
}

// =============================================================
// ⚡ SAISIE RAPIDE
// =============================================================
function bindQuickForm() {
  const form = $('#quick-form');
  $('#q-date').value = fmtDateInput(new Date());
  $('#q-min').addEventListener('input', updateQuickRoundInfo);
  $('#q-type').addEventListener('change', syncQuickRateFromType);
  $('#q-client').addEventListener('change', syncQuickRateFromClient);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = new Date($('#q-date').value + 'T12:00:00');
    const client_id = $('#q-client').value;
    const description = $('#q-desc').value.trim();
    const mins = parseInt($('#q-min').value, 10);
    const type = $('#q-type').value;
    const rateVal = parseFloat($('#q-rate').value || '0');
    if (!client_id || !description || !mins || mins <= 0 || isNaN(mins)) {
      toast('Veuillez renseigner Client, Description et Durée', 'alert-circle', 'warn');
      return;
    }
    if (type === 'hourly' && (!rateVal || rateVal <= 0)) {
      toast('Taux horaire invalide', 'alert-circle', 'warn');
      return;
    }
    if (type === 'flat' && (!rateVal || rateVal <= 0)) {
      toast('Prix forfait invalide', 'alert-circle', 'warn');
      return;
    }
    const payload = {
      client_id,
      description,
      real_minutes: mins,
      billed_minutes: billedMinutes(mins),
      rate_applied: type === 'hourly' ? rateVal : 0,
      custom_price: type === 'flat' ? rateVal : null,
      date,
    };
    try {
      await createLog(payload);
      toast('Encodage ajouté', 'check-circle');
      // reset quick form
      $('#q-desc').value = ''; $('#q-min').value = '';
      updateQuickRoundInfo();
      syncQuickRateFromClient();
      refreshPeriod();
    } catch (ex) {
      console.warn(ex);
      toast('Erreur d\'enregistrement · index Firestore requis ?', 'alert-circle', 'danger');
    }
  });
}
function updateQuickRoundInfo() {
  const info = $('#q-round-info');
  const raw = parseInt($('#q-min').value, 10);
  if (!raw || raw <= 0) {
    info.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5 text-zinc-600"></i><span>Saisissez la durée pour voir l'arrondi de facturation.</span>`;
    if (window.lucide) lucide.createIcons();
    return;
  }
  const billed = billedMinutes(raw);
  const diff = billed - raw;
  if (diff > 0) {
    info.innerHTML = `<i data-lucide="arrow-up" class="w-3.5 h-3.5 text-amber-400"></i>
      <span><b class="text-zinc-200">${raw} min</b> réelles <span class="text-zinc-500">➔</span> <b class="text-amber-300">${billed} min (${HHdecimal(billed)} h)</b> facturées <span class="text-amber-400/80">(+${diff} min)</span></span>`;
  } else {
    info.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400"></i>
      <span><b class="text-zinc-200">${raw} min</b> ➔ <b class="text-emerald-300">${billed} min · ${HHdecimal(billed)} h</b> (tranche respectée)</span>`;
  }
  if (window.lucide) lucide.createIcons();
}
function syncQuickRateFromType() {
  const type = $('#q-type').value;
  const unit = $('#q-rate-unit');
  const rateInput = $('#q-rate');
  if (type === 'flat') {
    unit.textContent = '€';
    rateInput.placeholder = '3200';
    rateInput.value = rateInput.value || '';
  } else {
    unit.textContent = '€';
    rateInput.placeholder = '80';
    syncQuickRateFromClient();
  }
}
function syncQuickRateFromClient() {
  const type = $('#q-type').value;
  if (type === 'flat') return; // on garde la valeur
  const cid = $('#q-client').value;
  const c = getClient(cid);
  if (c) $('#q-rate').value = c.default_rate || 0;
}

// =============================================================
// 🗂️ POPULATE CLIENT DROPDOWNS
// =============================================================
function populateClientSelects() {
  const main = getMainClient();
  const list = STATE.clients.slice().sort((a, b) => {
    if (a.is_main_contract && !b.is_main_contract) return -1;
    if (!a.is_main_contract && b.is_main_contract) return 1;
    return a.name.localeCompare(b.name);
  });
  const qSel = $('#q-client');
  qSel.innerHTML = list.map((c) => `<option value="${c.id}">${c.name}${c.is_main_contract ? '  👑' : ''} · ${c.default_rate}€/h</option>`).join('');
  // Si main client existe → présélection
  if (main) qSel.value = main.id;
  syncQuickRateFromClient();

  // Edit modal
  const eSel = $('#e-client');
  eSel.innerHTML = list.map((c) => `<option value="${c.id}">${c.name}${c.is_main_contract ? '  👑' : ''}</option>`).join('');
}

// =============================================================
// 💬 MODALS (Client · Manage · Edit Log)
// =============================================================
function bindModals() {
  // Generic close
  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', (e) => {
    const modal = e.currentTarget.closest('.fixed');
    if (modal) modal.classList.add('hidden');
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.fixed').forEach((m) => m.classList.add('hidden'));
  });
  // New client
  $('#btn-new-client').addEventListener('click', () => openClientModal(null));
  $('#client-form').addEventListener('submit', handleClientFormSubmit);
  // Manage clients
  $('#btn-manage-clients').addEventListener('click', openManageClients);
  // Edit log
  $('#e-min').addEventListener('input', () => {
    const rm = parseInt($('#e-min').value, 10) || 0;
    $('#e-billed').value = billedMinutes(rm);
  });
  $('#edit-form').addEventListener('submit', handleEditLogSubmit);
  // Export CSV
  $('#btn-export').addEventListener('click', exportCSV);
}

function openClientModal(client) {
  STATE.editingClientId = client ? client.id : null;
  const err = $('#client-error'); err.classList.add('hidden');
  $('#client-modal-title').textContent = client ? 'Modifier un Client' : 'Nouveau Client';
  $('#c-name').value = client ? client.name : '';
  $('#c-rate').value = client ? (client.default_rate ?? 80) : 80;
  $('#c-main').checked = client ? !!client.is_main_contract : false;
  $('#client-modal').classList.remove('hidden');
  setTimeout(() => $('#c-name').focus(), 50);
}
async function handleClientFormSubmit(e) {
  e.preventDefault();
  const err = $('#client-error'); err.classList.add('hidden');
  const name = $('#c-name').value.trim();
  const rate = parseFloat($('#c-rate').value || '0');
  const isMain = $('#c-main').checked;
  if (!name) { err.textContent = 'Nom requis'; err.classList.remove('hidden'); return; }
  if (isNaN(rate) || rate < 0) { err.textContent = 'Taux invalide'; err.classList.remove('hidden'); return; }
  try {
    if (STATE.editingClientId) {
      await updateClient(STATE.editingClientId, { name, default_rate: rate, is_main_contract: isMain });
      toast('Client mis à jour', 'check');
    } else {
      await createClient({ name, default_rate: rate, is_main_contract: isMain });
      toast('Client créé', 'check');
    }
    $('#client-modal').classList.add('hidden');
    refreshPeriod();
  } catch (ex) {
    console.warn(ex);
    err.textContent = 'Erreur · vérifiez Firestore rules.';
    err.classList.remove('hidden');
  }
}

function openManageClients() {
  const body = $('#manage-body');
  if (STATE.clients.length === 0) {
    body.innerHTML = `<div class="text-sm text-zinc-500 text-center py-8">Aucun client.</div>`;
  } else {
    body.innerHTML = STATE.clients.map((c) => `
      <div class="rounded-xl p-4 border border-zinc-800 bg-zinc-900/40 flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-1 min-w-0">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-none ${c.is_main_contract ? 'bg-gradient-to-br from-indigo-500/20 via-fuchsia-500/20 to-emerald-500/20 border border-fuchsia-500/30' : 'bg-zinc-800 border border-zinc-700'}">
            ${c.is_main_contract ? '<i data-lucide="crown" class="w-5 h-5 text-fuchsia-300"></i>' : '<i data-lucide="building" class="w-5 h-5 text-zinc-400"></i>'}
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-semibold truncate">${c.name}</div>
            <div class="text-[11px] text-zinc-500 font-mono chip">Taux ${c.default_rate || 0} €/h${c.is_main_contract ? ' · Contrat Principal' : ''}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button data-setmain="${c.id}" ${c.is_main_contract ? 'disabled' : ''} class="px-3 py-1.5 text-xs rounded-md ${c.is_main_contract ? 'bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/30 cursor-default' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'}">
            ${c.is_main_contract ? '👑 Principal' : 'Définir Principal'}
          </button>
          <button data-editc="${c.id}" class="px-3 py-1.5 text-xs rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            <i data-lucide="pencil" class="w-3 h-3 inline mr-1"></i>Modifier
          </button>
          <button data-delc="${c.id}" class="px-3 py-1.5 text-xs rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30">
            <i data-lucide="trash" class="w-3 h-3 inline mr-1"></i>Supprimer
          </button>
        </div>
      </div>
    `).join('');
  }
  $('#manage-modal').classList.remove('hidden');
  lucide.createIcons();
  // events
  $$('#manage-body [data-editc]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-editc');
    const c = STATE.clients.find((x) => x.id === id);
    if (c) openClientModal(c);
  }));
  $$('#manage-body [data-delc]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-delc');
    if (!confirm('Supprimer ce client ? Les encodages liés seront orphelins.')) return;
    try { await deleteClient(id); toast('Client supprimé', 'trash', 'warn'); refreshPeriod(); }
    catch { /* handled toast */ }
  }));
  $$('#manage-body [data-setmain]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-setmain');
    const c = STATE.clients.find((x) => x.id === id);
    if (!c || c.is_main_contract) return;
    try { await updateClient(id, { is_main_contract: true }); toast(c.name + ' · Contrat principal', 'crown'); refreshPeriod(); }
    catch { toast('Erreur mise à jour', 'alert-circle', 'danger'); }
  }));
}

// =============================================================
// ✏️ EDIT LOG MODAL
// =============================================================
function openEditLog(log) {
  $('#e-id').value = log.id;
  $('#e-date').value = fmtDateInput(log.date);
  $('#e-client').value = log.client_id;
  $('#e-desc').value = log.description || '';
  $('#e-min').value = log.real_minutes || 0;
  $('#e-billed').value = log.billed_minutes || billedMinutes(log.real_minutes || 0);
  const isFlat = log.custom_price != null && log.custom_price > 0;
  $('#e-type').value = isFlat ? 'flat' : 'hourly';
  $('#e-rate').value = isFlat ? log.custom_price : (log.rate_applied || 0);
  $('#edit-error').classList.add('hidden');
  $('#edit-modal').classList.remove('hidden');
  lucide.createIcons();
}
async function handleEditLogSubmit(e) {
  e.preventDefault();
  const id = $('#e-id').value;
  const date = new Date($('#e-date').value + 'T12:00:00');
  const client_id = $('#e-client').value;
  const description = $('#e-desc').value.trim();
  const rm = parseInt($('#e-min').value, 10);
  const bm = billedMinutes(rm);
  const type = $('#e-type').value;
  const rateVal = parseFloat($('#e-rate').value || '0');
  const err = $('#edit-error'); err.classList.add('hidden');
  if (!rm || rm <= 0 || !client_id || !description) { err.textContent = 'Champs invalides'; err.classList.remove('hidden'); return; }
  if (type === 'hourly' && (!rateVal || rateVal <= 0)) { err.textContent = 'Taux horaire invalide'; err.classList.remove('hidden'); return; }
  if (type === 'flat' && (!rateVal || rateVal <= 0)) { err.textContent = 'Prix forfait invalide'; err.classList.remove('hidden'); return; }
  const patch = {
    date, client_id, description,
    real_minutes: rm, billed_minutes: bm,
    rate_applied: type === 'hourly' ? rateVal : 0,
    custom_price: type === 'flat' ? rateVal : null,
  };
  try {
    await updateLog(id, patch);
    toast('Encodage mis à jour', 'check');
    $('#edit-modal').classList.add('hidden');
    refreshPeriod();
  } catch { toast('Erreur mise à jour', 'alert-circle', 'danger'); }
}

// =============================================================
// 📤 EXPORT CSV
// =============================================================
function exportCSV() {
  const agg = aggregateMonth();
  const months = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const headers = ['Date', 'Client', 'Description', 'Min Réelles', 'Min Facturées', 'Durée (h)', 'Type', 'Tarif appliqué (€/h ou forfait)', '€ HTVA'];
  const rows = [headers];
  for (const l of STATE.logs) {
    const client = getClient(l.client_id);
    const isFlat = l.custom_price != null && l.custom_price > 0;
    const eur = isFlat ? l.custom_price : ((l.billed_minutes || 0) / 60) * (l.rate_applied || 0);
    rows.push([
      fmtDateBE(l.date),
      client?.name || 'Client supprimé',
      (l.description || '').replace(/"/g, '""'),
      String(l.real_minutes || 0),
      String(l.billed_minutes || 0),
      HHdecimal(l.billed_minutes || 0),
      isFlat ? 'Forfait' : 'Horaire',
      String(isFlat ? l.custom_price : (l.rate_applied || 0)),
      eur.toFixed(2),
    ]);
  }
  rows.push([]);
  rows.push(['TOTAL MOIS · ' + months[STATE.selectedMonth] + ' ' + STATE.selectedYear]);
  rows.push(['Heures réelles', '', '', agg.globalRealMin, agg.globalBilledMin, HHdecimal(agg.globalBilledMin), '', '', '']);
  rows.push(['', '', '', '', '', '', '', 'CA HTVA Facturé (brut)', agg.globalRawEur.toFixed(2)]);
  rows.push(['', '', '', '', '', '', '', 'Min Garanti Principal appliqué', agg.minApplied ? 'OUI · ' + EUR(agg.minG) : 'NON']);
  rows.push(['', '', '', '', '', '', '', 'CA HTVA FINAL (Tous clients)', agg.globalCA.toFixed(2)]);
  rows.push(['', '', '', '', '', '', '', 'Reste NET Pocket', Math.round(agg.netPocket).toFixed(2)]);

  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[,";\n]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const mm = String(STATE.selectedMonth + 1).padStart(2, '0');
  a.download = `kopek_releve_${STATE.selectedYear}-${mm}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('CSV téléchargé', 'download');
}

// =============================================================
// LUCIDE INIT INITIAL (login screen)
// =============================================================
if (window.lucide) lucide.createIcons();
