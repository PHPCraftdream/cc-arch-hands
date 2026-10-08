import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AllModelCommands, AllCodexAgents } from '../lib/manifest.js';
import { CodexModelSpecs } from '../lib/codex-model-specs.js';
import { modelLimit } from '../lib/transcript-stats.js';

const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

// The window the display label advertises: "(1M)" or "(200k)".
function windowFromDisplay(display) {
  const match = display.match(/\((?:top, )?(\d+)(M|k)\)/);
  assert.ok(match, `${display} carries no window label`);
  return Number(match[1]) * (match[2] === 'M' ? 1_000_000 : 1_000);
}

describe('Claude alias context windows', () => {
  it('records a numeric contextWindow on every alias that matches its display label', () => {
    for (const alias of AllModelCommands) {
      assert.ok(positiveInt(alias.contextWindow), `${alias.name} contextWindow`);
      assert.equal(alias.contextWindow, windowFromDisplay(alias.display), `${alias.name} vs display`);
      assert.equal('maxContextWindow' in alias, false, `${alias.name} has no max window`);
    }
  });

  it('gives every alias of one model the same window', () => {
    const windows = new Map();
    for (const { model, contextWindow } of AllModelCommands) {
      assert.equal(windows.get(model) ?? contextWindow, contextWindow, model);
      windows.set(model, contextWindow);
    }
  });

  it('agrees with the status-line modelLimit for every model', () => {
    const saved = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    try {
      for (const { name, model, contextWindow } of AllModelCommands) {
        assert.equal(modelLimit(model), contextWindow, `${name} (${model})`);
      }
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = saved;
    }
  });
});

describe('Codex alias windows and efforts', () => {
  const models = [...new Set(AllCodexAgents.map((agent) => agent.model))];

  it('has a spec for exactly the models the agents use', () => {
    assert.deepEqual(Object.keys(CodexModelSpecs), models);
  });

  it('copies both windows from the model spec onto every agent', () => {
    for (const agent of AllCodexAgents) {
      const spec = CodexModelSpecs[agent.model];
      assert.ok(positiveInt(agent.contextWindow), `${agent.name} contextWindow`);
      assert.ok(positiveInt(agent.maxContextWindow), `${agent.name} maxContextWindow`);
      assert.equal(agent.contextWindow, spec.contextWindow, agent.name);
      assert.equal(agent.maxContextWindow, spec.maxContextWindow, agent.name);
      assert.ok(agent.contextWindow <= agent.maxContextWindow, `${agent.name} window order`);
    }
  });

  it('has one agent per accepted effort and no agent for a rejected one', () => {
    for (const model of models) {
      const efforts = AllCodexAgents.filter((agent) => agent.model === model).map((agent) => agent.effort);
      assert.deepEqual(efforts, [...CodexModelSpecs[model].efforts], model);
    }
  });

  it('keeps ultra only on the models that accept it', () => {
    const ultra = AllCodexAgents.filter((agent) => agent.effort === 'ultra').map((agent) => agent.name);
    assert.deepEqual(ultra, ['us', 'us1', 'us2', 'ut', 'ua']);
    assert.equal(AllCodexAgents.some((agent) => agent.name === 'ul1'), false);
  });
});
