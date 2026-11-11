export const VERSION = "1.5.0"

export type BadDeployment = {
  namespace: string
  name: string
  reason: string
  createdAt?: string
}

export type ReasonChange = {
  namespace: string
  name: string
  from: string
  to: string
  createdAt?: string
}

export interface DeploymentLike {
  metadata?: { uid?: string | null; name?: string | null; namespace?: string | null; creationTimestamp?: string | Date | null } | null
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

function creationIso(createdAt: string | Date): string {
  return createdAt instanceof Date ? createdAt.toISOString().replace(/\.\d{3}Z$/, "Z") : createdAt
}

export function badDeployments(deployments: readonly DeploymentLike[]): Map<string, BadDeployment> {
  const bad = new Map<string, BadDeployment>()
  for (const deployment of deployments) {
    const reasons = (deployment.status?.conditions ?? []).filter(isBadCondition).map(describeCondition)
    if (reasons.length === 0) continue
    const namespace = deployment.metadata?.namespace ?? ""
    const name = deployment.metadata?.name ?? ""
    const entry: BadDeployment = { namespace, name, reason: reasons.join("; ") }
    const createdAt = deployment.metadata?.creationTimestamp
    if (createdAt) entry.createdAt = creationIso(createdAt)
    bad.set(deployment.metadata?.uid ?? `${namespace}/${name}`, entry)
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
    const change: ReasonChange = { namespace: deployment.namespace, name: deployment.name, from: before.reason, to: deployment.reason }
    if (deployment.createdAt !== undefined) change.createdAt = deployment.createdAt
    changes.push(change)
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
  if ("all" in namespaces) return "all namespaces"
  if (namespaces.namespaces.length === 1) return `namespace ${namespaces.namespaces[0]}`
  return `namespaces ${namespaces.namespaces.join(", ")}`
}

export function parseContextArg(text: string): string | undefined {
  return text.match(/(?:^|\s)--context(?:\s+|=)(\S+)/)?.[1]
}

export function formatAge(createdAt: string, at: Date): string {
  const seconds = Math.floor((at.getTime() - Date.parse(createdAt)) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function clockStamp(at: Date): string {
  return `${at.toISOString().slice(11, 19)}Z`
}

function deploymentLabel(target: { namespace: string; name: string; createdAt?: string }, at: Date): string {
  const age = target.createdAt === undefined ? "" : ` (age ${formatAge(target.createdAt, at)})`
  return `${target.namespace}/${target.name}${age}`
}

export function formatInterval(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

export interface WatchScope {
  context: string
  watched: string
  intervalMs: number
  skipped: string[]
}

function badListLines(bad: readonly BadDeployment[], at: Date): string[] {
  return bad.map((deployment) => `- ${deploymentLabel(deployment, at)}: ${deployment.reason}`)
}

export function formatWatch(bad: readonly BadDeployment[], scope: WatchScope, at: Date): string {
  const lines = [`k8s-watch v${VERSION}: context ${scope.context}, ${scope.watched}, every ${formatInterval(scope.intervalMs)}.`]
  if (scope.skipped.length > 0) lines.push(`Skipped (no list access): ${scope.skipped.join(", ")}.`)
  if (bad.length === 0) lines.push("Failing now: none.")
  else lines.push("Failing now:", ...badListLines(bad, at))
  return lines.join("\n")
}

export function formatIdleStatus(): string {
  return `k8s-watch v${VERSION}: no watch is running. Start one with action=start.`
}

export function formatForbidden(scope: string): string {
  return `k8s-watch: this user cannot list Deployments in ${scope}. Ask the operator for access, or change the namespaces/allNamespaces options. Check what you can list with kubectl auth can-i list deployments.`
}

export function formatUnknownContext(context: string, contexts: string[]): string {
  return `k8s-watch: no such context "${context}". Available contexts: ${contexts.join(", ")}. Pass one with --context, the tool's context parameter, or the context plugin option.`
}

export function formatAlert(deployment: BadDeployment, at: Date): string {
  return `k8s-watch ${clockStamp(at)} ${deploymentLabel(deployment, at)}: ${deployment.reason}. Investigate.`
}

export function formatReasonChange(change: ReasonChange, at: Date): string {
  return `k8s-watch ${clockStamp(at)} ${deploymentLabel(change, at)}: still failing, changed: ${change.from} → ${change.to}. Investigate.`
}
