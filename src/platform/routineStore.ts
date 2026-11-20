// Storage the nightly run shares with the page. design/scheduled-runs.md.
//   data/users/<uid>/routine                 the organization agent's sweep dates and the last 14 nights' logs
//   data/users/<uid>/routine/outbox/<id>     results waiting for the page: grades, the courses' check, deep sweeps
// The nightly run (a cloud session) writes these; the page merges the outbox
// into the student's desk and deletes each document once it's in. Outside a
// claude.ai artifact there is no nightly run, so this store is empty.

import { host } from "./host";
import type { OutboxDoc } from "../routine/apply";
import type { RoutineDoc } from "../routine/nightly";

export interface RoutineStore {
  loadRoutine(): Promise<RoutineDoc | null>;
  loadOutbox(): Promise<OutboxDoc[]>;
  deleteOutbox(id: string): Promise<void>;
}

const none: RoutineStore = {
  async loadRoutine() {
    return null;
  },
  async loadOutbox() {
    return [];
  },
  async deleteOutbox() {},
};

let shared: Promise<RoutineStore> | null = null;

export function openRoutineStore(): Promise<RoutineStore> {
  if (!shared)
    shared = (async () => {
      const c = host();
      if (!c?.use) return none;
      const [db, user] = await Promise.all([c.use("db").catch(() => null), c.use("user").catch(() => null)]);
      const uid = user ? await user.id().catch(() => null) : null;
      if (!db || !uid) return none;
      const root = db.doc(`data/users/${uid}/routine`);
      const outbox = root.collection("outbox");
      return {
        async loadRoutine() {
          const s = await root.get();
          return s.exists ? (s.data() as unknown as RoutineDoc) : null;
        },
        async loadOutbox() {
          return (await outbox.get()).docs.filter((d) => d.exists).map((d) => d.data() as unknown as OutboxDoc);
        },
        async deleteOutbox(id) {
          await outbox.doc(id).delete();
        },
      } satisfies RoutineStore;
    })();
  return shared;
}
