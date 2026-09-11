import { it, expect } from 'vitest';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import { PlanSchema } from '../../packages/contracts/src/index.ts';
import { moveScene, addReadScene, changeActionType } from '../../apps/web/src/editor.ts';
it('reorders independent scenes without mutating the input plan', () => {
  const p = samplePlan(),
    next = moveScene(p, 1, -1);
  expect(next.scenes[0].id).toBe('create');
  expect(p.scenes[0].id).toBe('overview');
});
it('prevents moving a dependent scene before its producer', () => {
  const p = samplePlan();
  p.scenes[1].dependsOn = ['overview'];
  expect(() => moveScene(p, 1, -1)).toThrow();
});
it('adds a read-only scene with unique IDs and valid contract shape', () => {
  const p = addReadScene(samplePlan());
  expect(p.scenes).toHaveLength(4);
  expect(p.scenes[3].retryPolicy).toBe('read_only');
  expect(PlanSchema.safeParse(p).success).toBe(true);
});
it('changes action kinds without carrying irrelevant fields', () => {
  const p = samplePlan(),
    next = changeActionType(p.scenes[1].actions[0], 'click', p);
  expect(next.type).toBe('click');
  expect(next).not.toHaveProperty('value');
});
