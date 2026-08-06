import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type NexusDb } from '../db/connection.js';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from '../repositories/project.js';
import { createDecision } from '../repositories/decision.js';
import type { Decision, DecisionKind } from '../types/index.js';
import {
  findSupersessionCandidates,
  adjudicateSupersession,
  applySupersession,
  reconcileDecisions,
} from './supersession.js';
import * as llm from '../llm/index.js';
import * as config from '../config/index.js';

let db: NexusDb;
let dir: string;
let projectId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-supersede-'));
  db = openDatabase({ dbPath: path.join(dir, 'test.db'), encryptionKey: 'test-key' });
  migrateDatabase(db);
  projectId = createProject(db, { name: 'demo', path: path.join(dir, 'ws') }, 'cli').id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(kind: DecisionKind, summary: string, rationale?: string): Decision {
  return createDecision(db, { projectId, kind, summary, ...(rationale ? { rationale } : {}) }, 'cli');
}

/** Force recorded_at so ordering is explicit rather than dependent on clock ticks. */
function at(decision: Decision, ms: number): Decision {
  db.prepare('UPDATE decisions SET recorded_at = ? WHERE id = ?').run(ms, decision.id);
  return { ...decision, recordedAt: ms };
}

/** Stub the model with a fixed reply. */
function mockLlm(reply: unknown) {
  vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
  vi.spyOn(llm, 'createProvider').mockReturnValue({
    name: 'anthropic',
    chatCompletion: vi.fn().mockResolvedValue({ text: JSON.stringify(reply), model: 'test' }),
  } as never);
}

describe('findSupersessionCandidates', () => {
  it('shortlists an earlier decision on the same subject', () => {
    const older = at(
      record('security', 'Encryption key remains in plain text in config.json; plan to move to OS keychain'),
      1_000,
    );
    const newer = at(
      record('security', 'Database encryption key lives in the OS credential store, never in config.json'),
      2_000,
    );

    expect(findSupersessionCandidates(db, newer).map((c) => c.id)).toContain(older.id);
  });

  it('never shortlists a decision of a different kind', () => {
    at(record('naming', 'Encryption key config json keychain credential store'), 1_000);
    const newer = at(
      record('security', 'Encryption key config json keychain credential store'),
      2_000,
    );

    expect(findSupersessionCandidates(db, newer)).toHaveLength(0);
  });

  it('never shortlists a newer decision, so ordering cannot invert', () => {
    const newer = at(record('security', 'sqlcipher encryption keychain rotation'), 5_000);
    const older = at(record('security', 'sqlcipher encryption keychain rotation'), 1_000);

    expect(findSupersessionCandidates(db, older)).toHaveLength(0);
    expect(findSupersessionCandidates(db, newer).map((c) => c.id)).toEqual([older.id]);
  });

  it('never shortlists an already superseded decision', () => {
    const older = at(record('security', 'sqlcipher encryption keychain rotation'), 1_000);
    const newer = at(record('security', 'sqlcipher encryption keychain rotation policy'), 2_000);
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(newer.id, older.id);

    const newest = at(record('security', 'sqlcipher encryption keychain rotation cadence'), 3_000);
    expect(findSupersessionCandidates(db, newest).map((c) => c.id)).not.toContain(older.id);
  });

  it('shortlists nothing on an unrelated subject', () => {
    at(record('security', 'sqlcipher encryption at rest'), 1_000);
    const newer = at(record('security', 'rotate the discord webhook quarterly'), 2_000);
    expect(findSupersessionCandidates(db, newer)).toHaveLength(0);
  });
});

