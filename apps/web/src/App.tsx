import { LoginProfileFields, emptyLoginProfile } from './LoginProfileFields.tsx';
import { RecentProjects } from './RecentProjects.tsx';
import { useEffect, useRef, useState } from 'react';
import type {
  Plan,
  Scene,
  Action,
  Condition,
  ValidationReport,
  Job,
  RecoveryPreview,
} from '../../../packages/contracts/src/index.ts';
import { api, operation } from './api.ts';
import { moveScene, addReadScene, changeActionType } from './editor.ts';

const stages: Record<string, string> = {
  preflight: '시작 상태 확인',
  audio: '음성 준비',
  capture: '화면 촬영',
  render: '장면 합성',
  compose: '전체 영상 합성',
  verify: '영상 검사',
};
const statuses: Record<string, string> = {
  pending: '대기',
  queued: '대기',
  running: '진행 중',
  succeeded: '완료',
  failed: '실패',
  skipped: '앞 장면 확인 필요',
  needs_action: '확인 필요',
  cancelled: '취소됨',
};
const actionNames: Record<Action['type'], string> = {
  navigate: '화면 이동',
  click: '클릭',
  fill: '텍스트 입력',
  select: '항목 선택',
  press: '키 누르기',
  scroll: '스크롤',
  waitFor: '조건 대기',
  assert: '결과 확인',
};
/** Plain-language summary of a scene so the plan reads as steps, not as a form of raw fields. */
function describeScene(plan: Plan, scene: Scene): string[] {
  const name = (id: string) => {
    const l = plan.locators.find((x) => x.id === id);
    return typeof l?.value === 'string' ? `「${l.value}」` : '지정한 대상';
  };
  return scene.actions.map((a) => {
    switch (a.type) {
      case 'navigate':
        return `${typeof a.url === 'string' ? a.url : '앞 장면의 결과 화면'}(으)로 이동합니다.`;
      case 'click':
        return `${name(a.locatorId)}을(를) 클릭합니다.`;
      case 'fill':
        return `${name(a.locatorId)}에 "${typeof a.value === 'string' ? a.value : '앞 장면의 결과'}"을(를) 입력합니다.`;
      case 'select':
        return `${name(a.locatorId)}에서 "${typeof a.value === 'string' ? a.value : '앞 장면의 결과'}"을(를) 선택합니다.`;
      case 'press':
        return `${name(a.locatorId)}에서 ${a.key} 키를 누릅니다.`;
      case 'scroll':
        return `화면을 ${a.deltaY > 0 ? '아래로' : '위로'} 스크롤합니다.`;
      default:
        return `${describeCondition(plan, a.condition)}을(를) 확인합니다.`;
    }
  });
}
function describeCondition(plan: Plan, c: Condition): string {
  const id = 'locatorId' in c ? c.locatorId : null;
  const l = plan.locators.find((l) => l.id === id);
  return (
    (c.type === 'visible' ? '대상이 화면에 보임' : c.type) +
    (l ? ' · ' + (typeof l.value === 'string' ? l.value : l.id) : '')
  );
}
function FailureEvidence({ artifactId }: { artifactId: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    api(`/artifacts/${artifactId}/download`)
      .then((x) => {
        if (active) setUrl(x.url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [artifactId]);
  return url ? (
    <details className="failure-evidence">
      <summary>실패 시점 화면 보기</summary>
      <img src={url} alt="장면 실패 시점의 실제 앱 화면" />
    </details>
  ) : null;
}
export function App() {
  const [page, setPage] = useState<'connect' | 'review' | 'progress'>('connect'),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const busyRef = useRef(false);
  const [target, setTarget] = useState(''),
    [intent, setIntent] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState('');
  const [mode, setMode] = useState<'form' | 'storage_state' | 'none'>('form'),
    [session, setSession] = useState<unknown>(null),
    [projectId, setProjectId] = useState('');
  const [poc, setPoc] = useState(false),
    [serviceReady, setServiceReady] = useState(false),
    [loginProfile, setLoginProfile] = useState(emptyLoginProfile),
    [discoveryUrls, setDiscoveryUrls] = useState(''),
    [allowedOrigins, setAllowedOrigins] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null),
    [report, setReport] = useState<ValidationReport | null>(null),
    [effectsHash, setEffectsHash] = useState(''),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState(0);
  const [job, setJob] = useState<Job | null>(null),
    [approvalId, setApprovalId] = useState(''),
    [videoUrl, setVideoUrl] = useState(''),
    [preview, setPreview] = useState<RecoveryPreview | null>(null),
    [retryScene, setRetryScene] = useState<string | null>(null);
  // Caption rewrites typed on the result screen, kept per scene until they are sent together.
  const [captions, setCaptions] = useState<Record<string, string>>({}),
    [openCaption, setOpenCaption] = useState<string | null>(null),
    [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    api('/capabilities')
      .then((x) => {
        setPoc(x.mode === 'poc');
        setServiceReady(x.ready);
        if (x.mode === 'poc' && x.demoOrigin) setTarget(x.demoOrigin);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    const restore = async () => {
      const pending = sessionStorage.getItem('demo-reel:operation');
      if (pending) {
        busyRef.current = true;
        setBusy('진행 중인 계획 처리를 이어서 확인하고 있어요.');
        try {
          const op = await operation(pending);
          if (!active) return;
          const result = await api(`/plans/${op.planId}`);
          const validation = await api(`/validations/${op.reportId}`);
          if (!active) return;
          setPlan(result.plan);
          setMode(result.plan.auth.mode);
          setProjectId(result.plan.projectId);
          setEffectsHash(result.effectsHash);
          setReport(validation);
          setPage('review');
        } catch (e) {
          if (active) setError((e as Error).message);
        } finally {
          if (active) {
            busyRef.current = false;
            setBusy('');
          }
        }
        return;
      }
      const saved = sessionStorage.getItem('demo-reel:job');
      if (!saved) return;
      try {
        const ref = JSON.parse(saved);
        if (typeof ref.jobId !== 'string' || typeof ref.approvalId !== 'string')
          throw Error('Invalid reference');
        const previous = await api<Job>(`/jobs/${encodeURIComponent(ref.jobId)}`);
        const result = await api(`/plans/${previous.planId}?revision=${previous.revision}`);
        if (!active) return;
        setPlan(result.plan);
        setMode(result.plan.auth.mode);
        setProjectId(result.plan.projectId);
        setEffectsHash(result.effectsHash);
        setApprovalId(ref.approvalId);
        setJob(previous);
        setPage('progress');
      } catch {
        sessionStorage.removeItem('demo-reel:job');
        if (active) setError('이전 작업을 불러오지 못했습니다. 연결부터 다시 시작해 주세요.');
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (job && approvalId)
      sessionStorage.setItem('demo-reel:job', JSON.stringify({ jobId: job.jobId, approvalId }));
  }, [job?.jobId, approvalId]);
  async function work(label: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 중 오류가 발생했습니다.');
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const interval = setInterval(() => {
      api<Job>(`/jobs/${job.jobId}`)
        .then(setJob)
        .catch((e) => setError(e.message));
    }, 1200);
    return () => clearInterval(interval);
  }, [job?.jobId, job?.status]);
  useEffect(() => {
    if (job?.outputArtifactId)
      api(`/artifacts/${job.outputArtifactId}/download`)
        .then((x) => setVideoUrl(x.url))
        .catch((e) => setError(e.message));
  }, [job?.outputArtifactId]);
  function authPayload() {
    return mode === 'form'
      ? { mode, username, password, ...(!poc ? { profile: loginProfile } : {}) }
      : {
          mode: 'storage_state',
          storageState: session,
          ...(!poc
            ? { verifyUrl: loginProfile.successUrl, successTarget: loginProfile.successTarget }
            : {}),
        };
  }
  async function resume(ref: { jobId: string; approvalId: string }) {
    await work('이전 작업을 불러오고 있어요.', async () => {
      const job = await api<Job>(`/jobs/${ref.jobId}`);
      const result = await api(`/plans/${job.planId}?revision=${job.revision}`);
      setPlan(result.plan);
      setMode(result.plan.auth.mode);
      setProjectId(result.plan.projectId);
      setEffectsHash(result.effectsHash);
      setApprovalId(ref.approvalId);
      setJob(job);
      setPage('progress');
    });
  }
  async function auth() {
    return api(`/projects/${projectId}/auth`, 'POST', authPayload());
  }
  async function connect() {
    await work('테스트 앱에 연결하고 계획을 준비하고 있어요.', async () => {
      sessionStorage.removeItem('demo-reel:job');
      setJob(null);
      const p = await api('/projects', 'POST', {
        targetUrl: target,
        intent,
        ...(!poc
          ? {
              allowedOrigins: allowedOrigins
                .split(/\n/)
                .map((s) => s.trim())
                .filter(Boolean),
              discoveryUrls: discoveryUrls
                .split(/\n/)
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      });
      setProjectId(p.projectId);
      const a =
        mode === 'none' ? {} : await api(`/projects/${p.projectId}/auth`, 'POST', authPayload());
      const pending = await api(
          `/projects/${p.projectId}/plans`,
          'POST',
          a.authRef ? { authRef: a.authRef } : {},
        ),
        op = await operation(pending.operationId);
      const result = await api(`/plans/${op.planId}`);
      setPlan(result.plan);
      setPassword('');
      setSession(null);
      setEffectsHash(result.effectsHash);
      setReport(await api(`/validations/${op.reportId}`));
      setDirty(false);
      setSelected(0);
      setPage('review');
    });
  }
  function edit(next: Plan) {
    setPlan(next);
    setDirty(true);
    setReport(null);
  }
  function updateScene(next: Scene) {
    if (plan) edit({ ...plan, scenes: plan.scenes.map((s, i) => (i === selected ? next : s)) });
  }
  function updateAction(index: number, next: Action) {
    const scene = plan!.scenes[selected];
    updateScene({ ...scene, actions: scene.actions.map((a, i) => (i === index ? next : a)) });
  }
  async function validate() {
    if (!plan) return;
    await work('수정한 계획과 실제 화면을 확인하고 있어요.', async () => {
      let p = plan;
      if (dirty) {
        const saved = await api(`/plans/${plan.planId}`, 'PUT', {
          expectedRevision: plan.revision,
          plan,
        });
        p = saved.plan;
        setPlan(p);
        setEffectsHash(saved.effectsHash);
        setDirty(false);
      }
      const pending = await api(`/plans/${p.planId}/validations`, 'POST', { revision: p.revision }),
        op = await operation(pending.operationId);
      setReport(await api(`/validations/${op.reportId}`));
    });
  }
  async function generate() {
    if (!plan || !report) return;
    await work('승인한 계획으로 작업을 시작하고 있어요.', async () => {
      const approval = await api(`/plans/${plan.planId}/approvals`, 'POST', {
        revision: plan.revision,
        reportId: report.reportId,
        acceptedEffectsHash: effectsHash,
      });
      setApprovalId(approval.approvalId);
      // A finished video keeps its clips: only scenes that were added or changed get re-recorded.
      if (job && !['queued', 'running'].includes(job.status)) {
        setPage('progress');
        setRetryScene(null);
        setPreview(
          await api(`/jobs/${job.jobId}/recovery-preview`, 'POST', {
            sceneIds: [],
            mode: 'compose',
            planId: plan.planId,
            revision: plan.revision,
          }),
        );
        return;
      }
      const next = await api<Job>('/jobs', 'POST', {
        planId: plan.planId,
        revision: plan.revision,
        approvalId: approval.approvalId,
      });
      setJob(next);
      setVideoUrl('');
      setPage('progress');
    });
  }
  /** Rewrites captions on a finished video. The app is never revisited, so nothing is re-recorded. */
  async function applyCaptions() {
    if (!plan || !job) return;
    const narrations = Object.entries(captions)
      .map(([sceneId, text]) => ({ sceneId, text: text.trim() }))
      .filter(
        (n) => n.text && n.text !== plan.scenes.find((s) => s.id === n.sceneId)?.narration.text,
      );
    if (!narrations.length) return;
    await work('자막과 음성만 다시 만들고 있어요. 화면은 다시 찍지 않습니다.', async () => {
      const result = await api<{ job: Job; approvalId: string }>(
        `/jobs/${job.jobId}/narration`,
        'POST',
        { expectedRevision: plan.revision, narrations },
      );
      const saved = await api(`/plans/${result.job.planId}?revision=${result.job.revision}`);
      setPlan(saved.plan);
      setEffectsHash(saved.effectsHash);
      setApprovalId(result.approvalId);
      setJob(result.job);
      setVideoUrl('');
      setCaptions({});
      setOpenCaption(null);
    });
  }
  async function recovery(sceneId: string | null) {
    if (!plan || !job) return;
    setRetryScene(sceneId);
    await work('다시 만들 범위를 확인하고 있어요.', async () =>
      setPreview(
        await api(`/jobs/${job.jobId}/recovery-preview`, 'POST', {
          sceneIds: sceneId ? [sceneId] : [],
          mode: sceneId ? 'recapture' : 'compose',
          planId: plan.planId,
          revision: plan.revision,
        }),
      ),
    );
  }
  async function reauthenticate() {
    await work('테스트 앱에 다시 연결하고 있어요.', async () => {
      await auth();
      setPreview(
        await api(`/jobs/${job!.jobId}/recovery-preview`, 'POST', {
          sceneIds: retryScene ? [retryScene] : [],
          mode: retryScene ? 'recapture' : 'compose',
          planId: plan!.planId,
          revision: plan!.revision,
        }),
      );
    });
  }
  async function recover() {
    await work('선택한 범위를 다시 만들고 있어요.', async () => {
      const next = await api<Job>(`/jobs/${job!.jobId}/recoveries`, 'POST', {
        previewId: preview!.previewId,
        approvalId,
      });
      setJob(next);
      setPreview(null);
      setVideoUrl('');
    });
  }
  const captionsChanged = plan
    ? Object.entries(captions).filter(
        ([id, text]) =>
          text.trim() && text.trim() !== plan.scenes.find((s) => s.id === id)?.narration.text,
      ).length
    : 0;
  const scene = plan?.scenes[selected],
    canApprove =
      !!report &&
      !dirty &&
      !report.issues.some((i) => i.severity === 'error') &&
      !report.targets.some((t) => t.status === 'blocked');
  const connectionInputs = (
    <>
      <div className="auth-choice">
        <button
          type="button"
          className={mode === 'form' ? 'active' : ''}
          onClick={() => setMode('form')}
        >
          테스트 계정
        </button>
        <button
          type="button"
          className={mode === 'storage_state' ? 'active' : ''}
          onClick={() => setMode('storage_state')}
        >
          세션 파일
        </button>
        {!poc && (
          <button
            type="button"
            className={mode === 'none' ? 'active' : ''}
            onClick={() => setMode('none')}
          >
            로그인 없음
          </button>
        )}
      </div>
      {mode === 'form' ? (
        <div className="field-row">
          <label>
            테스트 계정 ID
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            테스트 비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
      ) : mode === 'storage_state' ? (
        <label>
          로그인 상태 파일
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 1024 * 1024) {
                  setError('1MB 이하의 세션 파일을 선택해 주세요.');
                  return;
                }
                file
                  .text()
                  .then((t) => setSession(JSON.parse(t)))
                  .catch(() => setError('올바른 JSON 세션 파일을 선택해 주세요.'));
              }
            }}
          />
        </label>
      ) : (
        <p className="small-note">로그인 없이 열리는 화면을 연결합니다.</p>
      )}
      {!poc && mode !== 'none' && (
        <LoginProfileFields
          profile={loginProfile}
          onChange={setLoginProfile}
          session={mode === 'storage_state'}
        />
      )}
    </>
  );
  return (
    <div className="studio">
      <aside className="rail">
        <a className="logo" href="/">
          D
          <span>
            DEMO
            <br />
            REEL
          </span>
        </a>
        <div className="rail-line" />
        <span className={page === 'connect' ? 'rail-step active' : 'rail-step'}>01</span>
        <span className={page === 'review' ? 'rail-step active' : 'rail-step'}>02</span>
        <span className={page === 'progress' ? 'rail-step active' : 'rail-step'}>03</span>
        <span className="rail-bottom">
          MAKE IT
          <br />
          VISIBLE.
        </span>
      </aside>
      <div className="studio-body">
        <header className="topbar">
          <div>
            <span className="kicker">FROM WORKING APP TO WORKING DEMO</span>
            <b>당신이 만든 기능, 직접 보여주세요.</b>
          </div>
          <span className="poc-tag">
            <i /> {poc ? '고정 시나리오 PoC' : '앱 시연 스튜디오'}
          </span>
        </header>
        <div className="workspace">
          <div className="steps">
            <span className={page === 'connect' ? 'current' : ''}>
              01 <b>앱 연결</b>
            </span>
            <em>→</em>
            <span className={page === 'review' ? 'current' : ''}>
              02 <b>계획 검토</b>
            </span>
            <em>→</em>
            <span className={page === 'progress' ? 'current' : ''}>
              03 <b>영상 만들기</b>
            </span>
          </div>
          {busy && (
            <div role="status" className="notice busy">
              <span className="spinner" />
              {busy}
            </div>
          )}
          {error && (
            <div role="alert" className="notice error">
              {error}
            </div>
          )}
          {page === 'connect' && (
            <section className="connect-grid">
              <div className="intro">
                <p className="eyebrow">YOUR PROJECT, IN ACTION</p>
                <h1>
                  링크 너머의 기능을
                  <br />
                  <span>하나의 영상으로.</span>
                </h1>
                <p className="lede">
                  로그인 뒤의 실제 화면을 조작하고,
                  <br />
                  검토한 계획대로 데모 영상을 만듭니다.
                </p>
                <div className="intro-proof">
                  <span>01</span>
                  <div>
                    <b>먼저 계획을 확인하세요</b>
                    <p>어떤 데이터를 입력하고 무엇을 보여줄지 직접 검토합니다.</p>
                  </div>
                </div>
                <div className="intro-proof">
                  <span>02</span>
                  <div>
                    <b>실제로 동작하는 화면만</b>
                    <p>클릭, 입력, 결과까지. 실제 앱에서 일어난 일을 담습니다.</p>
                  </div>
                </div>
                <div className="intro-proof">
                  <span>03</span>
                  <div>
                    <b>필요한 장면만 다시</b>
                    <p>완성된 클립을 보존하고 바꿔야 할 부분을 확인합니다.</p>
                  </div>
                </div>
              </div>
              <form
                className="connect-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  connect();
                }}
              >
                <div className="card-head">
                  <h2>어떤 기능을 보여줄까요?</h2>
                  <p>시연할 앱과 기능을 연결해 주세요.</p>
                </div>
                <label>
                  앱 주소
                  <input
                    aria-label="앱 주소"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                </label>
                <label>
                  보여줄 기능 한 문장
                  <textarea
                    rows={2}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    required
                  />
                </label>
                {!poc && (
                  <details className="discovery-settings">
                    <summary>탐색할 화면과 연결 도메인</summary>
                    <label>
                      추가 탐색 주소 (한 줄에 하나)
                      <textarea
                        rows={3}
                        value={discoveryUrls}
                        onChange={(e) => setDiscoveryUrls(e.target.value)}
                        placeholder="로그인 후 시연할 화면의 HTTPS 주소"
                      />
                    </label>
                    <label>
                      추가 연결 도메인 (한 줄에 하나)
                      <textarea
                        rows={2}
                        value={allowedOrigins}
                        onChange={(e) => setAllowedOrigins(e.target.value)}
                        placeholder="예: https://api.example.com"
                      />
                    </label>
                    <p className="small-note">
                      지정한 화면을 열람하며, 화면의 요소 이름과 기능 설명을 AI에 전달해 계획을
                      만듭니다. 데이터 변경은 계획을 승인한 뒤 실행합니다.
                    </p>
                  </details>
                )}
                {connectionInputs}
                <div className="privacy-note">
                  테스트 계정만 사용해 주세요. 인증 정보는 영상에 포함하지 않고 실행 종료 후
                  폐기합니다.
                </div>
                <button
                  className="primary wide"
                  disabled={!!busy || !serviceReady || (mode === 'storage_state' && !session)}
                >
                  실행 계획 만들기 <span>→</span>
                </button>
                <p className="small-note">
                  {poc
                    ? '테스트 모드에서는 고정 계획과 음원을 사용합니다.'
                    : !serviceReady
                      ? '영상 생성 서비스 연결을 준비 중입니다. 연결 설정이 완료되면 시작할 수 있습니다.'
                      : 'AI가 생성한 음성과 자막을 사용합니다. 테스트용 계정과 데이터로 진행해 주세요.'}
                </p>
              </form>
            </section>
          )}
          {page === 'connect' && !poc && <RecentProjects onResume={resume} />}
          {page === 'review' && plan && scene && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">REVIEW BEFORE RECORDING</p>
                  <h1>이렇게 보여드릴게요.</h1>
                  <p>장면과 입력 내용을 확인하고, 원하는 흐름으로 수정하세요.</p>
                </div>
                <div className="review-actions">
                  <span className="version">
                    계획 v{plan.revision}
                    {dirty ? ' · 수정 중' : ''}
                  </span>
                  <button className="secondary" onClick={validate} disabled={!!busy}>
                    저장하고 검증
                  </button>
                </div>
              </div>
              <div className="plan-layout">
                <section className="scene-list">
                  <div className="section-cap">
                    장면 구성 <span>{plan.scenes.length}개</span>
                  </div>
                  {plan.scenes.map((s, i) => (
                    <div
                      key={s.id}
                      className={'scene-option ' + (selected === i ? 'selected' : '')}
                    >
                      <button className="scene-select" onClick={() => setSelected(i)}>
                        <span className="scene-number">{String(i + 1).padStart(2, '0')}</span>
                        <div>
                          <b>{s.title}</b>
                          <small>
                            약 {Math.round(s.narration.estimatedDurationMs / 1000)}초 ·{' '}
                            {s.actions.length}개 동작
                          </small>
                        </div>
                      </button>
                      <div className="scene-tools">
                        <button
                          aria-label={`${i + 1}번 장면 위로`}
                          disabled={i === 0}
                          onClick={() => {
                            try {
                              edit(moveScene(plan, i, -1));
                              setSelected(i - 1);
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`${i + 1}번 장면 아래로`}
                          disabled={i === plan.scenes.length - 1}
                          onClick={() => {
                            try {
                              edit(moveScene(plan, i, 1));
                              setSelected(i + 1);
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          ↓
                        </button>
                        <button
                          aria-label={`${i + 1}번 장면 삭제`}
                          disabled={plan.scenes.length === 1}
                          onClick={() => {
                            if (plan.scenes.some((x) => x.dependsOn.includes(s.id))) {
                              setError('이 장면의 결과를 사용하는 후속 장면이 있습니다.');
                              return;
                            }
                            edit({ ...plan, scenes: plan.scenes.filter((x) => x.id !== s.id) });
                            setSelected(0);
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="add-scene"
                    disabled={plan.scenes.length >= 6}
                    onClick={() => {
                      try {
                        edit(addReadScene(plan));
                        setSelected(plan.scenes.length);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    ＋ 조회 장면 추가
                  </button>
                  <div className="plan-tip">
                    장면을 바꾸면 다시 검증합니다.
                    <br />
                    이미 승인한 실행은 바뀌지 않습니다.
                  </div>
                </section>
                <section className="scene-editor">
                  <div className="editor-heading">
                    <span className="eyebrow">SCENE {String(selected + 1).padStart(2, '0')}</span>
                    <span className={'pill ' + (scene.effects.writes.length ? 'amber' : '')}>
                      {scene.effects.writes.length ? '테스트 데이터 변경' : '화면 조회'}
                    </span>
                  </div>
                  <label>
                    장면 제목
                    <input
                      value={scene.title}
                      onChange={(e) => updateScene({ ...scene, title: e.target.value })}
                    />
                  </label>
                  <label hidden={!advanced}>
                    시작할 화면
                    <input
                      value={
                        typeof scene.entry.url === 'string' ? scene.entry.url : '앞 장면의 결과 URL'
                      }
                      readOnly={typeof scene.entry.url !== 'string'}
                      onChange={(e) =>
                        updateScene({ ...scene, entry: { ...scene.entry, url: e.target.value } })
                      }
                    />
                  </label>
                  <label className="narration-label">
                    이 장면에서 나올 내레이션 · 자막{' '}
                    <span>예상 약 {Math.round(scene.narration.estimatedDurationMs / 1000)}초</span>
                    <textarea
                      rows={4}
                      value={scene.narration.text}
                      onChange={(e) =>
                        updateScene({
                          ...scene,
                          narration: { ...scene.narration, text: e.target.value },
                        })
                      }
                    />
                    <small>영상이 만들어진 뒤에도 이 문장만 따로 고칠 수 있어요.</small>
                  </label>
                  <div className="scene-steps">
                    <div className="section-cap">
                      이 장면에서 하는 일 <span>순서대로 실행돼요</span>
                    </div>
                    <ol>
                      {describeScene(plan, scene).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ol>
                    <div className="effect-box">
                      <b>
                        {scene.effects.writes.length ? '바뀌는 데이터' : '데이터를 바꾸지 않아요'}
                      </b>
                      <p>{scene.effects.summary}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-button advanced-toggle"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced(!advanced)}
                  >
                    {advanced ? '자세한 설정 접기 ▲' : '자세히 편집하기 (동작·시간·대상) ▼'}
                  </button>
                  <div className="section-cap" hidden={!advanced}>
                    실행할 동작 <span>위에서 아래 순서로 실행</span>
                  </div>
                  <div className="actions" hidden={!advanced}>
                    {scene.actions.map((a, i) => (
                      <div className="action-row" key={a.id}>
                        <span className="action-index">{i + 1}</span>
                        <div className="action-fields">
                          <div className="field-row compact">
                            <label>
                              동작
                              <select
                                value={a.type}
                                onChange={(e) =>
                                  updateAction(
                                    i,
                                    changeActionType(a, e.target.value as Action['type'], plan),
                                  )
                                }
                              >
                                {Object.entries(actionNames).map(([v, label]) => (
                                  <option key={v} value={v}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              시작 시각 (초)
                              <input
                                type="number"
                                min={0}
                                max={29}
                                step={0.1}
                                value={a.atMs / 1000}
                                onChange={(e) =>
                                  updateAction(i, {
                                    ...a,
                                    atMs: Math.round(Number(e.target.value) * 1000),
                                  })
                                }
                              />
                            </label>
                          </div>
                          {'locatorId' in a && (
                            <label>
                              조작 대상
                              <select
                                value={a.locatorId}
                                onChange={(e) =>
                                  updateAction(i, { ...a, locatorId: e.target.value })
                                }
                              >
                                {plan.locators.map((l) => (
                                  <option key={l.id} value={l.id}>
                                    {typeof l.value === 'string' ? l.value : l.id}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {'value' in a && (
                            <label>
                              입력할 값
                              <input
                                value={typeof a.value === 'string' ? a.value : '앞 장면의 결과'}
                                readOnly={typeof a.value !== 'string'}
                                onChange={(e) => updateAction(i, { ...a, value: e.target.value })}
                              />
                            </label>
                          )}
                          {a.type === 'navigate' && (
                            <label>
                              이동 주소
                              <input
                                value={typeof a.url === 'string' ? a.url : '앞 장면의 결과'}
                                readOnly={typeof a.url !== 'string'}
                                onChange={(e) => updateAction(i, { ...a, url: e.target.value })}
                              />
                            </label>
                          )}
                          {a.type === 'scroll' && (
                            <label>
                              스크롤 거리
                              <input
                                type="number"
                                value={a.deltaY}
                                onChange={(e) =>
                                  updateAction(i, { ...a, deltaY: Number(e.target.value) })
                                }
                              />
                            </label>
                          )}
                          {a.type === 'press' && (
                            <label>
                              키
                              <select
                                value={a.key}
                                onChange={(e) =>
                                  updateAction(i, { ...a, key: e.target.value as typeof a.key })
                                }
                              >
                                {['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'].map((k) => (
                                  <option key={k}>{k}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {'condition' in a && (
                            <div className="condition-note">
                              확인 조건: {describeCondition(plan, a.condition)}
                            </div>
                          )}
                        </div>
                        <button
                          className="icon-delete"
                          aria-label={`${i + 1}번 동작 삭제`}
                          disabled={scene.actions.length === 1}
                          onClick={() =>
                            updateScene({
                              ...scene,
                              actions: scene.actions.filter((_, n) => n !== i),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <section className="approval-bar">
                <div>
                  <b>
                    {dirty
                      ? '수정한 계획을 검증해 주세요.'
                      : canApprove
                        ? '검토가 끝나면 영상을 만들 수 있어요.'
                        : '확인이 필요한 항목이 있습니다.'}
                  </b>
                  <p>
                    {report?.issues.map((i) => i.message).join(' ') ||
                      '생성 버튼을 누르면 위 계획과 표시된 테스트 데이터 변경을 승인합니다.'}
                  </p>
                  {report?.targets.some((t) => t.status === 'runtime_required') && (
                    <small>새 데이터의 대상은 생성 후 실행 시점에 다시 확인합니다.</small>
                  )}
                </div>
                <button className="primary" disabled={!canApprove || !!busy} onClick={generate}>
                  이 계획으로 영상 만들기 →
                </button>
              </section>
            </>
          )}
          {page === 'progress' && job && plan && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR APP, RECORDED</p>
                  <h1>
                    {job.status === 'succeeded'
                      ? '실제 기능이 담긴 영상입니다.'
                      : job.status === 'needs_action'
                        ? '이 부분을 확인해 주세요.'
                        : job.status === 'cancelled'
                          ? '작업을 취소했습니다.'
                          : '검토한 계획을 영상으로 만들고 있어요.'}
                  </h1>
                  <p>장면별 결과를 보존하며 진행합니다.</p>
                </div>
                <div>
                  <span className={'pill ' + (job.status === 'needs_action' ? 'amber' : '')}>
                    {statuses[job.status]}
                  </span>
                  {!['queued', 'running'].includes(job.status) && (
                    <button
                      className="text-button"
                      onClick={() => {
                        sessionStorage.removeItem('demo-reel:job');
                        setJob(null);
                        setPlan(null);
                        setPreview(null);
                        setError('');
                        setPage('connect');
                      }}
                    >
                      새 프로젝트 시작
                    </button>
                  )}
                </div>
              </div>
              <div className="result-layout">
                <section className="video-panel">
                  {videoUrl ? (
                    <>
                      <video controls src={videoUrl} aria-label="생성된 데모 영상" />
                      {!poc && (
                        <p className="small-note">이 영상의 내레이션은 AI로 생성되었습니다.</p>
                      )}
                    </>
                  ) : (
                    <div className="video-placeholder">
                      <span
                        className={
                          ['queued', 'running'].includes(job.status) ? 'reel spinning' : 'reel'
                        }
                      >
                        ◉
                      </span>
                      <b>{stages[job.stage] ?? '작업 준비'}</b>
                      <p>
                        {job.completedSceneCount} / {job.totalSceneCount} 장면 완료
                      </p>
                    </div>
                  )}
                  <div className="video-footer">
                    <div>
                      <b>{plan.title}</b>
                      <p>실제 화면 · 한국어 내레이션 · 자막</p>
                      <p>영상 보관: {new Date(job.expiresAt).toLocaleString('ko-KR')}까지</p>
                    </div>
                    {videoUrl && (
                      <a className="primary" href={videoUrl} download="demo-reel.mp4">
                        MP4 다운로드 ↓
                      </a>
                    )}
                  </div>
                  {job.failure && (
                    <div className="notice error">
                      <b>{job.failure.message}</b>
                      <p>{job.failure.suggestedAction}</p>
                    </div>
                  )}
                </section>
                <section className="progress-panel">
                  <div className="section-cap">장면별 진행 상황</div>
                  {plan.scenes.map((s, i) => {
                    const a = job.sceneAttempts.find((x) => x.sceneId === s.id);
                    return (
                      <article className="progress-scene" key={s.id}>
                        <div className="progress-scene-head">
                          <span className={'status-dot ' + (a?.status ?? 'pending')}>
                            {a?.status === 'succeeded' ? '✓' : i + 1}
                          </span>
                          <div>
                            <b>{s.title}</b>
                            <p>
                              {statuses[a?.status ?? 'pending']}
                              {a?.status === 'running' ? ' · ' + (stages[a.stage] ?? a.stage) : ''}
                              {a?.reusedFromAttemptId ? ' · 기존 클립 사용' : ''}
                            </p>
                          </div>
                        </div>
                        {a?.failure && <p className="scene-error">{a.failure.message}</p>}
                        {a?.failure?.screenshotArtifactId && (
                          <FailureEvidence artifactId={a.failure.screenshotArtifactId} />
                        )}
                        {!['queued', 'running'].includes(job.status) && (
                          <div className="scene-tools">
                            <button
                              className="text-button"
                              aria-expanded={openCaption === s.id}
                              onClick={() => {
                                setOpenCaption(openCaption === s.id ? null : s.id);
                                setCaptions((c) =>
                                  s.id in c ? c : { ...c, [s.id]: s.narration.text },
                                );
                              }}
                            >
                              자막·내레이션 고치기 ✎
                            </button>
                            <button
                              className="text-button"
                              onClick={() => recovery(s.id)}
                              disabled={!!busy}
                            >
                              이 장면 다시 찍기 ↻
                            </button>
                          </div>
                        )}
                        {openCaption === s.id && (
                          <div className="caption-editor">
                            <label>
                              {s.title} 자막
                              <textarea
                                rows={4}
                                value={captions[s.id] ?? s.narration.text}
                                onChange={(e) =>
                                  setCaptions({ ...captions, [s.id]: e.target.value })
                                }
                              />
                            </label>
                            <p className="small-note">
                              화면은 그대로 두고 음성과 자막만 새로 만듭니다. 촬영·로그인은 다시
                              하지 않아요.
                            </p>
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {['queued', 'running'].includes(job.status) ? (
                    <button
                      className="secondary wide"
                      onClick={() =>
                        work('취소를 요청하고 있어요.', async () =>
                          setJob(await api(`/jobs/${job.jobId}/cancel`, 'POST', {})),
                        )
                      }
                      disabled={!!busy}
                    >
                      작업 취소
                    </button>
                  ) : (
                    <>
                      {captionsChanged > 0 && (
                        <button className="primary wide" onClick={applyCaptions} disabled={!!busy}>
                          자막 {captionsChanged}개 반영해서 다시 만들기 →
                        </button>
                      )}
                      <button
                        className="secondary wide"
                        onClick={() => {
                          setPreview(null);
                          setPage('review');
                        }}
                        disabled={!!busy}
                      >
                        보여줄 기능 추가하기 ＋
                      </button>
                      <button
                        className="secondary wide"
                        onClick={() => recovery(null)}
                        disabled={!!busy}
                      >
                        기존 클립으로 다시 합성
                      </button>
                    </>
                  )}
                </section>
              </div>
              {preview && (
                <section className="recovery-box">
                  <div className="page-heading">
                    <div>
                      <h2>다시 만들 범위</h2>
                      <p>이 범위를 확인한 뒤 재실행합니다.</p>
                    </div>
                    <button className="text-button" onClick={() => setPreview(null)}>
                      닫기 ×
                    </button>
                  </div>
                  <div className="recovery-summary">
                    <span>
                      재촬영 <b>{preview.captureSceneIds.length}개</b>
                    </span>
                    <span>
                      재합성 <b>{preview.renderSceneIds.length}개</b>
                    </span>
                    <span>
                      클립 재사용 <b>{preview.reuseArtifactIds.length}개</b>
                    </span>
                  </div>
                  {preview.reasons.map((r) => (
                    <p className="notice error" key={r}>
                      {r}
                    </p>
                  ))}
                  {preview.requiresAuth && (
                    <div className="reauth">
                      <p>
                        촬영에 쓴 인증 정보는 폐기했습니다. 다시 촬영하려면 테스트 계정을 입력해
                        주세요.
                      </p>
                      {connectionInputs}
                      <button className="secondary" disabled={!!busy} onClick={reauthenticate}>
                        재인증하고 복구 범위 확인
                      </button>
                    </div>
                  )}
                  <button
                    className="primary"
                    disabled={!!busy || preview.requiresAuth || preview.requiresStateReset}
                    onClick={recover}
                  >
                    확인한 범위로 다시 만들기 →
                  </button>
                </section>
              )}
            </>
          )}
        </div>
        <footer className="studio-footer">
          <span>DEMO REEL</span> 실제 앱의 동작을, 검토한 계획대로.
        </footer>
      </div>
    </div>
  );
}
