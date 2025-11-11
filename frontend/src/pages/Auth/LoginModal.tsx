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
        <div className="auth-form__fields">
          <label className="auth-field">
            <span className="auth-field__label">{t('auth.loginField')}</span>
            <input
              ref={loginRef}
              type="text"
              className="auth-field__input"
              autoComplete="username"
              value={loginValue}
              onChange={(event) => setLoginValue(event.target.value)}
              required
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">{t('auth.passwordField')}</span>
            <input
              type="password"
              className="auth-field__input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
        </div>
        {error && (
          <div className="auth-form__error-container" role="alert">
            <p className="auth-form__error">{error}</p>
          </div>
        )}
        <div className="auth-form__footer">
          <button type="submit" className="auth-button auth-button--primary" disabled={loading}>
            {loading ? (
              <>
                <span className="auth-button__spinner" aria-hidden="true"></span>
                <span>{t('common.loading')}</span>
              </>
            ) : (
              t('auth.loginAction')
            )}
          </button>
          <button
            type="button"
            className="auth-button auth-button--secondary"
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
