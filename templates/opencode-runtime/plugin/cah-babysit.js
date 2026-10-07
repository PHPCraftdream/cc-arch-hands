// cah-opencode-runtime:v1
// Thin OpenCode plugin (published to <root>/plugins/cah-babysit.js): registers
// the cah_babysit and cah_todos tools via the published @opencode-ai/plugin tool() factory
// and forwards lifecycle events to the pure scheduler in
// ../cah-opencode/cah-babysit-scheduler.js. All babysit logic lives in the
// scheduler; this file only adapts the plugin surface.
//
// Single canonical export: OpenCode's plugin loader instantiates the module's
// default export once ({ id?, server } or default export; we use default).
import { tool } from '@opencode-ai/plugin';
import { createBabysitScheduler, readTodos } from '../cah-opencode/cah-babysit-scheduler.js';

export default async ({ client }) => {
  if (!client) {
    throw new Error('cah-babysit plugin requires the OpenCode SDK client from the plugin context');
  }
  // A failing or missing reporter must never break the heartbeat.
  const best = (call) => {
    try { Promise.resolve(call()).catch(() => {}); } catch { /* best-effort */ }
  };
  const log = (message, extra) => {
    best(() => client.app?.log?.({
      body: { level: 'error', service: 'cah-babysit', message, extra },
    }));
    // The server log is invisible in the TUI; tell the user the heartbeat is gone.
    best(() => client.tui?.showToast?.({
      body: { title: 'babysit stopped', message, variant: 'error', duration: 15000 },
    }));
  };
  const scheduler = createBabysitScheduler({
    client,
    onError: (sessionID, error) => {
      log(`babysit stopped for session ${sessionID}: ${error?.message ?? String(error)}`);
    },
  });
  return {
    event: async ({ event }) => {
      const type = event?.type ?? '';
      const props = event?.properties ?? {};
      const info = props.info ?? {};
      const sessionID = props.sessionID ?? info.sessionID ?? info.id;
      if (!sessionID) return;
      if (type === 'session.idle') {
        scheduler.handleEvent({ type: 'session.idle', sessionID });
      } else if (type === 'session.status') {
        scheduler.handleEvent({
          type: 'session.status',
          sessionID,
          status: props.status ?? info.status,
        });
      } else if (type === 'todo.updated') {
        scheduler.handleEvent({ type: 'todo.updated', sessionID, todos: props.todos });
      } else if (type === 'session.error') {
        scheduler.handleEvent({ type: 'session.error', sessionID, error: props.error });
      } else if (type === 'message.updated') {
        scheduler.handleEvent({ type: 'message.updated', sessionID, info });
      } else if (type === 'session.deleted') {
        scheduler.handleEvent({ type: 'session.deleted', sessionID });
      }
    },
    tool: {
      cah_todos: tool({
        description: "Read this session's live todo list (OpenCode has no todoread tool). Returns a JSON array of {content, status} with status pending, in_progress, completed or cancelled. Read-only.",
        args: {},
        execute: async (_args, ctx) => {
          if (ctx.abort?.aborted) throw new Error('Todo read aborted');
          return JSON.stringify(await readTodos({ client, sessionID: ctx.sessionID, signal: ctx.abort }));
        },
      }),
      cah_babysit: tool({
        description: 'Control the user-requested session-only todo heartbeat. action: arm starts one timer (requires unfinished todos in this session), action: status inspects it (an unarmed status carries the stop reason), action: off stops it. Never arm without an explicit /babysit or /babygoal request. It cannot revive a closed OpenCode process.',
        args: {
          action: tool.schema.enum(['arm', 'status', 'off']),
          interval: tool.schema.string().optional(),
        },
        execute: async ({ action, interval }, ctx) => {
          if (ctx.abort?.aborted) throw new Error('Babysit tool execution aborted');
          let result;
          if (action === 'off') result = scheduler.off(ctx.sessionID);
          else if (action === 'status') result = scheduler.status(ctx.sessionID);
          else if (action === 'arm') result = await scheduler.arm({
            sessionID: ctx.sessionID, interval, signal: ctx.abort,
          });
          else throw new Error('Unknown babysit action: use arm, status or off');
          return JSON.stringify(result);
        },
      }),
    },
    dispose: async () => scheduler.dispose(),
  };
};
