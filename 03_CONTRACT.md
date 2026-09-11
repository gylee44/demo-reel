# 웹앱 데모 영상 자동 생성 — 공유 계약 초안

> 2026-09-11 갱신: 사용자가 실서비스 전환을 승인했습니다. 현재 구현·배포 경계는 [README](README.md)와 [DEPLOYMENT](DEPLOYMENT.md), 검증 사실은 [TESTING](TESTING.md)을 따릅니다. 아래 v0.1 문서의 미확정·PoC 상태는 작성 당시 기록입니다.
작성일: 2026-09-09 · 계약: v0.1 · 고정 PoC 구현. 실행 가능한 스키마는 `packages/contracts/src/index.ts`, 실제 API는 `apps/api/src/app.ts` 참조

이 문서는 Plan·API·상태 모델의 유일한 설계 정의다. [요구사항](01_REQUIREMENTS.md)과 [시스템 설계](02_ARCHITECTURE.md)는 이를 참조한다. 구현 시 `packages/contracts/`의 런타임 스키마에서 타입·API 명세를 생성하고 이 문서를 같은 변경으로 갱신한다. 설명 문서와 코드가 따로 계약을 발전시키지 않는다. 공유 계약 변경은 구현 전에 A/B에 영향을 공유한다.

## 1. 공통 규칙

- 식별자는 불투명 문자열이며 배열 위치를 식별자로 쓰지 않는다. 삭제한 ID는 재사용하지 않는다.
- 시간 단위는 밀리초, 날짜는 UTC ISO 8601이다. 사용자 일정 표시는 한국 시간으로 변환한다.
- 스키마 버전과 편집 버전을 분리한다. 서버는 성공한 편집마다 `revision`을 1 증가시킨다.
- 실행은 `planId + revision + approvalId`로 승인된 스냅샷에 고정된다. 나중에 편집한 계획은 기존 실행을 바꾸지 않는다.
- 모든 API는 요청자의 프로젝트 소유권을 검사한다. 비밀 참조를 아는 것만으로 인증 자료에 접근할 수 없다.
- Plan에는 계정·암호·쿠키·토큰을 담지 않는다. 테스트용 업무 이름 등 비밀이 아닌 입력만 허용한다.
- 알 수 없는 필드·액션, 순환 의존성, 없는 ID 참조, 허용 범위 밖 URL은 검증 오류다.

## 2. 핵심 모델

| 모델 | 역할 |
|---|---|
| Project | 사용자의 대상 앱·요청 의도·소유권 |
| AuthHandle | 암호화된 인증 자료를 가리키는 공개 가능한 불투명 참조와 만료 정보 |
| PlanVersion | 편집 가능한 계획의 불변 버전. 새 편집은 새 버전 |
| ValidationReport | 특정 계획 버전에 대한 정적·DOM 검사 결과와 관측 근거 |
| Approval | 사용자가 확인한 계획 버전·검증 보고서·데이터 변경 범위 |
| Job | 승인 계획의 실행 또는 복구 요청 |
| SceneAttempt | 한 장면의 한 번의 실행. 원본 클립·부작용·실패 원인을 기록 |
| RenderManifest | 합성에 사용할 정확한 장면 시도·음성·자막·설정의 목록 |
| Artifact | 원본 클립·음성·자막·최종 MP4·보호된 진단 이미지 |

## 3. Plan 스키마

### 최상위 필드

| 필드 | 형식 | 의미·규칙 |
|---|---|---|
| `schemaVersion` | 문자열, `0.1` | 계약 호환성 버전 |
| `planId`, `projectId` | ID | 계획과 소유 프로젝트 |
| `revision` | 양의 정수 | 편집 버전, 서버 부여 |
| `title`, `intent` | 문자열 | 영상 제목과 사용자가 보여줄 기능 |
| `target` | 객체 | `baseUrl`, `allowedOrigins`. 실행 이동은 승인된 대상 범위로 제한 |
| `auth` | 객체 | `mode: form / storage_state / none`, `authRef`, `expiresAt`. none이면 뒤 두 필드 null |
| `format` | 객체 | 폭 1280·높이 720, 목표 길이 60000, 최대 길이 75000, 언어 `ko-KR`. 출력 인코딩은 RenderProfile로 관리 |
| `locators` | Locator 배열 | 장면에서 ID로 참조할 대상 목록 |
| `scenes` | Scene 배열 | 1~6개, 배열 순서는 영상 순서이며 의존성에도 부합해야 함 |
| `createdAt` | 날짜 | 버전 생성 시각 |

