const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|secret|signature|sig|password|passphrase|credentials?|session(?:[-_]?id)?|csrf(?:[-_]?token)?|payment[-_]?session|checkout[-_]?session|profile(?:[-_]?dir|[-_]?path)?|browser(?:[-_]?profile)?(?:[-_]?path)?)$/iu;
const SENSITIVE_QUERY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth|authorization|api[-_]?key|key|secret|password|session(?:[-_]?id)?|client[-_]?secret|signature|sig|payment[-_]?session|checkout[-_]?session)$/iu;
const PROFILE_PATH = /(?:^|[\\/])\.cloner-profiles(?:[\\/]|$)/u;
const LOCAL_PATH = /(?:^|\s)(?:\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\\\)[^\s"']+/gu;
const PAYMENT_HOST = /(?:stripe|paypal|adyen|checkout)/iu;
const PAYMENT_PATH = /(?:checkout|payment|session|billing-portal|(?:^|\/)pay(?:\/|$)|(?:^|\/)setup(?:\/|$))/iu;
const CREDENTIAL_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key)\s*[:=]\s*[^\r\n,;]+/giu;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[^\s,;]+/giu;
const CREDENTIAL_ASSIGNMENT = /\b(access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|session(?:[-_]?id)?|csrf(?:[-_]?token)?|password|secret|signature|sig)\s*[:=]\s*(?!\[REDACTED\]|%5BREDACTED%5D)[^\s&;,]+/giu;

function redactUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (PAYMENT_HOST.test(parsed.hostname) && PAYMENT_PATH.test(parsed.pathname)) return '[REDACTED_URL]';
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(key)) parsed.searchParams.set(key, '[REDACTED]');
  }
  if (parsed.hash && /(?:token|auth|session|secret)/iu.test(parsed.hash)) parsed.hash = '#[REDACTED]';
  return parsed.toString();
}

export function redactString(value) {
  if (typeof value !== 'string') return value;
  if (PROFILE_PATH.test(value)) return '[REDACTED_PROFILE_PATH]';
  const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
  return value
    .replace(urlPattern, (url) => redactUrl(url))
    .replace(CREDENTIAL_HEADER, '$1: [REDACTED]')
    .replace(AUTH_SCHEME, '$1 [REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1=[REDACTED]')
    .replace(LOCAL_PATH, '[REDACTED_PATH]');
}

function redactValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(childKey)) output[childKey] = '[REDACTED]';
      else output[childKey] = redactValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

export function redactForPersistence(value) {
  return redactValue(value);
}

export function containsSensitiveMaterial(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (/\b(?:Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]+=*/iu.test(serialized)) return true;
  const assignment = /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|session(?:[-_]?id)?|csrf(?:[-_]?token)?|password|secret|signature|sig)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s&;,}]+))/giu;
  const redacted = /^(?:\[REDACTED(?:_[A-Z]+)?\]|%5BREDACTED(?:_[A-Z]+)?%5D)$/iu;
  for (const match of serialized.matchAll(assignment)) {
    const candidate = match[1] ?? match[2] ?? match[3] ?? '';
    if (candidate && !redacted.test(candidate)) return true;
  }
  return false;
}

export function safeUrl(value) {
  return redactUrl(value);
}

export const redactionPatterns = Object.freeze({
  sensitiveKey: SENSITIVE_KEY.source,
  sensitiveQuery: SENSITIVE_QUERY.source,
  profilePath: PROFILE_PATH.source,
});
