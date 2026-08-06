import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type NexusDb } from '../db/connection.js';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import { createDecision } from './decision.js';
import type { Decision } from '../types/index.js';
import {
  proposeSupersession,
  listPendingProposals,
  pendingProposalsFor,
  acceptProposal,
  rejectProposal,
} from './supersession-proposal.js';

let db: NexusDb;
let dir: string;
let projectId: string;
let older: Decision;
let newer: Decision;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-proposal-'));
  db = openDatabase({ dbPath: path.join(dir, 'test.db'), encryptionKey: 'test-key' });
  migrateDatabase(db);
  projectId = createProject(db, { name: 'demo', path: path.join(dir, 'ws') }, 'cli').id;
  older = createDecision(db, { projectId, kind: 'security', summary: 'key in config.json' }, 'cli');
  newer = createDecision(db, { projectId, kind: 'security', summary: 'key in the keychain' }, 'cli');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const propose = () =>
  proposeSupersession(
    db,
    { projectId, supersedingId: newer.id, supersededId: older.id, reason: 'the key moved' },
    'daemon',
  );

const supersededBy = (id: string) =>
  (db.prepare('SELECT superseded_by FROM decisions WHERE id = ?').get(id) as
    { superseded_by: string | null }).superseded_by;

describe('proposeSupersession', () => {
  it('records a pending proposal without touching the decision', () => {
    const proposal = propose();
    expect(proposal?.status).toBe('pending');
    expect(supersededBy(older.id)).toBeNull();
  });

  it('refuses to propose a decision against itself', () => {
    expect(
      proposeSupersession(db, { projectId, supersedingId: newer.id, supersededId: newer.id }),
    ).toBeUndefined();
  });

  it('raises a given pair only once', () => {
    expect(propose()).toBeDefined();
    expect(propose()).toBeUndefined();
    expect(listPendingProposals(db, projectId)).toHaveLength(1);
  });
});

describe('rejectProposal', () => {
  it('leaves the decision in place', () => {
    const proposal = propose()!;
    expect(rejectProposal(db, proposal.id, 'cli')).toBe(true);
    expect(supersededBy(older.id)).toBeNull();
  });

  it('never raises the same pair again', () => {
    // This is what separates a question from nagging. A rejected suggestion that
    // returns next session is how the advisory tier trained everyone to ignore it.
    const proposal = propose()!;
    rejectProposal(db, proposal.id, 'cli');

    expect(propose()).toBeUndefined();
    expect(listPendingProposals(db, projectId)).toHaveLength(0);
  });

  it('cannot be decided twice', () => {
    const proposal = propose()!;
    expect(rejectProposal(db, proposal.id, 'cli')).toBe(true);
    expect(rejectProposal(db, proposal.id, 'cli')).toBe(false);
    expect(acceptProposal(db, proposal.id, 'cli')).toBe(false);
  });
});

describe('acceptProposal', () => {
  it('retires the older decision', () => {
    const proposal = propose()!;
    expect(acceptProposal(db, proposal.id, 'cli')).toBe(true);
    expect(supersededBy(older.id)).toBe(newer.id);
  });

  it('keeps the row so acceptance is still undoable', () => {
    const proposal = propose()!;
    acceptProposal(db, proposal.id, 'cli');

    const row = db.prepare('SELECT summary FROM decisions WHERE id = ?').get(older.id) as
      { summary: string } | undefined;
    expect(row?.summary).toBe('key in config.json');
  });

  it('drops out of the pending list once decided', () => {
    const proposal = propose()!;
    acceptProposal(db, proposal.id, 'cli');
    expect(listPendingProposals(db, projectId)).toHaveLength(0);
  });

  it('audits the change', () => {
    const proposal = propose()!;
    acceptProposal(db, proposal.id, 'cli');
    const n = db
      .prepare("SELECT count(*) n FROM audit_log WHERE operation = 'supersession.accept'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('pendingProposalsFor', () => {
  it('finds the proposal against a decision about to be quoted', () => {
    propose();
    const found = pendingProposalsFor(db, [older.id]);
    expect(found.get(older.id)?.reason).toBe('the key moved');
  });

  it('returns nothing for decisions with no open question', () => {
    propose();
    expect(pendingProposalsFor(db, [newer.id]).size).toBe(0);
  });

  it('returns nothing once decided', () => {
    const proposal = propose()!;
    rejectProposal(db, proposal.id, 'cli');
    expect(pendingProposalsFor(db, [older.id]).size).toBe(0);
  });

  it('handles an empty request without querying', () => {
    expect(pendingProposalsFor(db, []).size).toBe(0);
  });
});
