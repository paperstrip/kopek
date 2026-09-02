import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
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
  limit,
  startAt,
  endAt,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// =============================================================
// 🔧 CONFIGURATION FIREBASE · Projet kopek-4ffe6
// =============================================================
const firebaseConfig = {
  apiKey:            'AIzaSyAtvekD4jUt75sAyKvJFPeHDxPHTyaEUUQ',
  authDomain:        'kopek-4ffe6.firebaseapp.com',
  projectId:         'kopek-4ffe6',
  storageBucket:     'kopek-4ffe6.firebasestorage.app',
  messagingSenderId: '474763017409',
  appId:             '1:474763017409:web:fdd11e36b76987ce512840',
};

// =============================================================
// INITIALISATION
// =============================================================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Persistance de session · localStorage · reste connecté entre visites
setPersistence(auth, browserLocalPersistence).catch((e) => console.warn('setPersistence', e));

// =============================================================
// EXPORTS (disponibles dans app.js via import)
// =============================================================
export {
  app,
  auth,
  db,
  // Auth
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  // Firestore helpers
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
  limit,
  startAt,
  endAt,
};
