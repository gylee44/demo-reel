import type { Plan, Scene, Action } from '../../../packages/contracts/src/index.ts';
export function moveScene(plan: Plan, index: number, direction: -1 | 1): Plan {
  const next = structuredClone(plan),
    to = index + direction;
  if (to < 0 || to >= next.scenes.length) return plan;
  [next.scenes[index], next.scenes[to]] = [next.scenes[to], next.scenes[index]];
  const seen = new Set<string>();
  for (const s of next.scenes) {
    if (s.dependsOn.some((d) => !seen.has(d)))
      throw new Error('앞 장면의 결과를 사용하는 장면은 먼저 배치할 수 없습니다.');
    seen.add(s.id);
  }
  return next;
}
export function addReadScene(plan: Plan): Plan {
  if (plan.scenes.length >= 6) throw new Error('장면은 최대 6개입니다.');
  const source = plan.scenes.find((s) => s.retryPolicy === 'read_only');
  if (!source) throw new Error('복사할 조회 장면이 없습니다.');
  const id = 'scene_' + crypto.randomUUID(),
    copy: Scene = {
      ...structuredClone(source),
      id,
      title: '추가 조회 장면',
      dependsOn: [],
      outputs: [],
      actions: source.actions.map((a) => ({ ...a, id: 'action_' + crypto.randomUUID() })),
    };
  return { ...plan, scenes: [...plan.scenes, copy] };
}
export function changeActionType(action: Action, type: Action['type'], plan: Plan): Action {
  const base = { id: action.id, atMs: action.atMs, timeoutMs: action.timeoutMs },
    locatorId = 'locatorId' in action ? action.locatorId : plan.locators[0].id;
  switch (type) {
    case 'navigate':
      return { ...base, type, url: plan.target.baseUrl };
    case 'click':
      return { ...base, type, locatorId };
    case 'fill':
    case 'select':
      return { ...base, type, locatorId, value: '' };
    case 'press':
      return { ...base, type, locatorId, key: 'Enter' };
    case 'scroll':
      return { ...base, type, deltaY: 300 };
    case 'waitFor':
    case 'assert':
      return { ...base, type, condition: { type: 'visible', locatorId } };
  }
}
