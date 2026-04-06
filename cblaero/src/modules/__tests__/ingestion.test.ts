import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock persistence module
const mocks = vi.hoisted(() => ({
  isSupabaseConfigured: vi.fn(() => false),
  getSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/modules/persistence', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
  getSupabaseAdminClient: mocks.getSupabaseAdminClient,
}));

vi.mock('@/modules/email/nlp-extract-and-upload', () => ({
  uploadAttachmentToStorage: vi.fn().mockResolvedValue({ filename: 'test.pdf', url: 'https://example.com/test.pdf', size: 100 }),
}));

const submissionMocks = vi.hoisted(() => ({
  findSubmissionByMessageId: vi.fn().mockResolvedValue(null),
  insertSubmission: vi.fn().mockResolvedValue('sub-uuid'),
}));

vi.mock('@/features/candidate-management/infrastructure/submission-repository', () => ({
  findSubmissionByMessageId: submissionMocks.findSubmissionByMessageId,
  insertSubmission: submissionMocks.insertSubmission,
}));

import {
  recordSyncFailure,
  listRecentSyncErrors,
  clearSyncErrorsForTest,
  upsertCandidateFromATS,
  upsertCandidateFromEmailFull,
} from '@/modules/ingestion';

describe('Sync Error Store', () => {
  beforeEach(() => {
    clearSyncErrorsForTest();
    vi.clearAllMocks();
    mocks.isSupabaseConfigured.mockReturnValue(false);
  });

  it('records a sync failure with source attribution', async () => {
    recordSyncFailure('ats', 'rec-123', new Error('Connection timeout'));
    const errors = await listRecentSyncErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe('ats');
    expect(errors[0].recordId).toBe('rec-123');
    expect(errors[0].message).toBe('Connection timeout');
    expect(errors[0].timestamp).toBeTruthy();
    expect(errors[0].id).toMatch(/^ats-/);
  });

  it('records non-Error values as string messages', async () => {
    recordSyncFailure('email', 'msg-1', 'string error');
    const errors = await listRecentSyncErrors();
    expect(errors[0].message).toBe('string error');
  });

  it('maintains FIFO order (newest first)', async () => {
    recordSyncFailure('ats', 'first', new Error('err1'));
    recordSyncFailure('email', 'second', new Error('err2'));
    const errors = await listRecentSyncErrors();
    expect(errors[0].source).toBe('email');
    expect(errors[1].source).toBe('ats');
  });

  it('caps at 100 entries', async () => {
    for (let i = 0; i < 110; i++) {
      recordSyncFailure('ats', `rec-${i}`, new Error(`err-${i}`));
    }
    const errors = await listRecentSyncErrors();
    expect(errors).toHaveLength(100);
    // Newest should be rec-109
    expect(errors[0].recordId).toBe('rec-109');
  });

  it('clears errors for test isolation', async () => {
    recordSyncFailure('ats', 'rec-1', new Error('err'));
    clearSyncErrorsForTest();
    const errors = await listRecentSyncErrors();
    expect(errors).toHaveLength(0);
  });

  it('returns a copy, not a reference to internal state', async () => {
    recordSyncFailure('ats', 'rec-1', new Error('err'));
    const errors1 = await listRecentSyncErrors();
    const errors2 = await listRecentSyncErrors();
    expect(errors1).not.toBe(errors2);
    expect(errors1).toEqual(errors2);
  });
});

// createIngestionEnvelope test removed — dead code was removed from ingestion module

