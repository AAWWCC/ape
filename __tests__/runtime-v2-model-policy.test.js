import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEADLINES_MS,
  DEFAULT_MODELS,
  ROLE_MODEL_OVERRIDES,
  ROLE_POLICIES,
} from '../lib/runtime/constants.js';
import { DEFAULT_CONFIG, resolveModel } from '../lib/runtime/config.js';

describe('model tier policy', () => {
  it('maps the claude tiers to haiku/sonnet/opus', () => {
    expect(DEFAULT_MODELS.claude).toEqual({
      fast: { model: 'haiku' },
      balanced: { model: 'sonnet' },
      deep: { model: 'opus' },
    });
  });

  it('keeps the planner on the deep tier', () => {
    expect(ROLE_POLICIES.planner).toMatchObject({ writable: false, model_tier: 'deep' });
  });

  it('pins the security reviewer to opus on the claude host', () => {
    expect(ROLE_MODEL_OVERRIDES.security_reviewer.claude).toEqual({ model: 'opus' });
    expect(resolveModel(DEFAULT_CONFIG, 'claude', 'deep', 'security_reviewer'))
      .toEqual({ model: 'opus' });
  });

  it('resolves the deep tier default for unpinned roles', () => {
    expect(resolveModel(DEFAULT_CONFIG, 'claude', 'deep', 'reviewer')).toEqual({ model: 'opus' });
    expect(resolveModel(DEFAULT_CONFIG, 'claude', 'deep')).toEqual({ model: 'opus' });
  });

  it('keeps the security reviewer on opus when a project override points deep at fable', () => {
    const config = {
      ...DEFAULT_CONFIG,
      models: { ...DEFAULT_CONFIG.models, claude: { ...DEFAULT_CONFIG.models.claude, deep: { model: 'fable' } } },
    };
    expect(resolveModel(config, 'claude', 'deep', 'reviewer')).toEqual({ model: 'fable' });
    expect(resolveModel(config, 'claude', 'deep', 'security_reviewer')).toEqual({ model: 'opus' });
  });

  it('leaves the codex host untouched by the claude-only override', () => {
    expect(resolveModel(DEFAULT_CONFIG, 'codex', 'deep', 'security_reviewer'))
      .toEqual({ model: 'gpt-5.5', reasoning_effort: 'high' });
  });

  it('gives the fast and full lanes deadline headroom for long deep-tier turns', () => {
    expect(DEFAULT_DEADLINES_MS).toEqual({
      mechanical: 15 * 60_000,
      fast: 30 * 60_000,
      full: 60 * 60_000,
    });
  });
});
