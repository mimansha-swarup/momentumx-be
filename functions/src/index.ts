import { IS_NOT_TENANT, onUserCreated, onUserDeleted } from "firebase-functions/v2/identity";
import { UserRecord } from "firebase-admin/auth";
import { COLLECTIONS, getUserObject } from "./util";
import * as admin from "firebase-admin";

admin.initializeApp();

// Keep the original region and single-request execution; retries remain opt-in.
const authOptions = { region: "us-central1", concurrency: 1, retry: false, tenantId: IS_NOT_TENANT };

function assertUser(user: UserRecord): void {
  if (!user || typeof user.uid !== "string" || !user.uid || user.uid.includes("/")) {
    throw new Error("Invalid Auth event user");
  }
}

// New names are required for a generation migration. See functions/README.md.
export const onCreateUserV2 = onUserCreated(authOptions, async ({ data: user }) => {
  assertUser(user);
  try {
    // Atomic create preserves API-created profiles and makes repeated delivery safe:
    // a merge would reset existing stats, profile fields and creation time.
    await admin
      .firestore()
      .collection(COLLECTIONS.USERS)
      .doc(user.uid)
      .create(getUserObject(user));
  } catch (error) {
    if ((error as { code?: number })?.code === 6) return; // Firestore ALREADY_EXISTS
    console.error(
      JSON.stringify({
        event: "user_record_create_failed",
        uid: user.uid,
        message: (error as Error)?.message,
      })
    );
    throw error;
  }
});

/** SDK/admin deletion bypasses the API. Keep content and explicitly freeze orphaned channels. */
export const onDeleteUserV2 = onUserDeleted(authOptions, async ({ data: deleted }) => {
  assertUser(deleted);
  const db = admin.firestore();
  const accounts = await db.collection(COLLECTIONS.ACCOUNTS).where("memberUids", "array-contains", deleted.uid).get();
  for (const doc of accounts.docs) {
    await db.runTransaction(async tx => {
      const current = (await tx.get(doc.ref)).data();
      if (!current || current.deletedAt || !current.memberUids?.includes(deleted.uid)) return;
      const members = { ...current.members };
      delete members[deleted.uid];
      const memberUids = Object.keys(members);
      const ownerUids = memberUids.filter(uid => members[uid].role === "owner");
      /**
       * The FREEZE is deliberate and kept: losing the payer means a human has to
       * decide who funds the channel, so it is marked `orphanedAt` and excluded
       * from discovery until an operator acts.
       *
       * What is fixed is that `billingOwnerUid` used to keep pointing at the
       * deleted uid. Every membership write goes through `writeMembers`, which
       * requires the payer to BE an owner — so even after an operator cleared
       * `orphanedAt` by hand, the channel stayed unusable, and recovery needed a
       * direct Firestore write rather than an API call. Pointing it at a surviving
       * owner leaves the document coherent, so clearing the tombstone is enough.
       */
      const payerGone = current.billingOwnerUid === deleted.uid;
      const heir = payerGone && ownerUids.length ? [...ownerUids].sort()[0] : undefined;
      const orphaned = !ownerUids.length || payerGone;
      // Outstanding links must not restore a member removed by Auth deletion.
      tx.set(doc.ref.collection("membershipChanges").doc(deleted.uid), {
        changedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(doc.ref, { members, memberUids, ownerUids,
        ...(heir ? { billingOwnerUid: heir } : {}),
        ...(orphaned ? { orphanedAt: admin.firestore.FieldValue.serverTimestamp(), orphanedReason: payerGone ? "billing_owner_deleted" : "last_owner_deleted" } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (heir) console.warn(JSON.stringify({ event: "billing_owner_reassigned", accountId: doc.id, from: deleted.uid, to: heir }));
    });
  }
});
