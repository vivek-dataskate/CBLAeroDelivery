#!/usr/bin/env node

const approvedRegions = (process.env.CBL_APPROVED_US_REGIONS ?? "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const targetMap = {
  CBL_DATA_REGION: (process.env.CBL_DATA_REGION ?? "").trim().toLowerCase(),
  CBL_LOG_REGION: (process.env.CBL_LOG_REGION ?? "").trim().toLowerCase(),
  CBL_BACKUP_REGION: (process.env.CBL_BACKUP_REGION ?? "").trim().toLowerCase(),
};

const issues = [];

if (approvedRegions.length === 0) {
  issues.push("CBL_APPROVED_US_REGIONS is required and must include approved USA regions.");
}

for (const region of approvedRegions) {
  if (!/^us-[a-z0-9-]+$/.test(region)) {
    issues.push(`CBL_APPROVED_US_REGIONS contains non-USA region value: ${region}.`);
  }
}

for (const [key, value] of Object.entries(targetMap)) {
  if (!value) {
    issues.push(`${key} is required and cannot be empty.`);
    continue;
  }

  if (!approvedRegions.includes(value)) {
    issues.push(
      `${key}=${value} is not in approved USA regions: ${
        approvedRegions.length > 0 ? approvedRegions.join(", ") : "<none>"
      }.`,
    );
  }
}

if (issues.length > 0) {
  console.error(`USA data residency policy gate failed: ${issues.join(" ")}`);
  process.exit(1);
}

console.log("USA data residency preflight passed.");