import { PlanSchema, type Plan, type Scene, type Action, type Condition } from './index.ts';

export const NARRATIONS = {
  overview:
    '프로젝트를 처음 보는 사람도, 실제로 어떤 일을 할 수 있는지 쉽게 이해할 수 있어야 합니다. 먼저 로그인한 사용자의 작업 공간입니다. 진행 중인 업무와 완료한 업무를 한눈에 확인하고, 필요한 작업으로 바로 이동할 수 있습니다.',
  create:
    '이제 새로운 업무를 직접 추가해 보겠습니다. 제목과 설명을 입력하고 저장하면, 실제 서비스에 데이터가 만들어집니다. 미리 만들어 낸 화면이 아니라, 브라우저에서 실제 기능을 실행한 결과를 그대로 보여드립니다.',
  complete:
    '마지막으로 준비된 업무를 완료 처리합니다. 버튼을 누르면 상태가 바뀌고, 완료 목록에서 결과를 다시 확인할 수 있습니다. 로그인 뒤의 실제 기능 흐름을 짧은 영상으로 전달하는 것, 이것이 데모 릴이 해결하려는 문제입니다.',
} as const;
const visible = (locatorId: string): Condition => ({ type: 'visible', locatorId });
const a = (id: string, atMs: number, data: Omit<Action, 'id' | 'atMs' | 'timeoutMs'>): Action =>
  ({ id, atMs, timeoutMs: 5000, ...data }) as Action;
export function samplePlan(
  baseUrl = 'http://127.0.0.1:4001',
  projectId = 'project_demo',
  planId = 'plan_demo',
  authRef = 'auth_demo',
): Plan {
  const origin = new URL(baseUrl).origin;
  const locator = (
    id: string,
    value: string,
    strategy: 'role' | 'label' | 'testId' = 'role',
    role: string | null = 'heading',
  ) => ({
    id,
    value,
    strategy,
    role: strategy === 'role' ? role : null,
    exact: true,
    scopeLocatorId: null,
    evidenceId: `${planId}_${id}`,
  });
  const scene = (
    id: keyof typeof NARRATIONS,
    title: string,
    path: string,
    ready: string,
    actions: Action[],
    postconditions: Condition[],
  ): Scene => ({
    id,
    title,
    purpose: title,
    entry: { url: `${origin}${path}`, readyConditions: [visible(ready)] },
    dependsOn: [],
    preconditions: [],
    actions,
    postconditions,
    narration: { text: NARRATIONS[id], estimatedDurationMs: 21000 },
    timing: { maxDurationMs: 30000, tailHoldMs: 600, maxFreezeMs: 3000 },
    effects: { reads: [`screen:${id}`], writes: [], summary: '화면 조회' },
    retryPolicy: 'read_only',
    recoveryConditions: null,
    outputs: [],
  });
  const overview = scene(
    'overview',
    '로그인한 사용자의 작업 공간',
    '/dashboard',
    'dashboard',
    [
      a('overview_open', 13500, { type: 'click', locatorId: 'all-tasks' } as never),
      a('overview_confirm', 16000, {
        type: 'assert',
        condition: visible('tasks-heading'),
      } as never),
    ],
    [visible('tasks-heading')],
  );
  const create = scene(
    'create',
    '새 업무를 직접 추가하기',
    '/tasks/new',
    'new-heading',
    [
      a('create_title', 2500, {
        type: 'fill',
        locatorId: 'title-field',
        value: '데모 영상 만들기',
      } as never),
      a('create_description', 6500, {
        type: 'fill',
        locatorId: 'description-field',
        value: '로그인부터 업무 완료까지 실제 기능을 보여줍니다.',
      } as never),
      a('create_save', 11000, { type: 'click', locatorId: 'save-task' } as never),
      a('create_confirm', 15000, { type: 'assert', condition: visible('created-title') } as never),
    ],
    [visible('created-title')],
  );
  create.effects = {
    reads: ['new-task-form'],
    writes: ['task:created-demo'],
    summary: '테스트 업무 “데모 영상 만들기” 1개 생성',
  };
  create.retryPolicy = 'manual_reset';
  const complete = scene(
    'complete',
    '준비된 업무 완료하기',
    '/tasks/seed-task',
    'seed-title',
    [
      a('complete_click', 6500, { type: 'click', locatorId: 'complete-task' } as never),
      a('complete_confirm', 10000, { type: 'assert', condition: visible('done-badge') } as never),
      a('complete_list', 15000, { type: 'click', locatorId: 'completed-list' } as never),
    ],
    [visible('completed-heading')],
  );
  complete.effects = {
    reads: ['task:seed'],
    writes: ['task:seed'],
    summary: '미리 준비된 테스트 업무 1개를 완료 상태로 변경',
  };
  complete.retryPolicy = 'manual_reset';
  return PlanSchema.parse({
    schemaVersion: '0.1',
    planId,
    projectId,
    revision: 1,
    title: '로그인 뒤, 실제 기능을 보여주세요',
    intent: '업무를 추가하고 완료하는 흐름',
    target: { baseUrl: origin, allowedOrigins: [origin] },
    auth: { mode: 'form', authRef, expiresAt: new Date(Date.now() + 7200000).toISOString() },
    format: {
      width: 1280,
      height: 720,
      targetDurationMs: 60000,
      maxDurationMs: 75000,
      language: 'ko-KR',
    },
    locators: [
      locator('dashboard', '프로젝트 현황'),
      locator('all-tasks', '모든 업무 보기 ↗', 'role', 'link'),
      locator('tasks-heading', '모든 업무'),
      locator('new-heading', '새 업무 추가'),
      locator('title-field', '업무 제목', 'label'),
      locator('description-field', '업무 설명', 'label'),
      locator('save-task', '업무 저장', 'role', 'button'),
      locator('created-title', '데모 영상 만들기'),
      locator('seed-title', '포트폴리오 소개 작성'),
      locator('complete-task', '완료 처리', 'role', 'button'),
      locator('done-badge', 'done-badge', 'testId'),
      locator('completed-list', '완료 목록 보기', 'role', 'link'),
      locator('completed-heading', '완료한 업무'),
    ],
    scenes: [overview, create, complete],
    createdAt: new Date().toISOString(),
  });
}
