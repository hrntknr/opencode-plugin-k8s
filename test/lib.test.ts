import assert from "node:assert/strict"
import { test } from "node:test"
import {
  badDeployments,
  describeDeployment,
  describeNamespaces,
  diffBad,
  formatAlert,
  formatForbidden,
  formatIdleStatus,
  formatReasonChange,
  formatReport,
  formatStatus,
  formatUnknownContext,
  parseContextArg,
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

test("reason-change alerts say the deployment is still failing", () => {
  assert.equal(
    formatReasonChange({
      namespace: "default",
      name: "no-replicas",
      from: "Available=False (MinimumReplicasUnavailable)",
      to: "Progressing=False (ProgressDeadlineExceeded)",
    }),
    "k8s-watch: Deployment default/no-replicas is still failing, conditions changed: Available=False (MinimumReplicasUnavailable) → Progressing=False (ProgressDeadlineExceeded). Check whether it needs intervention.",
  )
})

test("report and alert text list namespace, name and reason", () => {
  const [bad] = badDeployments([availableFalse]).values()
  assert.equal(formatReport([], { context: "dev", watched: "default", skipped: [] }).startsWith(`k8s-watch (v${VERSION}):`), true)
  assert.equal(formatReport([], { context: "dev", watched: "default", skipped: [] }).endsWith("No Deployments are currently failing."), true)
  assert.equal(
    formatReport([bad!], { context: "dev", watched: "default", skipped: [] }).includes("- default/no-replicas: Available=False (MinimumReplicasUnavailable)"),
    true,
  )
  assert.equal(
    formatAlert(bad!),
    "k8s-watch: Deployment default/no-replicas just became unhealthy: Available=False (MinimumReplicasUnavailable). Investigate it (rollout status, events, pod logs) and report what is wrong.",
  )
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

test("watched namespaces are described for reports", () => {
  assert.equal(describeNamespaces({ all: true }), "all namespaces")
  assert.equal(describeNamespaces({ namespaces: ["default", "prod"] }), "default, prod")
})

test("report names the pinned context, the watched and the forbidden skipped namespaces", () => {
  const text = formatReport([], { context: "tenant-a", watched: "default, prod", skipped: ["stage"] })
  assert.equal(text.includes("Watching kubeconfig context tenant-a: default, prod."), true)
  assert.equal(text.includes("Skipped forbidden namespaces (this user cannot list Deployments there): stage."), true)
  assert.equal(text.endsWith("No Deployments are currently failing."), true)
})

test("status text names the context, the watched namespaces, the interval and the current failures", () => {
  const [bad] = badDeployments([availableFalse]).values()
  const text = formatStatus([bad!], { context: "dev", watched: "default", intervalMs: 45000 })
  assert.equal(text.startsWith(`k8s-watch (v${VERSION}): the watch is running.`), true)
  assert.equal(text.includes("Watching kubeconfig context dev: default."), true)
  assert.equal(text.includes("Polling every 45000 ms."), true)
  assert.equal(text.includes("- default/no-replicas: Available=False (MinimumReplicasUnavailable)"), true)
})

test("status text with nothing failing says so", () => {
  const text = formatStatus([], { context: "dev", watched: "all namespaces", intervalMs: 30000 })
  assert.equal(text.endsWith("No Deployments are currently failing."), true)
})

test("idle status text carries the version and how to start", () => {
  assert.equal(formatIdleStatus(), `k8s-watch (v${VERSION}): no watch is running. Start one with action=start.`)
})

test("all-forbidden failure text explains the RBAC situation and the options", () => {
  const text = formatForbidden("stage, sandbox")
  assert.equal(text.includes("not allowed to list Deployments in stage, sandbox (HTTP 403)"), true)
  assert.equal(text.includes("Ask the operator"), true)
  assert.equal(text.includes("namespaces`/`allNamespaces`"), true)
  assert.equal(text.includes("`kubectl auth can-i list deployments`"), true)
})

test("the --context flag is parsed from command text", () => {
  assert.equal(parseContextArg("/k8s-watch --context=prod-cluster"), "prod-cluster")
  assert.equal(parseContextArg("/k8s-watch --context prod-cluster"), "prod-cluster")
  assert.equal(parseContextArg("please watch --context prod-cluster now"), "prod-cluster")
  assert.equal(parseContextArg("/k8s-watch"), undefined)
  assert.equal(parseContextArg("/k8s-watch stop"), undefined)
  assert.equal(parseContextArg("/k8s-watch --context"), undefined)
})

test("unknown-context failure text names the requested context and lists the available ones", () => {
  const text = formatUnknownContext("tenant-z", ["tenant-a", "tenant-b"])
  assert.equal(text.includes("k8s-watch could not start: the kubeconfig has no context tenant-z."), true)
  assert.equal(text.includes("Available contexts: tenant-a, tenant-b."), true)
  assert.equal(text.includes("`--context` flag"), true)
})
