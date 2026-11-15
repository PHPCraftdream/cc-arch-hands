// The values the checkpoint-watch mod keeps in the session's $.state.

/** One event held while a cycle ran: when, from where, and its text. */
export type HeldEvent = {
  time: string;
  label: string;
  text: string;
};

/** The checkpoint cycle in flight, so a hot reload of the mod can pick it up. */
export type CheckpointCycle = {
  name: string;
  mode: 'checkpoint' | 'commit';
  trigger: 'threshold' | 'idle' | 'manual';
  phase: 'stopping' | 'queued' | 'checkpointing' | 'compacting' | 'resuming';
  held: HeldEvent[];
  /** The module instance that runs the cycle: a reload takes it over, the older instance stands down. */
  owner: string;
  /** When it was last written (ms): a cycle older than the cycle limit is forgotten. */
  savedAt: number;
};

/** The running main turn and when the last one ended, for the idle checks after a reload. */
export type TurnActivity = {
  mainTurn: string | null;
  lastTurnEnd: number | null;
};

declare module 'claude-code' {
  interface PluginState {
    'cah-checkpoint-watch': {
      cycle: CheckpointCycle | null;
      activity: TurnActivity | null;
    };
  }
}
