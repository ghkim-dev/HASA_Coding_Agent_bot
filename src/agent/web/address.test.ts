import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AddressRefused, assertFetchableUrl, isPrivateAddress } from "./address.ts";

/**
 * What the agent may reach.
 *
 * This is the security boundary of the web tools, and it is not abstract: this
 * repository ships an orchestrator on `127.0.0.1:7801` that prints a bearer
 * token at boot, and a model picks its URLs off pages other people wrote. So
 * the tests are about the addresses that must stay unreachable, not about the
 * ones that work.
 */

/** A resolver under test control, so none of this needs DNS. */
const resolves = (...addresses: Array<[string, number]>) =>
  async () => addresses.map(([address, family]) => ({ address, family }));

const PUBLIC = resolves(["93.184.216.34", 4]);

describe("addresses that are not the public internet", () => {
  test("loopback in both families", () => {
    assert.equal(isPrivateAddress("127.0.0.1", 4), true);
    assert.equal(isPrivateAddress("127.1.2.3", 4), true);
    assert.equal(isPrivateAddress("::1", 6), true);
  });

  test("the cloud metadata address", () => {
    // 169.254.169.254 is the one that turns a fetch tool into a credential leak
    // on every major cloud.
    assert.equal(isPrivateAddress("169.254.169.254", 4), true);
  });

  test("the RFC1918 ranges, and their edges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) {
      assert.equal(isPrivateAddress(ip, 4), true, ip);
    }
    // 172.15 and 172.32 are outside the range and must stay reachable.
    assert.equal(isPrivateAddress("172.15.0.1", 4), false);
    assert.equal(isPrivateAddress("172.32.0.1", 4), false);
  });

  test("carrier-grade NAT, multicast and 0.0.0.0", () => {
    assert.equal(isPrivateAddress("100.64.0.1", 4), true);
    assert.equal(isPrivateAddress("224.0.0.1", 4), true);
    assert.equal(isPrivateAddress("0.0.0.0", 4), true);
  });

  test("an IPv4 address wearing an IPv6 hat is still an IPv4 address", () => {
    // ::ffff:127.0.0.1 is loopback, and reading it as "some IPv6 address" is
    // how this check gets bypassed.
    assert.equal(isPrivateAddress("::ffff:127.0.0.1", 6), true);
    assert.equal(isPrivateAddress("::ffff:169.254.169.254", 6), true);
    assert.equal(isPrivateAddress("::ffff:93.184.216.34", 6), false);
  });

  test("IPv6 unique-local and link-local", () => {
    assert.equal(isPrivateAddress("fd00::1", 6), true);
    assert.equal(isPrivateAddress("fe80::1", 6), true);
    assert.equal(isPrivateAddress("fe80::1%eth0", 6), true);
    assert.equal(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946", 6), false);
  });

  test("a public address is public", () => {
    assert.equal(isPrivateAddress("93.184.216.34", 4), false);
    assert.equal(isPrivateAddress("8.8.8.8", 4), false);
  });
});

describe("refusing a URL before anything connects", () => {
  test("a public https URL is allowed", async () => {
    const url = await assertFetchableUrl("https://example.com/a", { resolve: PUBLIC });
    assert.equal(url.host, "example.com");
  });

  test("the decision is made on the resolved address, not the hostname", async () => {
    // The whole reason this resolves rather than pattern-matching: a public
    // name can answer 127.0.0.1, and `localtest.me` does exactly that today.
    await assert.rejects(
      () => assertFetchableUrl("https://totally-normal.example/", { resolve: resolves(["127.0.0.1", 4]) }),
      AddressRefused,
    );
  });

  test("one private address among several is enough to refuse", async () => {
    // Otherwise a name with a public and a loopback record is fetchable
    // whenever the resolver happens to order them favourably, which is worse
    // than either answer.
    await assert.rejects(
      () =>
        assertFetchableUrl("https://mixed.example/", {
          resolve: resolves(["93.184.216.34", 4], ["127.0.0.1", 4]),
        }),
      AddressRefused,
    );
  });

  test("localhost by name is refused, with a reason the model can read", async () => {
    const err = await refusal("http://localhost:7801/runs", resolves(["127.0.0.1", 4]));
    assert.match(err.guidance, /127\.0\.0\.1/);
    assert.match(err.guidance, /local services/i);
  });

  test("schemes that are not http are refused by name", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/", "data:text/html,hi"]) {
      const err = await refusal(url, PUBLIC);
      assert.match(err.guidance, /Only http and https/i, url);
    }
  });

  test("something that is not a URL says so", async () => {
    const err = await refusal("how do I use transformers", PUBLIC);
    assert.match(err.guidance, /is not a URL/i);
  });

  test("a name that does not resolve is refused, not attempted", async () => {
    const err = await refusal("https://nope.invalid/", async () => {
      throw new Error("ENOTFOUND");
    });
    assert.match(err.guidance, /does not resolve/i);
  });

  test("an empty resolver answer is a refusal, not an allow", async () => {
    // A resolver that returns nothing must not fall through the loop into
    // "no private address found, therefore fine".
    await assert.rejects(() => assertFetchableUrl("https://x.example/", { resolve: resolves() }), AddressRefused);
  });
});

async function refusal(
  url: string,
  resolve: () => Promise<Array<{ address: string; family: number }>>,
): Promise<AddressRefused> {
  try {
    await assertFetchableUrl(url, { resolve });
  } catch (err) {
    assert.ok(err instanceof AddressRefused, `expected a refusal, got ${String(err)}`);
    return err;
  }
  return assert.fail(`expected ${url} to be refused`);
}
