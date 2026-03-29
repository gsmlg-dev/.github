/**
 * Cleanup untagged GHCR package versions.
 *
 * Multi-arch container images store a manifest list (tagged) that references
 * platform-specific child manifests (untagged).  Deleting those children
 * breaks the parent tag.  This module resolves all child digests via the
 * ghcr.io registry API and protects them from deletion.
 *
 * Exported for testing; the workflow invokes `run()`.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function paginate(request, perPage = 100) {
  const results = [];
  let page = 1;
  while (true) {
    const response = await request(page);
    results.push(...response.data);
    if (response.data.length < perPage) break;
    page += 1;
  }
  return results;
}

async function getRegistryToken(basicAuth, scope) {
  const res = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
    { headers: { Authorization: `Basic ${basicAuth}` } },
  );
  if (!res.ok) return null;
  const body = await res.json();
  return body.token || null;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/**
 * Fetch the manifest for `ref` (tag or digest) and return the list of child
 * digests if it is a manifest list / OCI index.  Returns `[]` for single-arch
 * manifests.  Throws on network / auth errors so the caller can decide policy.
 */
async function fetchChildDigests(registryToken, org, pkgName, ref) {
  const res = await fetch(
    `https://ghcr.io/v2/${org}/${pkgName}/manifests/${ref}`,
    {
      headers: {
        Authorization: `Bearer ${registryToken}`,
        Accept: MANIFEST_ACCEPT,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`registry returned ${res.status} for ${pkgName}:${ref}`);
  }
  const manifest = await res.json();
  if (manifest.manifests && Array.isArray(manifest.manifests)) {
    return manifest.manifests.map((m) => m.digest).filter(Boolean);
  }
  return [];
}

/**
 * Check whether a manifest digest exists in the registry.
 * Returns true if it exists, false if 404, throws on other errors.
 */
async function digestExists(registryToken, org, pkgName, digest) {
  const res = await fetch(
    `https://ghcr.io/v2/${org}/${pkgName}/manifests/${digest}`,
    {
      headers: {
        Authorization: `Bearer ${registryToken}`,
        Accept: MANIFEST_ACCEPT,
      },
    },
  );
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`registry returned ${res.status} checking ${pkgName}@${digest}`);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Determine which versions of a single package are safe to delete.
 *
 * @param {object}   opts
 * @param {string}   opts.org           – GitHub org / user
 * @param {string}   opts.pkgName       – package name
 * @param {object[]} opts.versions      – package versions from GitHub API
 * @param {string|null} opts.registryToken – Bearer token for ghcr.io
 * @param {object}   opts.log           – logger ({ info, warning })
 * @param {Date}     [opts.now]         – current time (default: new Date())
 * @param {number}   [opts.maxAgeDays]  – only delete orphans older than this (default: 90)
 * @returns {Promise<{deletable: object[], skipped: boolean}>}
 *   `deletable` – versions safe to delete
 *   `skipped`   – true if we bailed due to incomplete manifest data
 */
async function classifyVersions({ org, pkgName, versions, registryToken, log, now, maxAgeDays = 90 }) {
  const cutoff = new Date(now || new Date());
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  // Step 1: tag-bearing versions are always protected
  const protectedDigests = new Set();
  for (const v of versions) {
    const tags = v.metadata?.container?.tags || [];
    if (tags.length > 0) {
      protectedDigests.add(v.name);
    }
  }

  // Step 2: resolve child manifests of every tagged version
  if (!registryToken) {
    log.warning(
      `Package ${pkgName}: unable to obtain ghcr.io token – skipping deletion entirely.`,
    );
    return { deletable: [], skipped: true };
  }

  let manifestFetchFailed = false;
  // Track children per tagged version: Map<versionName, string[]>
  const childrenByVersion = new Map();
  // Set of broken tagged version digests (all children missing)
  const brokenTaggedDigests = new Set();

  for (const v of versions) {
    const tags = v.metadata?.container?.tags || [];
    if (tags.length === 0) continue;
    const allChildren = [];
    for (const tag of tags) {
      try {
        const children = await fetchChildDigests(registryToken, org, pkgName, tag);
        allChildren.push(...children);
      } catch (e) {
        log.warning(`Package ${pkgName}:${tag}: ${e.message}`);
        manifestFetchFailed = true;
      }
    }
    childrenByVersion.set(v.name, allChildren);
  }

  if (manifestFetchFailed) {
    log.warning(
      `Package ${pkgName}: some manifest fetches failed – skipping deletion to avoid breaking images.`,
    );
    return { deletable: [], skipped: true };
  }

  // Step 3: verify child manifests actually exist in registry
  // If ALL children of a tagged version are missing, the tag is broken.
  for (const [versionDigest, children] of childrenByVersion) {
    if (children.length === 0) {
      // Single-arch or no children — tag itself is the image, keep it
      for (const d of children) protectedDigests.add(d);
      continue;
    }

    let existCount = 0;
    for (const childDigest of children) {
      try {
        if (await digestExists(registryToken, org, pkgName, childDigest)) {
          existCount++;
          protectedDigests.add(childDigest);
        }
      } catch (e) {
        // Error checking existence — be safe, protect the digest
        log.warning(`Package ${pkgName}: error checking ${childDigest}: ${e.message}`);
        protectedDigests.add(childDigest);
        existCount++;
      }
    }

    if (existCount === 0) {
      // All children are gone — this tagged version is a broken shell
      const v = versions.find((ver) => ver.name === versionDigest);
      const tags = v?.metadata?.container?.tags || [];
      log.warning(
        `Package ${pkgName}: tag(s) [${tags.join(", ")}] broken – all ${children.length} child manifest(s) missing.`,
      );
      brokenTaggedDigests.add(versionDigest);
      protectedDigests.delete(versionDigest);
    }
  }

  log.info(`Package ${pkgName}: ${protectedDigests.size} protected digest(s).`);

  // Step 4: build deletable list
  const deletable = [];
  for (const v of versions) {
    const tags = v.metadata?.container?.tags || [];

    if (tags.length > 0 && !brokenTaggedDigests.has(v.name)) continue;

    if (protectedDigests.has(v.name)) {
      log.info(`Package ${pkgName}: keeping ${v.name} (referenced by tagged version).`);
      continue;
    }
    if (maxAgeDays > 0) {
      const updatedAt = new Date(v.updated_at);
      if (updatedAt >= cutoff) {
        log.info(`Package ${pkgName}: keeping ${v.name} (too recent: ${v.updated_at}).`);
        continue;
      }
    }
    deletable.push(v);
  }

  return { deletable, skipped: false };
}

// ---------------------------------------------------------------------------
// Runner (called from the workflow)
// ---------------------------------------------------------------------------

async function run({ github, core, dryRun = false }) {
  const org = "gsmlg-dev"; // overridden in workflow via context.repo.owner
  const packageType = "container";
  const perPage = 100;

  const packages = await paginate(
    (page) =>
      github.request("GET /orgs/{org}/packages", {
        org,
        package_type: packageType,
        per_page: perPage,
        page,
      }),
    perPage,
  );

  if (packages.length === 0) {
    core.info(`No ${packageType} packages found in ${org}.`);
    return;
  }

  core.info(`Found ${packages.length} ${packageType} packages in ${org}.`);

  const ghToken = process.env.GITHUB_TOKEN || "";
  const basicAuth = Buffer.from(`USERNAME:${ghToken}`).toString("base64");

  let totalDeleted = 0;

  for (const pkg of packages) {
    const versions = await paginate(
      (page) =>
        github.request(
          "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
          {
            org,
            package_type: packageType,
            package_name: pkg.name,
            per_page: perPage,
            page,
          },
        ),
      perPage,
    );

    const registryToken = await getRegistryToken(
      basicAuth,
      `repository:${org}/${pkg.name}:pull`,
    );

    const { deletable, skipped } = await classifyVersions({
      org,
      pkgName: pkg.name,
      versions,
      registryToken,
      log: core,
    });

    if (skipped) {
      core.info(`Package ${pkg.name}: skipping deletion.`);
      continue;
    }

    if (deletable.length === 0) {
      core.info(`Package ${pkg.name}: no untagged versions to delete.`);
      continue;
    }

    core.info(
      `Package ${pkg.name}: ${dryRun ? "[DRY-RUN] would delete" : "deleting"} ${deletable.length} untagged version(s).`,
    );

    if (dryRun) continue;

    for (const version of deletable) {
      await github.request(
        "DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}",
        {
          org,
          package_type: packageType,
          package_name: pkg.name,
          package_version_id: version.id,
        },
      );
      totalDeleted += 1;
      core.info(`Deleted ${pkg.name}@${version.id}`);
    }
  }

  core.info(`Cleanup finished. Deleted ${totalDeleted} untagged version(s).`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// Usage: GH_TOKEN=$(gh auth token) node scripts/cleanup-untagged-packages.js [options]
//   --package <name>     Only process this package (default: all)
//   --no-age-filter      Delete regardless of age (skip 90-day rule)
//   --dry-run            Show what would be deleted without deleting (default)
//   --delete             Actually delete (requires explicit opt-in)
// ---------------------------------------------------------------------------

async function cli() {
  const args = process.argv.slice(2);
  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const hasFlag = (flag) => args.includes(flag);

  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!ghToken) {
    console.error("Set GH_TOKEN or GITHUB_TOKEN");
    process.exit(1);
  }

  const org = "gsmlg-dev";
  const packageType = "container";
  const filterPkg = getArg("--package");
  const noAgeFilter = hasFlag("--no-age-filter");
  const realDelete = hasFlag("--delete");
  const dryRun = !realDelete;

  const basicAuth = Buffer.from(`USERNAME:${ghToken}`).toString("base64");
  const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };

  // Fetch packages
  let packages = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/packages?package_type=${packageType}&per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) { console.error(`API error: ${res.status}`); process.exit(1); }
    const data = await res.json();
    packages.push(...data);
    if (data.length < 100) break;
    page++;
  }

  if (filterPkg) {
    packages = packages.filter((p) => p.name === filterPkg);
    if (packages.length === 0) {
      console.error(`Package "${filterPkg}" not found.`);
      process.exit(1);
    }
  }

  console.log(`\nOrg: ${org}  |  Packages: ${packages.length}  |  Age filter: ${noAgeFilter ? "OFF" : "90 days"}  |  Mode: ${dryRun ? "DRY-RUN" : "DELETE"}\n`);

  const log = {
    info: (msg) => console.log(`  [INFO]    ${msg}`),
    warning: (msg) => console.log(`  [WARNING] ${msg}`),
  };

  let totalDeletable = 0;

  for (const pkg of packages) {
    // Fetch versions
    const versions = [];
    let vPage = 1;
    while (true) {
      const res = await fetch(
        `https://api.github.com/orgs/${org}/packages/${packageType}/${encodeURIComponent(pkg.name)}/versions?per_page=100&page=${vPage}`,
        { headers },
      );
      if (!res.ok) { console.error(`API error for ${pkg.name}: ${res.status}`); break; }
      const data = await res.json();
      versions.push(...data);
      if (data.length < 100) break;
      vPage++;
    }

    console.log(`--- ${pkg.name}: ${versions.length} version(s) ---`);

    const registryToken = await getRegistryToken(
      basicAuth,
      `repository:${org}/${pkg.name}:pull`,
    );

    const { deletable, skipped } = await classifyVersions({
      org,
      pkgName: pkg.name,
      versions,
      registryToken,
      log,
      maxAgeDays: noAgeFilter ? 0 : 90,
    });

    if (skipped) {
      console.log(`  SKIPPED (incomplete manifest data)\n`);
      continue;
    }

    if (deletable.length === 0) {
      console.log(`  Nothing to delete.\n`);
      continue;
    }

    for (const v of deletable) {
      const tags = v.metadata?.container?.tags || [];
      const label = tags.length > 0 ? `TAGGED [${tags.join(", ")}]` : "UNTAGGED";
      console.log(`  ${dryRun ? "WOULD DELETE" : "DELETING"}: ${v.id}  ${v.name.slice(0, 20)}...  ${v.updated_at}  ${label}`);

      if (!dryRun) {
        const res = await fetch(
          `https://api.github.com/orgs/${org}/packages/${packageType}/${encodeURIComponent(pkg.name)}/versions/${v.id}`,
          { method: "DELETE", headers },
        );
        if (!res.ok) {
          console.error(`  DELETE FAILED: ${res.status}`);
        }
      }
    }

    totalDeletable += deletable.length;
    console.log();
  }

  console.log(`\n=== Total: ${totalDeletable} version(s) ${dryRun ? "would be deleted" : "deleted"} ===`);
}

if (require.main === module) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  paginate,
  getRegistryToken,
  fetchChildDigests,
  digestExists,
  classifyVersions,
  run,
  MANIFEST_ACCEPT,
};
