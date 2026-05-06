import { networkInterfaces } from 'node:os';

const isIpv4Family = (family) => family === 'IPv4' || family === 4;

/** @type {Record<string, string[]>} */
const ipsPerInterface = {};
const nets = networkInterfaces();

for (const ifaceName of Object.keys(nets ?? {})) {
  const entries = nets[ifaceName];
  if (!entries) {
    continue;
  }

  /** @type {string[]} */
  const addresses = [];
  for (const entry of entries) {
    const isIpv4 = isIpv4Family(entry.family);
    if (!isIpv4 || entry.internal === true || !/^(\d{1,3}\.){3}\d{1,3}$/.test(entry.address)) {
      continue;
    }

    addresses.push(entry.address);
  }

  if (addresses.length > 0) {
    ipsPerInterface[ifaceName] = [...new Set(addresses)].sort((a, b) => a.localeCompare(b));
  }
}

/** Deterministic serialized snapshot for Nx runtime inputs */
const snapshot = {};
for (const name of Object.keys(ipsPerInterface).sort()) {
  snapshot[name] = ipsPerInterface[name];
}

// oxlint-disable-next-line no-console -- emitted for Nx `runtime` input hashing
console.log(JSON.stringify(snapshot));
