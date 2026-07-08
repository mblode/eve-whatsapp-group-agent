import type { proto, WAMessage } from "@whiskeysockets/baileys";

import { boundedMap } from "./bounded-set.js";

/**
 * Baileys decryption-retry support for the bridge.
 *
 * When a recipient device can't decrypt one of our messages it sends a retry
 * receipt. Baileys answers it by calling `getMessage(key)` to look up the
 * original plaintext and re-encrypt/resend. With no `getMessage`, nothing is
 * resent and the recipient is stuck on "Waiting for this message. This may take
 * a while." forever. This module keeps a small bounded store of recently SENT
 * message contents so `getMessage` can answer those retries, plus a minimal
 * `CacheStore` for `msgRetryCounterCache`.
 *
 * In-memory only: a retry receipt normally lands within seconds of the send, so
 * losing the store on a bridge restart just means that rare message stays
 * undelivered — the same outcome as before this store existed.
 */

const sentKey = (
  remoteJid: string | null | undefined,
  id: string | null | undefined
): string => `${remoteJid ?? ""}:${id ?? ""}`;

/** Bounded store of recently sent message contents, for getMessage retry replies. */
export interface SentStore {
  /** Remember a just-sent message so its retry receipt can be answered. No-op on missing jid/id/content. */
  record: (sent?: WAMessage) => void;
  /** Look up the proto content Baileys needs to re-encrypt, or undefined if unknown. */
  get: (key: {
    remoteJid?: string | null;
    id?: string | null;
  }) => proto.IMessage | undefined;
}

export const createSentStore = (cap = 500): SentStore => {
  const map = boundedMap<proto.IMessage>(cap);
  return {
    get: (key) =>
      key.id ? map.get(sentKey(key.remoteJid, key.id)) : undefined,
    record(sent) {
      const id = sent?.key?.id;
      const message = sent?.message;
      if (!(sent?.key?.remoteJid && id && message)) {
        return;
      }
      map.set(sentKey(sent.key.remoteJid, id), message);
    },
  };
};

/** The subset of Baileys' CacheStore we implement (get/set/del/flushAll). */
export interface CacheStore {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
  del: (key: string) => void;
  flushAll: () => void;
}

/**
 * A minimal bounded `CacheStore` for `msgRetryCounterCache`. Baileys stores a
 * per-message retry counter here; a bounded Map with oldest-first eviction is
 * plenty and avoids pulling in a NodeCache dependency.
 */
export const createCacheStore = (cap = 500): CacheStore => {
  let map = new Map<string, unknown>();
  return {
    del: (key) => {
      map.delete(key);
    },
    flushAll: () => {
      map = new Map();
    },
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      map.delete(key);
      map.set(key, value);
      if (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
          map.delete(oldest);
        }
      }
    },
  };
};
