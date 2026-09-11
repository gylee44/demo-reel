import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
export function AccountGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ email: string } | null>(null),
    [poc, setPoc] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [register, setRegister] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [changing, setChanging] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([api('/capabilities'), api('/account/me')])
      .then(([c, a]) => {
        if (active) {
          setPoc(c.mode === 'poc');
          setUser(a.user);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (register && password !== confirm) {
      setError('비밀번호가 서로 다릅니다.');
      return;
    }
    setBusy(true);
    try {
      const r = await api('/account/' + (register ? 'register' : 'login'), 'POST', {
        email,
        password,
      });
      setUser(r.user);
      setPassword('');
      setConfirm('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="account-shell">
        <p role="status">작업 공간을 불러오고 있어요.</p>
      </main>
    );
  if (poc) return children;
  if (user)
    return (
      <>
        <div className="account-bar">
          <span>{user.email}</span>
          <button
            onClick={() => {
              setChanging(!changing);
              setError('');
            }}
          >
            비밀번호 변경
          </button>
          <button
            onClick={async () => {
              await api('/account/logout', 'POST');
              sessionStorage.clear();
              setUser(null);
            }}
          >
            로그아웃
          </button>
        </div>
        {changing && (
          <form
            className="account-change"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('/account/password', 'POST', {
                  currentPassword: password,
                  newPassword: confirm,
                });
                setChanging(false);
                setPassword('');
                setConfirm('');
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              현재 비밀번호
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              새 비밀번호
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <button disabled={busy}>변경하기</button>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
        {children}
      </>
    );
  return (
    <main className="account-shell">
      <section className="account-intro">
        <p className="eyebrow">DEMO REEL</p>
        <h1>
          만든 기능을,
          <br />
          보여줄 수 있는 영상으로.
        </h1>
        <p>실제 앱 화면을 연결하고, 시연 계획을 검토해 나만의 데모 영상을 만들어 보세요.</p>
      </section>
      <form className="connect-card account-card" onSubmit={submit}>
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h2>{register ? '작업 공간 만들기' : '다시 만나 반가워요.'}</h2>
        <label>
          이메일
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={register ? 'new-password' : 'current-password'}
          />
        </label>
        {register && (
          <>
            <label>
              비밀번호 확인
              <input
                type="password"
                required
                minLength={12}
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <p className="small-note">비밀번호는 12자 이상으로 설정해 주세요.</p>
          </>
        )}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <button className="primary wide" disabled={busy}>
          {busy ? '확인 중…' : register ? '가입하고 시작하기' : '로그인'}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setRegister(!register);
            setError('');
          }}
        >
          {register ? '이미 계정이 있어요' : '처음이라면 계정 만들기'}
        </button>
      </form>
    </main>
  );
}
