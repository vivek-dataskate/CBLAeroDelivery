export type DataResidencyTargetKind = "data" | "logs" | "backups";

export type DataResidencyTargets = Record<DataResidencyTargetKind, string | null>;

export type DataResidencyValidation = {
  valid: boolean;
  approvedRegions: string[];
  targets: DataResidencyTargets;
  violations: string[];
};

const REQUIRED_TARGETS: ReadonlyArray<{
  kind: DataResidencyTargetKind;
  envKey: string;
}> = [
  { kind: "data", envKey: "CBL_DATA_REGION" },
  { kind: "logs", envKey: "CBL_LOG_REGION" },
  { kind: "backups", envKey: "CBL_BACKUP_REGION" },
];

function parseRegionList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function normalizeRegion(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isUsRegionIdentifier(value: string): boolean {
  return /^us-[a-z0-9-]+$/.test(value);
}

function shouldEnforcePolicy(env: NodeJS.ProcessEnv): boolean {
  const mode = (env.NODE_ENV ?? "development").trim().toLowerCase();
  return mode !== "test";
}

export function evaluateUsaDataResidencyPolicy(
  env: NodeJS.ProcessEnv = process.env,
): DataResidencyValidation {
  const approvedRegions = parseRegionList(env.CBL_APPROVED_US_REGIONS);

  const targets: DataResidencyTargets = {
    data: null,
    logs: null,
    backups: null,
  };

  const violations: string[] = [];

  if (approvedRegions.length === 0) {
    violations.push(
      "CBL_APPROVED_US_REGIONS is required and must include approved USA regions.",
    );
  }

  for (const approvedRegion of approvedRegions) {
    if (!isUsRegionIdentifier(approvedRegion)) {
      violations.push(
        `CBL_APPROVED_US_REGIONS contains non-USA region value: ${approvedRegion}.`,
      );
    }
  }

  for (const target of REQUIRED_TARGETS) {
    const value = normalizeRegion(env[target.envKey]);
    targets[target.kind] = value;

    if (!value) {
      violations.push(`${target.envKey} is required and cannot be empty.`);
      continue;
    }

    if (!approvedRegions.includes(value)) {
      const approved = approvedRegions.length > 0 ? approvedRegions.join(", ") : "<none>";
      violations.push(
        `${target.envKey}=${value} is not in approved USA regions: ${approved}.`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    approvedRegions,
    targets,
    violations,
  };
}

export function assertUsaDataResidencyPolicyConfigured(
  env: NodeJS.ProcessEnv = process.env,
): DataResidencyValidation {
  const validation = evaluateUsaDataResidencyPolicy(env);

  if (!shouldEnforcePolicy(env)) {
    return validation;
  }

  if (!validation.valid) {
    throw new Error(
      `USA data residency policy gate failed: ${validation.violations.join(" ")}`,
    );
  }

  return validation;
}