export function parseConfiguredPort(value, name, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  if (!/^\d{1,5}$/.test(raw)) throw new TypeError(`${name} must be an integer between 1 and 65535.`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}
