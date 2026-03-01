/**
 * Secret filter — conservative approach.
 * False positives are acceptable. False negatives are a security failure.
 *
 * Call filterSecrets() on ANY content before it touches the database or logs.
 */

const REDACTED = '[REDACTED]';

// High-confidence secret patterns
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API keys
  { name: 'anthropic-key', pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
  { name: 'openai-key', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'generic-api-key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9\-_]{16,}["']?/gi },

  // Tokens
  { name: 'bearer-token', pattern: /Bearer\s+[a-zA-Z0-9\-_.~+/]+=*/g },
  { name: 'github-token', pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g },
  { name: 'jwt', pattern: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g },

  // Passwords / secrets in assignment form
  { name: 'password-assignment', pattern: /(?:password|passwd|pwd|secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi },
  { name: 'connection-string', pattern: /(?:mongodb|postgresql|mysql|redis):\/\/[^\s"']+/gi },

  // Environment variable values that look like secrets
  { name: 'env-secret', pattern: /(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)\s*=\s*["']?[a-zA-Z0-9+/=]{16,}["']?/g },

  // AWS
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws-secret', pattern: /(?:aws_secret|AWS_SECRET)[_\s]*(?:access_key|ACCESS_KEY)[_\s]*(?:id|ID)?\s*[:=]\s*["']?[a-zA-Z0-9+/]{40}["']?/gi },

  // Private keys (PEM)
  { name: 'pem-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

export interface FilterResult {
  filtered: string;
  redactedCount: number;
  patternNames: string[];
}

/**
 * Redact secrets from a string. Always call this before persisting content.
 */
export function filterSecrets(content: string): FilterResult {
  let filtered = content;
  let redactedCount = 0;
  const patternNames: string[] = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    const before = filtered;
    filtered = filtered.replace(pattern, REDACTED);
    if (filtered !== before) {
      patternNames.push(name);
      // Count replacements via match count on original
      const matches = before.match(pattern);
      redactedCount += matches?.length ?? 0;
    }
  }

  return { filtered, redactedCount, patternNames };
}

/**
 * Returns true if the content looks like it might contain secrets.
 * Use for quick pre-checks before deciding whether to store content at all.
 */
export function mightContainSecrets(content: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}
