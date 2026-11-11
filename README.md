# famille-infra

Infrastructure Firebase commune du portail familial : règles de sécurité Firestore,
configuration de l'émulateur et tests des règles.

Ce dépôt ne contient AUCUNE logique métier des mini-applications.

## Environnements

| Alias  | Projet Firebase | Usage            |
|--------|-----------------|------------------|
| `dev`  | `famille-dev`   | développement    |
| `prod` | `famille-prod`  | production       |

Les tests tournent sur un projet fictif `demo-famille` dans l'émulateur : ils ne touchent jamais
aux vrais projets.

## Prérequis

- Node.js (LTS), Git
- Java (JDK 21 ou plus récent) pour l'émulateur Firestore
- Un compte Firebase (`npx firebase login`)

## Installation

```
npm install
npm install --save-dev firebase-tools firebase @firebase/rules-unit-testing vitest
```

## Commandes

```
npm test              # lance l'émulateur et les tests des règles
npm run emulators     # émulateurs en local (interface sur http://localhost:4000)
npm run deploy:dev    # déploie les règles sur famille-dev
npm run deploy:prod   # déploie les règles sur famille-prod
```

Toujours déployer sur `dev`, vérifier, puis sur `prod`.

## Modèle de données

```
catalog/{appId}                                   catalogue des apps (lecture : connectés, écriture : admins)
admins/{uid}                                      créé à la main dans la console, jamais via l'app
users/{uid}                                       profil (displayName, familyId)
invites/{code}                                    invitation (fid, expiresAt, createdBy)
families/{fid}                                    famille (name, ownerUid, createdAt)
families/{fid}/members/{uid}                      membres (displayName, role, joinedAt)
families/{fid}/apps/{appId}/...                   données de chaque mini-app (règle générique)
```

## Choix de conception

- Règle générique sur `families/{fid}/apps/{appId}/**` : ajouter une app ne modifie pas les règles.
  Contrepartie : les règles ne valident pas le contenu propre à chaque app.
- Pas de Cloud Functions (forfait Spark) : création de famille et invitations gérées
  côté client, contrôlées par les règles.
- Code d'invitation : aléatoire, durée limitée, lisible uniquement par `get` (jamais listable).
