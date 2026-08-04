import { lookup } from "node:dns/promises";

/**
 * Which addresses the agent may fetch.
 *
 * This is the security boundary of the whole web feature, and the threat is not
 * hypothetical: this repository ships an orchestrator that binds to
 * `127.0.0.1:7801` and prints a bearer token at boot. A tool that fetches
 * whatever URL a model produces — and a model reads its URLs off web pages —
 * is one redirect away from reading that, or from a cloud instance's metadata
 * service at 169.254.169.254.
 *
 * So the check is on the resolved *address*, not on the hostname. A name is a
 * request to a resolver, and a resolver can answer 127.0.0.1 for a name that
 * looks like anything at all; `localtest.me` does exactly that, publicly, today.
 * Every hop of a redirect is checked again for the same reason.
 */

export class AddressRefused extends Error {
  /** Shown to the model, so it stops rather than trying a variant. */
  readonly guidance: string;
  constructor(guidance: string) {
    super(guidance);
    this.name = "AddressRefused";
    this.guidance = guidance;
  }
}

/** Ranges that are not the public internet. */
function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const address = ip.toLowerCase().split("%")[0] ?? "";
  if (address === "::1" || address === "::") return true;
  // An IPv4-mapped address is an IPv4 address wearing a hat, and has to be
  // judged as one — ::ffff:127.0.0.1 is loopback.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1]);
  if (/^f[cd]/.test(address)) return true; // unique local
  if (/^fe[89ab]/.test(address)) return true; // link-local
  return false;
}

export function isPrivateAddress(ip: string, family: number): boolean {
  return family === 6 ? isPrivateV6(ip) : isPrivateV4(ip);
}

export interface AddressCheckOptions {
  /** Injected in tests, so none of this needs a network or a resolver. */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * Refuses a URL the agent must not fetch, before any connection is made.
 *
 * Scheme first, because `file:` and `gopher:` are not fixable by resolving
 * anything, and the message for them is different.
 */
export async function assertFetchableUrl(raw: string, opts: AddressCheckOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddressRefused(`"${raw}" is not a URL. Give a full one, starting with https://`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AddressRefused(`${url.protocol} is not fetchable. Only http and https are.`);
  }

  const resolveHost = opts.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    throw new AddressRefused(`${url.hostname} does not resolve. Check the address.`);
  }
  if (addresses.length === 0) throw new AddressRefused(`${url.hostname} does not resolve.`);

  // *Every* address, not the first. A name that answers with one public address
  // and one loopback address would otherwise be fetchable half the time, which
  // is worse than either outcome.
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new AddressRefused(
        `${url.hostname} resolves to ${address}, which is on this machine or its private network. ` +
          "Only public addresses can be fetched. Do not try to reach local services.",
      );
    }
  }
  return url;
}