AuthHandle의 실제 유효 상태는 서버 저장소가 관리한다. 계획의 만료 정보는 UI용 스냅샷이며 실행 시 재검사한다. 같은 사용자·대상·인증 방식으로 인증 자료만 교체하면 새 계획 승인 없이 인증 상태를 복구할 수 있다. 앱·계정의 의미나 조작 권한 범위가 바뀌면 계획을 재검증하고 새 승인한다.

### Locator

| 필드 | 형식 | 의미·규칙 |
|---|---|---|
| `id` | ID | 대상 식별자 |
| `strategy` | `role / label / testId / css` | role·label·testId 우선, CSS는 실제 관측 근거가 있을 때 사용 |
| `value` | 문자열 또는 제한된 값 참조 | 접근 가능한 이름·레이블·test id·CSS. role의 경우 이름이며 `role` 필드도 필수 |
| `role` | 문자열 또는 null | button, textbox 등. role 전략에만 사용 |
| `exact` | boolean | 이름·레이블 문자열은 기본 true. CSS에는 적용하지 않음 |
| `scopeLocatorId` | ID 또는 null | 특정 행·영역 아래로 대상을 좁힘. 순환 scope 금지 |
| `evidenceId` | ID | 이 대상 또는 반복 구조를 실제 관측한 근거. 서버가 소유권과 존재 확인 |

일반 값 참조는 문자열 리터럴 또는 같은 계획에서 미리 선언된 `SceneAttempt.outputs` 경로만 허용한다. 임의 템플릿 코드·JavaScript 평가를 허용하지 않는다. CSS 값에 동적 데이터를 끼워 넣는 범용 평가기는 두지 않는다. 동적 데이터 한정은 role·label의 정확 일치와 scope 조합을 사용한다.

검증 상태·매칭 수·확인 시각은 Locator에 덮어쓰지 않고 ValidationReport에 기록한다. 다른 계획 버전의 보고서를 승인 근거로 재사용하지 않는다.

### Scene

| 필드 | 형식 | 의미·규칙 |
|---|---|---|
| `id`, `title`, `purpose` | 문자열 | 안정된 ID, 화면 제목, 장면에서 보여줄 가치 |
| `entry` | 객체 | `url`, `readyConditions[]`. URL은 문자열 또는 앞 장면의 URL 출력 참조이며, 해석한 URL은 허용 origin에 속해야 함 |
| `dependsOn` | 장면 ID 배열 | 필요한 앞 장면. 영상 순서상 앞에 있어야 하고 순환 불가 |
| `preconditions` | Condition 배열 | 이미 있어야 할 데이터·화면·인증 조건 |
| `actions` | Action 배열 | 순서대로 수행, 최대 20개 |
| `postconditions` | Condition 배열 | 성공 판정 조건. 클릭이 끝났다는 이유만으로 성공 처리하지 않음 |
| `narration` | 객체 | `text`, `estimatedDurationMs`. 추정 길이는 안내용 |
| `timing` | 객체 | `maxDurationMs` 최대 30000, `tailHoldMs` 기본 600, `maxFreezeMs` 최대 3000 |
| `effects` | 객체 | `reads[]`, `writes[]` 자원 키, `summary` 사용자에게 보일 변경 내용 |
| `retryPolicy` | enum | `read_only / verify_before_repeat / manual_reset` |
| `recoveryConditions` | 객체 또는 null | verify_before_repeat에서는 `alreadyCompleted[]`, `safeToRepeat[]`가 모두 비어 있지 않은 Condition 배열. 다른 정책에서는 null |
| `outputs` | OutputBinding 배열 | 후속 장면에서 사용할 제한된 결과값 추출 정의 |

데이터 쓰기 여부는 모델의 자기 신고만 신뢰하지 않는다. 계획 검토에서 변경 요약을 명시하고, 실행기가 지원하는 액션 정책과 관측 결과로 대조한다. 결과를 확인할 수 없는 쓰기 장면에 read_only 정책을 허용하지 않는다.

