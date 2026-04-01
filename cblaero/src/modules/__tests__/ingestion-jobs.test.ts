import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all external dependencies
const mocks = vi.hoisted(() => ({
  fetchCeipalApplicants: vi.fn().mockResolvedValue([]),
  mapCeipalApplicantToCandidate: vi.fn((a: any) => ({ firstName: a.first_name, email: a.email_address, source: 'ceipal' })),
  parseInbox: vi.fn().mockResolvedValue([]),
  isSupabaseConfigured: vi.fn(() => false),
  getSupabaseAdminClient: vi.fn(),
  recordSyncFailure: vi.fn(),
  upsertCandidateFromATS: vi.fn().mockResolvedValue(undefined),
  upsertCandidateFromEmailFull: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/modules/ats', () => ({
  fetchCeipalApplicants: mocks.fetchCeipalApplicants,
  mapCeipalApplicantToCandidate: mocks.mapCeipalApplicantToCandidate,
}));

vi.mock('@/modules/email', () => ({
  MicrosoftGraphEmailParser: class {
    parseInbox = mocks.parseInbox;
  },
}));

vi.mock('@/modules/persistence', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
  getSupabaseAdminClient: mocks.getSupabaseAdminClient,
}));

vi.mock('@/modules/ingestion/index', () => ({
  recordSyncFailure: mocks.recordSyncFailure,
  upsertCandidateFromATS: mocks.upsertCandidateFromATS,
  upsertCandidateFromEmailFull: mocks.upsertCandidateFromEmailFull,
}));

import { CeipalIngestionJob, EmailIngestionJob, registerIngestionJobs } from '@/modules/ingestion/jobs';

describe('CeipalIngestionJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches applicants and upserts each one', async () => {
    mocks.fetchCeipalApplicants.mockResolvedValue([
      { first_name: 'Jane', last_name: 'Doe', email_address: 'jane@test.com' },
      { first_name: 'John', last_name: 'Smith', email_address: 'john@test.com' },
    ]);

    const job = new CeipalIngestionJob();
    await job.run();

    expect(mocks.fetchCeipalApplicants).toHaveBeenCalledTimes(1);
    expect(mocks.mapCeipalApplicantToCandidate).toHaveBeenCalledTimes(2);
    expect(mocks.upsertCandidateFromATS).toHaveBeenCalledTimes(2);
    expect(mocks.recordSyncFailure).not.toHaveBeenCalled();
  });

  it('records sync failure on per-record upsert error without stopping batch', async () => {
    mocks.fetchCeipalApplicants.mockResolvedValue([
      { first_name: 'Good', last_name: 'One', email_address: 'good@test.com' },
      { first_name: 'Bad', last_name: 'One', email_address: 'bad@test.com' },
      { first_name: 'Also', last_name: 'Good', email_address: 'also@test.com' },
    ]);
    mocks.upsertCandidateFromATS
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce(undefined);

    const job = new CeipalIngestionJob();
    await job.run();

    expect(mocks.upsertCandidateFromATS).toHaveBeenCalledTimes(3);
    expect(mocks.recordSyncFailure).toHaveBeenCalledTimes(1);
    expect(mocks.recordSyncFailure).toHaveBeenCalledWith('ceipal', 'bad@test.com', expect.any(Error));
  });

  it('records sync failure on polling error', async () => {
    mocks.fetchCeipalApplicants.mockRejectedValue(new Error('network timeout'));

    const job = new CeipalIngestionJob();
    await job.run();

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith('ceipal', 'polling', expect.any(Error));
    expect(mocks.upsertCandidateFromATS).not.toHaveBeenCalled();
  });

  it('passes lastRunAt for incremental sync on second run', async () => {
    mocks.fetchCeipalApplicants.mockResolvedValue([]);

    const job = new CeipalIngestionJob();
    await job.run();

    // First run — no since date
    expect(mocks.fetchCeipalApplicants).toHaveBeenCalledWith({ since: undefined });

    await job.run();

    // Second run — should have a since date
    const secondCallArgs = mocks.fetchCeipalApplicants.mock.calls[1][0];
    expect(secondCallArgs.since).toBeInstanceOf(Date);
  });

  it('uses email_address as record ID, falls back to name when email is null', async () => {
    mocks.fetchCeipalApplicants.mockResolvedValue([
      { first_name: 'NoEmail', last_name: 'Person', email_address: null },
    ]);
    mocks.upsertCandidateFromATS.mockRejectedValue(new Error('fail'));

    const job = new CeipalIngestionJob();
    await job.run();

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith('ceipal', 'NoEmail-Person', expect.any(Error));
  });
});

describe('EmailIngestionJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses inbox and upserts each record', async () => {
    mocks.parseInbox.mockResolvedValue([
      { id: 'msg-1', candidate: { firstName: 'Jane', email: 'jane@test.com' }, subject: 'Test', body: '', receivedAt: '2026-01-01', attachments: [] },
    ]);

    const job = new EmailIngestionJob();
    await job.run();

    expect(mocks.parseInbox).toHaveBeenCalledTimes(1);
    expect(mocks.upsertCandidateFromEmailFull).toHaveBeenCalledTimes(1);
  });

  it('records sync failure on per-record error without stopping batch', async () => {
    mocks.parseInbox.mockResolvedValue([
      { id: 'msg-1', candidate: {}, subject: 'S1', body: '', receivedAt: '', attachments: [] },
      { id: 'msg-2', candidate: {}, subject: 'S2', body: '', receivedAt: '', attachments: [] },
    ]);
    mocks.upsertCandidateFromEmailFull
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce(undefined);

    const job = new EmailIngestionJob();
    await job.run();

    expect(mocks.upsertCandidateFromEmailFull).toHaveBeenCalledTimes(2);
    expect(mocks.recordSyncFailure).toHaveBeenCalledWith('email', 'msg-1', expect.any(Error));
  });

  it('records sync failure on polling error', async () => {
    mocks.parseInbox.mockRejectedValue(new Error('Graph auth failed'));

    const job = new EmailIngestionJob();
    await job.run();

    expect(mocks.recordSyncFailure).toHaveBeenCalledWith('email', 'polling', expect.any(Error));
  });

  it('uses configurable inbox addresses from env', async () => {
    const originalEnv = process.env.CBL_SUBMISSION_INBOXES;
    process.env.CBL_SUBMISSION_INBOXES = 'inbox1@test.com, inbox2@test.com';

    const job = new EmailIngestionJob();
    await job.run();

    expect(mocks.parseInbox).toHaveBeenCalledWith(
      ['inbox1@test.com', 'inbox2@test.com'],
      expect.any(Set)
    );

    process.env.CBL_SUBMISSION_INBOXES = originalEnv;
  });
});

describe('registerIngestionJobs', () => {
  it('registers both CeipalIngestionJob and EmailIngestionJob', () => {
    const mockScheduler = { register: vi.fn() };
    registerIngestionJobs(mockScheduler);

    expect(mockScheduler.register).toHaveBeenCalledTimes(2);
    const names = mockScheduler.register.mock.calls.map((c: any) => c[0].name);
    expect(names).toContain('CeipalIngestionJob');
    expect(names).toContain('EmailIngestionJob');
  });

  it('registered jobs implement SchedulerJob interface', () => {
    const mockScheduler = { register: vi.fn() };
    registerIngestionJobs(mockScheduler);

    for (const [job] of mockScheduler.register.mock.calls) {
      expect(job).toHaveProperty('name');
      expect(job).toHaveProperty('run');
      expect(typeof job.run).toBe('function');
    }
  });
});
