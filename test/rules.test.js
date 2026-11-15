import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, updateDoc, writeBatch, collection, getDocs, Timestamp,
} from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'vitest';

let env;

const inOneDay = () => Timestamp.fromMillis(Date.now() + 24 * 3600 * 1000);
const oneDayAgo = () => Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-famille',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

// Données de départ : une famille f1 (alice propriétaire, bob membre),
// une autre famille f2 (carole), un admin (root), un catalogue, deux invitations.
async function seed() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'families/f1'), { name: 'Famille 1', ownerUid: 'alice', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'families/f1/members/alice'), { displayName: 'Alice', role: 'owner', joinedAt: Timestamp.now() });
    await setDoc(doc(db, 'families/f1/members/bob'), { displayName: 'Bob', role: 'member', joinedAt: Timestamp.now() });
    await setDoc(doc(db, 'families/f2'), { name: 'Famille 2', ownerUid: 'carole', createdAt: Timestamp.now() });
    await setDoc(doc(db, 'families/f2/members/carole'), { displayName: 'Carole', role: 'owner', joinedAt: Timestamp.now() });
    await setDoc(doc(db, 'admins/root'), { ok: true });
    await setDoc(doc(db, 'catalog/courses'), { name: 'Courses' });
    await setDoc(doc(db, 'invites/CODE-OK'), { fid: 'f1', expiresAt: inOneDay(), createdBy: 'alice' });
    await setDoc(doc(db, 'invites/CODE-EXPIRED'), { fid: 'f1', expiresAt: oneDayAgo(), createdBy: 'alice' });
    await setDoc(doc(db, 'families/f1/apps/courses/lists/l1'), { name: 'Liste test' });
  });
}

describe('catalogue', () => {
  test('un visiteur non connecté ne peut pas lire', async () => {
    await seed();
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'catalog/courses')));
  });
  test('un utilisateur connecté peut lire mais pas écrire', async () => {
    await seed();
    const db = env.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(db, 'catalog/courses')));
    await assertFails(setDoc(doc(db, 'catalog/hack'), { name: 'x' }));
  });
  test('un admin peut écrire', async () => {
    await seed();
    const db = env.authenticatedContext('root').firestore();
    await assertSucceeds(setDoc(doc(db, 'catalog/mrwhite'), { name: 'Mr White' }));
  });
});

describe('profil utilisateur', () => {
  test('lecture et écriture de son propre profil seulement', async () => {
    await seed();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(bob, 'users/bob'), { displayName: 'Bob', familyId: 'f1' }));
    await assertSucceeds(getDoc(doc(bob, 'users/bob')));
    await assertFails(getDoc(doc(bob, 'users/alice')));
    await assertFails(setDoc(doc(bob, 'users/alice'), { displayName: 'Pirate' }));
  });
});

describe('création de famille', () => {
  test('un utilisateur crée une famille dont il est propriétaire', async () => {
    const db = env.authenticatedContext('dave').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'families/f9'), { name: 'Les Dave', ownerUid: 'dave', createdAt: Timestamp.now() });
    batch.set(doc(db, 'families/f9/members/dave'), { displayName: 'Dave', role: 'owner', joinedAt: Timestamp.now() });
    await assertSucceeds(batch.commit());
  });
  test('impossible de se déclarer propriétaire au nom d\'un autre', async () => {
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f9'), { name: 'X', ownerUid: 'alice', createdAt: Timestamp.now() }));
  });
  test('impossible de s\'ajouter comme propriétaire d\'une famille existante', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f1/members/dave'), { displayName: 'Dave', role: 'owner', joinedAt: Timestamp.now() }));
  });
  test('impossible de lister toutes les familles', async () => {
    await seed();
    const db = env.authenticatedContext('alice').firestore();
    await assertFails(getDocs(collection(db, 'families')));
  });
});