복구 시 alreadyCompleted가 모두 성립하면 데이터 변경을 반복하지 않는다. 다시 찍을 내용에 생성 과정 자체가 필요하다면 새 데이터 키 또는 사용자 초기화가 필요하다. safeToRepeat만 모두 성립하면 승인된 장면을 다시 실행할 수 있다. 둘 다 성립하거나 둘 다 확인할 수 없으면 자동 복구하지 않는다. 일반적인 앱의 초기화 API를 추측해 호출하지 않는다.

### Action·Condition·OutputBinding

Action 공통 필드는 `id`, `type`, `atMs`, `timeoutMs`다. `atMs`는 촬영 시작 뒤 가장 이른 실행 시각이며, 이전 액션이 끝나야 다음 액션을 실행한다. 기본 제한 시간은 10000ms, 허용 상한은 30000ms이며 장면·작업의 남은 제한 시간을 넘을 수 없다.

| Action type | 추가 필드 | 동작 |
|---|---|---|
| `navigate` | `url` | 문자열 또는 앞 장면의 URL 출력 참조를 해석·검증 후 이동. 준비 조건을 다음 액션에서 확인 |
| `click` | `locatorId` | 유일한 대상 확인 → 커서 이동 → 실제 클릭 |
| `fill` | `locatorId`, `value` | 표시 가능한 테스트 값을 폼에 입력 |
| `select` | `locatorId`, `value` | 지원하는 네이티브 선택 요소의 값 선택 |
| `press` | `locatorId`, `key` | Enter·Tab·Escape 등 서버의 제한된 키 목록만 허용 |
| `scroll` | `deltaY` | 제한된 거리만 스크롤. 화면 밖 위치 추측 클릭 금지 |
| `waitFor` | `condition` | 고정 긴 sleep 대신 구체적 조건 대기 |
| `assert` | `condition` | 성공·중간 결과 확인 |

Condition은 `type: visible / hidden / textEquals / urlMatches / countEquals`, 필요한 `locatorId`, 비교값을 가진다. `urlMatches`는 허용 origin 안의 명시된 URL·경로 패턴만 허용한다. 임의 코드·범용 정규식 실행을 입력으로 받지 않는다. count 비교의 값은 0 이상의 정수다.

OutputBinding은 `name`, `source: text / href / currentUrl`, 필요한 `locatorId`로 구성한다. href·URL 결과는 허용 origin과 데이터 형식을 다시 검증한다. 출력에서 비밀 필드나 전체 HTML을 수집하지 않는다. 이후 장면이 참조하면 `dependsOn`에 해당 원본 장면이 반드시 포함되어야 한다.

로그인은 영상 액션 목록과 분리한다. Auth 어댑터만 비밀 저장소의 값을 폼에 입력할 수 있다. Plan의 일반 fill을 이용해 비밀번호를 입력하지 않는다.

폼 인증의 비밀값과 별도로 AuthProfile에 `loginUrl`, `usernameLocator`, `passwordLocator`, `submitLocator`, `successUrl`, `successConditions[]`를 둔다. Locator는 실제 로그인 DOM을 관측한 근거를 가지며, 프로필 수정 시 연결·계획 검증을 다시 수행한다. 로그인에 추가 입력·팝업·봇 탐지 처리가 필요한 경우 초기 폼 모드 범위 밖으로 판정하고 지원 가능한 세션 경로를 안내한다.

## 4. 검증·승인·편집

ValidationReport는 `reportId`, `planId`, `revision`, `checkedAt`, `expiresAt`, `issues[]`, `targets[]`를 포함한다. 기본 유효 기간 제안은 10분이며, 이것이 외부 앱의 변경을 막아 주지는 않는다.

| 대상 상태 | 의미 | 승인 가능 여부 |
|---|---|---|
| `verified` | 관측 상태에서 정확한 대상과 조작 가능 여부 확인 | 가능, 실행 직전 재검사 |
| `runtime_required` | 관측된 구조를 근거로 선행 액션 뒤에만 매칭 가능 | 조건과 위험을 UI에 표시하고 승인 가능 |
| `blocked` | 근거 없음·불명확한 대상·미지원 요소·준비 불가 | 불가 |

