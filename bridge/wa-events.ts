import type { BaileysEventMap, WASocket } from "@whiskeysockets/baileys";

/**
 * A typed map of Baileys event handlers: each key is a real Baileys event name
 * and its handler receives that event's exact payload from `BaileysEventMap`.
 * Lets the bridge register handlers with full IntelliSense/compile-time checking
 * instead of re-declaring inline payload shapes at each `sock.ev.on` call.
 */
type EventHandlers = {
  [E in keyof BaileysEventMap]?: (
    arg: BaileysEventMap[E]
  ) => void | Promise<void>;
};

/** Register handlers on the Baileys emitter with full per-event payload typing. */
export const bindEvents = (sock: WASocket, handlers: EventHandlers): void => {
  for (const key of Object.keys(handlers) as (keyof BaileysEventMap)[]) {
    // One cast at the boundary (the emitter's `on` is invariant over the union);
    // every call site above is fully typed against BaileysEventMap.
    sock.ev.on(key, handlers[key] as never);
  }
};
