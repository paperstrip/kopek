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
  // =========================================================================
  // 🔑 RÈGLE MÉTIER (nouvelle logique utilisateur) :
  //   SOCLE 2 000 € (25 h) + MIN GARANTI 3 500 € (43,75 h) = ACQUIS PROMIS
  //   sur contrat, DÈS LE PREMIER JOUR DU MOIS, SANS ENCODAGE.
  //
  //   Les heures encodées servent DEUX CHOSES :
  //   1. REMBOURSER l'heure acquise (crédit d'heures dûes au client Nessy)
  //      → de 0 h → 43,75 h : comble la dette horaire contractuelle
  //   2. AU-DELÀ : générer du SURPLUS BONUS (facturé en plus du Min Garanti)
  //      → > 43,75 h = @ Taux horaire Nessy → ajouté DESSUS du Min Garanti
  //
  //   mainFinalCA = Max(Min Garanti, revenu réel) PAR CONSTRUCTION :
  //   → on prend donc Le Min Garanti si pas assez travaillé (top-up acquis)
  //   → on prend le réel si on dépasse le Min Garanti grâce au surplus.
  // =========================================================================
  const hoursHourlyNessy = mainBilledMin / 60;
  // ---- Heures remboursement (dette 0 → 43,75 h) ----
  const heuresDette = NESSY.minHoursEq;
  const refundedH = Math.min(hoursHourlyNessy, heuresDette);            // 0 → 43,75
  const debtRemainH = Math.max(0, heuresDette - hoursHourlyNessy);     // ce qu'il reste à faire pour le client
  const t3h = Math.max(hoursHourlyNessy - heuresDette, 0);             // SURPLUS BONUS au-dessus du Min Garanti

  // Pour les cartes paliers 1/2/3 : on affiche le % D'ACQUITTEMENT DE LA DETTE
  // (pas le % d'acquisition car l'argent est déjà acquis)
  const socleHours = NESSY.socleHours;
  const t1h = Math.min(refundedH, socleHours);                                         // Remboursement Socle
  const t2h = Math.min(Math.max(refundedH - socleHours, 0), heuresDette - socleHours); // Remboursement Régie Garantie

  // CA NESSY = MIN GARANTI (acquis) + SURPLUS RÉEL HORAIRE + FORFAITS
  const minG = getMinGaranti(monthIdx);
  // Revenu hourly réel NESSY pour heures > minHoursEq (surplus) + forfaits
  const hourlySurplusEur = Math.max(0, mainHourlyRealEur - (heuresDette * NESSY.regieRate));
  const mainFlatEur = mainFlatLogs.reduce((a, l) => a + (l.custom_price || 0), 0);
  const bonusEur = hourlySurplusEur + mainFlatEur;

  // t1eur/t2eur = Ce qui a été "comptabilisé" comme Heures REMBOURSÉES (pas euros facturés — c'est déjà dans MinG)
  const t1eur = t1h * NESSY.regieRate;              // 0 → 2000
  const t2eur = t2h * NESSY.regieRate;              // 0 → 1500
  const t3eur = hourlySurplusEur;

  const mainRevenusAvantMin = (refundedH * NESSY.regieRate) + bonusEur;
  // Si on a ne serait-ce qu'1 log Nessy → on active le contrat pour le mois → Min Garanti
  const hasAnyNessy = (mainHourlyLogs.length + mainFlatLogs.length) > 0;
  const mainFinalCA = hasAnyNessy
    ? Math.max(minG, mainRevenusAvantMin)
    : 0;
  const minApplied = hasAnyNessy && mainRevenusAvantMin < minG;

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

  // Pour jauge · base = heures DETTE (43,75 h). On clamp 0→120%
  //   0%   = 0h encodées (dette ENTIÈRE)
  //   100% = 43,75h remboursées (dette soldée)
  //   > 100% = surplus bonus
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
    bonusEur,                      // = surplus facturable en euros
    refundedH,                     // heures de dette remboursées
    debtRemainH,                   // il reste X heures avant de déclencher le bonus
    hasAnyNessy,                   // contrat activé pour le mois ?
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
  renderCity(agg);
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

  // ------------------------------------------------------------------
  // HEADER NESSY (à gauche du Hero)
  //   Titre "CONTRAT PRINCIPAL · NESSY"
  //   Sous-titre : on MET EN ÉVIDENCE l'ACQUIS CONTRACTUEL
  //   + le surplus en bonus en plus
  // ------------------------------------------------------------------
  const acquisShow = EUR(agg.hasAnyNessy ? agg.minG : 0);
  const bonusShow  = EUR(agg.bonusEur || 0);
  const hh = HHdecimal(hoursNessy * 60);           // heures decimal pour affichage
  $('#nessy-sub').innerHTML = (agg.hasAnyNessy)
    ? `<b>Acquis <span class="chip text-amber-300 font-bold">${acquisShow}</span> garanti</b> · ` +
      `Réalisé <span class="chip text-white font-bold">${hh} h / ${garantieH.toFixed(2)} h</span> · ` +
      `<span class="text-emerald-300 font-bold">+ ${bonusShow} bonus</span>`
    : `Aucun encodage Nessy ce mois · Acquis contractuel non activé — Encode tes premières heures pour activer <b class="text-amber-300">${EUR(agg.minG)}</b> de Min Garanti.`;

  // Cards tiers (3 sous-cartes sous la jauge)
  // Puisque l'argent est acquis : montrer REMBOURSEMENT (pas € gagnés)
  $('#tier1-h').textContent   = `${agg.tiers.t1.h.toFixed(2)} h / ${socleH.toFixed(2)} h`;
  $('#tier1-eur').textContent = `~ ${EUR(agg.tiers.t1.eur)} remboursés`;
  $('#tier2-h').textContent   = `${agg.tiers.t2.h.toFixed(2)} h / ${(garantieH - socleH).toFixed(2)} h`;
  $('#tier2-eur').textContent = `~ ${EUR(agg.tiers.t2.eur)} remboursés @ ${NESSY.regieRate} €/h`;
  $('#tier3-h').textContent   = `+ ${agg.tiers.t3.h.toFixed(2)} h`;
  $('#tier3-eur').textContent = `+ ${EUR(agg.tiers.t3.eur + agg.mainFlatEur)} bonus`;

  // ---- STATUS BAND : remplacements ACQUIS vs RÉALISÉ vs BONUS ----
  const st = $('#gauge-status');
  const refunded = agg.refundedH || 0;
  const debt = agg.debtRemainH || 0;

  // Cas 0 · Rien d'encodé (hasAnyNessy false → pas top-up)
  if (!agg.hasAnyNessy) {
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-amber-500/30 bg-amber-500/[0.06]';
    st.innerHTML = `<i data-lucide="scale" class="w-5 h-5 text-amber-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-1.5">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ Acquis Contractuel</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-700 text-zinc-300 text-[11px] font-mono">💶 Min Garanti · ${EUR(agg.minG)}</span>
        </div>
        <strong class="text-zinc-100 block">0 h encodées Nessy · L'acquis <b class="text-amber-300">${EUR(agg.minG)}</b> est PROMIS par contrat, mais <b>pas encore activé</b> sur le mois.</strong>
        <div class="mt-3 grid grid-cols-3 gap-3 text-xs font-mono">
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-indigo-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Socle 2 000 €</div>
            <b class="block mt-1 text-zinc-100">—</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">0 / ${socleH.toFixed(2)} h · dette</div>
          </div>
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-fuchsia-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Régie Garantie</div>
            <b class="block mt-1 text-zinc-100">—</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">0 / ${(garantieH - socleH).toFixed(2)} h · dette</div>
          </div>
          <div class="rounded-lg p-2 bg-zinc-900/70 border border-zinc-800 text-emerald-300/90">
            <div class="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Bonus Surplus</div>
            <b class="block mt-1 text-zinc-100">0,00 €</b>
            <div class="text-[10px] text-zinc-500 mt-0.5">seulement après ${garantieH.toFixed(2)} h</div>
          </div>
        </div>
        <div class="mt-3 text-[12px] text-zinc-400">
          Sélectionnez <b>${agg.mainClient?.name || 'NESSY'}</b> dans la saisie rapide ci-dessus, puis encodez vos heures · Le top-up Min Garanti s'appliquera en fin de mois si nécessaire.
        </div>
      </div>`;
  }

  // Cas 1 · Dans le SOCLE (0 → 25h)
  else if (refunded < socleH) {
    const pctSocle = Math.min(100, (refunded / socleH) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-indigo-500/40 bg-indigo-500/[0.07]';
    st.innerHTML = `<i data-lucide="move-up-right" class="w-5 h-5 text-indigo-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ ACQUIS ${EUR(agg.minG)} GARANTI</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE EN COURS</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-[11px] font-mono">✨ BONUS <b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-indigo-100">Heures de dette · <span class="chip">${refunded.toFixed(2)} h / ${socleH.toFixed(2)} h</span> sur le Socle (25 h)</strong>
        <div class="mt-2 h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:${pctSocle}%"></div></div>
        <div class="flex justify-between text-[11px] font-mono mt-1.5 text-indigo-300/80">
          <span>Remboursement Socle · ${pctSocle.toFixed(0)}%</span>
          <span>Il manque <b>${debt.toFixed(2)} h</b> avant déclenchement du surplus</span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          Le contrat Nessy est activé · Tu gagnes <b class="text-amber-300">déjà ${EUR(agg.minG)}</b> d'office. Encode encore <b class="text-indigo-300">${(socleH - refunded).toFixed(2)} h</b> pour solder le socle.
        </div>
      </div>`;
  }

  // Cas 2 · Dans la RÉGIE GARANTIE (25h → 43,75h)
  else if (refunded < garantieH) {
    const regieH = refunded - socleH;
    const regieMax = garantieH - socleH; // 18,75 h
    const pctRegie = Math.min(100, (regieH / regieMax) * 100);
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-fuchsia-500/40 bg-fuchsia-500/[0.07]';
    st.innerHTML = `<i data-lucide="shield-check" class="w-5 h-5 text-fuchsia-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">⚜️ ACQUIS ${EUR(agg.minG)} GARANTI</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-fuchsia-500/20 border border-fuchsia-400/50 text-fuchsia-200 text-[11px] font-semibold tracking-wider uppercase">🛡️ RÉGIE ${pctRegie.toFixed(0)}%</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-400/40 text-emerald-200 text-[11px] font-mono">✨ BONUS <b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-fuchsia-100">Dette Régie Garantie · <span class="chip">${regieH.toFixed(2)} h / ${regieMax.toFixed(2)} h</span> · il reste <b>${debt.toFixed(2)} h</b></strong>
        <div class="mt-2 grid grid-cols-2 gap-3">
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-fuchsia-500 to-fuchsia-300 rounded-full" style="width:${pctRegie}%"></div></div>
        </div>
        <div class="flex justify-between text-[11px] font-mono mt-1.5 text-zinc-400">
          <span class="text-indigo-300/80">Socle 100% · 25 h · dette remboursée</span>
          <span class="text-fuchsia-300/80">Régie Garantie · manque <b>${(garantieH - refunded).toFixed(2)} h</b></span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          <b class="text-amber-300">${EUR(agg.minG)}</b> d'office · Dès que tu atteindras <b class="text-fuchsia-300">${garantieH.toFixed(2)} h</b>, tu passeras en <b class="text-emerald-300">Surplus Bonus</b>.
        </div>
      </div>`;
  }

  // Cas 3 · SURPLUS (≥ 43,75h)  — 🏆 ENGAGEMENT VALIDÉ
  else {
    const surplusH = agg.tiers.t3.h;
    st.className = 'mt-6 rounded-xl p-4 flex items-start gap-3.5 border border-emerald-500/50 bg-emerald-500/[0.08] shadow-[0_30px_80px_-40px_rgba(16,185,129,0.55)]';
    st.innerHTML = `<i data-lucide="trophy" class="w-5 h-5 text-amber-300 flex-none mt-0.5"></i>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/20 border border-amber-400/50 text-amber-200 text-[11px] font-semibold tracking-wider uppercase">🏆 ENGAGEMENT VALIDÉ</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-200 text-[11px] font-semibold tracking-wider uppercase">🧱 SOCLE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-fuchsia-500/20 border border-fuchsia-400/50 text-fuchsia-200 text-[11px] font-semibold tracking-wider uppercase">🛡️ GARANTIE ✓</span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 text-[11px] font-mono">✨ BONUS +<b class="ml-1">${EUR(agg.bonusEur || 0)}</b></span>
        </div>
        <strong class="text-emerald-100">Tu as remboursé toutes tes heures · <span class="chip">+${surplusH.toFixed(2)} h</span> en bonus facturable en <b class="text-amber-300">plus de ${EUR(agg.minG)}</b></strong>
        <div class="mt-2 grid grid-cols-3 gap-3">
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-indigo-500 to-indigo-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-fuchsia-500 to-fuchsia-300 rounded-full" style="width:100%"></div></div>
          <div class="h-2 rounded-full bg-zinc-900/60 overflow-hidden"><div class="h-full bg-gradient-to-r from-emerald-400 via-lime-400 to-amber-300 rounded-full" style="width:${Math.min(100,(surplusH/8.75)*100)}%"></div></div>
        </div>
        <div class="flex justify-between text-[11px] font-mono mt-1.5 text-zinc-400">
          <span class="text-indigo-300/80">Socle 25 h · ${EUR(NESSY.socleFlat)}</span>
          <span class="text-fuchsia-300/80">Régie 18,75 h · ${EUR(1500)}</span>
          <span class="text-emerald-300/80">Surplus · +${surplusH.toFixed(2)} h × ${NESSY.regieRate} €</span>
        </div>
        <div class="text-zinc-400 text-[12px] mt-2">
          CA principal · <b class="text-white">${EUR(agg.mainFinalCA)}</b> dont acquis <b class="text-amber-300">${EUR(agg.minG)}</b> + bonus <b class="text-emerald-300">${EUR(agg.bonusEur || 0)}</b> · Chaque heure en plus = c'est <b class="text-emerald-300">directement dans la poche</b>.
        </div>
      </div>`;
  }
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

// =================================================================
// 🎮 GAMIFIED · MINE KOPEK 3D + SCOREBOARD
// =================================================================
function renderCity(agg) {
  // ==========================================================================
  // KOPEK CITY · VRAI RENDU "CITY BUILDER" 2,5D
  //  - lecture visuelle façon SimCity / jeu de gestion
  //  - districts organisés sur un plateau isométrique
  //  - routes diagonales, lots, carrefour, place centrale, canal
  //  - bâtiments plus "volumiques" avec faces gauche/droite/toit
  // ==========================================================================
  const root = document.getElementById('city-buildings');
  if (!root) return;

  const socleH = NESSY.socleHours;
  const fullH = NESSY.minHoursEq;
  const refunded = agg.refundedH || 0;
  const bonusH = agg.tiers?.t3?.h || 0;
  const soclePct = Math.min(100, (refunded / socleH) * 100);
  const garantiPct = refunded >= socleH
    ? Math.min(100, ((refunded - socleH) / (fullH - socleH)) * 100)
    : 0;
  const bonusPct = Math.min(150, (bonusH / 12) * 100);

  const factory = document.getElementById('k-factory');
  if (factory) {
    if (agg.mainHoursHourly > 0.01) factory.classList.add('lit');
    else factory.classList.remove('lit');
  }

  const districtLots = {
    socle: [
      { x: 6, y: 29, type: 'villa' },
      { x: 15, y: 34, type: 'shop' },
      { x: 24, y: 29, type: 'villa' },
      { x: 10, y: 19, type: 'villa' },
      { x: 20, y: 23, type: 'shop' },
      { x: 28, y: 18, type: 'villa' },
    ],
    garantie: [
      { x: 34, y: 37, type: 'shop' },
      { x: 44, y: 42, type: 'midrise' },
      { x: 55, y: 37, type: 'midrise' },
      { x: 38, y: 24, type: 'shop' },
      { x: 49, y: 28, type: 'midrise' },
      { x: 60, y: 23, type: 'midrise' },
    ],
    bonus: [
      { x: 67, y: 39, type: 'tower' },
      { x: 79, y: 44, type: 'spire' },
      { x: 90, y: 39, type: 'tower' },
      { x: 73, y: 24, type: 'tower' },
      { x: 85, y: 21, type: 'spire' },
    ],
  };

  function completionState(list, pct, index) {
    const progress = (pct / 100) * list.length;
    const completed = Math.floor(progress);
    const hasActive = progress > 0 && completed < list.length;
    return {
      built: index < completed,
      active: hasActive && index === completed,
      empty: index > completed || (completed === 0 && progress === 0),
    };
  }

  function buildingMarkup(type, state, idx) {
    if (state.empty) return '';
    const cls = [
      'k-iso',
      type,
      state.built ? 'lit' : '',
      state.active ? 'construction' : '',
      idx % 2 === 0 ? 'k-twinkle' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${cls}">
      <div class="top"></div>
      <div class="left"></div>
      <div class="right"></div>
      <div class="front"></div>
      ${state.active ? '<div class="k-crane"><div class="hook"></div></div>' : ''}
    </div>`;
  }

  function lotCluster(zone, pct, list) {
    return list.map((lot, index) => {
      const state = completionState(list, pct, index);
      return `<div class="k-lot ${zone}" style="left:${lot.x}%; bottom:${lot.y}%;">
        ${buildingMarkup(lot.type, state, index)}
      </div>`;
    }).join('');
  }

  const treePositions = [
    [31, 19], [35, 14], [63, 18], [67, 13], [95, 19], [92, 13], [58, 47], [26, 42],
  ];
  const trees = treePositions.map(([x, y]) =>
    `<div class="k-stage-tree" style="left:${x}%; bottom:${y}%"></div>`
  ).join('');

  const crowdPositions = [
    [47, 29, '#f472b6'], [49, 31, '#60a5fa'], [51, 27, '#34d399'], [53, 29, '#facc15'],
    [41, 24, '#f59e0b'], [57, 24, '#a78bfa'], [46, 21, '#fb7185'], [54, 21, '#22c55e'],
  ];
  const crowds = crowdPositions.map(([x, y, color], idx) =>
    `<div class="k-crowd-dot" style="left:${x}%; bottom:${y}%; background:${color}; animation: sky-pulse-y ${2.2 + (idx % 3) * 0.4}s ease-in-out infinite; animation-delay:-${idx * 0.25}s;"></div>`
  ).join('');

  const vans = `
    <div class="k-van" style="left:4%; bottom:15%; --v1:#60a5fa; --v2:#1d4ed8; animation:diagDriveA 11s linear infinite;"></div>
    <div class="k-van" style="left:82%; bottom:33%; --v1:#34d399; --v2:#047857; animation:diagDriveB 13s linear infinite -4s;"></div>
    <div class="k-van" style="left:12%; bottom:15%; --v1:#f59e0b; --v2:#b45309; animation:diagDriveA 15s linear infinite -7s;"></div>
  `;

  root.innerHTML = `
    <div class="k-stage">
      <div class="k-district-band"></div>
      <div class="k-canal"></div>
      <div class="k-rail"></div>
      <div class="k-avenue a1"></div>
      <div class="k-avenue a2"></div>
      <div class="k-cross"></div>
      <div class="k-plaza"></div>
      <div class="k-district-tag socle" style="left:8%; bottom:57%;">District Socle</div>
      <div class="k-district-tag garantie" style="left:41%; bottom:61%;">District Garantie</div>
      <div class="k-district-tag bonus" style="left:73%; bottom:58%;">District Bonus</div>
      ${lotCluster('socle', soclePct, districtLots.socle)}
      ${lotCluster('garantie', garantiPct, districtLots.garantie)}
      ${lotCluster('bonus', bonusPct, districtLots.bonus)}
      ${trees}
      ${crowds}
      ${vans}
    </div>
  `;

  // ---------------------------------------------------------------------------
  // HUD · City Board (infobulle en bas à droite)
  // ---------------------------------------------------------------------------
  const pctForBar = Math.min(120,
    (refunded / fullH) * 100 + Math.min(30, (bonusH / 24) * 30)
  );
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('hud-socle',  `${soclePct.toFixed(0)} %`);
  setText('hud-garanti', `${garantiPct.toFixed(0)} %`);
  setText('hud-bonus',  `+${bonusH.toFixed(1).replace('.',',')} h`);
  const population = Math.round(150 + refunded * 28 + bonusH * 60 + agg.secondaryEur / 8);
  setText('hud-pop',    population.toLocaleString('fr-BE') + ' hab.');
  setText('hud-acquis', EUR(agg.hasAnyNessy ? agg.minG : 0));
  setText('hud-ca-bonus', EUR(agg.bonusEur || 0));
  const bar = document.getElementById('hud-bar');
  if (bar) bar.style.width = `${pctForBar}%`;
  const label = document.getElementById('hud-label');
  if (label) {
    if (!agg.hasAnyNessy) label.textContent = 'Contrat principal non activé sur la période';
    else if (refunded < fullH) label.textContent = `Engagement ${refunded.toFixed(2).replace('.', ',')} / ${fullH.toFixed(2).replace('.', ',')} h · reste ${agg.debtRemainH.toFixed(2).replace('.', ',')} h`;
    else label.textContent = `Engagement validé · Bonus ${EUR(agg.bonusEur || 0)} · Surplus ${bonusH.toFixed(1).replace('.', ',')} h`;
  }

  // ---------------------------------------------------------------------------
  // POP-UP BULLE (info-bulle flottante comme Pixar)
  // ---------------------------------------------------------------------------
  const pop = document.getElementById('city-pop');
  if (pop) {
    pop.classList.remove('hidden');
    let popHtml = '';
    if (!agg.hasAnyNessy) {
      popHtml = `<span class="text-white font-bold">Contrat en attente</span><br><span class="text-zinc-400">Premier encodage nécessaire pour lancer la ville et activer ${EUR(agg.minG)}.</span>`;
      pop.classList.remove('gain','loss');
    } else if (refunded < socleH) {
      popHtml = `<span class="text-white font-bold">Chantier Socle</span><br><span class="text-zinc-400">${soclePct.toFixed(0)}% du district livré · reste <b>${(socleH - refunded).toFixed(2).replace('.', ',')} h</b>.</span>`;
      pop.classList.remove('gain','loss');
    } else if (refunded < fullH) {
      popHtml = `<span class="text-white font-bold">Garantie en construction</span><br><span class="text-zinc-400">${garantiPct.toFixed(0)}% du centre-ville livré · encore <b>${agg.debtRemainH.toFixed(2).replace('.', ',')} h</b>.</span>`;
      pop.classList.remove('gain','loss');
    } else if (agg.bonusEur > 50) {
      popHtml = `<span class="text-emerald-300 font-bold">District Bonus lancé</span><br><span class="text-zinc-300">${bonusH.toFixed(1).replace('.', ',')} h en surplus · <b>+${EUR(agg.bonusEur)}</b> facturables.</span>`;
      pop.classList.add('gain'); pop.classList.remove('loss');
    } else {
      popHtml = `<span class="text-emerald-300 font-bold">Ville stabilisée</span><br><span class="text-zinc-300">Engagement contractuel couvert · continue pour ouvrir le quartier bonus.</span>`;
      pop.classList.add('gain'); pop.classList.remove('loss');
    }
    pop.innerHTML = popHtml;
  }

  // ---------------------------------------------------------------------------
  // VÉHICULE SUPPLÉMENTAIRE (camion-citerne d'or) qui apparaît quand BONUS > 0
  // ---------------------------------------------------------------------------
  let truckEl = document.getElementById('bonus-truck');
  if (bonusH > 0.1) {
    if (!truckEl) {
      const section = document.getElementById('kopek-city');
      if (section) {
        truckEl = document.createElement('div');
        truckEl.id = 'bonus-truck';
        truckEl.className = 'k-car';
        truckEl.style.cssText = `bottom: calc(22% + 52px);
          --c1: linear-gradient(180deg,#facc15,#ca8a04); --c2: linear-gradient(180deg,#a16207,#713f12);
          animation: k-car-right 11s linear infinite;
          transform: scale(1.15);
          filter: drop-shadow(0 6px 8px rgba(234,179,8,0.45));`;
        truckEl.innerHTML = `<div class="cb" style="width: 92px; background: linear-gradient(180deg, #fde047 0%, #ca8a04 100%);
          box-shadow: inset 0 -6px 0 rgba(0,0,0,0.2), inset 0 8px 0 rgba(255,255,255,0.28), 0 0 24px rgba(250,204,21,0.35);">
          <div style="position:absolute; inset: 25% 8% 12% 38%;
            background: repeating-linear-gradient(45deg,#0ea5e9 0 6px,#082f49 6px 12px);
            border-radius: 8px; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.2);"></div>
          </div><div class="cw"></div>`;
        section.appendChild(truckEl);
      }
    }
  } else if (truckEl) {
    truckEl.remove();
  }

  // ---------------------------------------------------------------------------
  // HÉLICOPTÈRE BONUS qui survole quand bonus > 2h
  // ---------------------------------------------------------------------------
  let heliEl = document.getElementById('bonus-heli');
  if (bonusH > 2) {
    if (!heliEl) {
      const sky = document.querySelector('.k-sky-wrap');
      if (sky) {
        heliEl = document.createElement('div');
        heliEl.id = 'bonus-heli';
        heliEl.style.cssText = `position:absolute; top:15%; left:-10%;
          font-size: 40px; filter: drop-shadow(0 8px 10px rgba(15,23,42,0.35));
          animation: sky-drift-x 22s linear infinite reverse; animation-delay:-4s;`;
        heliEl.textContent = '🚁';
        sky.appendChild(heliEl);
      }
    }
  } else if (heliEl) {
    heliEl.remove();
  }

  // ---------------------------------------------------------------------------
  // PETIT EFFET FUMÉE RÉGULIER (si on encode du temps cette heure-ci)
  // ---------------------------------------------------------------------------
  maybePuffSmoke(agg.mainHoursHourly > 0.01);

  // Re-render icônes lucide (le HUD City Board en utilise)
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}

// Déclencher un (ou 2) puits de fumée si usine allumée (pas d'accumulation)
let puffCooldown = 0;
function maybePuffSmoke(shouldRun) {
  if (!shouldRun) return;
  const smoke = document.getElementById('k-smoke');
  if (!smoke) return;
  if (puffCooldown > 0) return;
  smoke.style.animation = 'none';
  // reflow
  void smoke.offsetWidth;
  smoke.style.animation = `puf ${(2.6 + Math.random() * 0.8).toFixed(2)}s ease-out forwards`;
  puffCooldown = 1;
  setTimeout(() => { puffCooldown = 0; }, 2400);
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
      // Petit effet bonus : usine en ébullition + bonus confetti si la somme nous fait passer en bonus
      maybePuffSmoke(true);
      setTimeout(maybePuffSmoke, 800, true);
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
