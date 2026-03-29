const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { classifyVersions } = require("./cleanup-untagged-packages");

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

function makeVersion(name, tags = [], updatedAt = "2025-01-01T00:00:00Z") {
  return {
    id: Math.floor(Math.random() * 1e9),
    name, // digest, e.g. "sha256:aaa..."
    metadata: { container: { tags } },
    updated_at: updatedAt,
  };
}

function makeLog() {
  const messages = { info: [], warning: [] };
  return {
    info: (msg) => messages.info.push(msg),
    warning: (msg) => messages.warning.push(msg),
    messages,
  };
}

// Monkey-patch global fetch for tests (Node 18+ has global fetch)
let fetchMock;
function mockFetch(handler) {
  fetchMock = handler;
  global.fetch = async (...args) => fetchMock(...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyVersions", () => {
  beforeEach(() => {
    // Reset fetch mock
    mockFetch(() => {
      throw new Error("fetch not mocked for this test");
    });
  });

  it("keeps tagged versions and deletes truly orphaned untagged ones", async () => {
    const tagged = makeVersion("sha256:tagged111", ["latest", "v1.0"]);
    const orphan = makeVersion("sha256:orphan222", []);
    const log = makeLog();

    // Mock: manifest for both tags returns single-arch (no children)
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 2,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        config: {},
        layers: [],
      }),
    }));

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "testpkg",
      versions: [tagged, orphan],
      registryToken: "fake-token",
      log,
    });

    assert.equal(skipped, false);
    assert.equal(deletable.length, 1);
    assert.equal(deletable[0].name, "sha256:orphan222");
  });

  it("protects multi-arch child manifests referenced by tagged manifest list", async () => {
    const tagged = makeVersion("sha256:index111", ["latest"]);
    const childAmd64 = makeVersion("sha256:child-amd64", []);
    const childArm64 = makeVersion("sha256:child-arm64", []);
    const orphan = makeVersion("sha256:truly-orphan", []);
    const log = makeLog();

    // Mock: manifest list returns two children
    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          { digest: "sha256:child-amd64", platform: { architecture: "amd64", os: "linux" } },
          { digest: "sha256:child-arm64", platform: { architecture: "arm64", os: "linux" } },
        ],
      }),
    }));

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "testpkg",
      versions: [tagged, childAmd64, childArm64, orphan],
      registryToken: "fake-token",
      log,
    });

    assert.equal(skipped, false);
    assert.equal(deletable.length, 1);
    assert.equal(deletable[0].name, "sha256:truly-orphan");
    // Both children should be logged as kept
    const keepMsgs = log.messages.info.filter((m) => m.includes("keeping"));
    assert.equal(keepMsgs.length, 2);
  });

  it("skips entire package when registry token is null", async () => {
    const tagged = makeVersion("sha256:tagged", ["latest"]);
    const untagged = makeVersion("sha256:untagged", []);
    const log = makeLog();

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "testpkg",
      versions: [tagged, untagged],
      registryToken: null,
      log,
    });

    assert.equal(skipped, true);
    assert.equal(deletable.length, 0);
    assert.ok(log.messages.warning.some((m) => m.includes("unable to obtain")));
  });

  it("skips entire package when ANY manifest fetch fails", async () => {
    const taggedA = makeVersion("sha256:indexA", ["v1"]);
    const taggedB = makeVersion("sha256:indexB", ["v2"]);
    const childA = makeVersion("sha256:child-A", []);
    const orphan = makeVersion("sha256:orphan", []);
    const log = makeLog();

    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        // First tag succeeds
        return {
          ok: true,
          json: async () => ({
            manifests: [{ digest: "sha256:child-A" }],
          }),
        };
      }
      // Second tag fails
      return { ok: false, status: 500 };
    });

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "testpkg",
      versions: [taggedA, taggedB, childA, orphan],
      registryToken: "fake-token",
      log,
    });

    // Must skip — we don't know if v2's children overlap with orphan
    assert.equal(skipped, true);
    assert.equal(deletable.length, 0);
    assert.ok(log.messages.warning.some((m) => m.includes("skipping deletion")));
  });

  it("skips entire package when manifest fetch throws network error", async () => {
    const tagged = makeVersion("sha256:index", ["latest"]);
    const untagged = makeVersion("sha256:child-maybe", []);
    const log = makeLog();

    mockFetch(async () => {
      throw new Error("network timeout");
    });

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "testpkg",
      versions: [tagged, untagged],
      registryToken: "fake-token",
      log,
    });

    assert.equal(skipped, true);
    assert.equal(deletable.length, 0);
  });

  it("handles package with no versions", async () => {
    const log = makeLog();
    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "empty",
      versions: [],
      registryToken: "fake-token",
      log,
    });

    assert.equal(skipped, false);
    assert.equal(deletable.length, 0);
  });

  it("handles package with only tagged versions (no untagged at all)", async () => {
    const v1 = makeVersion("sha256:aaa", ["v1"]);
    const v2 = makeVersion("sha256:bbb", ["v2"]);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, config: {}, layers: [] }),
    }));

    const { deletable, skipped } = await classifyVersions({
      org: "testorg",
      pkgName: "alltagged",
      versions: [v1, v2],
      registryToken: "fake-token",
      log,
    });

    assert.equal(skipped, false);
    assert.equal(deletable.length, 0);
  });

  it("protects children across multiple tags pointing to same manifest list", async () => {
    // "latest" and "v1" both point to same index with same children
    const tagged = makeVersion("sha256:index", ["latest", "v1"]);
    const child = makeVersion("sha256:child-only", []);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        manifests: [{ digest: "sha256:child-only" }],
      }),
    }));

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "multi-tag",
      versions: [tagged, child],
      registryToken: "fake-token",
      log,
    });

    assert.equal(deletable.length, 0);
  });

  it("protects attestation/signature manifests referenced by tagged version", async () => {
    // Some OCI registries store cosign signatures and attestations as
    // manifest entries in the index alongside platform manifests
    const tagged = makeVersion("sha256:index", ["latest"]);
    const platformManifest = makeVersion("sha256:linux-amd64", []);
    const attestation = makeVersion("sha256:attestation-sha", []);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({
        manifests: [
          { digest: "sha256:linux-amd64", platform: { architecture: "amd64", os: "linux" } },
          {
            digest: "sha256:attestation-sha",
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            annotations: { "vnd.docker.reference.type": "attestation-manifest" },
          },
        ],
      }),
    }));

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "with-attestations",
      versions: [tagged, platformManifest, attestation],
      registryToken: "fake-token",
      log,
    });

    assert.equal(deletable.length, 0);
  });

  it("only deletes orphaned untagged versions older than 3 months", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    const fourMonthsAgo = "2025-11-20T00:00:00Z";
    const twoWeeksAgo = "2026-03-15T00:00:00Z";

    const tagged = makeVersion("sha256:tagged", ["latest"], now.toISOString());
    const oldOrphan = makeVersion("sha256:old-orphan", [], fourMonthsAgo);
    const recentOrphan = makeVersion("sha256:recent-orphan", [], twoWeeksAgo);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, config: {}, layers: [] }),
    }));

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "age-test",
      versions: [tagged, oldOrphan, recentOrphan],
      registryToken: "fake-token",
      log,
      now,
    });

    assert.equal(deletable.length, 1);
    assert.equal(deletable[0].name, "sha256:old-orphan");
    assert.ok(log.messages.info.some((m) => m.includes("recent-orphan") && m.includes("too recent")));
  });

  it("keeps orphaned untagged version exactly 3 months old", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    const exactlyThreeMonths = "2025-12-29T00:00:00Z";

    const tagged = makeVersion("sha256:tagged", ["latest"], now.toISOString());
    const borderline = makeVersion("sha256:borderline", [], exactlyThreeMonths);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, config: {}, layers: [] }),
    }));

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "age-border",
      versions: [tagged, borderline],
      registryToken: "fake-token",
      log,
      now,
    });

    // Exactly 3 months = 90 days boundary, should NOT be deleted (need strictly older)
    assert.equal(deletable.length, 0);
  });

  it("deletes orphaned untagged version older than 3 months", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    const overThreeMonths = "2025-12-28T00:00:00Z"; // 91 days ago

    const tagged = makeVersion("sha256:tagged", ["latest"], now.toISOString());
    const old = makeVersion("sha256:old", [], overThreeMonths);
    const log = makeLog();

    mockFetch(async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, config: {}, layers: [] }),
    }));

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "age-over",
      versions: [tagged, old],
      registryToken: "fake-token",
      log,
      now,
    });

    assert.equal(deletable.length, 1);
    assert.equal(deletable[0].name, "sha256:old");
  });

  it("marks tagged version as broken and deletable when ALL children are missing", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    // 3.19 is tagged but its children were deleted by previous buggy runs
    const broken = makeVersion("sha256:broken-index", ["3.19"], "2025-10-09T01:35:13Z");
    const healthy = makeVersion("sha256:healthy-index", ["latest"], now.toISOString());
    const healthyChild = makeVersion("sha256:healthy-child", [], now.toISOString());
    const log = makeLog();

    mockFetch(async (url) => {
      // Manifest list fetch for tags
      if (url.includes("/manifests/3.19")) {
        return {
          ok: true,
          json: async () => ({
            manifests: [
              { digest: "sha256:dead-amd64" },
              { digest: "sha256:dead-arm64" },
            ],
          }),
        };
      }
      if (url.includes("/manifests/latest")) {
        return {
          ok: true,
          json: async () => ({
            manifests: [{ digest: "sha256:healthy-child" }],
          }),
        };
      }
      // HEAD checks for child existence
      if (url.includes("sha256:dead-amd64") || url.includes("sha256:dead-arm64")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("sha256:healthy-child")) {
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    });

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "alpine",
      versions: [broken, healthy, healthyChild],
      registryToken: "fake-token",
      log,
      now,
    });

    // broken-index should be deletable (all children missing, older than 90 days)
    assert.equal(deletable.length, 1);
    assert.equal(deletable[0].name, "sha256:broken-index");
    assert.ok(log.messages.warning.some((m) => m.includes("3.19") && m.includes("broken")));
  });

  it("keeps tagged version when SOME children still exist", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    const partial = makeVersion("sha256:partial-index", ["v2"], "2025-06-01T00:00:00Z");
    const survivingChild = makeVersion("sha256:surviving", [], "2025-06-01T00:00:00Z");
    const log = makeLog();

    mockFetch(async (url) => {
      if (url.includes("/manifests/v2")) {
        return {
          ok: true,
          json: async () => ({
            manifests: [
              { digest: "sha256:surviving" },
              { digest: "sha256:gone" },
            ],
          }),
        };
      }
      // HEAD checks
      if (url.includes("sha256:surviving")) return { ok: true, status: 200 };
      if (url.includes("sha256:gone")) return { ok: false, status: 404 };
      return { ok: true, status: 200 };
    });

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "partial-pkg",
      versions: [partial, survivingChild],
      registryToken: "fake-token",
      log,
      now,
    });

    // Tag still has a living child — keep the tag and the surviving child
    assert.equal(deletable.length, 0);
  });

  it("keeps broken tagged version if it is newer than 3 months", async () => {
    const now = new Date("2026-03-29T00:00:00Z");
    const recentBroken = makeVersion("sha256:recent-broken", ["edge"], "2026-03-01T00:00:00Z");
    const log = makeLog();

    mockFetch(async (url) => {
      if (url.includes("/manifests/edge")) {
        return {
          ok: true,
          json: async () => ({
            manifests: [{ digest: "sha256:gone-child" }],
          }),
        };
      }
      // Child is missing
      return { ok: false, status: 404 };
    });

    const { deletable } = await classifyVersions({
      org: "testorg",
      pkgName: "recent-broken-pkg",
      versions: [recentBroken],
      registryToken: "fake-token",
      log,
      now,
    });

    // Broken but too recent to delete
    assert.equal(deletable.length, 0);
  });
});
