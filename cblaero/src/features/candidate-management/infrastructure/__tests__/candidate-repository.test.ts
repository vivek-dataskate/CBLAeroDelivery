import { beforeEach, describe, expect, it } from "vitest";

import {
  CandidateNotFoundError,
  clearCandidateStoreForTest,
  getCandidateById,
  listCandidates,
  seedCandidateForTest,
} from "../candidate-repository";
import type { CandidateDetail } from "../../contracts/candidate";

function makeCandidate(overrides: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    id: crypto.randomUUID(),
    tenantId: "tenant-a",
    name: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "5551234567",
    location: "Dallas, TX",
    availabilityStatus: "active",
    ingestionState: "active",
    source: "csv",
    sourceBatchId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    middleName: null,
    homePhone: null,
    workPhone: null,
    address: null,
    city: null,
    state: null,
    country: null,
    postalCode: null,
    currentCompany: "AeroCorp",
    jobTitle: "A&P Mechanic",
    alternateEmail: null,
    skills: [],
    certifications: [],
    experience: [],
    extraAttributes: {},
    workAuthorization: null,
    clearance: null,
    aircraftExperience: [],
    employmentType: null,
    currentRate: null,
    perDiem: null,
    hasApLicense: null,
    yearsOfExperience: null,
    ceipalId: null,
    submittedBy: null,
    submitterEmail: null,
    shiftPreference: null,
    expectedStartDate: null,
    callAvailability: null,
    interviewAvailability: null,
    veteranStatus: null,
    ...overrides,
  };
}

describe("candidate-repository (in-memory)", () => {
  beforeEach(() => {
    clearCandidateStoreForTest();
  });

  describe("listCandidates", () => {
    it("returns empty array when no candidates exist", async () => {
      const result = await listCandidates({
        tenantId: "tenant-a",
        availabilityStatus: "active",
      });
      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it("returns candidates matching tenantId and availability filter", async () => {
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000001", tenantId: "tenant-a", availabilityStatus: "active" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000002", tenantId: "tenant-a", availabilityStatus: "passive" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000003", tenantId: "tenant-b", availabilityStatus: "active" }));

      const result = await listCandidates({ tenantId: "tenant-a", availabilityStatus: "active" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("00000000-0000-0000-0000-000000000001");
    });

    it("filters out non-active ingestion_state candidates", async () => {
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000010", ingestionState: "active" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000011", ingestionState: "pending_dedup" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000012", ingestionState: "pending_enrichment" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000013", ingestionState: "rejected" }));

      const result = await listCandidates({ tenantId: "tenant-a", availabilityStatus: "active" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("00000000-0000-0000-0000-000000000010");
    });

    it("filters by location substring (case-insensitive)", async () => {
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000020", location: "Dallas, TX" }));
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000021", location: "Houston, TX" }));

      const result = await listCandidates({ tenantId: "tenant-a", location: "dallas" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("00000000-0000-0000-0000-000000000020");
    });

    it("filters by cert_type within certifications JSONB array", async () => {
      seedCandidateForTest(
        makeCandidate({
          id: "00000000-0000-0000-0000-000000000030",
          certifications: [{ type: "A&P", issuer: "FAA" }],
        }),
      );
      seedCandidateForTest(
        makeCandidate({
          id: "00000000-0000-0000-0000-000000000031",
          certifications: [{ type: "CFI", issuer: "FAA" }],
        }),
      );

      const result = await listCandidates({ tenantId: "tenant-a", certType: "a&p" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("00000000-0000-0000-0000-000000000030");
    });

    it("implements cursor-based pagination correctly", async () => {
      for (let i = 1; i <= 5; i++) {
        seedCandidateForTest(
          makeCandidate({ id: `00000000-0000-0000-0000-00000000000${i}`, availabilityStatus: "active" }),
        );
      }

      const page1 = await listCandidates({ tenantId: "tenant-a", availabilityStatus: "active", limit: 3 });
      expect(page1.items).toHaveLength(3);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listCandidates({
        tenantId: "tenant-a",
        availabilityStatus: "active",
        limit: 3,
        cursor: page1.nextCursor!,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items].map((c) => c.id);
      expect(new Set(allIds).size).toBe(5);
    });

    it("respects max limit of 100", async () => {
      for (let i = 1; i <= 5; i++) {
        seedCandidateForTest(makeCandidate({ id: `00000000-0000-0000-0000-0000000000a${i}`, availabilityStatus: "active" }));
      }
      const result = await listCandidates({ tenantId: "tenant-a", availabilityStatus: "active", limit: 200 });
      expect(result.items.length).toBeLessThanOrEqual(100);
    });

    it("isolates tenants — tenant-b cannot see tenant-a candidates", async () => {
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000040", tenantId: "tenant-a" }));

      const result = await listCandidates({ tenantId: "tenant-b", availabilityStatus: "active" });
      expect(result.items).toHaveLength(0);
    });
  });

  describe("getCandidateById", () => {
    it("returns full candidate detail when found", async () => {
      const candidate = makeCandidate({
        id: "00000000-0000-0000-0000-000000000050",
        tenantId: "tenant-a",
        jobTitle: "Senior A&P",
        skills: [{ name: "jet engines" }],
      });
      seedCandidateForTest(candidate);

      const result = await getCandidateById("00000000-0000-0000-0000-000000000050", "tenant-a");
      expect(result.id).toBe("00000000-0000-0000-0000-000000000050");
      expect(result.jobTitle).toBe("Senior A&P");
      expect(result.skills).toEqual([{ name: "jet engines" }]);
      expect(result.source).toBe("csv");
      expect(result.ingestionState).toBe("active");
    });

    it("throws CandidateNotFoundError when id not found", async () => {
      await expect(
        getCandidateById("00000000-0000-0000-0000-000000000099", "tenant-a"),
      ).rejects.toThrow(CandidateNotFoundError);
    });

    it("throws CandidateNotFoundError when id exists but tenant mismatches", async () => {
      seedCandidateForTest(makeCandidate({ id: "00000000-0000-0000-0000-000000000060", tenantId: "tenant-a" }));

      await expect(
        getCandidateById("00000000-0000-0000-0000-000000000060", "tenant-b"),
      ).rejects.toThrow(CandidateNotFoundError);
    });

    it("returns all source and ingestion metadata fields", async () => {
      const batchId = crypto.randomUUID();
      const candidate = makeCandidate({
        id: "00000000-0000-0000-0000-000000000070",
        source: "ats",
        sourceBatchId: batchId,
        ingestionState: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      });
      seedCandidateForTest(candidate);

      const result = await getCandidateById("00000000-0000-0000-0000-000000000070", "tenant-a");
      expect(result.source).toBe("ats");
      expect(result.sourceBatchId).toBe(batchId);
      expect(result.ingestionState).toBe("active");
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    });
  });
});
