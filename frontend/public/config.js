window.__CHARGE_CONFIG__ = window.__CHARGE_CONFIG__ || {};

const configuredBase = window.__CHARGE_CONFIG__.apiBaseUrl;
if (typeof configuredBase !== 'string' || configuredBase.trim() === '') {
  const { protocol, port, origin } = window.location;
  const devPorts = new Set(['5173', '4173']);

  if (protocol === 'https:' || !devPorts.has(port)) {
    window.__CHARGE_CONFIG__.apiBaseUrl = origin;
  }
}
