// The only module that touches storage. Inside a claude.ai artifact it uses
// the artifact database, in each user's private area. Elsewhere (local
// development, or a view without database access) it falls back to this
// browser's localStorage.

import { host } from "./host";
import type { Chat } from "../chat/types";

export type StoreMode = "cloud" | "local";

export interface ChatStore {
  mode: StoreMode;
  /** Live list of this user's chats, newest first. */
  watchChats(next: (chats: Chat[]) => void, onError: (message: string) => void): () => void;
  saveChat(chat: Chat): Promise<void>;
  deleteChat(id: string): Promise<void>;
}

const DOC_LIMIT = 250_000; // the artifact database caps a document at 256 KiB

export class ChatTooLargeError extends Error {}

function checkSize(chat: Chat) {
  if (JSON.stringify(chat).length > DOC_LIMIT) {
    throw new ChatTooLargeError("This chat is full. Start a new chat to keep going.");
  }
}

export async function openStore(): Promise<ChatStore> {
  const c = host();
  if (c?.use) {
    const [db, user] = await Promise.all([
      c.use("db").catch(() => null),
      c.use("user").catch(() => null),
    ]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (db && uid) return cloudStore(db, uid);
  }
  return localStore();
}

function cloudStore(db: DB, uid: string): ChatStore {
  const chats = db.doc(`data/users/${uid}/profile`).collection("chats");
  // One write at a time per document: queue writes, keep only the latest.
  const queues = new Map<string, { running: boolean; next: Chat | null; waiters: Array<(e?: unknown) => void> }>();

  async function drain(id: string) {
    const q = queues.get(id)!;
    if (q.running) return;
    q.running = true;
    while (q.next) {
      const chat = q.next;
      const waiters = q.waiters;
      q.next = null;
      q.waiters = [];
      let err: unknown;
      try {
        await chats.doc(id).set(JSON.parse(JSON.stringify(chat)));
      } catch (e) {
        err = e;
      }
      waiters.forEach((w) => w(err));
    }
    q.running = false;
  }

  return {
    mode: "cloud",
    watchChats(next, onError) {
      return chats.onSnapshot(
        (snap) => {
          const list = snap.docs
            .filter((d) => d.exists)
            .map((d) => d.data() as unknown as Chat)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          next(list);
        },
        (e) => onError(e.code === "revoked" ? "Saving is no longer available in this view." : "Your chats couldn't be loaded."),
      );
    },
    saveChat(chat) {
      checkSize(chat);
      if (!queues.has(chat.id)) queues.set(chat.id, { running: false, next: null, waiters: [] });
      const q = queues.get(chat.id)!;
      q.next = chat;
      const done = new Promise<void>((resolve, reject) => q.waiters.push((e) => (e ? reject(e) : resolve())));
      void drain(chat.id);
      return done;
    },
    async deleteChat(id) {
      await chats.doc(id).delete();
    },
  };
}

function localStore(): ChatStore {
  const KEY = "studydesk.chats.v1";
  const listeners = new Set<(chats: Chat[]) => void>();
  const read = (): Chat[] => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {
      return [];
    }
  };
  let cache = read();
  const emit = () => {
    const sorted = [...cache].sort((a, b) => b.updatedAt - a.updatedAt);
    listeners.forEach((l) => l(sorted));
  };
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* storage unavailable: keep in memory only */
    }
  };
  return {
    mode: "local",
    watchChats(next) {
      listeners.add(next);
      queueMicrotask(emit);
      return () => listeners.delete(next);
    },
    async saveChat(chat) {
      checkSize(chat);
      cache = [chat, ...cache.filter((c) => c.id !== chat.id)];
      write();
      emit();
    },
    async deleteChat(id) {
      cache = cache.filter((c) => c.id !== id);
      write();
      emit();
    },
  };
}
