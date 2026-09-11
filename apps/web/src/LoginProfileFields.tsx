import type { LoginProfile } from '../../../packages/contracts/src/connection.ts';
export const emptyLoginProfile: LoginProfile = {
  loginUrl: '',
  successUrl: '',
  username: { strategy: 'label', value: '' },
  password: { strategy: 'label', value: '' },
  submit: { strategy: 'role', role: 'button', value: '' },
  successTarget: { strategy: 'css', value: '' },
};
export function LoginProfileFields({
  profile,
  onChange,
  session = false,
}: {
  profile: LoginProfile;
  onChange: (p: LoginProfile) => void;
  session?: boolean;
}) {
  function target(name: 'username' | 'password' | 'submit' | 'successTarget', label: string) {
    const value = profile[name];
    return (
      <div className="field-row" key={name}>
        <label>
          {label}
          <input
            value={value.value}
            onChange={(e) => onChange({ ...profile, [name]: { ...value, value: e.target.value } })}
            placeholder={name === 'successTarget' ? '예: [data-testid="dashboard"]' : undefined}
            required
          />
        </label>
        <label>
          찾는 방식
          <select
            value={value.strategy}
            onChange={(e) => {
              const strategy = e.target.value as typeof value.strategy;
              onChange({
                ...profile,
                [name]: {
                  value: value.value,
                  strategy,
                  ...(strategy === 'role'
                    ? { role: name === 'submit' ? 'button' : 'textbox' }
                    : {}),
                },
              });
            }}
          >
            <option value="label">입력칸 이름</option>
            <option value="role">{name === 'submit' ? '버튼 이름' : '텍스트 입력 이름'}</option>
            <option value="testId">testId</option>
            <option value="css">CSS 선택자</option>
          </select>
        </label>
      </div>
    );
  }
  return (
    <details className="login-profile" open>
      <summary>로그인 화면 연결 설정</summary>
      <p className="small-note">
        앱마다 로그인 화면이 달라, 입력 대상과 로그인 성공 조건을 직접 지정합니다.
      </p>
      {!session && (
        <>
          <label>
            로그인 페이지 주소
            <input
              type="url"
              value={profile.loginUrl}
              onChange={(e) => onChange({ ...profile, loginUrl: e.target.value })}
              required
            />
          </label>
          {target('username', '계정 입력칸')}
          {target('password', '비밀번호 입력칸')}
          {target('submit', '로그인 버튼')}
        </>
      )}
      <label>
        로그인 성공 후 주소
        <input
          type="url"
          value={profile.successUrl}
          onChange={(e) => onChange({ ...profile, successUrl: e.target.value })}
          required
        />
      </label>
      {target('successTarget', '로그인 후 보이는 대상')}
    </details>
  );
}
