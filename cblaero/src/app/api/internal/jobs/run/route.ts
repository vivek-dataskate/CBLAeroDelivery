import { NextRequest, NextResponse } from 'next/server';
import { CeipalIngestionJob, EmailIngestionJob, OneDriveResumePollerJob } from '@/modules/ingestion/jobs';
import { isSupabaseConfigured } from '@/modules/persistence';
import {
  countCandidatesBySource,
  getLastCandidateUpdateBySource,
} from '@/features/candidate-management/infrastructure/candidate-repository';
import {
  getMarkerValue,
  setMarkerValue,
} from '@/features/candidate-management/infrastructure/sync-error-repository';

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
    const endPage = startPage + pages - 1;
    console.log(`[CeipalSync] Initial load — pages ${startPage} to ${endPage}`);
    await job.run({ startPage, maxPages: pages });

    // Always advance the high-water mark by the full page count requested,
    // regardless of how many records were actually upserted vs skipped/failed.
    // This prevents the resume page from getting stuck when the fingerprint
    // gate or identity validation filters out records without increasing counts.
    await saveResumePage(endPage + 1);
  } else {
    const since = await getLastModifiedDate();
    console.log(`[CeipalSync] Daily sync — since ${since?.toISOString() ?? 'all time'}`);
    await job.run({ since, maxPages: 50 });
  }
}

const RESUME_PAGE_KEY = 'ceipal_initial_load_resume_page';

async function getResumePage(): Promise<number> {
  if (!isSupabaseConfigured()) return 1;
  try {
    const stored = await getMarkerValue(RESUME_PAGE_KEY, 'resume_page');
    if (stored) {
      const page = parseInt(stored, 10);
      if (!isNaN(page) && page > 1) return page;
    }

    // Fallback: derive from candidate count (first run or missing marker)
    const count = await countCandidatesBySource('ceipal');
    return Math.ceil(count / 50) + 1;
  } catch {
    return 1;
  }
}

async function saveResumePage(nextPage: number): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    await setMarkerValue(RESUME_PAGE_KEY, 'resume_page', String(nextPage));
  } catch {
    // Non-fatal — next run will derive from counts
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
