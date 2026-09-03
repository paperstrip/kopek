# kopek · Cockpit financier & time-tracking

Application statique (HTML + JS vanilla + Firebase) hébergée sur GitHub Pages.
Aucune étape de build n'est nécessaire pour la faire tourner : `index.html` peut
être servi tel quel.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (login + tableau de bord bento) |
| `app.js` | Logique métier : paliers Nessy, cascade de trésorerie, CRUD Firestore, saisie rapide |
| `city3d.js` | Ville 3D low-poly (Three.js) pilotée par la jauge |
| `firebase-config.js` | Initialisation Firebase Auth + Firestore |
| `styles.css` | **Généré** — feuille Tailwind compilée (voir ci-dessous) |
| `vendor/three/` | Three.js + OrbitControls vendorés (pas de CDN) |
| `.nojekyll` | Empêche GitHub Pages de filtrer des dossiers comme `vendor/` |

## Régénérer `styles.css`

`styles.css` est compilé depuis les classes réellement utilisées dans
`index.html` et `app.js`. **Après avoir ajouté de nouvelles classes Tailwind,
il faut le régénérer**, sinon elles n'auront aucun effet :

```bash
npm install -D tailwindcss@3.4.17
npx tailwindcss -i tailwind-input.css -o styles.css --minify
```

Le projet utilise volontairement une feuille compilée plutôt que
`cdn.tailwindcss.com` : ce CDN est un outil de développement qui recompile tout
le CSS dans le navigateur à chaque chargement.

## Structure des données Firestore

Deux collections, filtrées par `userId` :

- **`clients`** — en réalité des *projets* : `{ name, default_rate, is_external }`.
  Les heures de tous les projets alimentent la même jauge Nessy. Un projet
  marqué `is_external: true` représente un vrai client indépendant : son chiffre
  d'affaires s'ajoute au total mais ne compte pas dans les paliers.
- **`time_logs`** — `{ client_id, description, real_minutes, billed_minutes,
  rate_applied, custom_price, date }`.

⚠️ Les requêtes n'utilisent **qu'un seul filtre d'égalité** (`userId ==`) et
aucun `orderBy` Firestore : le tri et le filtrage par mois se font en JavaScript.
C'est délibéré — toute requête combinant plusieurs champs exigerait un index
composite créé à la main dans la console Firebase, faute de quoi elle échoue
silencieusement.

## Règles Firestore attendues

L'utilisateur connecté doit pouvoir lire/écrire ses propres documents :

```
match /{col}/{doc} {
  allow read, write: if request.auth != null
                     && request.resource.data.userId == request.auth.uid;
  allow read, delete: if request.auth != null
                     && resource.data.userId == request.auth.uid;
}
```
