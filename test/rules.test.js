import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, writeBatch, collection, getDocs, Timestamp,
} from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, test } from 'vitest';

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
