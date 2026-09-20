import { describe, it, expect } from 'vitest';
import { PlanSchema, resolveValue } from '../../packages/contracts/src/index.ts';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import {
  affectedScenes,
  sceneDuration,
  totalDuration,
  mayRepeat,
} from '../../packages/contracts/src/rules.ts';

describe('Plan contract', () => {
  it('accepts the fixed authenticated three-scene plan', () =>
    expect(PlanSchema.safeParse(samplePlan()).success).toBe(true));
  it.each([
    [
      'empty scenes',
      (p: any) => {
        p.scenes = [];
      },
    ],
    [
      'too many scenes',
      (p: any) => {
        p.scenes = Array(7).fill(p.scenes[0]);
      },
    ],
    [
      'duplicate scene',
      (p: any) => {
        p.scenes[1].id = p.scenes[0].id;
      },
    ],
    [
      'duplicate action',
      (p: any) => {
        p.scenes[1].actions[0].id = p.scenes[0].actions[0].id;
      },
    ],
    [
      'missing locator',
      (p: any) => {
        p.scenes[0].actions[0].locatorId = 'missing';
      },
    ],
    [
      'future dependency',
      (p: any) => {
        p.scenes[0].dependsOn = ['complete'];
      },
    ],
    [
      'self dependency',
      (p: any) => {
        p.scenes[0].dependsOn = ['overview'];
      },
    ],
    [
      'cyclic locator',
      (p: any) => {
        p.locators[0].scopeLocatorId = p.locators[0].id;
      },
    ],
    [
      'URL credentials',
      (p: any) => {
        p.target.baseUrl = 'http://name:secret@example.com';
      },
    ],
    [
      'cross origin navigation',
      (p: any) => {
        p.scenes[0].entry.url = 'https://example.com';
      },
    ],
    [
      'non HTTP URL',
      (p: any) => {
        p.scenes[0].entry.url = 'file:///etc/passwd';
      },
    ],
    [
      'unknown arbitrary action',
      (p: any) => {
        p.scenes[0].actions[0] = { ...p.scenes[0].actions[0], type: 'evaluate', code: 'fetch()' };
      },
    ],
    [
      'secret field',
      (p: any) => {
        p.auth.password = 'secret';
      },
    ],
    [
      'fake read-only mutation',
      (p: any) => {
        p.scenes[1].retryPolicy = 'read_only';
      },
    ],
    [
      'missing recovery predicates',
      (p: any) => {
        p.scenes[1].retryPolicy = 'verify_before_repeat';
      },
    ],
    [
      'narration over budget',
      (p: any) => {
        p.scenes[0].narration.estimatedDurationMs = 30001;
      },
    ],
    [
      'action past budget',
      (p: any) => {
        p.scenes[0].actions[0].atMs = 30000;
      },
    ],
    [
      'unbound output',
      (p: any) => {
        p.scenes[1].entry.url = { sceneId: 'overview', output: 'missing' };
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const p = structuredClone(samplePlan());
    mutate(p);
    expect(PlanSchema.safeParse(p).success).toBe(false);
  });
  it('allows explicitly declared earlier outputs', () => {
    const p = samplePlan();
    p.scenes[0].outputs = [{ name: 'url', source: 'currentUrl', locatorId: null }];
    p.scenes[1].dependsOn = ['overview'];
    p.scenes[1].entry.url = { sceneId: 'overview', output: 'url' };
    expect(PlanSchema.safeParse(p).success).toBe(true);
  });
  it('never substitutes missing outputs with empty values', () =>
    expect(() => resolveValue({ sceneId: 's', output: 'url' }, {})).toThrow('PRECONDITION_FAILED'));
});
describe('recovery boundaries', () => {
  it('retries only an independent selected scene', () =>
    expect(affectedScenes(samplePlan(), ['create'])).toEqual(['create']));
  it('invalidates declared transitive consumers', () => {
    const p = samplePlan();
    p.scenes[1].dependsOn = ['overview'];
    p.scenes[2].dependsOn = ['create'];
    expect(affectedScenes(p, ['overview'])).toEqual(['overview', 'create', 'complete']);
  });
  it('invalidates later scenes reading a changed resource', () => {
    const p = samplePlan();
    p.scenes[2].effects.reads.push('task:created-demo');
    expect(affectedScenes(p, ['create'])).toEqual(['create', 'complete']);
  });
  it('rejects unknown scenes', () =>
    expect(() => affectedScenes(samplePlan(), ['other'])).toThrow());
  it.each([
    [true, false, 'already_completed'],
    [false, true, 'repeat'],
    [true, true, 'needs_action'],
    [false, false, 'needs_action'],
  ] as const)('classifies completed=%s safe=%s', (completed, safe, result) =>
    expect(mayRepeat(completed, safe)).toBe(result),
  );
});
describe('media duration rules', () => {
  it('uses measured audio and completed actions, whichever is later', () => {
    const s = samplePlan().scenes[0];
    expect(sceneDuration(s, 19000, 17000)).toBe(19600);
    expect(sceneDuration(s, 16000, 21000)).toBe(21600);
  });
  it('does not cut overlong narration', () =>
    expect(() => sceneDuration(samplePlan().scenes[0], 30000, 15000)).toThrow('DURATION_EXCEEDED'));
  it('accepts an exact scene boundary', () =>
    expect(sceneDuration(samplePlan().scenes[0], 29400, 0)).toBe(30000));
  it('rejects invalid and empty durations', () => {
    expect(() => totalDuration([])).toThrow();
    expect(() => totalDuration([NaN])).toThrow();
    expect(() => sceneDuration(samplePlan().scenes[0], -1, 0)).toThrow();
  });
  it('rejects final videos exceeding the cap', () =>
    expect(() => totalDuration([26000, 26000, 26000])).toThrow('DURATION_EXCEEDED'));
});
it('rejects a plan naming something that is not a URL instead of crashing on it', () => {
  const p = samplePlan();
  // The planner has written a regex here before; a throw would take down the whole generation.
  p.scenes[0].actions = [
    {
      id: 'a_wait',
      atMs: 0,
      type: 'waitFor',
      condition: { type: 'urlMatches', value: '.*[?&]plan=' },
      timeoutMs: 5000,
    },
  ] as never;
  const result = PlanSchema.safeParse(p);
  expect(result.success).toBe(false);
});
