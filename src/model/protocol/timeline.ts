/** UI-only transcript coordinates. Never sent to model providers. */
export type TimelinePosition = {
  version: 1;
  /** Originating agent turn (also preserved when forwarded through a parent). */
  turnId: string;
  /** Stable within the originating turn, including retries. */
  id: string;
  previousId?: string;
  /** Position allocated before the first visible update. */
  order: number;
  /** Monotone per-turn update version, shared by replay and live delivery. */
  revision: number;
  /** UTF-16 offset for a delta; omitted on a complete snapshot. */
  offset?: number;
};

export type StreamBoundary = { turnId: string; through: number; revision: number };
