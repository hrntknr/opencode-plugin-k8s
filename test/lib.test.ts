import assert from "node:assert/strict"
import { test } from "node:test"
import {
  badDeployments,
  claimable,
  describeDeployment,
  describeNamespaces,
  diffBad,
  formatAge,
  formatAlert,
  formatForbidden,
  formatIdleStatus,
  formatInterval,
  formatReasonChange,
  formatUnknownContext,
  formatWatch,
  parseContextArg,
  pollDecision,
  reasonChanges,
  resolveWatchedNamespaces,
  VERSION,
  type DeploymentLike,
} from "../src/lib.ts"
import flapBad from "./fixtures/flap-bad.json" with { type: "json" }
import flapHealthy from "./fixtures/flap-healthy.json" with { type: "json" }
import healthy from "./fixtures/healthy.json" with { type: "json" }
import availableFalse from "./fixtures/available-false.json" with { type: "json" }
import paused from "./fixtures/paused.json" with { type: "json" }
import progressingDeadline from "./fixtures/progressing-deadline.json" with { type: "json" }
import replicaFailure from "./fixtures/replica-failure.json" with { type: "json" }

const detectedAt = new Date("2026-11-11T05:58:23Z")
const prod17Reason = "Available=False (MinimumReplicasUnavailable); ReplicaFailure=True (FailedCreate)"
const prod17: DeploymentLike = {
  metadata: {
    uid: "77777777-7777-7777-7777-777777777777",
    namespace: "org-pfn--managed-inference",
    name: "prod17",
    creationTimestamp: "2026-11-11T05:57:39Z",
  },
  status: {
    conditions: [
      { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
      { type: "ReplicaFailure", status: "True", reason: "FailedCreate" },
    ],
  },
}

test("healthy and paused deployments are not bad", () => {
  assert.equal(badDeployments([healthy, paused]).size, 0)
})

test("Available=False is bad", () => {
  const [bad] = badDeployments([availableFalse]).values()
  assert.deepEqual(bad, {
    namespace: "default",
    name: "no-replicas",
    reason: "Available=False (MinimumReplicasUnavailable)",
  })
})

test("Progressing=False with ProgressDeadlineExceeded is bad", () => {
  const [bad] = badDeployments([progressingDeadline]).values()
  assert.deepEqual(bad, {
    namespace: "prod",
    name: "timed-out",
    reason: "Progressing=False (ProgressDeadlineExceeded)",
  })
})

test("ReplicaFailure=True is bad", () => {
  const [bad] = badDeployments([replicaFailure]).values()
  assert.deepEqual(bad, {
    namespace: "ws",
    name: "quota-exceeded",
    reason: "ReplicaFailure=True (FailedCreate)",
  })
})

test("multiple bad conditions are reported together", () => {
  const [bad] = badDeployments([
    {
      metadata: { uid: "u", namespace: "default", name: "multi" },
      status: {
        conditions: [
          { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
          { type: "ReplicaFailure", status: "True" },
        ],
      },
    },
  ]).values()
  assert.equal(bad?.reason, "Available=False (MinimumReplicasUnavailable); ReplicaFailure=True")
})

test("bad deployments keep the creation timestamp", () => {
  const [bad] = badDeployments([prod17]).values()
  assert.equal(bad?.createdAt, "2026-11-11T05:57:39Z")
  assert.equal(bad?.reason, prod17Reason)
  const [dated] = badDeployments([
    {
      metadata: {
        uid: "99999999-9999-9999-9999-999999999999",
        namespace: "org-pfn--managed-inference",
        name: "prod17",
        creationTimestamp: new Date("2026-11-11T05:57:39Z"),
      },
      status: prod17.status,
    },
  ]).values()
  assert.equal(dated?.createdAt, "2026-11-11T05:57:39Z")
})

test("newly bad deployments fire", () => {
  const fresh = diffBad(badDeployments([availableFalse, progressingDeadline]), new Map())
  assert.deepEqual(fresh.map(describeDeployment), [
    "default/no-replicas: Available=False (MinimumReplicasUnavailable)",
    "prod/timed-out: Progressing=False (ProgressDeadlineExceeded)",
  ])
})

test("still bad deployments do not refire", () => {
  const previous = badDeployments([availableFalse])
  assert.equal(diffBad(badDeployments([availableFalse]), previous).length, 0)
})

test("recovered deployments leave the bad set without refiring", () => {
  const previous = badDeployments([flapBad, availableFalse])
  const current = badDeployments([flapHealthy, availableFalse])
  assert.equal(diffBad(current, previous).length, 0)
  assert.equal(current.has("55555555-5555-5555-5555-555555555555"), false)
})

test("recovered then bad again refires", () => {
  let previous = badDeployments([])
  const poll = (deployments: readonly DeploymentLike[]) => {
    const current = badDeployments(deployments)
    const fresh = diffBad(current, previous)
    previous = current
    return fresh
  }
  assert.equal(poll([flapBad]).length, 1)
  assert.equal(poll([flapHealthy]).length, 0)
  assert.equal(poll([flapBad]).length, 1)
})

const minimumReplicas: DeploymentLike = {
  metadata: { uid: "22222222-2222-2222-2222-222222222222", namespace: "default", name: "no-replicas" },
  status: { conditions: [{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable" }] },
}
const deadlineExceeded: DeploymentLike = {
  metadata: { uid: "22222222-2222-2222-2222-222222222222", namespace: "default", name: "no-replicas" },
  status: { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] },
}
const agedMinimumReplicas: DeploymentLike = {
  metadata: { uid: "22222222-2222-2222-2222-222222222222", namespace: "default", name: "no-replicas", creationTimestamp: "2026-11-11T05:57:39Z" },
  status: minimumReplicas.status,
}
const agedDeadlineExceeded: DeploymentLike = {
  metadata: { uid: "22222222-2222-2222-2222-222222222222", namespace: "default", name: "no-replicas", creationTimestamp: "2026-11-11T05:57:39Z" },
  status: deadlineExceeded.status,
}

test("a reason change on a still-bad deployment fires once", () => {
  let previous = badDeployments([minimumReplicas])
  const poll = (deployments: readonly DeploymentLike[]) => {
    const current = badDeployments(deployments)
    const changes = reasonChanges(current, previous)
    previous = current
    return changes
  }
  assert.equal(poll([minimumReplicas]).length, 0)
  const [change] = poll([deadlineExceeded])
  assert.deepEqual(change, {
    namespace: "default",
    name: "no-replicas",
    from: "Available=False (MinimumReplicasUnavailable)",
    to: "Progressing=False (ProgressDeadlineExceeded)",
  })
  assert.equal(poll([deadlineExceeded]).length, 0)
})

test("reason changes keep the creation timestamp", () => {
  const previous = badDeployments([agedMinimumReplicas])
  const [change] = reasonChanges(badDeployments([agedDeadlineExceeded]), previous)
  assert.equal(change?.createdAt, "2026-11-11T05:57:39Z")
})

test("newly bad and reason changed are disjoint in the same poll", () => {
  const previous = badDeployments([minimumReplicas])
  const current = badDeployments([deadlineExceeded, progressingDeadline])
  assert.deepEqual(diffBad(current, previous).map(describeDeployment), [
    "prod/timed-out: Progressing=False (ProgressDeadlineExceeded)",
  ])
  assert.deepEqual(reasonChanges(current, previous), [
    {
      namespace: "default",
      name: "no-replicas",
      from: "Available=False (MinimumReplicasUnavailable)",
      to: "Progressing=False (ProgressDeadlineExceeded)",
    },
  ])
})

test("alerts open with k8s-watch, the detection time and the deployment age", () => {
  const [bad] = badDeployments([prod17]).values()
  assert.equal(
    formatAlert(bad!, detectedAt),
    `k8s-watch 05:58:23Z org-pfn--managed-inference/prod17 (age 44s): ${prod17Reason}. Investigate.`,
  )
})

test("reason-change alerts carry time, age and both reasons", () => {
  assert.equal(
    formatReasonChange(
      {
        namespace: "org-pfn--managed-inference",
        name: "prod17",
        from: "Available=False (MinimumReplicasUnavailable)",
        to: "Progressing=False (ProgressDeadlineExceeded)",
        createdAt: "2026-11-11T06:02:02Z",
      },
      new Date("2026-11-11T06:14:02Z"),
    ),
    "k8s-watch 06:14:02Z org-pfn--managed-inference/prod17 (age 12m): still failing, changed: Available=False (MinimumReplicasUnavailable) → Progressing=False (ProgressDeadlineExceeded). Investigate.",
  )
})

test("entries without a creation timestamp omit the age", () => {
  assert.equal(
    formatAlert({ namespace: "default", name: "no-replicas", reason: "Available=False (MinimumReplicasUnavailable)" }, detectedAt),
    "k8s-watch 05:58:23Z default/no-replicas: Available=False (MinimumReplicasUnavailable). Investigate.",
  )
  assert.equal(
    formatReasonChange(
      {
        namespace: "default",
        name: "no-replicas",
        from: "Available=False (MinimumReplicasUnavailable)",
        to: "Progressing=False (ProgressDeadlineExceeded)",
      },
      detectedAt,
    ),
    "k8s-watch 05:58:23Z default/no-replicas: still failing, changed: Available=False (MinimumReplicasUnavailable) → Progressing=False (ProgressDeadlineExceeded). Investigate.",
  )
})

test("age formatting buckets to seconds, minutes, hours and days", () => {
  const at = new Date("2026-11-11T12:00:00Z")
  assert.equal(formatAge("2026-11-11T11:59:16Z", at), "44s")
  assert.equal(formatAge("2026-11-11T11:48:00Z", at), "12m")
  assert.equal(formatAge("2026-11-11T09:00:00Z", at), "3h")
  assert.equal(formatAge("2026-11-09T12:00:00Z", at), "2d")
})

test("poll intervals compact to seconds or whole minutes", () => {
  assert.equal(formatInterval(30_000), "30s")
  assert.equal(formatInterval(45_000), "45s")
  assert.equal(formatInterval(60_000), "1m")
  assert.equal(formatInterval(120_000), "2m")
})

test("allNamespaces resolves to the cluster scope", () => {
  assert.deepEqual(resolveWatchedNamespaces({ allNamespaces: true }, "stage"), { all: true })
  assert.deepEqual(resolveWatchedNamespaces({ allNamespaces: true, namespaces: ["prod"] }, "stage"), { all: true })
})

test("configured namespaces win over the context namespace", () => {
  assert.deepEqual(resolveWatchedNamespaces({ namespaces: ["default", "prod"] }, "stage"), { namespaces: ["default", "prod"] })
})

test("without options the kubeconfig context namespace is watched", () => {
  assert.deepEqual(resolveWatchedNamespaces({}, "stage"), { namespaces: ["stage"] })
  assert.deepEqual(resolveWatchedNamespaces({ allNamespaces: false, namespaces: [] }, undefined), { namespaces: ["default"] })
})

test("watched scopes read as namespace, namespaces, or all namespaces", () => {
  assert.equal(describeNamespaces({ all: true }), "all namespaces")
  assert.equal(describeNamespaces({ namespaces: ["default"] }), "namespace default")
  assert.equal(describeNamespaces({ namespaces: ["default", "prod"] }), "namespaces default, prod")
})

test("start and status share one formatter", () => {
  const [bad] = badDeployments([prod17]).values()
  assert.equal(
    formatWatch([bad!], { context: "pfcp-pfn-iz1-01-managed-inference", watched: "namespace org-pfn--managed-inference", intervalMs: 30_000, skipped: [] }, detectedAt),
    [
      `k8s-watch v${VERSION}: context pfcp-pfn-iz1-01-managed-inference, namespace org-pfn--managed-inference, every 30s.`,
      "Failing now:",
      `- org-pfn--managed-inference/prod17 (age 44s): ${prod17Reason}`,
    ].join("\n"),
  )
})

test("the formatter collapses to none and appends skipped namespaces", () => {
  assert.equal(
    formatWatch([], { context: "dev", watched: "namespaces default, prod", intervalMs: 30_000, skipped: ["stage", "sandbox"] }, detectedAt),
    [
      `k8s-watch v${VERSION}: context dev, namespaces default, prod, every 30s.`,
      "Skipped (no list access): stage, sandbox.",
      "Failing now: none.",
    ].join("\n"),
  )
})

test("an all-namespaces view names the cluster scope", () => {
  assert.equal(
    formatWatch([], { context: "dev", watched: describeNamespaces({ all: true }), intervalMs: 120_000, skipped: [] }, detectedAt),
    [`k8s-watch v${VERSION}: context dev, all namespaces, every 2m.`, "Failing now: none."].join("\n"),
  )
})

test("list lines omit the age without a creation timestamp", () => {
  const [bad] = badDeployments([availableFalse]).values()
  const text = formatWatch([bad!], { context: "dev", watched: "namespace default", intervalMs: 30_000, skipped: [] }, detectedAt)
  assert.equal(
    text,
    [
      `k8s-watch v${VERSION}: context dev, namespace default, every 30s.`,
      "Failing now:",
      "- default/no-replicas: Available=False (MinimumReplicasUnavailable)",
    ].join("\n"),
  )
})

test("idle status text carries the version and how to start", () => {
  assert.equal(formatIdleStatus(), `k8s-watch v${VERSION}: no watch is running. Start one with action=start.`)
})

test("all-forbidden failure text explains the RBAC situation and the options", () => {
  assert.equal(
    formatForbidden("namespaces stage, sandbox"),
    "k8s-watch: this user cannot list Deployments in namespaces stage, sandbox. Ask the operator for access, or change the namespaces/allNamespaces options. Check what you can list with kubectl auth can-i list deployments.",
  )
})

test("the --context flag is parsed from command text", () => {
  assert.equal(parseContextArg("/k8s-watch --context=prod-cluster"), "prod-cluster")
  assert.equal(parseContextArg("/k8s-watch --context prod-cluster"), "prod-cluster")
  assert.equal(parseContextArg("please watch --context prod-cluster now"), "prod-cluster")
  assert.equal(parseContextArg("/k8s-watch"), undefined)
  assert.equal(parseContextArg("/k8s-watch stop"), undefined)
  assert.equal(parseContextArg("/k8s-watch --context"), undefined)
})

const intervalMs = 30_000
const now = 1_700_000_000_000
const heldLease = { sessionID: "session", owner: "watcher-a", heartbeat: now }

test("a stored watch without a lease is claimable", () => {
  assert.equal(claimable(undefined, now, intervalMs), true)
  assert.equal(claimable({ sessionID: "session" }, now, intervalMs), true)
})

test("a live holder blocks claims by refreshing its heartbeat", () => {
  assert.equal(claimable(heldLease, now, intervalMs), false)
  assert.equal(claimable({ ...heldLease, heartbeat: now - 2 * intervalMs }, now, intervalMs), false)
})

test("the heartbeat goes claimable once it is older than three intervals", () => {
  assert.equal(claimable({ ...heldLease, heartbeat: now - 3 * intervalMs }, now, intervalMs), false)
  assert.equal(claimable({ ...heldLease, heartbeat: now - 3 * intervalMs - 1 }, now, intervalMs), true)
})

test("the holder keeps polling only while the stored watch is its own", () => {
  assert.equal(pollDecision(heldLease, "watcher-a", "session"), "armed")
  assert.equal(pollDecision(undefined, "watcher-a", "session"), "step-down")
  assert.equal(pollDecision(heldLease, "watcher-b", "session"), "step-down")
  assert.equal(pollDecision(heldLease, "watcher-a", "session-2"), "step-down")
  assert.equal(pollDecision({ sessionID: "session" }, "watcher-a", "session"), "step-down")
})

test("unknown-context failure text names the requested context and lists the available ones", () => {
  assert.equal(
    formatUnknownContext("tenant-z", ["tenant-a", "tenant-b"]),
    `k8s-watch: no such context "tenant-z". Available contexts: tenant-a, tenant-b. Pass one with --context, the tool's context parameter, or the context plugin option.`,
  )
})

test("the release version is stamped into every text", () => {
  assert.equal(VERSION, "1.6.0")
})
