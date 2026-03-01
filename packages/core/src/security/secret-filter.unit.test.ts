import { describe, it, expect } from 'vitest';
import { filterSecrets, mightContainSecrets } from './secret-filter.js';

describe('filterSecrets', () => {
  it('redacts Anthropic API keys', () => {
    const input = 'Using key sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const { filtered, redactedCount } = filterSecrets(input);
    expect(filtered).toContain('[REDACTED]');
    expect(filtered).not.toContain('sk-ant-api03');
    expect(redactedCount).toBe(1);
  });

  it('redacts OpenAI API keys', () => {
    const input = 'OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('sk-abcdefghij');
  });

  it('redacts GitHub tokens', () => {
    const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('ghp_');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('eyJhbGci');
  });

  it('redacts connection strings', () => {
    const input = 'const db = "postgresql://user:password@localhost:5432/mydb"';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('postgresql://');
  });

  it('redacts AWS access keys', () => {
    const input = 'AWS key: AKIAIOSFODNN7EXAMPLE';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('AKIA');
  });

  it('redacts PEM private keys', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const { filtered } = filterSecrets(input);
    expect(filtered).not.toContain('MIIEow');
  });

  it('does not redact normal text', () => {
    const input = 'function getUser(id: string) { return repo.findById(id); }';
    const { filtered, redactedCount } = filterSecrets(input);
    expect(filtered).toBe(input);
    expect(redactedCount).toBe(0);
  });

  it('returns pattern names for each redaction', () => {
    const input = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const { patternNames } = filterSecrets(input);
    expect(patternNames).toContain('anthropic-key');
  });
});

describe('mightContainSecrets', () => {
  it('returns true for content with secrets', () => {
    expect(mightContainSecrets('sk-ant-api03-test12345678901234567890')).toBe(true);
  });

  it('returns false for clean content', () => {
    expect(mightContainSecrets('This is normal code without any secrets')).toBe(false);
  });
});
