import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificationProtectionPolicyDigest as digest } from '../scripts/certification-protection-policy.mjs';

function policy() {
  return {
    version: 1,
    target: { origin: 'https://github.com/example/certification.git', repository: 'example/certification', base: 'main' },
    classic_protection: {
      required_status_checks: { strict: true, checks: [{ context: 'lint', app_id: 7 }, { context: 'test', app_id: 8 }] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { bypass_pull_request_allowances: { users: [], teams: [] } },
    },
    branch_rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

describe('canonical retained certification protection observations', () => {
  it('is deterministic across object-key and nested policy-set ordering without mutation', () => {
    const original = policy();
    const reordered = {
      branch_rules: [...original.branch_rules].reverse(),
      classic_protection: {
        required_pull_request_reviews: original.classic_protection.required_pull_request_reviews,
        enforce_admins: original.classic_protection.enforce_admins,
        required_status_checks: { checks: [...original.classic_protection.required_status_checks.checks].reverse(), strict: true },
      },
      target: { base: 'main', repository: original.target.repository, origin: original.target.origin },
      version: 1,
    };
    const raw = JSON.stringify(original);
    const result = digest(raw);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    expect(digest(JSON.stringify(reordered, null, 2))).toBe(result);
    expect(JSON.stringify(original)).toBe(raw);
    expect(digest(raw)).toBe(result);
  });

  it.each([
    ['nested policy', (value) => { value.classic_protection.required_status_checks.strict = false; }],
    ['check', (value) => { value.classic_protection.required_status_checks.checks[0].context = 'different'; }],
    ['provider identity', (value) => { value.classic_protection.required_status_checks.checks[0].app_id = 9; }],
    ['bypass', (value) => { value.classic_protection.required_pull_request_reviews.bypass_pull_request_allowances.users.push({ id: 42 }); }],
    ['unknown provider field', (value) => { value.branch_rules[0].future_policy = { enabled: false }; }],
    ['target', (value) => { value.target.origin = 'https://github.com/example/other.git'; value.target.repository = 'example/other'; }],
    ['target transport', (value) => { value.target.origin = 'git@github.com:example/certification.git'; }],
    ['duplicate policy', (value) => { value.branch_rules.push({ type: 'deletion' }); }],
  ])('changes the digest when %s evidence changes', (_, change) => {
    const original = JSON.stringify(policy());
    const changed = policy();
    change(changed);
    expect(digest(JSON.stringify(changed))).not.toBe(digest(original));
  });

  it.each(['classic', 'rules'])('accepts a %s-only observation without inventing its counterpart', (kind) => {
    const value = policy();
    if (kind === 'classic') value.branch_rules = [];
    else value.classic_protection = null;
    expect(digest(JSON.stringify(value))).toMatch(/^[a-f0-9]{64}$/);
    expect(digest(JSON.stringify(value))).not.toBe(digest(JSON.stringify(policy())));
  });

  it('uses a fixed versioned domain and canonical representation', () => {
    const raw = '{"version":1,"target":{"origin":"https://github.com/a/b","repository":"a/b","base":"main"},"classic_protection":{},"branch_rules":[]}';
    const canonical = '{"branch_rules":[],"classic_protection":{},"target":{"base":"main","origin":"https://github.com/a/b","repository":"a/b"},"version":1}';
    expect(digest(raw)).toBe(createHash('sha256').update(`APE certification protection policy v1\n${canonical}`).digest('hex'));
  });

  it('normalizes only explicitly known check, restriction, and allowance sets', () => {
    const value = policy();
    value.classic_protection.required_status_checks.contexts = ['test', 'lint'];
    value.classic_protection.restrictions = { users: [{ id: 2 }, { id: 1 }], teams: [2, 1], apps: [9, 8] };
    value.classic_protection.required_pull_request_reviews.dismissal_restrictions = { users: [2, 1], teams: [4, 3], apps: [6, 5] };
    value.classic_protection.required_pull_request_reviews.bypass_pull_request_allowances = { users: [2, 1], teams: [4, 3], apps: [6, 5] };
    value.branch_rules.push({ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }, { context: 'lint' }] } });
    const original = JSON.stringify(value);
    value.classic_protection.required_status_checks.contexts.reverse();
    value.classic_protection.required_status_checks.checks.reverse();
    for (const key of ['users', 'teams', 'apps']) {
      value.classic_protection.restrictions[key].reverse();
      value.classic_protection.required_pull_request_reviews.dismissal_restrictions[key].reverse();
      value.classic_protection.required_pull_request_reviews.bypass_pull_request_allowances[key].reverse();
    }
    value.branch_rules.at(-1).parameters.required_status_checks.reverse();
    value.branch_rules.reverse();
    expect(digest(JSON.stringify(value))).toBe(digest(original));
  });

  it.each(['future_ordered_policy', 'required_status_checks/contexts'])('preserves unknown array order for %s', (key) => {
    const value = policy();
    value.classic_protection[key] = [{ operation: 'first' }, { operation: 'second' }];
    const original = JSON.stringify(value);
    value.classic_protection[key].reverse();
    expect(digest(JSON.stringify(value))).not.toBe(digest(original));
  });

  it('preserves unknown nested rule array order even inside a known unordered collection', () => {
    const value = policy();
    value.branch_rules.push({ type: 'future', parameters: { ordered_operations: ['first', 'second'] } });
    const original = JSON.stringify(value);
    value.branch_rules.at(-1).parameters.ordered_operations.reverse();
    expect(digest(JSON.stringify(value))).not.toBe(digest(original));
  });

  it('does not interpret a known field name as a set inside an unknown rule type', () => {
    const value = policy();
    value.branch_rules = [{ type: 'future_sequential_policy', parameters: { required_status_checks: ['first', 'second'] } }];
    const before = digest(JSON.stringify(value));
    value.branch_rules[0].parameters.required_status_checks.reverse();
    expect(digest(JSON.stringify(value))).not.toBe(before);
  });

  it.each([
    ['object input', () => policy()],
    ['undefined input', () => undefined],
    ['invalid JSON', () => '{bad'],
    ['JSON undefined', () => JSON.stringify(policy()).replace('"version":1', '"version":undefined')],
    ['wrong version', () => JSON.stringify({ ...policy(), version: 2 })],
    ['extra envelope field', () => JSON.stringify({ ...policy(), credential: 'not retained' })],
    ['extra target field', () => { const value = policy(); value.target.extra = true; return JSON.stringify(value); }],
    ['wrong target', () => { const value = policy(); value.target.repository = 'example/other'; return JSON.stringify(value); }],
    ['non-GitHub origin', () => { const value = policy(); value.target.origin = 'https://elsewhere.example/example/certification'; return JSON.stringify(value); }],
    ['credential origin', () => { const value = policy(); value.target.origin = 'https://secret@github.com/example/certification'; return JSON.stringify(value); }],
    ['non-main base', () => { const value = policy(); value.target.base = 'feature'; return JSON.stringify(value); }],
    ['array classic', () => JSON.stringify({ ...policy(), classic_protection: [] })],
    ['object rules', () => JSON.stringify({ ...policy(), branch_rules: {} })],
    ['absent policies', () => JSON.stringify({ ...policy(), classic_protection: null, branch_rules: [] })],
    ['duplicate key', () => JSON.stringify(policy()).replace('"strict":true', '"strict":true,"strict":false')],
    ['escaped duplicate key', () => JSON.stringify(policy()).replace('"strict":true', '"strict":true,"str\\u0069ct":false')],
    ['numeric overflow', () => JSON.stringify(policy()).replace('"app_id":7', '"app_id":1e400')],
    ['unsafe integer', () => JSON.stringify(policy()).replace('"app_id":7', '"app_id":9007199254740993')],
    ['byte limit', () => JSON.stringify({ ...policy(), classic_protection: { data: 'é'.repeat(132_000) } })],
    ['depth limit', () => JSON.stringify(policy()).replace('"app_id":7', `"app_id":${'['.repeat(33)}0${']'.repeat(33)}`)],
    ['entry limit', () => JSON.stringify({ ...policy(), branch_rules: Array(10_000).fill(null) })],
  ])('rejects %s without reflecting input evidence', (_, raw) => {
    expect(() => digest(raw())).toThrow('certification protection policy must be a valid bounded version-1 GitHub observation');
  });

  it('retains arbitrary provider object keys safely instead of changing prototypes or dropping fields', () => {
    const value = policy();
    const raw = JSON.stringify(value).replace('"enforce_admins":{"enabled":true}', '"enforce_admins":{"enabled":true,"__proto__":{"provider":true},"constructor":false}');
    expect(digest(raw)).not.toBe(digest(JSON.stringify(value)));
    expect({}).not.toHaveProperty('provider');
  });
});
