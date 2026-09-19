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
            placeholder={
              name === 'username'
                ? '아이디'
                : name === 'password'
                  ? '비밀번호'
                  : name === 'submit'
                    ? '로그인'
                    : '로그인 후에만 보이는 글자'
            }
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
      <summary>로그인 화면 알려주기</summary>
      <p className="field-hint">
        앱마다 로그인 화면이 달라서 자동으로 찾을 수 없습니다. <strong>어디에 무엇을 넣고, 무엇이
        보이면 로그인에 성공한 것인지</strong> 알려주세요. &ldquo;찾는 방식&rdquo;은 잘 모르시면
        그대로 두시고, 옆 칸에 화면에 적힌 글자를 그대로 적어보세요.
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
