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

import {
  recordSyncFailure,
  listRecentSyncErrors,
  clearSyncErrorsForTest,
  createIngestionEnvelope,
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

describe('createIngestionEnvelope', () => {
  it('creates envelope with source and ISO timestamp', () => {
    const envelope = createIngestionEnvelope('email');
    expect(envelope.source).toBe('email');
    expect(envelope.receivedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

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

  it('inserts new candidate by email', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    });
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') {
          return { select: mockSelect, insert: mockInsert };
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

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.first_name).toBe('Jane');
    expect(insertedRow.last_name).toBe('Doe');
    expect(insertedRow.email).toBe('jane@test.com');
    expect(insertedRow.source).toBe('ceipal');
    expect(insertedRow.tenant_id).toBe('cbl-aero');
  });

  it('throws on insert failure', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: { message: 'constraint violation' } });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    });
    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn(() => ({ select: mockSelect, insert: mockInsert })),
    });

    await expect(
      upsertCandidateFromATS({ firstName: 'Bad', email: 'bad@test.com', source: 'ats' })
    ).rejects.toThrow('Candidate insert failed: constraint violation');
  });
});

describe('upsertCandidateFromEmailFull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSyncErrorsForTest();
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
    const mockCandidateInsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'cand-uuid-1' }, error: null }),
      }),
    });
    const mockSubInsert = vi.fn().mockResolvedValue({ error: null });
    const mockSubSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null }), // no existing submission
        }),
      }),
    });
    const mockCandidateSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null }), // no existing candidate
        }),
      }),
    });

    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') return { select: mockCandidateSelect, insert: mockCandidateInsert };
        if (table === 'candidate_submissions') return { select: mockSubSelect, insert: mockSubInsert };
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

    expect(mockCandidateInsert).toHaveBeenCalledTimes(1);
    expect(mockSubInsert).toHaveBeenCalledTimes(1);
    const subRow = mockSubInsert.mock.calls[0][0];
    expect(subRow.email_subject).toBe('MHI | Tucson | A&P Tech | Jane');
    expect(subRow.extraction_model).toBe('claude-haiku-4-5-20251001');
    expect(subRow.candidate_id).toBe('cand-uuid-1');
  });

  it('skips already-processed email by message ID', async () => {
    const mockCandidateUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const mockCandidateSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'cand-existing' } }),
        }),
      }),
    });
    const mockSubSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'sub-existing' } }), // already processed
        }),
      }),
    });
    const mockSubInsert = vi.fn();

    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') return { select: mockCandidateSelect, update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) };
        if (table === 'candidate_submissions') return { select: mockSubSelect, insert: mockSubInsert };
        return {};
      }),
    });

    await upsertCandidateFromEmailFull({
      id: 'msg-duplicate',
      subject: 'Already processed',
      body: '<p>body</p>',
      candidate: { firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', source: 'email' },
      receivedAt: '2026-03-31T12:00:00Z',
    });

    // Submission insert should NOT be called — dedup skipped it
    expect(mockSubInsert).not.toHaveBeenCalled();
  });

  it('updates existing candidate by email dedup', async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const mockCandidateSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'cand-existing' } }),
        }),
      }),
    });
    const mockSubSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    });

    mocks.isSupabaseConfigured.mockReturnValue(true);
    mocks.getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'candidates') return { select: mockCandidateSelect, update: mockUpdate };
        if (table === 'candidate_submissions') return { select: mockSubSelect, insert: vi.fn().mockResolvedValue({ error: null }) };
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

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