describe('invitations', () => {
  test('le propriétaire crée une invitation, un simple membre non', async () => {
    await seed();
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(alice, 'invites/NEW1'), { fid: 'f1', expiresAt: inOneDay(), createdBy: 'alice' }));
    await assertFails(setDoc(doc(bob, 'invites/NEW2'), { fid: 'f1', expiresAt: inOneDay(), createdBy: 'bob' }));
  });
  test('rejoindre avec un code valide', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertSucceeds(setDoc(doc(db, 'families/f1/members/dave'), {
      displayName: 'Dave', role: 'member', inviteCode: 'CODE-OK', joinedAt: Timestamp.now(),
    }));
  });
  test('rejoindre avec un code expiré est refusé', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f1/members/dave'), {
      displayName: 'Dave', role: 'member', inviteCode: 'CODE-EXPIRED', joinedAt: Timestamp.now(),
    }));
  });
  test('rejoindre sans code est refusé', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f1/members/dave'), {
      displayName: 'Dave', role: 'member', joinedAt: Timestamp.now(),
    }));
  });
  test('un code de la famille 1 ne permet pas d\'entrer dans la famille 2', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f2/members/dave'), {
      displayName: 'Dave', role: 'member', inviteCode: 'CODE-OK', joinedAt: Timestamp.now(),
    }));
  });
  test('impossible de se donner le rôle propriétaire avec un code', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(db, 'families/f1/members/dave'), {
      displayName: 'Dave', role: 'owner', inviteCode: 'CODE-OK', joinedAt: Timestamp.now(),
    }));
  });
});

describe('données des applications', () => {
  test('un membre lit et écrit les données de sa famille', async () => {
    await seed();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(bob, 'families/f1/apps/courses/lists/l1')));
    await assertSucceeds(setDoc(doc(bob, 'families/f1/apps/courses/lists/l2'), { name: 'Nouvelle' }));
    await assertSucceeds(setDoc(doc(bob, 'families/f1/apps/nouvelleapp/anything/x'), { ok: 1 }));
  });
  test('un membre d\'une autre famille ne peut rien lire ni écrire', async () => {
    await seed();
    const carole = env.authenticatedContext('carole').firestore();
    await assertFails(getDoc(doc(carole, 'families/f1/apps/courses/lists/l1')));
    await assertFails(setDoc(doc(carole, 'families/f1/apps/courses/lists/l3'), { name: 'Pirate' }));
  });
  test('un visiteur non connecté ne peut rien lire', async () => {
    await seed();
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'families/f1/apps/courses/lists/l1')));
  });
});

describe('membres', () => {
  test('un membre peut quitter la famille, pas expulser les autres', async () => {
    await seed();
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bob, 'families/f1/members/alice')));
    await assertSucceeds(deleteDoc(doc(bob, 'families/f1/members/bob')));
  });
});


// ======================================================================================
// Familles multiples : mêmes écritures que famille-core (createFamily, joinFamily,
// leaveFamily, deleteFamily) rejouées contre les règles.
// ======================================================================================

async function seedMemberships() {
  await seed();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [uid, fid] of [['alice', 'f1'], ['bob', 'f1'], ['carole', 'f2']]) {
      await setDoc(doc(db, `users/${uid}/memberships/${fid}`), { joinedAt: Timestamp.now() });
    }
  });
}

