import { Plugin } from "@opencode/plugin"
import { AppsV1Api, KubeConfig, type V1Deployment } from "@kubernetes/client-node"
import { badDeployments, diffBad, formatAlert, formatReport, type BadDeployment } from "./lib.ts"

type Delivery = "steer" | "queue"

interface Options {
  intervalMs?: number
  namespaces?: string[]
  labelSelector?: string
}

type WatchState = {
  sessionID: string
  bad: Record<string, BadDeployment>
}

const WATCH_KEY = "watch"

export default Plugin.define({
  id: "k8s",
  async setup(ctx) {
    const options = ctx.options as Options
    const intervalMs = options.intervalMs ?? 30_000

    let timer: ReturnType<typeof setInterval> | undefined
    let state: WatchState | undefined

    const listDeployments = async (): Promise<V1Deployment[]> => {
      const kubeConfig = new KubeConfig()
      kubeConfig.loadFromDefault()
      const api = kubeConfig.makeApiClient(AppsV1Api)
      const lists = options.namespaces?.length
        ? await Promise.all(
            options.namespaces.map((namespace) => api.listNamespacedDeployment({ namespace, labelSelector: options.labelSelector })),
          )
        : [await api.listDeploymentForAllNamespaces({ labelSelector: options.labelSelector })]
      return lists.flatMap((list) => list.items)
    }

    const kick = (sessionID: string, text: string, delivery: Delivery) => ctx.session.prompt({ sessionID, text, delivery })

    const sync = async (current: Map<string, BadDeployment>) => {
      if (!state) return
      for (const deployment of diffBad(current, new Map(Object.entries(state.bad)))) {
        await kick(state.sessionID, formatAlert(deployment), "queue")
      }
      state = { sessionID: state.sessionID, bad: Object.fromEntries(current) }
      await ctx.storage.set(WATCH_KEY, state)
    }

    const poll = async () => {
      if (!state) return
      try {
        await sync(badDeployments(await listDeployments()))
      } catch (error) {
        console.error("k8s-watch: polling deployments failed", error)
      }
    }

    const arm = () => {
      clearInterval(timer)
      timer = setInterval(() => void poll(), intervalMs)
    }

    const disarm = async () => {
      clearInterval(timer)
      timer = undefined
      state = undefined
      await ctx.storage.remove(WATCH_KEY)
    }

    const start = async (sessionID: string, delivery: Delivery) => {
      clearInterval(timer)
      let current: Map<string, BadDeployment>
      try {
        current = badDeployments(await listDeployments())
      } catch (error) {
        console.error("k8s-watch: listing deployments failed", error)
        await disarm()
        const message = error instanceof Error ? error.message : String(error)
        await kick(
          sessionID,
          `k8s-watch could not list deployments: ${message}. Check that kubectl reaches your cluster (for example with \`kubectl get deployments\`), then run /k8s-watch in this session again.`,
          delivery,
        )
        return
      }
      state = { sessionID, bad: Object.fromEntries(current) }
      await ctx.storage.set(WATCH_KEY, state)
      arm()
      await kick(sessionID, formatReport([...current.values()]), delivery)
    }

    const registration = await ctx.command.transform((editor) => {
      editor.add({
        name: "k8s-watch",
        description: "Watch Kubernetes Deployments for failures and report them in this session. Stop the watch with: stop",
        execute: async ({ sessionID, prompt, delivery }) => {
          if (/\bstop\b/i.test(prompt.text)) {
            await disarm()
            await kick(sessionID, "k8s-watch stopped. Failing Deployments are no longer reported.", delivery)
            return
          }
          await start(sessionID, delivery)
        },
      })
    })

    const stored = (await ctx.storage.get(WATCH_KEY)) as WatchState | undefined
    if (stored) {
      state = stored
      arm()
    }

    return async () => {
      clearInterval(timer)
      await registration.dispose()
    }
  },
})
