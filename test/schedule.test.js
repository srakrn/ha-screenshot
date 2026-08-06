import assert from "node:assert/strict";
import test from "node:test";
import { resolveImageTaskId } from "../src/schedule.js";

const image = {
  fallbackTaskId: "fallback",
  slots: [
    { days: ["mon"], start: "06:00", end: "09:00", taskId: "morning" },
    { days: ["sun"], start: "22:00", end: "02:00", taskId: "night" },
  ],
};

test("resolves exact weekly boundaries and fallback", () => {
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T05:59:00Z")), "fallback");
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T06:00:00Z")), "morning");
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T08:59:00Z")), "morning");
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T09:00:00Z")), "fallback");
});

test("resolves overnight Sunday-to-Monday ranges", () => {
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-02T23:00:00Z")), "night");
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T01:59:00Z")), "night");
  assert.equal(resolveImageTaskId(image, "UTC", new Date("2026-08-03T02:00:00Z")), "fallback");
});

test("uses the configured timezone rather than UTC weekday and time", () => {
  assert.equal(resolveImageTaskId(image, "Asia/Bangkok", new Date("2026-08-02T23:30:00Z")), "morning");
});
