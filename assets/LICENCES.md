# Provenance et licences des ressources embarquées

Ces fichiers ne sont pas de moi. Ils viennent de sources publiques et sont
embarqués dans le dépôt parce que les CDN sont inaccessibles depuis la page.
Chaque entrée indique l'origine exacte et la licence.

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
