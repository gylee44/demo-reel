# DemoReel

개발자가 앱 URL·테스트 로그인 정보·보여줄 기능을 입력하면 실제 화면을 관측하고, AI가 제안한 실행 계획을 검토·승인한 뒤 한국어 내레이션과 자막이 있는 데모 영상을 만드는 서비스입니다.

2026-09-11 구현 기준: **Vercel 프론트·API + 별도 녹화 워커**, **OpenAI 계획 생성·음성**, **이메일·비밀번호 로그인**. 모든 인증값은 [.env.example](.env.example)에 공란으로 두었습니다. 외부 키 입력과 배포 후 실연동 검증은 아직 수행하지 않았습니다.

## 코드 영역

| 영역 | 위치 | 역할 |
|---|---|---|
| 프론트 | `apps/web/src` | 회원가입·로그인, 앱 연결 폼, 계획 편집·검증·승인, 진행·복구·재생, 이전 작업 |
| 백엔드 | `apps/api/src` | 계정·서버 세션, 작업 소유권, 계획 버전, 동시성·한도, 큐 등록, 다운로드 |
| Vercel 진입점 | `api/index.ts`, `vercel.json` | 가벼운 API 요청 처리. 브라우저·인코딩·스키마 변경 없음 |
| 실행 엔진 | `apps/worker/src` | 범용 폼/세션 로그인, 지정 화면 관측, AI 계획, DOM 검증, 장면 녹화·부분 복구 |
| AI·음성 | `apps/worker/src/providers`, `narration.ts` | Responses 구조화 출력, Speech API, 문장별 음성 길이·자막 |
| 공유 계약 | `packages/contracts/src` | Plan·액션·로그인 설정 스키마, 실행·복구 정책 |
| 저장·네트워크 | `packages/runtime/src` | 공개 HTTPS/IP 검증, 비공개 S3 업로드·서명 URL·복원 |
| 테스트 전용 | `apps/demo`, `fixtures`, 워커의 `poc-*` | 기존 고정 PoC 회귀 검증. 서비스 기본 경로에서 사용하지 않음 |

## 실행

Node.js 22.12 이상, pnpm, PostgreSQL, Chromium, ffmpeg/ffprobe, 한글 폰트가 필요합니다.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# DATABASE_URL, ENCRYPTION_KEY, OpenAI 및 S3 값을 직접 설정
pnpm db:migrate
pnpm dev:api
# 별도 터미널
pnpm dev:worker
# 별도 터미널
pnpm dev:web
```

웹: `http://127.0.0.1:5173`. 기본값은 서비스 모드입니다. 키가 없거나 워커가 준비되지 않았으면 생성 버튼을 비활성화하고 설정 안내를 표시합니다. 실제 동작처럼 보이게 고정 결과로 대체하지 않습니다.

개발 환경에서 DATABASE_URL을 비우면 기존 전용 로컬 DB `postgres://demo@127.0.0.1:5448/demo_reel`을 사용합니다. 운영 환경은 DATABASE_URL과 ENCRYPTION_KEY가 없으면 시작하지 않습니다.

## 검증

```sh
pnpm check
```

타입 검사 → 전체 단위·통합 테스트 → 프론트 빌드 → 브라우저 E2E를 실행합니다. 테스트는 독립 계정을 만들고, 실제 DB·브라우저·ffmpeg와 모의 OpenAI/S3 응답을 사용합니다. API 키나 유료 호출은 필요하지 않습니다. 프로젝트 전용 테스트 DB를 사용해야 합니다.

2026-09-11 전체 검사: **단위 76개 + 통합 34개 + E2E 5개 = 115개 통과**, 타입 검사·프론트 빌드 통과. 서비스 모드의 별도 연구 노트 앱에서 실제 3장면을 녹화하고 모의 음성 응답·S3 서버로 **51초 MP4**를 생성했습니다. 공급자 비용·실제 음성 품질·배포 성공의 증거는 아닙니다. 상세 내용은 [TESTING.md](TESTING.md)에 있습니다.

## 배포와 지원 범위

[DEPLOYMENT.md](DEPLOYMENT.md)에 Vercel 설정, 워커 구성, 환경변수 담당, DB 마이그레이션, 저장소 권한·보관 정책을 정리했습니다. 운영용 워커 파일은 `infra/worker.Dockerfile`, `infra/worker.compose.yaml`입니다.

공개 HTTPS 앱의 폼 로그인·쿠키/localStorage 세션·로그인 없는 화면을 지원합니다. 앱 주소와 사용자가 지정한 추가 화면을 관측하며, 로그인 요소·성공 조건을 직접 지정합니다. OTP/CAPTCHA, sessionStorage 전용 인증, 팝업·WebSocket, 결제·삭제·초대·권한 변경 시연은 지원하지 않습니다. 이메일 확인·비밀번호 분실 메일은 아직 포함하지 않습니다.

기존 고정 PoC를 재현하려면 **명시적으로** `POC_MODE=true`를 지정하고 `apps/demo`를 실행하세요. `compose.yaml`은 이 테스트 전용 구성입니다. 운영 `NODE_ENV=production`에서는 PoC 모드를 거부합니다. 기존 PoC 영상과 장애 복구 증거는 [TESTING.md](TESTING.md)의 기록을 유지합니다.
