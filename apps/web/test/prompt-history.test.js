import { test, expect } from "bun:test"
import { recentPrompts, navigatePromptHistory } from "../public/prompt-history.js"

test("history keeps the latest three sent inputs in newest-first order", () => {
  const messages = ["a", "b", "c", "d"].flatMap((text) => [
    { role: "user", text }, { role: "assistant", text: "reply" },
  ])
  expect(recentPrompts(messages)).toEqual(["d", "c", "b"])
})

test("undone prompts are restored to the newest end of history", () => {
  const messages = ["a", "b"].flatMap((text) => [
    { role: "user", text }, { role: "assistant", text: "reply" },
  ])
  expect(recentPrompts(messages, ["c"])).toEqual(["c", "b", "a"])
  // 重新发送后（已回到会话里）不再重复占位
  expect(recentPrompts(messages, ["c", "b"])).toEqual(["c", "b", "a"])
})

test("up and down traverse the three inputs and return to the empty draft", () => {
  const history = ["d", "c", "b"]
  let step = { index: -1, value: "", draft: "" }
  for (const expected of ["d", "c", "b", "b"]) {
    step = navigatePromptHistory(history, step.index, "ArrowUp", step.value, step.draft)
    expect(step.value).toBe(expected)
  }
  for (const expected of ["c", "d", "", ""]) {
    const next = navigatePromptHistory(history, step.index, "ArrowDown", step.value, step.draft)
    if (next) step = next
    expect(step.value).toBe(expected)
  }
  expect(navigatePromptHistory(history, -1, "ArrowUp", "draft")).toBeNull()
})
