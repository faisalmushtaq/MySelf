import { useState } from "react";
import { STUDIO_ROLES, atLeast, type StudioRole } from "@myself/studio";
import { studio, StudioCallError, useAccessConfig, useAudit, useMembers, useStudioSession, type MemberDoc } from "../data/index.js";
import { formatDate, ROLE_DESCRIPTIONS, ROLE_NAMES, toDate } from "../format.js";
import { AuditList, LoadError } from "../shell/common.js";
import { PageHead, Shell } from "../shell/Shell.js";
import { ConfirmDialog } from "../ui/dialog.js";
import { Badge, Button, Field, IconButton, Notice, Skeleton } from "../ui/kit.js";
import { useToast } from "../ui/toast.js";

/**
 * Who can use the Studio (docs/16 §5.7). Admins manage the list; everyone else
 * sees their own role and who to ask. Every change goes through a function that
 * re-checks the caller is an admin and writes the audit row, and takes effect on
 * the person's next request — there is no token to wait out.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/**
 * Addresses anyone can sign up for. The server refuses these as domain rules
 * whatever this says; checking here only saves a round trip and explains why.
 */
const CONSUMER = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

export function emailProblem(email: string): string | null {
  if (!email) return "Enter an email address.";
  if (!EMAIL.test(email)) return "That doesn’t look like an email address.";
  return null;
}

export function domainProblem(domain: string): string | null {
  if (!domain) return "Enter a domain, for example brainpop.com.";
  if (domain.includes("@")) return "Enter just the part after the @, for example brainpop.com.";
  if (!DOMAIN.test(domain)) return "That doesn’t look like a domain.";
  if (CONSUMER.has(domain)) return "Anyone can create an account at this domain, so it can’t be used as a rule. Add people individually instead.";
  return null;
}

/** The standalone page (#/access), for admins before any survey exists. */
export function AccessScreen() {
  return (
    <Shell crumb="Who has access">
      <div className="stp-page">
        <PageHead title="Who has access" lede="The Studio list is shared by every survey in the study." />
        <AccessPanel />
      </div>
    </Shell>
  );
}

export function AccessPanel() {
  const session = useStudioSession();
  if (!atLeast(session.role, "admin")) {
    const role = session.role ?? "viewer";
    return (
      <section className="stp-card" aria-labelledby="access-you">
        <h2 id="access-you" className="stp-h2">
          Your access
        </h2>
        <p>
          You&rsquo;re signed in as <strong>{session.user?.email}</strong> with the <strong>{ROLE_NAMES[role]}</strong>{" "}
          role. {ROLE_DESCRIPTIONS[role]}
        </p>
        <p className="stp-muted">To change who has access, or your own role, ask a Studio admin.</p>
      </section>
    );
  }
  return (
    <div className="stp-stack">
      <Members />
      <Domains />
      <RoleLegend />
      <AccessActivity />
    </div>
  );
}

function RoleSelect({
  value,
  onChange,
  label,
  disabled,
  id,
  describedBy,
}: {
  value: StudioRole;
  onChange: (role: StudioRole) => void;
  label?: string | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  describedBy?: string | undefined;
}) {
  return (
    <select
      id={id}
      className="st-select stp-role-select"
      aria-label={label}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as StudioRole)}
    >
      {STUDIO_ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_NAMES[r]}
        </option>
      ))}
    </select>
  );
}

