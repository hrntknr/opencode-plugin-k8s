export const VERSION = "1.4.0"

export type BadDeployment = {
  namespace: string
  name: string
  reason: string
}

export type ReasonChange = {
  namespace: string
  name: string
  from: string
  to: string
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

export function reasonChanges(current: Map<string, BadDeployment>, previous: Map<string, BadDeployment>): ReasonChange[] {
  const changes: ReasonChange[] = []
  for (const [key, deployment] of current) {
    const before = previous.get(key)
    if (before === undefined || before.reason === deployment.reason) continue
    changes.push({ namespace: deployment.namespace, name: deployment.name, from: before.reason, to: deployment.reason })
  }
  return changes
}

export function describeDeployment(deployment: BadDeployment): string {
  return `${deployment.namespace}/${deployment.name}: ${deployment.reason}`
}

export type WatchedNamespaces = { all: true } | { namespaces: string[] }

export interface NamespaceOptions {
  allNamespaces?: boolean
  namespaces?: string[]
}

export function resolveWatchedNamespaces(options: NamespaceOptions, contextNamespace: string | undefined): WatchedNamespaces {
  if (options.allNamespaces === true) return { all: true }
  if (options.namespaces?.length) return { namespaces: options.namespaces }
  return { namespaces: [contextNamespace ?? "default"] }
}

export function describeNamespaces(namespaces: WatchedNamespaces): string {
  return "all" in namespaces ? "all namespaces" : namespaces.namespaces.join(", ")
}

export function parseContextArg(text: string): string | undefined {
  return text.match(/(?:^|\s)--context(?:\s+|=)(\S+)/)?.[1]
}

export interface ReportScope {
  context: string
  watched: string
  skipped: string[]
}

function badListLines(bad: readonly BadDeployment[]): string[] {
  if (bad.length === 0) return ["No Deployments are currently failing."]
  return ["Failing Deployments, investigate these:", ...bad.map((deployment) => `- ${describeDeployment(deployment)}`)]
}

export function formatReport(bad: readonly BadDeployment[], scope: ReportScope): string {
  const lines = [
    `k8s-watch (v${VERSION}): a watcher for failing Kubernetes Deployments has started. It reports newly failing Deployments in this session.`,
    `Watching kubeconfig context ${scope.context}: ${scope.watched}.`,
  ]
  if (scope.skipped.length > 0)
    lines.push(`Skipped forbidden namespaces (this user cannot list Deployments there): ${scope.skipped.join(", ")}.`)
  return [...lines, ...badListLines(bad)].join("\n")
}

export interface StatusScope {
  context: string
  watched: string
  intervalMs: number
}

export function formatStatus(bad: readonly BadDeployment[], scope: StatusScope): string {
  return [
    `k8s-watch (v${VERSION}): the watch is running.`,
    `Watching kubeconfig context ${scope.context}: ${scope.watched}.`,
    `Polling every ${scope.intervalMs} ms.`,
    ...badListLines(bad),
  ].join("\n")
}

export function formatIdleStatus(): string {
  return `k8s-watch (v${VERSION}): no watch is running. Start one with action=start.`
}

export function formatForbidden(namespaces: string): string {
  return [
    `k8s-watch could not start: this user is not allowed to list Deployments in ${namespaces} (HTTP 403).`,
    "Ask the operator for permission to list Deployments there, or change the `namespaces`/`allNamespaces` plugin options to point at namespaces this user can list.",
    "Check what you can list with `kubectl auth can-i list deployments`.",
  ].join("\n")
}

export function formatUnknownContext(context: string, contexts: string[]): string {
  return [
    `k8s-watch could not start: the kubeconfig has no context ${context}.`,
    `Available contexts: ${contexts.join(", ")}.`,
    "Pass one of them with the `--context` flag, the `context` tool parameter, or the `context` plugin option, then start the watch again.",
  ].join("\n")
}

export function formatAlert(deployment: BadDeployment): string {
  return `k8s-watch: Deployment ${deployment.namespace}/${deployment.name} just became unhealthy: ${deployment.reason}. Investigate it (rollout status, events, pod logs) and report what is wrong.`
}

export function formatReasonChange(change: ReasonChange): string {
  return `k8s-watch: Deployment ${change.namespace}/${change.name} is still failing, conditions changed: ${change.from} → ${change.to}. Check whether it needs intervention.`
}
