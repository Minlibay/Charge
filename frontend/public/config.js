window.__CHARGE_CONFIG__ = window.__CHARGE_CONFIG__ || {};

if (typeof window.__CHARGE_CONFIG__.apiBaseUrl !== 'string' || window.__CHARGE_CONFIG__.apiBaseUrl.trim() === '') {
  window.__CHARGE_CONFIG__.apiBaseUrl = window.location.origin;
}
