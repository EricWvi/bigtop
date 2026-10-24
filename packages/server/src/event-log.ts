import type { Actor, Envelope } from "@bigtop/protocol";

/** Append-only, in-memory event log. Keeps the most recent `max` events. */
export class EventLog {
  #events: Envelope[] = [];
  #next = 1;
  #max: number;
  #subscribers = new Set<(event: Envelope) => void>();

  constructor(max = 10_000) {
    this.#max = max;
  }

  append<T>(type: string, actor: Actor, data: T, subject?: Envelope["subject"]): Envelope<T> {
    const event: Envelope<T> = {
      id: this.#next++,
      at: new Date().toISOString(),
      actor,
      ...(subject ? { subject } : {}),
      type,
      data,
    };
    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.splice(0, this.#events.length - this.#max);
    for (const subscriber of this.#subscribers) subscriber(event);
    return event;
  }

  /** Events with an id greater than `after`, oldest first. */
  since(after = 0): Envelope[] {
    return this.#events.filter((e) => e.id > after);
  }

  subscribe(subscriber: (event: Envelope) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}