describe('familles multiples : création et appartenance', () => {
  test('créer une famille : famille + membre + index dans un seul lot, puis famille active', async () => {
    const db = env.authenticatedContext('dave').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'families/f9'), { name: 'Famille A', ownerUid: 'dave', createdAt: Timestamp.now() });
    batch.set(doc(db, 'families/f9/members/dave'), { displayName: 'Dave', role: 'owner', joinedAt: Timestamp.now() });
    batch.set(doc(db, 'users/dave/memberships/f9'), { joinedAt: Timestamp.now() });
    await assertSucceeds(batch.commit());
    await assertSucceeds(setDoc(doc(db, 'users/dave'), { displayName: 'Dave', familyId: 'f9' }));
  });
  test('une même personne peut appartenir à plusieurs familles, et les lister', async () => {
    await seedMemberships();
    const db = env.authenticatedContext('alice').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'families/f9'), { name: 'Famille B', ownerUid: 'alice', createdAt: Timestamp.now() });
    batch.set(doc(db, 'families/f9/members/alice'), { displayName: 'Alice', role: 'owner', joinedAt: Timestamp.now() });
    batch.set(doc(db, 'users/alice/memberships/f9'), { joinedAt: Timestamp.now() });
    await assertSucceeds(batch.commit());
    const snap = await assertSucceeds(getDocs(collection(db, 'users/alice/memberships')));
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['f1', 'f9']);
    // les données de chaque famille restent séparées
    await assertSucceeds(setDoc(doc(db, 'families/f9/apps/courses/lists/l1'), { name: 'Liste de B' }));
    const carole = env.authenticatedContext('carole').firestore();
    await assertFails(getDoc(doc(carole, 'families/f9/apps/courses/lists/l1')));
  });
  test('l\'index n\'est lisible que par la personne concernée', async () => {
    await seedMemberships();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(getDocs(collection(bob, 'users/bob/memberships')));
    await assertFails(getDocs(collection(bob, 'users/alice/memberships')));
    await assertFails(getDoc(doc(bob, 'users/alice/memberships/f1')));
  });
  test('index refusé pour une famille dont on n\'est pas membre', async () => {
    await seedMemberships();
    const dave = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(dave, 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() }));
  });
  test('index refusé au nom de quelqu\'un d\'autre', async () => {
    await seedMemberships();
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bob, 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() }));
  });
  test('index refusé avec des champs en trop', async () => {
    await seedMemberships();
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(setDoc(doc(bob, 'users/bob/memberships/f1'), { joinedAt: Timestamp.now(), role: 'owner' }));
  });
  test('compte ancien : un membre peut compléter son propre index', async () => {
    await seed(); // pas d'index
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(bob, 'users/bob/memberships/f1'), { joinedAt: Timestamp.now() }));
  });
  test('rejoindre : membre + index dans un seul lot, avec un code valide', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'families/f1/members/dave'), { displayName: 'Dave', role: 'member', inviteCode: 'CODE-OK', joinedAt: Timestamp.now() });
    batch.set(doc(db, 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() });
    await assertSucceeds(batch.commit());
    await assertSucceeds(getDoc(doc(db, 'families/f1/apps/courses/lists/l1')));
  });
  test('rejoindre sans code valide : refusé, index compris', async () => {
    await seed();
    const db = env.authenticatedContext('dave').firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, 'families/f1/members/dave'), { displayName: 'Dave', role: 'member', inviteCode: 'CODE-EXPIRED', joinedAt: Timestamp.now() });
    batch.set(doc(db, 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() });
    await assertFails(batch.commit());
  });
});

describe('familles multiples : quitter une famille', () => {
  test('un membre quitte : sa ligne de membre et son index disparaissent', async () => {
    await seedMemberships();
    const bob = env.authenticatedContext('bob').firestore();
    const batch = writeBatch(bob);
    batch.delete(doc(bob, 'families/f1/members/bob'));
    batch.delete(doc(bob, 'users/bob/memberships/f1'));
    await assertSucceeds(batch.commit());
    await assertFails(getDoc(doc(bob, 'families/f1/apps/courses/lists/l1')));
  });
  test('un membre ne peut ni retirer un autre membre ni effacer son index', async () => {
    await seedMemberships();
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bob, 'families/f1/members/alice')));
    await assertFails(deleteDoc(doc(bob, 'users/alice/memberships/f1')));
  });
  test('nettoyage d\'une ligne d\'index périmée par la personne elle-même', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() });
    });
    const dave = env.authenticatedContext('dave').firestore();
    await assertSucceeds(deleteDoc(doc(dave, 'users/dave/memberships/f1')));
  });
});

