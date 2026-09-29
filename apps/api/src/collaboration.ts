import type { LayoutTemplateLink, LayoutTemplateSlot } from "./store.ts"
import type { CollaborationInstance } from "./store.ts"

export type CollaborationKind = "three-ministries" | "brainstorm" | "debate"
export type CollaborationConfig = { layers?: number[]; agents?: number; sides?: number; perSide?: number }

export const PLACEHOLDER_TITLES = new Set([
  "", "未命名节点", "未命名会话", "未命名", "新节点", "新会话", "子节点", "子会话",
  "Untitled", "New Chat", "New Node",
])

/** 标题是否仍是占位/默认值。 */
export function isPlaceholderTitle(title?: string): boolean {
  const value = String(title ?? "").trim()
  return !value || PLACEHOLDER_TITLES.has(value) || /^new session\b/i.test(value)
}

/**
 * 协作子节点成功产出后是否应自动生成 AI 标题：
 * - 协作自己新建的节点：标题仍是角色名（默认槽位名）时才改，避免覆盖用户手动改过的名字；
 * - 用户绑定进槽位的已有节点：仅在标题仍是占位值时改名，不覆盖用户命名。
 */
export function shouldAutoRenameChild(title: string | undefined, slotLabel: string, owned: boolean): boolean {
  return owned ? String(title ?? "").trim() === slotLabel : isPlaceholderTitle(title)
}

export function collaborationDependencies(instance: CollaborationInstance): Map<string, string[]> {
  const workers = instance.slots.filter((slot) => slot.key !== instance.mainKey)
  return new Map(workers.map((slot) => [slot.key, instance.links
    .filter((link) => instance.kind === "three-ministries"
      ? link.from === slot.key && link.to !== instance.mainKey && link.kind === "dependency"
      : link.to === slot.key && link.from !== instance.mainKey && (link.kind === "dependency" || slot.key === "judge"))
    .map((link) => instance.kind === "three-ministries" ? link.to : link.from)]))
}

function count(value: unknown, min = 1, max = 12): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`人数必须为 ${min}-${max} 的整数`)
  }
  return Number(value)
}

export function collaborationLayout(kind: CollaborationKind, config: CollaborationConfig): {
  slots: LayoutTemplateSlot[]
  links: LayoutTemplateLink[]
  mainKey: string
  config: CollaborationConfig
} {
  const slots: LayoutTemplateSlot[] = []
  const links: LayoutTemplateLink[] = []
  if (kind === "three-ministries") {
    const layers = config.layers ?? [3, 6]
    if (!Array.isArray(layers) || layers.length < 2 || layers.length > 5) throw new Error("三省六部需要 2-5 层")
    const sizes = layers.map((n) => count(n, 1, 12))
    if (sizes.reduce((sum, n) => sum + n, 0) > 36) throw new Error("除皇帝外最多 36 个 agent")
    slots.push({ key: "emperor", label: "皇帝", x: 0, y: -300 })
    for (let level = 0; level < sizes.length; level++) {
      for (let index = 0; index < sizes[level]; index++) {
        const key = `layer${level + 1}_${index + 1}`
        const label = level === 0 && sizes[0] === 3 ? ["中书", "门下", "尚书"][index]
          : level === 1 && sizes[0] === 3 && sizes[1] === 6 ? ["吏部", "户部", "礼部", "兵部", "刑部", "工部"][index]
            : `第${level + 1}层 ${index + 1}`
        slots.push({ key, label, x: (index - (sizes[level] - 1) / 2) * 210, y: level * 240 })
        if (level > 0) links.push({ from: `layer${level}_${Math.min(sizes[level - 1], Math.floor(index * sizes[level - 1] / sizes[level]) + 1)}`, to: key, kind: "dependency" })
      }
    }
    for (let index = 1; index <= sizes[0]; index++) links.push({ from: "emperor", to: `layer1_${index}`, kind: "reference" })
    for (let index = 1; index < sizes[0]; index++) links.push({ from: `layer1_${index}`, to: `layer1_${index + 1}`, kind: "dependency" })
    return { slots, links, mainKey: "emperor", config: { layers: sizes } }
  }
  if (kind === "brainstorm") {
    const agents = count(config.agents ?? 6)
    slots.push({ key: "center", label: "主持", x: 0, y: 0 })
    for (let index = 0; index < agents; index++) {
      const angle = 2 * Math.PI * index / agents - Math.PI / 2
      const key = `idea${index + 1}`
      slots.push({ key, label: `发散 ${index + 1}`, x: Math.round(Math.cos(angle) * 380), y: Math.round(Math.sin(angle) * 300) })
      links.push({ from: "center", to: key, kind: "reference", directed: false })
    }
    return { slots, links, mainKey: "center", config: { agents } }
  }
  if (kind === "debate") {
    const sides = count(config.sides ?? 2, 2, 6)
    const perSide = count(config.perSide ?? 2, 1, 6)
    slots.push({ key: "moderator", label: "主持", x: 0, y: -340 })
    for (let side = 0; side < sides; side++) {
      for (let index = 0; index < perSide; index++) {
        const key = `side${side + 1}_${index + 1}`
        slots.push({ key, label: `第${side + 1}方 ${index + 1}辩`, x: Math.round((side - (sides - 1) / 2) * 330), y: index * 210 })
        links.push({ from: index ? `side${side + 1}_${index}` : "moderator", to: key, kind: index ? "dependency" : "reference" })
      }
    }
    slots.push({ key: "judge", label: "评审", x: 0, y: perSide * 210 + 120 })
    for (let side = 0; side < sides; side++) links.push({ from: `side${side + 1}_${perSide}`, to: "judge", kind: "reference" })
    return { slots, links, mainKey: "moderator", config: { sides, perSide } }
  }
  throw new Error("未知协作模板")
}
