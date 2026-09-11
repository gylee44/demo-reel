import type { Plan } from './index.ts';
import { AppError } from '../../../apps/api/src/security.ts';
export function assertExecutionPolicy(plan: Plan) {
  for (const scene of plan.scenes) {
    if (
      scene.actions.some((a) => ['click', 'fill', 'select', 'press'].includes(a.type)) &&
      (!scene.effects.writes.length || scene.retryPolicy === 'read_only')
    )
      throw new AppError(
        'INVALID_PLAN',
        '입력·클릭이 있는 장면에는 데이터 변경 범위와 복구 방식을 지정해 주세요.',
      );
    for (const action of scene.actions)
      if ('locatorId' in action) {
        const locator = plan.locators.find((l) => l.id === action.locatorId);
        if (
          locator &&
          typeof locator.value === 'string' &&
          /password|비밀번호|결제|구매|삭제|초대|권한|sign.?out|log.?out|delete|purchase|checkout|payment/i.test(
            locator.value,
          )
        )
          throw new AppError(
            'UNSUPPORTED_ACTION',
            '비밀번호 입력·결제·삭제·초대·권한 변경은 영상 실행에서 지원하지 않습니다.',
          );
      }
  }
}
