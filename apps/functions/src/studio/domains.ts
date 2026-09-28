import consumerDomains from "./consumer-domains.json" with { type: "json" };

/**
 * Addresses and domains, as the Studio list keys them (docs/16 §5.7).
 *
 * One definition, used by the functions that change the list and by
 * `studio-access.mjs` (which reads the same JSON file), so the command line and
 * the Settings page can never disagree about what a valid address is or which
 * domains are too public to admit wholesale.
 */

/**
 * Mail providers anyone can sign up to. A domain rule for one of these would
 * admit every account there — the opposite of a list — so it is refused on the
 * server whatever the page in front of it allows. People at these domains are
 * added individually instead.
 */
export const CONSUMER_DOMAINS: ReadonlySet<string> = new Set(consumerDomains);

/**
 * The key an address is stored under: what the rules compare against
 * (`request.auth.token.email.lower()`), so one person is never a member under
 * one spelling and a stranger under another.
 */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * One "@", something either side, a dot in the domain, and nothing that could
 * change the shape of a document path. Deliberately not an RFC 5322 parser: the
 * address is only ever compared with the one Google verified, so this exists to
 * stop mistakes and path tricks, not to decide what email is.
 */
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

export function isEmailKey(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value) && !/^__.*__$/.test(value);
}

/** A lower-case host name with a top-level domain, e.g. "brainpop.com". */
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function domainKey(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

export function isDomainKey(value: string): boolean {
  return DOMAIN.test(value);
}

/** Whether a domain is a public mail provider, so not a rule anybody may set. */
export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domainKey(domain));
}
