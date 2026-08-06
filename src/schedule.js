const DAY_INDEX = new Map([["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6]]);

function localTime(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    day: DAY_INDEX.get(values.weekday.toLowerCase()),
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function resolveImageTaskId(image, timezone, now = new Date()) {
  const current = localTime(now, timezone);
  for (const slot of image.slots) {
    const start = timeToMinutes(slot.start);
    const end = timeToMinutes(slot.end);
    const days = new Set(slot.days.map((day) => DAY_INDEX.get(day)));
    const active = end > start
      ? days.has(current.day) && current.minute >= start && current.minute < end
      : (days.has(current.day) && current.minute >= start)
        || (days.has((current.day + 6) % 7) && current.minute < end);
    if (active) return slot.taskId;
  }
  return image.fallbackTaskId;
}