describe('adjudicateSupersession', () => {
  it('maps the model\'s indexes back to the shortlist', async () => {
    mockLlm({ replaces: [1], reason: 'the key was moved' });
    const a = at(record('security', 'first'), 1_000);
    const b = at(record('security', 'second'), 1_100);
    const newer = at(record('security', 'third'), 2_000);

    const verdict = await adjudicateSupersession(newer, [a, b]);
    expect(verdict.supersededIds).toEqual([b.id]);
  });

  it('ignores an out-of-range index rather than retiring something arbitrary', async () => {
    // The model is not trusted with identifiers: a fabricated or stray index must
    // resolve to nothing, not to whichever decision happens to sit there.
    mockLlm({ replaces: [0, 7, 99] });
    const a = at(record('security', 'first'), 1_000);
    const newer = at(record('security', 'second'), 2_000);

    expect((await adjudicateSupersession(newer, [a])).supersededIds).toEqual([a.id]);
  });

  it('returns nothing when the model declines', async () => {
    mockLlm({ replaces: [], reason: '' });
    const a = at(record('security', 'first'), 1_000);
    const newer = at(record('security', 'second'), 2_000);

    expect((await adjudicateSupersession(newer, [a])).supersededIds).toEqual([]);
  });

  it('returns nothing on unparseable output instead of throwing', async () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
    vi.spyOn(llm, 'createProvider').mockReturnValue({
      name: 'anthropic',
      chatCompletion: vi.fn().mockResolvedValue({ text: 'I think maybe the first one?' }),
    } as never);

    const a = at(record('security', 'first'), 1_000);
    const newer = at(record('security', 'second'), 2_000);
    await expect(adjudicateSupersession(newer, [a])).resolves.toMatchObject({ supersededIds: [] });
  });

  it('does not call the model when there is nothing to compare', async () => {
    const spy = vi.spyOn(llm, 'createProvider');
    const newer = at(record('security', 'only decision'), 2_000);
    await adjudicateSupersession(newer, []);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('applySupersession', () => {
  it('keeps the row and records who replaced it', () => {
    const older = at(record('security', 'old'), 1_000);
    const newer = at(record('security', 'new'), 2_000);

    expect(applySupersession(db, newer.id, [older.id], 'cli')).toBe(1);

    const row = db.prepare('SELECT summary, superseded_by FROM decisions WHERE id = ?').get(older.id) as
      { summary: string; superseded_by: string };
    expect(row.summary).toBe('old');
    expect(row.superseded_by).toBe(newer.id);
  });

  it('will not re-supersede something already retired', () => {
    const older = at(record('security', 'old'), 1_000);
    const first = at(record('security', 'first replacement'), 2_000);
    const second = at(record('security', 'second replacement'), 3_000);

    applySupersession(db, first.id, [older.id], 'cli');
    expect(applySupersession(db, second.id, [older.id], 'cli')).toBe(0);
  });

  it('audits a bulk change so it is not silent', () => {
    const older = at(record('security', 'old'), 1_000);
    const newer = at(record('security', 'new'), 2_000);
    applySupersession(db, newer.id, [older.id], 'cli', 'reversed');

    const n = db
      .prepare("SELECT count(*) n FROM audit_log WHERE operation = 'decision.supersede'")
      .get() as { n: number };
    expect(n.n).toBeGreaterThan(0);
  });
});

describe('reconcileDecisions', () => {
  it('retires the stale decision that started all this', async () => {
    // The exact failure observed in production: the prompt hook reported the
    // database key as living in config.json hours after it had been moved out.
    mockLlm({ replaces: [0], reason: 'the key was moved to the credential store' });

    const stale = at(
      record(
        'security',
        'Encryption key remains in plain text in config.json; plan to move to OS keychain',
        'Security boundary is the config file',
      ),
      1_000,
    );
    at(
      record(
        'security',
        'Database encryption key lives in the OS credential store, never in config.json',
        'A key beside the database travels with the folder',
      ),
      2_000,
    );

    const result = await reconcileDecisions(db, projectId, 2_000, 'cli');
    expect(result.superseded).toBe(1);

    const row = db.prepare('SELECT superseded_by FROM decisions WHERE id = ?').get(stale.id) as
      { superseded_by: string | null };
    expect(row.superseded_by).not.toBeNull();
  });

  it('leaves everything alone when the model declines', async () => {
    mockLlm({ replaces: [] });
    at(record('security', 'sqlcipher encryption at rest'), 1_000);
    at(record('security', 'sqlcipher encryption key rotation cadence'), 2_000);

    expect((await reconcileDecisions(db, projectId, 2_000, 'cli')).superseded).toBe(0);
  });

  it('survives a provider outage without failing the session', async () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
    vi.spyOn(llm, 'createProvider').mockReturnValue({
      name: 'anthropic',
      chatCompletion: vi.fn().mockRejectedValue(new Error('provider down')),
    } as never);

    at(record('security', 'sqlcipher encryption at rest'), 1_000);
    at(record('security', 'sqlcipher encryption at rest revisited'), 2_000);

    await expect(reconcileDecisions(db, projectId, 2_000, 'cli')).resolves.toMatchObject({
      superseded: 0,
    });
  });

  it('does not let supersessions chain within one pass', async () => {
    // The failure this guard exists for, seen on live data: A retires B, then C
    // retires A, then D retires C. Every link defensible alone; the survivor ends
    // up unrelated to the subject the chain started on, and the fact that was
    // being tracked disappears entirely.
    mockLlm({ replaces: [0], reason: 'replaced' });

    const a = at(record('security', 'sqlcipher encryption keychain storage first'), 1_000);
    const b = at(record('security', 'sqlcipher encryption keychain storage second'), 2_000);
    const c = at(record('security', 'sqlcipher encryption keychain storage third'), 3_000);

    await reconcileDecisions(db, projectId, 2_000, 'cli');

    const state = (id: string) =>
      (db.prepare('SELECT superseded_by FROM decisions WHERE id = ?').get(id) as
        { superseded_by: string | null }).superseded_by;

    // b retires a; b must then be off the table, so c cannot retire b.
    expect(state(a.id)).toBe(b.id);
    expect(state(b.id)).toBeNull();
    expect(state(c.id)).toBeNull();
  });

  it('records which decisions were retired, not merely how many', async () => {
    // A bulk judgement call has to be precisely undoable.
    mockLlm({ replaces: [0] });
    const older = at(record('security', 'sqlcipher encryption keychain rotation'), 1_000);
    at(record('security', 'sqlcipher encryption keychain rotation revised'), 2_000);

    await reconcileDecisions(db, projectId, 2_000, 'cli');

    const row = db
      .prepare("SELECT meta FROM audit_log WHERE operation='decision.supersede' ORDER BY at DESC LIMIT 1")
      .get() as { meta: string };
    expect(JSON.parse(row.meta).superseded_ids).toContain(older.id);
  });

  it('does not call the model for decisions with no plausible predecessor', async () => {
    const spy = vi.spyOn(llm, 'createProvider');
    at(record('security', 'a completely novel and unrelated choice'), 2_000);
    await reconcileDecisions(db, projectId, 1_000, 'cli');
    expect(spy).not.toHaveBeenCalled();
  });
});
