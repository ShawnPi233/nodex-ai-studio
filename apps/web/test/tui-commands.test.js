import { test, expect } from "bun:test"
import { TUI_COMMANDS, slashChoices, tuiCommand } from "../public/tui-commands.js"

test("TUI slash names and aliases follow OpenCode v1.17.20", () => {
  expect(tuiCommand("mo")?.name).toBe("models")
  expect(tuiCommand("clear")?.name).toBe("new")
  expect(tuiCommand("resume")?.name).toBe("sessions")
  expect(tuiCommand("continue")?.name).toBe("sessions")
  expect(tuiCommand("summarize")?.name).toBe("compact")
  expect(tuiCommand("toggle-thinking")?.name).toBe("thinking")
  expect(tuiCommand("compose")?.action).toBe("server")
  expect(tuiCommand("new_compose")?.action).toBe("new-compose")
  expect(tuiCommand("new-compose")?.name).toBe("new_compose")
  expect(TUI_COMMANDS.some((item) => item.name === "model")).toBe(false)
})

test("TUI autocomplete keeps skills in /skills and merges non-skill server commands", () => {
  const commands = [
    { name: "review", description: "Review changes", source: "command" },
    { name: "demo-skill", description: "A skill", source: "skill" },
    { name: "models", description: "Shadow builtin", source: "command" },
  ]
  expect(slashChoices(commands).some((item) => item.name === "demo-skill")).toBe(false)
  expect(slashChoices(commands, "revi").map((item) => item.name)).toEqual(["review"])
  expect(slashChoices(commands, "mo")[0].name).toBe("models")
  expect(slashChoices(commands, "models").filter((item) => item.name === "models")).toHaveLength(1)
  const composeChoices = slashChoices([...commands, { name: "compose", source: "command" }], "compose").map((item) => item.name)
  expect(composeChoices[0]).toBe("compose")
  expect(composeChoices).toContain("new_compose")
  expect(slashChoices(Array.from({ length: 20 }, (_, index) => ({ name: `cmd${index}`, source: "command" })))).toHaveLength(TUI_COMMANDS.length + 20)
})
