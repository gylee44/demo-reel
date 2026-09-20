import { it, expect } from 'vitest';
import { samplePlan } from '../../packages/contracts/src/sample.ts';
import type { Plan } from '../../packages/contracts/src/index.ts';
import { discardedFills } from '../../apps/worker/src/validation.ts';
const fill = (locatorId: string) => ({
  id: 'a_fill',
  atMs: 0,
  type: 'fill',
  value: 'x',
  locatorId,
  timeoutMs: 5000,
});
const click = (locatorId: string) => ({
  id: 'a_click',
  atMs: 0,
  type: 'click',
  locatorId,
  timeoutMs: 5000,
});
/** A scene that types into a form and a later scene that presses its button, same entry URL. */
function split(second: unknown[]) {
  const p = samplePlan() as Plan,
    url = p.scenes[0].entry.url,
    field = p.locators[0].id;
  const scenes = [
    { ...p.scenes[0], id: 'fill_form', actions: [fill(field)], dependsOn: [] },
    { ...p.scenes[1], id: 'press_button', actions: second, dependsOn: ['fill_form'] },
  ];
  for (const s of scenes) s.entry = { ...s.entry, url };
  return { ...p, scenes } as unknown as Plan;
}
it('reports a fill that the next scene will reload away before using it', () => {
  const issues = discardedFills(split([click('loc_button')]));
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ code: 'SCENE_STATE_NOT_CARRIED', sceneId: 'press_button' });
});
it('stays quiet when the scene that presses the button also fills the field', () => {
  const p = samplePlan() as Plan;
  expect(discardedFills(split([fill(p.locators[0].id), click('loc_button')]))).toHaveLength(0);
});
it('stays quiet when the later scene opens a different screen', () => {
  const p = split([click('loc_button')]);
  p.scenes[1].entry = { ...p.scenes[1].entry, url: 'https://example.test/elsewhere' };
  expect(discardedFills(p)).toHaveLength(0);
});
it('leaves the sample plan alone', () => {
  expect(discardedFills(samplePlan() as Plan)).toHaveLength(0);
});