issues에는 `code`, `sceneId`, `actionId`, `fieldPath`, `message`, `severity`가 있다. 오류가 있으면 승인 불가다. 모든 구조 검사를 통과하고 blocked 대상이 없을 때만 승인할 수 있다.

Approval은 `approvalId`, `planId`, `revision`, `reportId`, `approvedAt`, `acceptedEffectsHash`를 포함한다. 데이터 변경 요약과 조건부 검증 내용을 확인한 사용자의 승인 기록이다. 저장·승인·작업 생성은 버전 일치를 서버에서 원자적으로 확인한다. 작업 시작 시 보고서가 만료되었으면 재검증으로 돌리고, 변경된 조작은 재승인을 요구한다.

## 5. 상태와 실행 결과

| 대상 | 상태값 | 전이 규칙 |
|---|---|---|
| 계획 처리 | `draft`, `validating`, `needs_changes`, `ready_for_review`, `approved` | 검사 오류 → needs_changes. 유효 결과 → ready_for_review. 사용자 승인만 approved. 편집은 새 draft 버전 |
| 작업 | `queued`, `running`, `needs_action`, `succeeded`, `failed`, `cancelled` | 처리 시작 → running. 수정·재인증·상태 확인 필요 → needs_action. 복구는 원본을 보존하는 새 Job |
| 장면 시도 | `pending`, `running`, `succeeded`, `failed`, `skipped` | 선행 실패로 실행하지 않은 장면은 skipped. 성공 클립 재사용은 별도 reusedFromAttemptId로 표현 |
| 작업·장면 단계 | `preflight`, `audio`, `capture`, `render`, `compose`, `verify` | 해당 모델에 맞는 단계만 사용. 재사용한 단계는 다시 실행 중으로 표시하지 않음 |
| 외부 변경 결과 | `none`, `confirmed`, `unknown` | 실제 변경과 완료 기록 사이 장애는 unknown. 자동 반복 금지 |

SceneAttempt에는 `attemptId`, `jobId`, `sceneId`, `planRevision`, `stage`, `status`, `startedAt`, `finishedAt`, `rawClipArtifactId`, `renderedArtifactId`, `audioArtifactId`, `outputs`, `effectOutcome`, `failure`를 둔다. 성공 시 원본·합성 클립과 측정된 길이를 기록한다. 화면·음성 처리 단계의 결과는 별도 artifact 참조로 이어진다.

failure는 `code`, `message`, `sceneId`, `actionId`, `locatorId`, `screenshotArtifactId`, `suggestedAction`을 포함한다. 없는 값은 null이다. 내부 스택·쿠키·암호·외부 앱의 민감한 응답을 UI에 전달하지 않는다.

주요 오류 코드: `INVALID_PLAN`, `STALE_REVISION`, `VALIDATION_EXPIRED`, `URL_BLOCKED`, `AUTH_FAILED`, `AUTH_EXPIRED`, `AUTH_UNSUPPORTED`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `ACTION_TIMEOUT`, `PRECONDITION_FAILED`, `EFFECT_UNKNOWN`, `DURATION_EXCEEDED`, `TTS_FAILED`, `RENDER_FAILED`, `QUOTA_EXCEEDED`, `STORAGE_FULL`, `WORKER_INTERRUPTED`.

RenderManifest는 `manifestId`, `planId`, `revision`, 순서가 고정된 `sceneArtifacts[]`, `renderProfileVersion`, `outputArtifactId`를 가진다. sceneArtifacts는 장면 ID·선택한 시도 ID·원본/음성/자막 참조·최종 길이·캐시 키를 포함한다. 이전 실행과 새 실행의 결과를 우연히 섞지 않는다.

재사용 캐시 키에는 액션·대상·진입 조건·입력·실행 의존 결과·촬영 프로필을 포함한다. 렌더 캐시 키에는 원본 클립·내레이션/음성·자막·타이밍·렌더 설정을 포함한다. 외부 앱이 달라졌는지 완벽하게 감지하는 캐시는 아니며 재사용 전에 시작·결과 조건의 유효성을 판단한다.

## 6. API 초안

경로 접두사는 `/api/v1`이다. 오류 응답은 `{ error: { code, message, details, requestId } }`로 통일한다. 파일·인증 API도 소유권 검사를 적용한다.

