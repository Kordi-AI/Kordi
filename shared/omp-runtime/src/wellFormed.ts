// Frames must be well-formed UTF-16. A provider may stream a character
// outside the Basic Multilingual Plane, such as a math italic letter or an
// emoji, as two deltas that each hold one half of its surrogate pair.
// `JSON.stringify` writes such a half as a lone `\ud835` escape, which the
// Rust host's JSON parser rejects, failing the whole run.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** `value` with every lone surrogate replaced by U+FFFD. */
export function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, '�');
}

/** A `JSON.stringify` replacer that keeps every string well-formed. */
export function wellFormedReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? wellFormed(value) : value;
}

/**
 * Rejoins characters split across stream deltas: a delta that ends in a high
 * surrogate keeps it for the next delta of the same stream.
 */
export class DeltaJoiner {
  #held = new Map<string, string>();

  /** The part of `delta` that can be sent now; empty when nothing is ready. */
  push(stream: string, delta: string): string {
    let text = (this.#held.get(stream) ?? '') + delta;
    this.#held.delete(stream);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#held.set(stream, text.slice(-1));
      text = text.slice(0, -1);
    }
    return wellFormed(text);
  }

  /** Forgets held halves when a message ends; a dangling half is never sent. */
  reset(): void {
    this.#held.clear();
  }
}
