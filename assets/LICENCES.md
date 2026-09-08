# Provenance et licences des ressources embarquées

Ces fichiers ne sont pas de moi. Ils viennent de sources publiques et sont
embarqués dans le dépôt parce que les CDN sont inaccessibles depuis la page.
Chaque entrée indique l'origine exacte et la licence.

## Modèles 3D · KayKit Medieval Hexagon Pack

| Ce qui est embarqué | Origine | Licence |
|---|---|---|
| `models/*.gltf` + `.bin` (31 modèles) et `models/atlas.png` | [KayKit Medieval Hexagon Pack 1.0](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0) par Kay Lousberg | **CC0 1.0** — usage commercial autorisé, aucune attribution obligatoire |

Le pack complet contient plus de 200 modèles ; seul un sous-ensemble est
embarqué, pour tenir le poids de page :

- **Tuiles** : `hex_grass`, `hex_water`
- **Relief** : `mountain_A/B_grass_trees`, `hills_A_trees`, `hill_single_A`
- **Nature** : `tree_single_A/B`, `rock_single_A/B`
- **Bâti du joueur** (bleu) : château, logis A et B, église, marché, tour,
  mine, moulin
- **Bâti des clans** (rouge, vert, jaune) : château, logis, tour
- **Bannières** dans les quatre couleurs

⚠️ Les clans n'ont que trois types de bâtiment là où le joueur en a huit :
quatre couleurs × huit types pesaient 4,5 Mo pour un détail qu'on ne voit
jamais de chez soi. Le sous-ensemble actuel fait **2,7 Mo**.

Tous les modèles partagent **un seul atlas** (`atlas.png`, 16 ko) : c'est ce qui
rend 31 modèles aussi légers. Le chemin de la texture a été réécrit dans chaque
`.gltf` pour pointer vers cet atlas unique.

**Pour changer de style**, remplacez les fichiers de `models/` en gardant les
noms : le code ne connaît que les noms, pas les formes.

## Environnement lumineux

| Fichier | Origine | Licence |
|---|---|---|
| `env/ciel_venise_1k.hdr` | Poly Haven — « Venice Sunset », distribué dans le dépôt three.js (`examples/textures/equirectangular/venice_sunset_1k.hdr`) | **CC0 1.0** — domaine public, usage commercial autorisé, aucune attribution obligatoire |

## Textures

Toutes issues du dépôt [three.js](https://github.com/mrdoob/three.js)
(`examples/textures/`), redimensionnées à 512 px et recompressées.

| Fichier | Source | Usage ici |
|---|---|---|
| `textures/sol_herbe.jpg` | `terrain/grasslight-big.jpg` | sol des prairies et des forêts |
| `textures/mur_couleur.jpg` | `brick_diffuse.jpg` | façades des bâtiments |
| `textures/mur_relief.jpg` | `brick_bump.jpg` | relief des façades |
| `textures/mur_rugosite.jpg` | `brick_roughness.jpg` | rugosité des façades |
| `textures/bois_couleur.jpg` | `hardwood2_diffuse.jpg` | bois (mâts, charpentes) |
| `textures/bois_relief.jpg` | `hardwood2_bump.jpg` | relief du bois |
| `textures/eau_normales.jpg` | `waternormals.jpg` | vagues de la mer |
| `textures/roche_relief.jpg` | `disturb.jpg` | relief de la roche et des falaises |

three.js est distribué sous licence **MIT**. Les ressources de son dossier
`examples/` sont fournies pour être réutilisées avec les exemples ; celles
retenues ici sont des textures génériques sans marque ni personnage.

⚠️ Si tu veux une garantie juridique sans réserve pour un usage commercial,
remplace ces textures par des équivalents explicitement CC0 (ambientCG,
Poly Haven). Le code n'a pas à changer : seuls les fichiers de `textures/`
sont à écraser, les noms font foi.

## Réduction de poids

Les sources pèsent 5,7 Mo au total ; après redimensionnement à 512 px elles
pèsent 452 ko. Le HDR est conservé tel quel (1,4 Mo) : c'est lui qui porte tout
l'éclairage réaliste, et il n'est chargé qu'à l'ouverture du jeu.
