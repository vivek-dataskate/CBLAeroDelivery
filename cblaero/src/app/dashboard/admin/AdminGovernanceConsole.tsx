"use client";

import { FormEvent, useMemo, useState } from "react";

import type { GovernanceInvitation, ManagedUser } from "@/modules/admin";
import type { AdminActionEvent, StepUpAttemptEvent } from "@/modules/audit";
import type { SessionRole } from "@/modules/auth";

type GovernancePayload = {
  users: ManagedUser[];
  invitations: GovernanceInvitation[];
  adminActions: AdminActionEvent[];
  stepUpAttempts: StepUpAttemptEvent[];
};

type Props = {
  tenantId: string;
  initialPayload: GovernancePayload;
};

const ALL_ROLES: SessionRole[] = [
  "recruiter",
  "delivery-head",
  "admin",
  "compliance-officer",
];

type ParsedError = {
  code: string | null;
  message: string;
  reauthenticateUrl: string | null;
};

async function parseError(response: Response): Promise<ParsedError> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        reauthenticateUrl?: string;
      };
    };

    return {
      code: body.error?.code ?? null,
      message: body.error?.message ?? "Request failed.",
      reauthenticateUrl:
        typeof body.error?.reauthenticateUrl === "string"
          ? body.error.reauthenticateUrl
          : null,
    };
  } catch {
    return {
      code: null,
      message: "Request failed.",
      reauthenticateUrl: null,
    };
  }
}

