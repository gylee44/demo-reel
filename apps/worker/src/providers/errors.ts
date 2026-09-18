import { AppError } from '../../../api/src/security.ts';
/**
 * Rate limiting and quota exhaustion both arrive as HTTP 429 but need opposite advice:
 * one clears in seconds, the other never clears until someone adds credits. Only the
 * provider's machine-readable reason field is inspected; the response body is never
 * echoed into a message or a log.
 */
export async function providerFailure(response: Response) {
  if (response.status !== 429)
    return new AppError(
      'PROVIDER_FAILED',
      'AI 제공자가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      502,
    );
  let exhausted = false;
  try {
    const body: any = await response.json();
    const reason = [body?.error?.type, body?.error?.code]
      .filter((v) => typeof v === 'string')
      .join(' ');
    exhausted = /insufficient_quota|credit_balance_exhausted/i.test(reason);
  } catch {}
  return exhausted
    ? new AppError(
        'PROVIDER_QUOTA_EXHAUSTED',
        'AI 제공자의 사용 한도를 초과했습니다. 결제 또는 할당량 설정을 확인해 주세요.',
        502,
      )
    : new AppError(
        'PROVIDER_RATE_LIMIT',
        'AI 제공자 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요.',
        502,
      );
}
