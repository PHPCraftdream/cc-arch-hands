// cah-omp-command-runtime:v1
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']);

export function intervalMilliseconds(value = '15m') {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error('Interval must be a positive integer followed by s, m or h');
  const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > MAX_MS) {
    throw new Error('Interval must be between 1 second and 7 days');
  }
  return ms;
}

export function latestTodo(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry.message;
    let phases;
    if (entry.type === 'custom' && entry.customType === 'user_todo_edit') {
      phases = entry.data?.phases;
    } else if (entry.type === 'message' && message?.role === 'toolResult'
        && message.toolName === 'todo' && !message.isError && message.details?.op !== 'view') {
      phases = message.details?.phases;
    } else continue;
    if (!Array.isArray(phases) || phases.some((phase) => !Array.isArray(phase.tasks)
        || phase.tasks.some((task) => typeof task.content !== 'string' || !STATUSES.has(task.status)))) {
      throw new Error('Cannot read canonical OMP todo state; babysit was stopped');
    }
    return phases.flatMap((phase) => phase.tasks);
  }
  return [];
}

const TICK = `# babysit tick — resume the current OMP todo plan

Call todo with op: view. The live todo list is the source of truth. If it has no pending or in_progress tasks, report the blockers or completion and do not invent work. Never unblock user, agent or service waits without new evidence. Otherwise resume the current in_progress task, or the earliest ready pending task, identified by verbatim content. Read its strategy and blockers from session context. Respect the user's limits and agent choices; do not launch subagents without an explicit user request. Mark finished work done and continue immediately with the next ready task in this same turn. Do not wait for another babysit tick to advance ordinary work. If the plan is exhausted, call cah_babysit with action: off. Report only concrete results or blockers.`;

export default function babysitExtension(pi) {
  let timer;
  let context;
  let sessionId;
  let interval;
  let expiresAt;
  let wakePending = false;

  function stop() {
    if (timer !== undefined) context.clearTimer(timer);
    timer = undefined;
    context = undefined;
    sessionId = undefined;
    interval = undefined;
    expiresAt = undefined;
    wakePending = false;
  }

  function tasks() {
    return latestTodo(context.sessionManager.getBranch());
  }

  function tick() {
    try {
      if (context.sessionManager.getSessionId() !== sessionId || Date.now() >= expiresAt) {
        stop();
        return;
      }
      const todo = tasks();
      if (!todo.some((task) => ['pending', 'in_progress', 'blocked'].includes(task.status))) {
        stop();
        return;
      }
      if (!todo.some((task) => task.status === 'pending' || task.status === 'in_progress')
          || !context.isIdle() || context.hasPendingMessages() || wakePending) return;
      wakePending = true;
      pi.sendMessage({ customType: 'cah-babysit-tick', content: TICK, display: true },
        { triggerTurn: true, deliverAs: 'followUp' });
    } catch (error) {
      stop();
      throw error;
    }
  }

  pi.registerTool({
    name: 'cah_babysit',
    label: 'Babysit',
    loadMode: 'essential',
    description: 'Control the user-requested session-only todo heartbeat. arm starts one timer, status inspects it, off stops it. Never arm without an explicit /babysit or /babygoal request. It cannot revive a closed OMP process.',
    parameters: pi.arktype({ action: "'arm' | 'status' | 'off'", 'interval?': 'string' }),
    execute: async (_id, params, _signal, _update, ctx) => {
      if (ctx.agent.kind !== 'main') throw new Error('Babysit can only run in the main session');
      if (timer !== undefined && ctx.sessionManager.getSessionId() !== sessionId) stop();
      if (params.action === 'off') stop();
      else if (params.action === 'arm') {
        const requested = params.interval ?? '15m';
        const ms = intervalMilliseconds(requested);
        const todo = latestTodo(ctx.sessionManager.getBranch());
        if (!todo.some((task) => ['pending', 'in_progress', 'blocked'].includes(task.status))) {
          throw new Error('No unfinished todo tasks: create the plan before arming babysit');
        }
        if (timer !== undefined && interval !== requested) {
          throw new Error(`Babysit already armed every ${interval}; use off before changing the interval`);
        }
        if (timer === undefined) {
          context = ctx;
          sessionId = ctx.sessionManager.getSessionId();
          interval = requested;
          expiresAt = Date.now() + MAX_MS;
          timer = ctx.setInterval(tick, ms);
        }
      } else if (params.action !== 'status') throw new Error('Unknown babysit action');
      const details = { armed: timer !== undefined, interval: interval ?? null,
        sessionId: sessionId ?? null, expiresAt: expiresAt ?? null, durable: false };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });

  pi.on('agent_start', () => { wakePending = false; });
  pi.on('agent_end', () => {
    wakePending = false;
    if (timer !== undefined) {
      try {
        if (!tasks().some((task) => ['pending', 'in_progress', 'blocked'].includes(task.status))) stop();
      } catch (error) {
        stop();
        throw error;
      }
    }
  });
  for (const event of ['session_switch', 'session_tree', 'session_shutdown']) pi.on(event, stop);
}
