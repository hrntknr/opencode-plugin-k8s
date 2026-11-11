export type BadDeployment = {
  namespace: string
  name: string
  reason: string
}

export interface DeploymentLike {
  metadata?: { uid?: string | null; name?: string | null; namespace?: string | null } | null
  status?: { conditions?: DeploymentCondition[] | null } | null
}

interface DeploymentCondition {
  type?: string | null
  status?: string | null
  reason?: string | null
}

function isBadCondition(condition: DeploymentCondition): boolean {
  return (
    (condition.type === "Available" && condition.status === "False") ||
    (condition.type === "Progressing" && condition.status === "False" && condition.reason === "ProgressDeadlineExceeded") ||
    (condition.type === "ReplicaFailure" && condition.status === "True")
  )
}

function describeCondition(condition: DeploymentCondition): string {
  const reason = condition.reason ? ` (${condition.reason})` : ""
  return `${condition.type}=${condition.status}${reason}`
}

export function badDeployments(deployments: readonly DeploymentLike[]): Map<string, BadDeployment> {
  const bad = new Map<string, BadDeployment>()
  for (const deployment of deployments) {
    const reasons = (deployment.status?.conditions ?? []).filter(isBadCondition).map(describeCondition)
    if (reasons.length === 0) continue
    const namespace = deployment.metadata?.namespace ?? ""
    const name = deployment.metadata?.name ?? ""
    bad.set(deployment.metadata?.uid ?? `${namespace}/${name}`, { namespace, name, reason: reasons.join("; ") })
  }
  return bad
}

export function diffBad(current: Map<string, BadDeployment>, previous: Map<string, BadDeployment>): BadDeployment[] {
  const fresh: BadDeployment[] = []
  for (const [key, deployment] of current) if (!previous.has(key)) fresh.push(deployment)
  return fresh
}

export function describeDeployment(deployment: BadDeployment): string {
  return `${deployment.namespace}/${deployment.name}: ${deployment.reason}`
}

export function formatReport(bad: readonly BadDeployment[]): string {
  const lines = [
    "k8s-watch: a watcher for failing Kubernetes Deployments has started. It reports newly failing Deployments in this session.",
  ]
  if (bad.length === 0) lines.push("No Deployments are currently failing.")
  else {
    lines.push("Failing Deployments, investigate these:")
    for (const deployment of bad) lines.push(`- ${describeDeployment(deployment)}`)
  }
  return lines.join("\n")
}

export function formatAlert(deployment: BadDeployment): string {
  return `k8s-watch: Deployment ${deployment.namespace}/${deployment.name} just became unhealthy: ${deployment.reason}. Investigate it (rollout status, events, pod logs) and report what is wrong.`
}