export default function AdminGovernanceConsole({ tenantId, initialPayload }: Props) {
  const [payload, setPayload] = useState(initialPayload);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [stepUpUrl, setStepUpUrl] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<SessionRole>("recruiter");
  const [inviteTeams, setInviteTeams] = useState("");

  const [roleTargetActorId, setRoleTargetActorId] = useState("");
  const [roleValue, setRoleValue] = useState<SessionRole>("recruiter");

  const [teamTargetActorId, setTeamTargetActorId] = useState("");
  const [teamValues, setTeamValues] = useState("");

  const knownActorIds = useMemo(
    () => payload.users.map((user) => user.actorId).sort((left, right) => left.localeCompare(right)),
    [payload.users],
  );

  async function refreshGovernance() {
    const response = await fetch(`/api/internal/admin/governance?tenantId=${encodeURIComponent(tenantId)}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      const parsed = await parseError(response);
      throw new Error(parsed.message);
    }

    const body = (await response.json()) as {
      data?: GovernancePayload;
    };

    if (!body.data) {
      throw new Error("Governance payload missing in response.");
    }

    setPayload(body.data);
  }

  async function submitGovernanceAction(body: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    setError("");
    setMessage("");
    setStepUpUrl(null);

    try {
      const response = await fetch("/api/internal/admin/governance", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const parsed = await parseError(response);
        if (parsed.code === "step_up_required" && parsed.reauthenticateUrl) {
          setStepUpUrl(parsed.reauthenticateUrl);
        }

        throw new Error(parsed.message);
      }

      const json = (await response.json()) as {
        data?: {
          governance?: GovernancePayload;
        };
      };

      if (json.data?.governance) {
        setPayload(json.data.governance);
      } else {
        await refreshGovernance();
      }

      setMessage(successMessage);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unknown request failure.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshClick() {
    setBusy(true);
    setError("");
    setMessage("");
    setStepUpUrl(null);

    try {
      await refreshGovernance();
      setMessage("Governance data refreshed.");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Refresh failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await submitGovernanceAction(
      {
        action: "invite_user",
        email: inviteEmail,
        role: inviteRole,
        teamIds: inviteTeams,
      },
      "Invitation created.",
    );

    setInviteEmail("");
    setInviteTeams("");
  }

  async function handleAssignRoleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await submitGovernanceAction(
      {
        action: "assign_role",
        targetActorId: roleTargetActorId,
        role: roleValue,
      },
      "Role assignment updated.",
    );
  }

  async function handleTeamsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await submitGovernanceAction(
      {
        action: "update_team_membership",
        targetActorId: teamTargetActorId,
        teamIds: teamValues,
      },
      "Team membership updated.",
    );
  }

  return (
    <section className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-white">User, Role, and Team Governance</h2>
        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={busy}
          className="rounded-md border border-cyan-200/40 px-3 py-1 text-xs text-cyan-100 hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-70"
        >
          Refresh
        </button>
      </div>

      {message ? (
        <p className="rounded-xl border border-emerald-300/35 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-100">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="rounded-xl border border-rose-300/35 bg-rose-500/15 px-4 py-2 text-sm text-rose-100">
          <p>{error}</p>
          {stepUpUrl ? (
            <p className="mt-1 text-xs text-rose-100/90">
              Re-authenticate here: <a href={stepUpUrl} className="underline">Continue to SSO</a>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-3">
        <form
          onSubmit={handleInviteSubmit}
          className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 text-sm"
        >
          <h3 className="text-base font-medium text-white">Invite User</h3>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Email
            <input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              required
              type="email"
              placeholder="new.user@cblsolutions.com"
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Role
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as SessionRole)}
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            >
              {ALL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Team IDs
            <input
              value={inviteTeams}
              onChange={(event) => setInviteTeams(event.target.value)}
              placeholder="team-east, team-red"
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <button
            disabled={busy}
            type="submit"
            className="mt-4 rounded-md bg-cyan-500/80 px-3 py-1.5 font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Send Invite
          </button>
        </form>

        <form
          onSubmit={handleAssignRoleSubmit}
          className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 text-sm"
        >
          <h3 className="text-base font-medium text-white">Assign Role</h3>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Target Actor ID
            <input
              list="known-actor-ids"
              value={roleTargetActorId}
              onChange={(event) => setRoleTargetActorId(event.target.value)}
              required
              placeholder="actor-id"
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            New Role
            <select
              value={roleValue}
              onChange={(event) => setRoleValue(event.target.value as SessionRole)}
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            >
              {ALL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy}
            type="submit"
            className="mt-4 rounded-md bg-cyan-500/80 px-3 py-1.5 font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Apply Role
          </button>
        </form>

        <form
          onSubmit={handleTeamsSubmit}
          className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 text-sm"
        >
          <h3 className="text-base font-medium text-white">Update Team Membership</h3>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Target Actor ID
            <input
              list="known-actor-ids"
              value={teamTargetActorId}
              onChange={(event) => setTeamTargetActorId(event.target.value)}
              required
              placeholder="actor-id"
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="mt-3 block text-xs uppercase tracking-[0.15em] text-slate-400">
            Team IDs
            <input
              value={teamValues}
              onChange={(event) => setTeamValues(event.target.value)}
              placeholder="team-east, team-red"
              className="mt-1 w-full rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-sm text-white"
            />
          </label>
          <button
            disabled={busy}
            type="submit"
            className="mt-4 rounded-md bg-cyan-500/80 px-3 py-1.5 font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-70"
          >
            Save Teams
          </button>
        </form>
      </div>

      <datalist id="known-actor-ids">
        {knownActorIds.map((actorId) => (
          <option key={actorId} value={actorId} />
        ))}
      </datalist>

      <div className="grid gap-5 lg:grid-cols-2">
        <article className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
          <h3 className="text-base font-medium text-white">Managed Users</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm text-slate-200">
              <thead>
                <tr className="text-xs uppercase tracking-[0.12em] text-slate-400">
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Role</th>
                  <th className="pb-2">Teams</th>
                  <th className="pb-2">Actor ID</th>
                </tr>
              </thead>
              <tbody>
                {payload.users.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-2 text-slate-400">
                      No managed users yet.
                    </td>
                  </tr>
                ) : (
                  payload.users.map((user) => (
                    <tr key={user.actorId} className="border-t border-white/10 align-top">
                      <td className="py-2">{user.email}</td>
                      <td className="py-2">{user.role}</td>
                      <td className="py-2">{user.teamIds.join(", ") || "-"}</td>
                      <td className="py-2 text-xs text-slate-400">{user.actorId}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
          <h3 className="text-base font-medium text-white">Pending Invitations</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm text-slate-200">
              <thead>
                <tr className="text-xs uppercase tracking-[0.12em] text-slate-400">
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Role</th>
                  <th className="pb-2">Teams</th>
                  <th className="pb-2">Expires</th>
                </tr>
              </thead>
              <tbody>
                {payload.invitations.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-2 text-slate-400">
                      No pending invitations.
                    </td>
                  </tr>
                ) : (
                  payload.invitations.map((invitation) => (
                    <tr key={invitation.invitationId} className="border-t border-white/10 align-top">
                      <td className="py-2">{invitation.email}</td>
                      <td className="py-2">{invitation.role}</td>
                      <td className="py-2">{invitation.teamIds.join(", ") || "-"}</td>
                      <td className="py-2 text-xs text-slate-400">{invitation.expiresAtIso}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>

      <article className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
        <h3 className="text-base font-medium text-white">Admin Action Audit Trail</h3>
        <ul className="mt-3 space-y-2 text-sm text-slate-200">
          {payload.adminActions.length === 0 ? (
            <li className="text-slate-400">No admin actions recorded yet.</li>
          ) : (
            payload.adminActions.map((event) => (
              <li key={`${event.traceId}-${event.occurredAtIso}`} className="rounded-lg border border-white/10 px-3 py-2">
                <p className="font-medium text-cyan-100">
                  {event.actionType} by {event.actorId}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                  {event.occurredAtIso} | target: {event.targetActorId ?? "n/a"}
                </p>
              </li>
            ))
          )}
        </ul>
      </article>

      <article className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
        <h3 className="text-base font-medium text-white">Step-Up Attempt Audit Trail</h3>
        <ul className="mt-3 space-y-2 text-sm text-slate-200">
          {payload.stepUpAttempts.length === 0 ? (
            <li className="text-slate-400">No step-up attempts recorded yet.</li>
          ) : (
            payload.stepUpAttempts.map((event) => (
              <li key={`${event.traceId}-${event.occurredAtIso}`} className="rounded-lg border border-white/10 px-3 py-2">
                <p className="font-medium text-cyan-100">
                  {event.action} {event.outcome} by {event.actorId}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                  {event.occurredAtIso} | reason: {event.reason ?? "verified"}
                </p>
              </li>
            ))
          )}
        </ul>
      </article>
    </section>
  );
}
