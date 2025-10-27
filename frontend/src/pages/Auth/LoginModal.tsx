import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigate } from '../../router';

import { AuthLayout } from './AuthLayout';
import { login } from '../../services/auth';
import { ApiError } from '../../services/api';

export function LoginModal(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loginRef = useRef<HTMLInputElement | null>(null);
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loginRef.current?.focus();
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ login: loginValue.trim(), password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(t('auth.unexpectedError'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title={t('auth.loginTitle')} onClose={() => navigate('/', { replace: true })}>
      <form className="auth-form" onSubmit={handleSubmit}>
        <label className="field">
          {t('auth.loginField')}
          <input
            ref={loginRef}
            type="text"
            autoComplete="username"
            value={loginValue}
            onChange={(event) => setLoginValue(event.target.value)}
            required
          />
        </label>
        <label className="field">
          {t('auth.passwordField')}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <p className="auth-form__error" role="alert">{error}</p>}
        <div className="auth-form__footer">
          <button type="submit" className="primary" disabled={loading}>
            {loading ? t('common.loading') : t('auth.loginAction')}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => navigate('/auth/register')}
            disabled={loading}
          >
            {t('auth.switchToRegister')}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