describe('familles multiples : suppression d\'une famille', () => {
  // Écritures identiques à deleteFamily() de famille-core.
  async function ownerDeletes(db) {
    const batch = writeBatch(db);
    batch.update(doc(db, 'families/f1'), { deletedAt: Timestamp.now() });
    for (const uid of ['alice', 'bob']) {
      batch.delete(doc(db, `families/f1/members/${uid}`));
      batch.delete(doc(db, `users/${uid}/memberships/f1`));
    }
    return batch.commit();
  }

  test('le propriétaire supprime la famille : marquage + retrait de tous les membres et index', async () => {
    await seedMemberships();
    await assertSucceeds(ownerDeletes(env.authenticatedContext('alice').firestore()));
  });
  test('un simple membre ne peut pas supprimer la famille', async () => {
    await seedMemberships();
    await assertFails(ownerDeletes(env.authenticatedContext('bob').firestore()));
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(doc(bob, 'families/f1'), { deletedAt: Timestamp.now() }));
  });
  test('après suppression : plus aucun accès aux données, ni à la famille', async () => {
    await seedMemberships();
    await ownerDeletes(env.authenticatedContext('alice').firestore());
    for (const uid of ['alice', 'bob']) {
      const db = env.authenticatedContext(uid).firestore();
      await assertFails(getDoc(doc(db, 'families/f1/apps/courses/lists/l1')));
      await assertFails(setDoc(doc(db, 'families/f1/apps/courses/lists/l9'), { name: 'x' }));
      await assertFails(getDoc(doc(db, 'families/f1')));
    }
  });
  test('après suppression : un code d\'invitation encore valide ne permet plus de rejoindre', async () => {
    await seedMemberships();
    await ownerDeletes(env.authenticatedContext('alice').firestore());
    const dave = env.authenticatedContext('dave').firestore();
    const batch = writeBatch(dave);
    batch.set(doc(dave, 'families/f1/members/dave'), { displayName: 'Dave', role: 'member', inviteCode: 'CODE-OK', joinedAt: Timestamp.now() });
    batch.set(doc(dave, 'users/dave/memberships/f1'), { joinedAt: Timestamp.now() });
    await assertFails(batch.commit());
  });
  test('après suppression : impossible de « ressusciter » la famille en se redéclarant propriétaire', async () => {
    await seedMemberships();
    await ownerDeletes(env.authenticatedContext('alice').firestore());
    const bob = env.authenticatedContext('bob').firestore();
    const batch = writeBatch(bob);
    batch.set(doc(bob, 'families/f1'), { name: 'Pirate', ownerUid: 'bob', createdAt: Timestamp.now() });
    batch.set(doc(bob, 'families/f1/members/bob'), { displayName: 'Bob', role: 'owner', joinedAt: Timestamp.now() });
    await assertFails(batch.commit());
    await assertFails(setDoc(doc(bob, 'families/f1/members/bob'), { displayName: 'Bob', role: 'owner', joinedAt: Timestamp.now() }));
  });
  test('supprimer une famille n\'affecte pas les autres', async () => {
    await seedMemberships();
    await ownerDeletes(env.authenticatedContext('alice').firestore());
    const carole = env.authenticatedContext('carole').firestore();
    await assertSucceeds(getDoc(doc(carole, 'families/f2')));
    await assertSucceeds(getDocs(collection(carole, 'users/carole/memberships')));
  });
});

describe('familles multiples : renommage', () => {
  test('le propriétaire peut renommer sa famille, pas un simple membre', async () => {
    await seedMemberships();
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(updateDoc(doc(alice, 'families/f1'), { name: 'Les Dupont' }));
    await assertFails(updateDoc(doc(bob, 'families/f1'), { name: 'Pirate' }));
  });
  test('le propriétaire ne peut pas changer de propriétaire ni ajouter de champ', async () => {
    await seedMemberships();
    const alice = env.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(alice, 'families/f1'), { ownerUid: 'bob' }));
    await assertFails(updateDoc(doc(alice, 'families/f1'), { secret: 1 }));
    await assertFails(updateDoc(doc(alice, 'families/f1'), { deletedAt: 'hier' }));
  });
});
