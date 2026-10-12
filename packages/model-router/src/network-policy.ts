import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Loopback plus the Tailscale CGNAT range (docs/20 section 3.4). */
const allowedAddresses = new BlockList();
allowedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
allowedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
allowedAddresses.addAddress("::1", "ipv6");

export type HostLookup = (host: string) => Promise<string[]>;

export const defaultLookup: HostLookup = async (host) => {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

/** IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by their IPv4 rules. */
export function isAllowedLocalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  try {
    return allowedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

/**
 * True only when every address the host resolves to is allowed for a Local source.
 * A literal IP host is judged directly without a lookup.
 */
export async function isAllowedLocalHost(hostname: string, lookup: HostLookup): Promise<boolean> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return isAllowedLocalAddress(bare);
  let addresses: string[];
  try {
    addresses = await lookup(bare);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isAllowedLocalAddress);
}
