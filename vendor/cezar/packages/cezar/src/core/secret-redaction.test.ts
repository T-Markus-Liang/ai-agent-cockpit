import { describe, expect, it } from 'vitest';
import { collectSecretValues, redactDeep, redactSecrets, REDACTED } from './secret-redaction.ts';

/**
 * #427: credentials must never be persisted to a run's NDJSON transcript.
 * Value-based redaction scrubs the host's own secret env values; pattern-based
 * redaction catches well-known token shapes from anywhere.
 *
 * These are deliberately synthetic TESTONLY canaries, never credentials read
 * from a user, an environment variable, or an account. Constructing the dummy
 * body keeps production-format coverage without committing key-shaped literals.
 */
function syntheticToken(prefix: string, bodyLength = 32): string {
  const marker = 'TESTONLY';
  return prefix + marker.repeat(Math.ceil(bodyLength / marker.length)).slice(0, bodyLength);
}

describe('collectSecretValues', () => {
  it('collects values of secret-named vars, skips short and non-secret names', () => {
    const token = syntheticToken('gho_');
    const awsSecret = 'TESTONLY-aws-secret-value';
    const values = collectSecretValues({
      GITHUB_TOKEN: token,
      AWS_SECRET_ACCESS_KEY: awsSecret,
      PATH: '/usr/bin:/bin',
      SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1', // AUTH but allow-listed
      SHORT_TOKEN: 'abc', // too short
    });
    expect(values).toContain(token);
    expect(values).toContain(awsSecret);
    expect(values).not.toContain('/usr/bin:/bin');
    expect(values).not.toContain('/tmp/ssh-abc/agent.1');
    expect(values).not.toContain('abc');
  });

  /** #427 review: the shared SECRET_NAME_RE means a var stripped from the
   *  child env is also collected for redaction — the two used to diverge. */
  it('collects the name shapes agent-env strips, so the lists cannot drift', () => {
    const values = collectSecretValues({
      SIGNING_KEY: 'TESTONLY-signing-value',
      MY_KEY_MATERIAL: 'TESTONLY-key-material',
      SESSION_SECRET: 'TESTONLY-session-value',
      COOKIE_SIGNING: 'TESTONLY-cookie-value',
    });
    expect(values).toEqual(
      expect.arrayContaining([
        'TESTONLY-signing-value',
        'TESTONLY-key-material',
        'TESTONLY-session-value',
        'TESTONLY-cookie-value',
      ]),
    );
  });

  it('skips session/desktop bookkeeping whose value is a path, not a credential', () => {
    const values = collectSecretValues({
      SESSION_MANAGER: 'local/host:@/tmp/.ICE-unix/1234',
      XDG_SESSION_TYPE: 'wayland-session-type',
    });
    expect(values).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('scrubs concrete host secret values found in text', () => {
    const token = syntheticToken('gho_');
    const secrets = collectSecretValues({ GITHUB_TOKEN: token });
    const out = redactSecrets('run: gh auth uses ' + token + ' here', secrets);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
  });

  it('scrubs well-known token shapes even without knowing the env', () => {
    const line = [
      'gh: ' + syntheticToken('ghp_', 36),
      'anthropic: ' + syntheticToken('sk-ant-'),
      'aws: ' + syntheticToken('AKIA', 16),
      'google: ' + syntheticToken('AIza', 35),
    ].join('\n');
    const out = redactSecrets(line, []);
    expect(out).not.toMatch(/ghp_|sk-ant|AKIA|AIza/);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))?.length).toBe(4);
  });

  it.each([
    ['GitHub PAT', 'ghp_', 36],
    ['GitHub OAuth', 'gho_', 36],
    ['GitHub server token', 'ghs_', 36],
    ['GitHub user token', 'ghu_', 36],
    ['GitHub refresh token', 'ghr_', 36],
    ['GitHub fine-grained PAT', 'github_pat_', 32],
    ['Anthropic', 'sk-ant-', 32],
    ['OpenAI-compatible', 'sk-', 32],
    ['AWS access key ID', 'AKIA', 16],
    ['AWS temporary access key ID', 'ASIA', 16],
    ['Google API key', 'AIza', 35],
    ['Google OAuth', 'ya29.', 32],
    ['Slack', 'xoxb-', 32],
    ['GitLab', 'glpat-', 32],
  ] as const)('redacts an explicitly synthetic %s canary', (_name, prefix, bodyLength) => {
    const token = syntheticToken(prefix, bodyLength);
    expect(token).toHaveLength(prefix.length + bodyLength);
    expect(token.slice(prefix.length)).toMatch(/^(?:TESTONLY)+(?:T|TE|TES|TEST|TESTO|TESTON|TESTONL)?$/);
    expect(redactSecrets('before ' + token + ' after', [])).toBe('before ' + REDACTED + ' after');
    expect(redactSecrets(token + ' ' + token, [])).toBe(REDACTED + ' ' + REDACTED);
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('the quick brown fox', [])).toBe('the quick brown fox');
  });

  /**
   * #427 review: the old 8-char floor mangled ordinary output — a dev box with
   * POSTGRES_PASSWORD=postgres turned apt install postgresql-16 into
   * apt install [REDACTED]ql-16. Short dictionary words are not redactable.
   */
  it('does not redact short dictionary-word "secrets" out of ordinary output', () => {
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: 'postgres', DB_PASSWORD: 'root' });
    expect(secrets).toEqual([]);
    const line = 'apt install postgresql-16 && psql -U postgres -c "select 1"';
    expect(redactSecrets(line, secrets)).toBe(line);
  });

  it('still redacts a synthetic credential value at the raised floor', () => {
    const password = 'TESTONLY-long-password';
    const secrets = collectSecretValues({ POSTGRES_PASSWORD: password });
    const out = redactSecrets('psql://app:' + password + '@db/prod', secrets);
    expect(out).not.toContain(password);
    expect(out).toContain(REDACTED);
  });
});

describe('redactDeep', () => {
  it('scrubs string leaves in nested event structures', () => {
    const event = {
      type: 'tool-result',
      result: 'export GITHUB_TOKEN=' + syntheticToken('ghp_', 36),
      item: { output: syntheticToken('sk-ant-'), nested: [{ text: 'safe' }] },
      seq: 3,
    };
    const out = redactDeep(event, []);
    expect(out.result).not.toContain('ghp_');
    expect((out.item as { output: string }).output).not.toContain('sk-ant');
    expect(out.seq).toBe(3); // non-strings preserved
    expect((out.item as { nested: Array<{ text: string }> }).nested[0]?.text).toBe('safe');
  });
});

it('redacts raw tracker key values from persisted task text', () => {
  const jira = 'TESTONLY-jira-value';
  const linear = 'TESTONLY-linear-value';
  const secrets = collectSecretValues({ JIRA_API_TOKEN: jira, LINEAR_API_KEY: linear });
  expect(redactSecrets(jira + ' ' + linear, secrets)).toBe(REDACTED + ' ' + REDACTED);
});

