import assert from "node:assert/strict"
import { test } from "node:test"
import {
  badDeployments,
  describeDeployment,
  describeNamespaces,
  diffBad,
  formatAlert,
  formatForbidden,
  formatReport,
  resolveWatchedNamespaces,
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

test("report and alert text list namespace, name and reason", () => {
  const [bad] = badDeployments([availableFalse]).values()
  assert.equal(formatReport([], { watched: "default", skipped: [] }).endsWith("No Deployments are currently failing."), true)
  assert.equal(
    formatReport([bad!], { watched: "default", skipped: [] }).includes("- default/no-replicas: Available=False (MinimumReplicasUnavailable)"),
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

test("report names the watched and the forbidden skipped namespaces", () => {
  const text = formatReport([], { watched: "default, prod", skipped: ["stage"] })
  assert.equal(text.includes("Watching Deployments in default, prod."), true)
  assert.equal(text.includes("Skipped forbidden namespaces (this user cannot list Deployments there): stage."), true)
  assert.equal(text.endsWith("No Deployments are currently failing."), true)
})

test("all-forbidden failure text explains the RBAC situation and the options", () => {
  const text = formatForbidden("stage, sandbox")
  assert.equal(text.includes("not allowed to list Deployments in stage, sandbox (HTTP 403)"), true)
  assert.equal(text.includes("Ask the operator"), true)
  assert.equal(text.includes("namespaces`/`allNamespaces`"), true)
  assert.equal(text.includes("`kubectl auth can-i list deployments`"), true)
})