| Method · Path | 요청 핵심 | 응답·의미 |
|---|---|---|
| `POST /projects` | `targetUrl`, `intent`, 선택 `repoUrl` | 201, Project. 작업 소유 세션 설정 |
| `POST /projects/:id/auth` | 인증 방식, 비밀값 또는 제한 크기의 세션 파일 | 201, AuthHandle. 비밀값 반환 없음 |
| `DELETE /projects/:id/auth/:authRef` | 없음 | 204. 인증 자료 삭제. 진행 중이면 안전 중단 요청 |
| `POST /projects/:id/plans` | `authRef` 또는 none | 202, `operationId`. DOM 관측·계획 생성 시작 |
| `GET /operations/:id` | 없음 | 처리 상태, 완료 시 `planId` 또는 `reportId`, 오류 |
| `GET /plans/:id` | 선택 revision | 200, PlanVersion과 계획 처리 상태 |
| `PUT /plans/:id` | `expectedRevision`, 전체 편집 내용 | 200, 새 PlanVersion. 불일치 409 |
| `POST /plans/:id/validations` | `revision` | 202, operationId. 버전 고정 검증 |
| `GET /validations/:reportId` | 없음 | 200, ValidationReport |
| `POST /plans/:id/approvals` | `revision`, `reportId`, `acceptedEffectsHash` | 201, Approval. 오류·만료·버전 불일치 시 거부 |
| `POST /jobs` | `planId`, `revision`, `approvalId` | 202, Job. 비용·한도 예약과 큐 등록 |
| `GET /jobs/:id` | 선택 `If-None-Match` 헤더 | 200, JobSnapshot와 ETag. 조건부 조회에서 변화 없으면 304 |
| `POST /jobs/:id/cancel` | 없음 | 202, 취소 요청 접수. 실제 정리 후 cancelled |
| `POST /jobs/:id/recovery-preview` | `sceneIds[]`, `mode`, 대상 `planId`, `revision` | 200, 아래 RecoveryPreview. 아직 실행하지 않음 |
| `POST /jobs/:id/recoveries` | `previewId`, 대상 `approvalId` | 202, 원본을 참조하는 새 Job. 영향 범위·버전이 달라졌으면 409 |
| `GET /artifacts/:id/download` | 없음 | 200, 소유자용 짧은 유효기간 다운로드 URL·만료 시각 |

자격증명 업로드를 제외한 비동기 생성·복구 요청에는 `Idempotency-Key`를 사용한다. 같은 소유자·같은 경로·같은 키·같은 본문은 기존 응답을 반환하고, 같은 키에 다른 본문은 409다. 같은 의미의 요청이라도 키가 다르면 한도·동시 작업 검사를 거쳐 새 요청으로 처리한다.

실제 상태를 변경하는 요청은 CSRF 검증을 적용한다. 삭제·취소·이미 완료된 요청도 중복 호출 시 결과가 일관되어야 한다.

### JobSnapshot

`jobId`, `version`, `status`, `stage`, `planId`, `revision`, `sceneAttempts[]`, `completedSceneCount`, `totalSceneCount`, `outputArtifactId`, `failure`, `expiresAt`을 포함한다. 정확한 처리 시간을 알 수 없을 때 임의의 남은 시간이나 진행률을 계산하지 않는다. A는 장면 개수·현재 단계·대기를 구분해 표시한다.

ETag는 소유권 확인 뒤 해당 JobSnapshot의 version을 기준으로 생성한다. 응답은 다른 사용자에게 공유 캐시되지 않도록 private 정책을 사용한다.

### RecoveryPreview

`previewId`, `baseJobVersion`, `targetPlanRevision`, `mode: recapture / rerender / compose`, `captureSceneIds[]`, `renderSceneIds[]`, `reuseArtifactIds[]`, `requiresAuth`, `requiresStateReset`, `reasons[]`, `expiresAt`을 포함한다. 서버는 선택한 장면의 의존 관계와 실제 산출물을 확인해 영향 범위를 계산한다.

사용자에게 “이 장면 다시 만들기”를 누르면 무엇을 다시 찍고 무엇을 재사용할지 보여준다. requiresStateReset이면 앱 상태 정리 후 새 검증을 요구한다. preview의 버전·인증·데이터 조건이 달라지면 새 preview를 받아야 한다.

