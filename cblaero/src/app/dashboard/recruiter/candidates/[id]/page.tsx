"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";

type CandidateDetail = {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  email: string | null;
  alternateEmail: string | null;
  phone: string | null;
  homePhone: string | null;
  workPhone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  availabilityStatus: string;
  ingestionState: string;
  jobTitle: string | null;
  currentCompany: string | null;
  skills: unknown[];
  certifications: unknown[];
  experience: unknown[];
  yearsOfExperience: string | null;
  workAuthorization: string | null;
  clearance: string | null;
  aircraftExperience: unknown[];
  employmentType: string | null;
  currentRate: string | null;
  perDiem: string | null;
  hasApLicense: boolean | null;
  shiftPreference: string | null;
  expectedStartDate: string | null;
  callAvailability: string | null;
  interviewAvailability: string | null;
  veteranStatus: string | null;
  source: string;
  ceipalId: string | null;
  submittedBy: string | null;
  submitterEmail: string | null;
  extraAttributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const AVAILABILITY_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  passive: "bg-yellow-100 text-yellow-700",
  unavailable: "bg-red-100 text-red-700",
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value}</dd>
    </div>
  );
}

function BoolField({ label, value }: { label: string; value: boolean | null | undefined }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value ? "Yes" : "No"}</dd>
    </div>
  );
}

function ArrayField({ label, items }: { label: string; items: unknown[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="col-span-2">
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <span key={i} className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700">
            {typeof item === "string" ? item : JSON.stringify(item)}
          </span>
        ))}
      </dd>
    </div>
  );
}

export default function CandidateDetailPage() {
  const params = useParams();
  const candidateId = params.id as string;
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/internal/candidates/${candidateId}`);
        const json = await res.json();
        if (!res.ok) {
          setError(json.error?.message ?? "Failed to load candidate.");
          return;
        }
        setCandidate(json.data);
      } catch {
        setError("Network error.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [candidateId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading candidate...</p>
      </div>
    );
  }

  if (error || !candidate) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
        <p className="text-red-600">{error ?? "Candidate not found."}</p>
        <Link href="/dashboard/recruiter/candidates" className="text-sm text-emerald-600 hover:text-emerald-700">
          &larr; Back to Search
        </Link>
      </div>
    );
  }

  const fullName = [candidate.firstName, candidate.middleName, candidate.lastName].filter(Boolean).join(" ");
  const location = [candidate.city, candidate.state, candidate.country].filter(Boolean).join(", ");
  const fullAddress = [candidate.address, candidate.city, candidate.state, candidate.postalCode, candidate.country].filter(Boolean).join(", ");

  // Flatten extra attributes for display
  const extraEntries = Object.entries(candidate.extraAttributes ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/dashboard/recruiter/candidates" className="text-sm text-emerald-600 hover:text-emerald-700">
            &larr; Back to Search
          </Link>
          <span className="text-xs text-gray-400">ID: {candidate.id}</span>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          {/* Name & Status Header */}
          <div className="border-b border-gray-100 px-6 py-5">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-gray-900">{fullName}</h1>
                {candidate.jobTitle && <p className="mt-1 text-sm text-gray-600">{candidate.jobTitle}</p>}
                {candidate.currentCompany && <p className="text-sm text-gray-500">at {candidate.currentCompany}</p>}
                {location && <p className="mt-1 text-xs text-gray-400">{location}</p>}
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${AVAILABILITY_BADGE[candidate.availabilityStatus] ?? "bg-gray-100 text-gray-600"}`}>
                  {candidate.availabilityStatus}
                </span>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600">
                  {candidate.ingestionState}
                </span>
              </div>
            </div>
          </div>

          {/* Contact Info */}
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Contact</h2>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
              <Field label="Email" value={candidate.email} />
              <Field label="Alt. Email" value={candidate.alternateEmail} />
              <Field label="Phone" value={candidate.phone} />
              <Field label="Home Phone" value={candidate.homePhone} />
              <Field label="Work Phone" value={candidate.workPhone} />
              <Field label="Address" value={fullAddress !== location ? fullAddress : null} />
            </dl>
          </div>

          {/* Professional */}
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Professional</h2>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
              <Field label="Job Title" value={candidate.jobTitle} />
              <Field label="Company" value={candidate.currentCompany} />
              <Field label="Years of Experience" value={candidate.yearsOfExperience} />
              <Field label="Employment Type" value={candidate.employmentType} />
              <Field label="Current Rate" value={candidate.currentRate} />
              <Field label="Per Diem" value={candidate.perDiem} />
              <Field label="Shift Preference" value={candidate.shiftPreference} />
              <Field label="Expected Start" value={candidate.expectedStartDate} />
              <Field label="Work Authorization" value={candidate.workAuthorization} />
              <Field label="Clearance" value={candidate.clearance} />
              <BoolField label="A&P License" value={candidate.hasApLicense} />
              <Field label="Veteran Status" value={candidate.veteranStatus} />
              <ArrayField label="Skills" items={candidate.skills} />
              <ArrayField label="Certifications" items={candidate.certifications} />
              <ArrayField label="Aircraft Experience" items={candidate.aircraftExperience} />
            </dl>
          </div>

          {/* Experience */}
          {Array.isArray(candidate.experience) && candidate.experience.length > 0 && (
            <div className="border-b border-gray-100 px-6 py-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Experience</h2>
              <div className="space-y-3">
                {candidate.experience.map((exp, i) => (
                  <div key={i} className="rounded-md border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
                    {typeof exp === "string" ? exp : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(exp, null, 2)}</pre>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Availability */}
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Availability</h2>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
              <Field label="Call Availability" value={candidate.callAvailability} />
              <Field label="Interview Availability" value={candidate.interviewAvailability} />
            </dl>
          </div>

          {/* Source & Metadata */}
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Source</h2>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
              <Field label="Source" value={candidate.source} />
              <Field label="Ceipal ID" value={candidate.ceipalId} />
              <Field label="Submitted By" value={candidate.submittedBy} />
              <Field label="Submitter Email" value={candidate.submitterEmail} />
              <Field label="Added" value={new Date(candidate.createdAt).toLocaleDateString()} />
              <Field label="Last Updated" value={new Date(candidate.updatedAt).toLocaleDateString()} />
            </dl>
          </div>

          {/* Extra Attributes */}
          {extraEntries.length > 0 && (
            <div className="px-6 py-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Additional Info</h2>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
                {extraEntries.map(([key, val]) => (
                  <Field key={key} label={key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} value={String(val)} />
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
