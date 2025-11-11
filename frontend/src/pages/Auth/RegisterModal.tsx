import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigate } from '../../router';

import { AuthLayout } from './AuthLayout';
import { loginAfterRegister, register } from '../../services/auth';
import { ApiError } from '../../services/api';

export function RegisterModal(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loginRef = useRef<HTMLInputElement | null>(null);
  const [loginValue, setLoginValue] = useState('');
  const [displayName, setDisplayName] = useState('');
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

    const payload = {
      login: loginValue.trim(),
      password,
      display_name: displayName.trim() || undefined,
    };

    try {
      await register(payload);
      await loginAfterRegister(payload);
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
    <AuthLayout title={t('auth.registerTitle')} onClose={() => navigate('/', { replace: true })}>
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
            <span className="auth-field__label">{t('auth.displayNameField')}</span>
            <input
              type="text"
              className="auth-field__input"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t('auth.displayNamePlaceholder')}
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">{t('auth.passwordField')}</span>
            <input
              type="password"
              className="auth-field__input"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
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
              t('auth.registerAction')
            )}
          </button>
          <button
            type="button"
            className="auth-button auth-button--secondary"
            onClick={() => navigate('/auth/login')}
            disabled={loading}
          >
            {t('auth.switchToLogin')}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