## 7. B 내부 인터페이스

이 인터페이스는 B 영역의 교체 지점이다. A는 아래 구현을 읽을 필요가 없다.

| 인터페이스 | 입력 → 출력 | 책임 |
|---|---|---|
| Planner | 요청 의도·정제된 관측 근거 → DraftPlan | 외부 콘텐츠를 데이터로 취급. PoC는 고정 샘플 |
| AuthProvider | AuthHandle·대상 → 보호된 RuntimeSession | 비밀 해제·로그인·유효성·폐기 |
| TargetValidator | PlanVersion·RuntimeSession → ValidationReport | 실제 DOM 대조. 데이터 변경을 숨겨 수행하지 않음 |
| SceneExecutor | 승인 Scene·의존 출력·RuntimeSession → SceneAttempt | 고정 액션, 녹화·부작용·진단 기록 |
| Narrator | 텍스트·음성 설정 → AudioArtifact·실측 길이·선택 타이밍 | PoC는 고정 음원. AI 공급자 차이 은닉 |
| Renderer | 원본·음성·자막·타이밍 → RenderedScene | 규격 통일, 시간 상한, 자막·커서 등 처리 |
| Composer | RenderManifest → FinalArtifact | 정확한 장면 조합과 MP4 검사 |
| ArtifactStore | 객체 키·파일 스트림 ↔ 보호된 Artifact | 로컬/오브젝트 저장소 교체, 삭제·만료 |

RuntimeSession과 원본 비밀값은 공개 API 응답 타입에 포함하지 않는다. API와 워커 간 큐에는 비밀값 대신 소유권이 있는 참조를 전달한다.

## 8. 계약 검증 기준

- 같은 정상·실패·복구 예제로 A 화면과 B API를 검증한다.
- 잘못된 상태값·중복 ID·순환 의존·다른 버전 승인·비밀값 혼입을 서버가 거부해야 한다.
- 예제만 통과했다고 실제 외부 앱 실행까지 검증됐다고 보지 않는다.
- 필드 추가·삭제·의미 변경은 A/B 영향과 하위 호환성을 먼저 공유한다.
- 구현 전 남은 작업은 실행 가능한 스키마·API 명세·공통 예제를 만드는 것이다. 이 문서만으로 타입 검사나 런타임 검증을 수행한 것은 아니다.

## 서비스 전환 추가 계약 (2026-09-11)

- `GET /api/v1/capabilities`: `mode: service|poc`, `ready`, `auth: email-password`. 서비스 모드에서 고정 결과로 대체하지 않는다.
- `POST /api/v1/account/register`, `/login`: `{email,password}`. 서버 세션 쿠키를 발급한다. `/logout`은 취소, `GET /account/me`는 현재 사용자, `POST /account/password`는 `{currentPassword,newPassword}`이며 기존 모든 세션을 취소한다.
- 서비스 모드의 모든 프로젝트·계획·작업·파일 API는 회원 세션이 필요하다. `GET /api/v1/projects`는 해당 계정의 최근 프로젝트와 작업 참조를 반환한다.
- 프로젝트 생성은 `allowedOrigins`(전체 최대 5개), `discoveryUrls`(추가 최대 5개)를 받는다. 공개 HTTPS와 연결 origin 범위만 허용한다.
- 로그인 정보는 `packages/contracts/src/connection.ts`의 `AuthInputSchema`를 따른다. 폼 방식은 로그인 URL·사용자/암호/제출 대상·성공 URL/대상을 포함한 `profile`이 필수다. 세션 방식은 `verifyUrl`, `successTarget`, 쿠키/localStorage 상태가 필요하다. 이 설정과 비밀값은 암호화해 보관하고 Plan에는 authRef만 연결한다.
- 계획 요청의 authRef를 생략하면 인증 없는 공개 화면 모드가 된다. 키·워커 준비 누락은 `SERVICE_NOT_READY`(503)로 반환한다.
- 파일 메타데이터는 내부 `objectKey`를 가질 수 있다. 다운로드 API는 소유권·보관 기한 확인 후 5분 만료 S3 서명 URL을 반환한다.
- 모델 출력은 관측된 locator 목록과 실행 정책을 검증한다. 수정한 locator가 원래 관측 근거와 다르면 재검증에서 차단한다.
