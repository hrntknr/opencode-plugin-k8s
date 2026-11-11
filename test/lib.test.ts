import assert from "node:assert/strict"
import { test } from "node:test"
import { badDeployments, diffBad, describeDeployment, formatAlert, formatReport, type DeploymentLike } from "../src/lib.ts"
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
  assert.equal(formatReport([]).endsWith("No Deployments are currently failing."), true)
  assert.equal(formatReport([bad!]).includes("- default/no-replicas: Available=False (MinimumReplicasUnavailable)"), true)
  assert.equal(
    formatAlert(bad!),
    "k8s-watch: Deployment default/no-replicas just became unhealthy: Available=False (MinimumReplicasUnavailable). Investigate it (rollout status, events, pod logs) and report what is wrong.",
  )
})
