import { NextRequest, NextResponse } from 'next/server';
import { CeipalIngestionJob, EmailIngestionJob, OneDriveResumePollerJob } from '@/modules/ingestion/jobs';
import { isSupabaseConfigured, getSupabaseAdminClient } from '@/modules/persistence';
import {
  countCandidatesBySource,
  getLastCandidateUpdateBySource,
} from '@/features/candidate-management/infrastructure/candidate-repository';

const JOBS_SECRET = process.env.CBL_JOBS_SECRET;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!JOBS_SECRET) {
    console.error('[JobsRoute] CBL_JOBS_SECRET not configured — rejecting all requests');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${JOBS_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    job?: string;
    mode?: 'initial-load' | 'daily-sync';
    pages?: number; // initial-load: how many pages per call (default 1, max 20)
  };

  const jobName = body.job;
  if (!jobName || !['ceipal-sync', 'email-sync', 'onedrive-sync'].includes(jobName)) {
    return NextResponse.json({
      error: 'Invalid job',
      available: ['ceipal-sync', 'email-sync', 'onedrive-sync'],
    }, { status: 400 });
  }

  const start = Date.now();

  try {
    if (jobName === 'ceipal-sync') {
      await runCeipalSync(body.mode ?? 'daily-sync', Math.min(body.pages ?? 1, 20));
    } else if (jobName === 'onedrive-sync') {
      const job = new OneDriveResumePollerJob();
      await job.run();
    } else {
      const job = new EmailIngestionJob();
      await job.run();
    }

    return NextResponse.json({
      status: 'ok',
      job: jobName,
      mode: body.mode ?? 'daily-sync',
      duration_ms: Date.now() - start,
    });
  } catch (err: unknown) {
    return NextResponse.json({
      status: 'error',
      job: jobName,
      message: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    }, { status: 500 });
  }
}

/**
 * Orchestrates Ceipal sync based on mode:
 * - initial-load: fetch 1 page from resume point (call repeatedly to load all 733K)
 * - daily-sync: fetch ALL new/modified records since last update
 */
async function runCeipalSync(mode: 'initial-load' | 'daily-sync', pages: number = 1) {
  const job = new CeipalIngestionJob();

  if (mode === 'initial-load') {
    const startPage = await getResumePage();
    console.log(`[CeipalSync] Initial load — pages ${startPage} to ${startPage + pages - 1}`);
    await job.run({ startPage, maxPages: pages });
  } else {
    const since = await getLastModifiedDate();
    console.log(`[CeipalSync] Daily sync — since ${since?.toISOString() ?? 'all time'}`);
    await job.run({ since, maxPages: 50 });
  }
}

async function getResumePage(): Promise<number> {
  if (!isSupabaseConfigured()) return 1;
  try {
    const candidateCount = await countCandidatesBySource('ceipal');
    const basePage = Math.floor(candidateCount / 50) + 1;

    // Problem: when the fingerprint gate skips all records on a page (already processed),
    // no new candidates are inserted → count doesn't change → same page forever.
    // Fix: count ats_external_id fingerprints and advance past pages they cover.
    // Fingerprints are recorded for EVERY record the job encounters (new or duplicate),
    // so they track the true high-water mark of pages seen.
    try {
      const db = getSupabaseAdminClient();
      const { count: fpCount, error } = await db
        .from('content_fingerprints')
        .select('id', { count: 'exact', head: true })
        .eq('fingerprint_type', 'ats_external_id')
        .eq('tenant_id', 'cbl-aero');
      if (!error && fpCount && fpCount > 0) {
        // Each fingerprint = 1 Ceipal record seen. Pages beyond the candidate count
        // that were fingerprinted but didn't increase the count need to be skipped.
        const fpPages = Math.ceil(fpCount / 50);
        return basePage + fpPages;
      }
    } catch {
      // fingerprint count unavailable — use candidate count only
    }

    return basePage;
  } catch {
    return 1;
  }
}

async function getLastModifiedDate(): Promise<Date | undefined> {
  if (!isSupabaseConfigured()) return undefined;
  try {
    return await getLastCandidateUpdateBySource('ceipal');
  } catch {
    return undefined;
  }
}