function Members() {
  const session = useStudioSession();
  const members = useMembers();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MemberDoc | null>(null);
  const me = (session.user?.email ?? "").toLowerCase();

  const setRole = (email: string, role: StudioRole | null) => {
    setBusy(email);
    return studio
      .setMember({ email, role })
      .then(() => {
        toast.success(role ? `${email} is now ${article(role)} ${ROLE_NAMES[role]}` : `${email} no longer has access`);
        return true;
      })
      .catch((e: unknown) => {
        toast.error(`Couldn’t change ${email}’s access`, e instanceof StudioCallError ? e.message : undefined);
        return false;
      })
      .finally(() => setBusy(null));
  };

  return (
    <section className="stp-card" aria-labelledby="access-people">
      <h2 id="access-people" className="stp-h2">
        People
      </h2>
      <p className="stp-muted">Each person signs in with the Google account for exactly this address.</p>
      {members.status === "loading" ? (
        <Skeleton lines={4} label="Loading people with access" />
      ) : members.status === "error" ? (
        <LoadError error={members.error} retry={members.retry} />
      ) : (
        <div className="stp-table-wrap">
          <table className="stp-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Added</th>
                <th scope="col">
                  <span className="st-sr">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data.length === 0 ? (
                <tr>
                  <td colSpan={4} className="stp-muted">
                    Nobody is listed individually yet.
                  </td>
                </tr>
              ) : (
                members.data.map((m) => {
                  const self = m.email.toLowerCase() === me;
                  return (
                    <tr key={m.email}>
                      <th scope="row" className="stp-cell-email">
                        {m.email} {self ? <Badge tone="muted">You</Badge> : null}
                      </th>
                      <td>
                        <RoleSelect
                          label={`Role for ${m.email}`}
                          value={m.role}
                          disabled={self || busy === m.email}
                          onChange={(role) => void setRole(m.email, role)}
                        />
                        {self ? <div className="st-field-hint">You can&rsquo;t change your own role.</div> : null}
                      </td>
                      <td>
                        {formatDate(toDate(m.addedAt))}
                        {m.addedByEmail ? <div className="st-field-hint">by {m.addedByEmail}</div> : null}
                      </td>
                      <td className="stp-cell-action">
                        {self ? null : (
                          <IconButton icon="trash" variant="danger" label={`Remove ${m.email}`} onClick={() => setRemoving(m)} disabled={busy === m.email} />
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
      <AddMember existing={members.status === "ready" ? members.data : []} onAdd={(email, role) => setRole(email, role)} />
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.email}?`}
          body={
            <p>
              They lose access to the Studio at once — on their next click, not when they next sign in. Anything they
              published or edited stays, and stays in the activity log.
              {" "}If a domain rule covers their address, they keep the access that rule gives.
            </p>
          }
          confirmLabel="Remove"
          destructive
          busy={busy === removing.email}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            void setRole(target.email, null).then(() => setRemoving(null));
          }}
        />
      ) : null}
    </section>
  );
}

function article(role: StudioRole): string {
  return role === "admin" || role === "editor" ? "an" : "a";
}

function AddMember({ existing, onAdd }: { existing: MemberDoc[]; onAdd: (email: string, role: StudioRole) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StudioRole>("editor");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const normalised = email.trim().toLowerCase();
  const already = existing.find((m) => m.email.toLowerCase() === normalised);
  const problem = emailProblem(normalised) ?? (already ? `${normalised} is already listed as ${ROLE_NAMES[already.role]}. Change their role in the table.` : null);

  return (
    <form
      className="stp-inline-form"
      aria-label="Add a person"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (problem) return;
        setBusy(true);
        void onAdd(normalised, role).then((ok) => {
          setBusy(false);
          if (ok) {
            setEmail("");
            setSubmitted(false);
          }
        });
      }}
    >
      <h3 className="stp-h3">Add a person</h3>
      <div className="stp-inline-fields">
        <Field label="Email address" error={submitted ? problem : null}>
          {(p) => (
            <input
              {...p}
              type="email"
              className="st-input"
              value={email}
              autoComplete="off"
              spellCheck={false}
              placeholder="name@example.org"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          {(p) => <RoleSelect id={p.id} describedBy={p["aria-describedby"]} value={role} onChange={setRole} />}
        </Field>
        <div className="stp-inline-submit">
          <Button type="submit" variant="primary" icon="plus" busy={busy}>
            Add
          </Button>
        </div>
      </div>
    </form>
  );
}

function Domains() {
  const config = useAccessConfig();
  const toast = useToast();
  const [domain, setDomain] = useState("");
  const [role, setRole] = useState<StudioRole>("viewer");
  const [submitted, setSubmitted] = useState(false);
  const [confirm, setConfirm] = useState<{ domain: string; role: StudioRole | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const normalised = domain.trim().toLowerCase().replace(/^@/, "");
  const problem = domainProblem(normalised);
  const rules = config.status === "ready" && config.data ? Object.entries(config.data.domains).sort(([a], [b]) => a.localeCompare(b)) : [];

  const apply = (target: { domain: string; role: StudioRole | null }) => {
    setBusy(true);
    studio
      .setDomain(target)
      .then(() => {
        toast.success(
          target.role ? `Everyone at ${target.domain} can now sign in as ${ROLE_NAMES[target.role]}` : `The rule for ${target.domain} is removed`,
        );
        setConfirm(null);
        if (target.role) {
          setDomain("");
          setSubmitted(false);
        }
      })
      .catch((e: unknown) => toast.error(`Couldn’t change the rule for ${target.domain}`, e instanceof StudioCallError ? e.message : undefined))
      .finally(() => setBusy(false));
  };

  return (
    <section className="stp-card" aria-labelledby="access-domains">
      <h2 id="access-domains" className="stp-h2">
        Whole organisations
      </h2>
      <p className="stp-muted">
        A domain rule lets in every verified Google Workspace account at that domain with the role you choose, unless the
        person is listed individually above. Use it for an organisation that manages its own Google accounts. Personal
        email domains such as gmail.com are refused by the server, because anyone can create an account there.
      </p>
      {config.status === "loading" ? (
        <Skeleton lines={2} label="Loading domain rules" />
      ) : config.status === "error" ? (
        <LoadError error={config.error} retry={config.retry} />
      ) : rules.length === 0 ? (
        <p>No domain rules.</p>
      ) : (
        <ul className="stp-rules">
          {rules.map(([d, r]) => (
            <li key={d}>
              <span>
                Everyone at <strong>{d}</strong> → {ROLE_NAMES[r]}
              </span>
              <IconButton icon="trash" variant="danger" label={`Remove the rule for ${d}`} onClick={() => setConfirm({ domain: d, role: null })} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="stp-inline-form"
        aria-label="Add a domain rule"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (problem) return;
          setConfirm({ domain: normalised, role });
        }}
      >
        <h3 className="stp-h3">Add a domain rule</h3>
        <div className="stp-inline-fields">
          <Field label="Domain" error={submitted ? problem : null}>
            {(p) => (
              <input
                {...p}
                className="st-input"
                value={domain}
                autoComplete="off"
                spellCheck={false}
                placeholder="brainpop.com"
                onChange={(e) => setDomain(e.target.value)}
              />
            )}
          </Field>
          <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
            {(p) => <RoleSelect id={p.id} describedBy={p["aria-describedby"]} value={role} onChange={setRole} />}
          </Field>
          <div className="stp-inline-submit">
            <Button type="submit" variant="secondary" icon="plus">
              Add rule
            </Button>
          </div>
        </div>
      </form>
      {confirm ? (
        <ConfirmDialog
          title={confirm.role ? `Let everyone at ${confirm.domain} in?` : `Remove the rule for ${confirm.domain}?`}
          body={
            confirm.role ? (
              <p>
                Every verified Google Workspace account at <strong>{confirm.domain}</strong> will be able to sign in as{" "}
                <strong>{ROLE_NAMES[confirm.role]}</strong>: {ROLE_DESCRIPTIONS[confirm.role].toLowerCase()} Only do this
                for an organisation that controls who has an account at that domain.
              </p>
            ) : (
              <p>People at {confirm.domain} who aren&rsquo;t listed individually lose access on their next click.</p>
            )
          }
          confirmLabel={confirm.role ? "Add rule" : "Remove rule"}
          destructive={!confirm.role || atLeast(confirm.role, "publisher")}
          {...(confirm.role ? { typeToConfirm: confirm.domain } : {})}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => apply(confirm)}
        />
      ) : null}
    </section>
  );
}

function RoleLegend() {
  return (
    <section className="stp-card" aria-labelledby="access-roles">
      <h2 id="access-roles" className="stp-h2">
        What each role can do
      </h2>
      <dl className="stp-roles">
        {STUDIO_ROLES.map((r) => (
          <div key={r}>
            <dt>{ROLE_NAMES[r]}</dt>
            <dd>{ROLE_DESCRIPTIONS[r]}</dd>
          </div>
        ))}
      </dl>
      <Notice>An owner of the study (from the researcher view) is treated as an admin here.</Notice>
    </section>
  );
}

function AccessActivity() {
  const audit = useAudit(null, 50);
  return (
    <section className="stp-card" aria-labelledby="access-activity">
      <h2 id="access-activity" className="stp-h2">
        Changes to access
      </h2>
      {audit.status === "loading" ? (
        <Skeleton lines={3} label="Loading changes to access" />
      ) : audit.status === "error" ? (
        <LoadError error={audit.error} retry={audit.retry} />
      ) : (
        <AuditList rows={audit.data.filter((r) => r.action.startsWith("access."))} empty="Adding, changing and removing people is recorded here." />
      )}
    </section>
  );
}