describe('upsertCandidateFromATS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncErrorsForTest();
  });

  it('skips persist when Supabase is not configured', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false);
    await upsertCandidateFromATS({ firstName: 'Jane', email: 'jane@test.com' });
    expect(mocks.getSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('rejects candidates with no email and no phone', async () => {
    const chainable = {
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    };
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({ from: vi.fn().mockReturnValue(chainable) });
    await upsertCandidateFromATS({ firstName: 'NoContact', source: 'ats' });
    // Read errors back — need to switch to in-memory since Supabase mock returns empty
    mocks.isSupabaseConfigured.mockReturnValue(false);
    const errors = await listRecentSyncErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('no email or phone');
  });

  it('upserts new candidate by email', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') {
          return { upsert: mockUpsert, insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        return {};
      }),
    });

    await upsertCandidateFromATS({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.com',
      phone: '555-1234',
      source: 'ceipal',
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const upsertedRow = mockUpsert.mock.calls[0][0];
    expect(upsertedRow.first_name).toBe('Jane');
    expect(upsertedRow.last_name).toBe('Doe');
    expect(upsertedRow.email).toBe('jane@test.com');
    expect(upsertedRow.source).toBe('ceipal');
    expect(upsertedRow.tenant_id).toBe('cbl-aero');
  });

  it('throws on upsert failure', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: { message: 'constraint violation' } });
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn(() => ({ upsert: mockUpsert, insert: vi.fn().mockResolvedValue({ error: null }) })),
    });

    await expect(
      upsertCandidateFromATS({ firstName: 'Bad', email: 'bad@test.com', source: 'ats' })
    ).rejects.toThrow('Candidate upsert failed: constraint violation');
  });
});

describe('upsertCandidateFromEmailFull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncErrorsForTest();
    submissionMocks.findSubmissionByMessageId.mockResolvedValue(null);
    submissionMocks.insertSubmission.mockResolvedValue('sub-uuid');
  });

  it('skips persist when Supabase is not configured', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false);
    await upsertCandidateFromEmailFull({
      id: 'msg-1',
      subject: 'Test',
      body: '<p>Test body</p>',
      candidate: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', source: 'email' },
      receivedAt: '2026-03-31T00:00:00Z',
    });
    expect(mocks.getSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('inserts new candidate and submission with attachments', async () => {
    const mockCandidateUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockCandidateSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'cand-uuid-1' }, error: null }),
        }),
      }),
    });

    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') return { select: mockCandidateSelect, upsert: mockCandidateUpsert };
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }),
      storage: { from: vi.fn().mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }), getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/test.pdf' } }) }) },
    });

    await upsertCandidateFromEmailFull({
      id: 'msg-new',
      subject: 'MHI | Tucson | A&P Tech | Jane',
      body: '<p>Candidate details</p>',
      candidate: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', source: 'email', extractionMethod: 'llm' },
      receivedAt: '2026-03-31T12:00:00Z',
    });

    expect(mockCandidateUpsert).toHaveBeenCalledTimes(1);
    expect(submissionMocks.insertSubmission).toHaveBeenCalledTimes(1);
    const subParams = submissionMocks.insertSubmission.mock.calls[0][0];
    expect(subParams.emailSubject).toBe('MHI | Tucson | A&P Tech | Jane');
    expect(subParams.extractionModel).toBe('claude-haiku-4-5-20251001');
    expect(subParams.candidateId).toBe('cand-uuid-1');
  });

  it('skips already-processed email by message ID (dedup before any DB writes)', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn(() => ({})),
    });

    // Mock submission dedup to return an existing submission
    submissionMocks.findSubmissionByMessageId.mockResolvedValueOnce({ id: 'sub-existing' });

    const mockUpsert = vi.fn();
    await upsertCandidateFromEmailFull({
      id: 'msg-duplicate',
      subject: 'Already processed',
      body: '<p>body</p>',
      candidate: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', source: 'email' },
      receivedAt: '2026-03-31T12:00:00Z',
    });

    // Neither candidate upsert nor submission insert should be called — dedup skipped everything
    expect(submissionMocks.insertSubmission).not.toHaveBeenCalled();
  });

  it('upserts existing candidate by email dedup', async () => {
    const mockCandidateUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockCandidateSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'cand-existing' }, error: null }),
        }),
      }),
    });
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') return { select: mockCandidateSelect, upsert: mockCandidateUpsert };
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }),
    });

    await upsertCandidateFromEmailFull({
      id: 'msg-update',
      subject: 'Updated submission',
      body: '<p>body</p>',
      candidate: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', source: 'email' },
      receivedAt: '2026-03-31T12:00:00Z',
    });

    expect(mockCandidateUpsert).toHaveBeenCalledTimes(1);
    expect(submissionMocks.insertSubmission).toHaveBeenCalledTimes(1);
  });
});
