const tasksBody = document.querySelector("#tasks");
const cssBody = document.querySelector("#custom-csses");
const imagesBody = document.querySelector("#images");
const notice = document.querySelector("#notice");
const saveState = document.querySelector("#save-state");
const saveButton = document.querySelector("#save-config");
const taskForm = document.querySelector("#task-form");
const cssForm = document.querySelector("#css-form");
const imageForm = document.querySelector("#image-form");
const settingsForm = document.querySelector("#settings-form");
const taskModal = new bootstrap.Modal("#task-modal");
const cssModal = new bootstrap.Modal("#css-modal");
const imageModal = new bootstrap.Modal("#image-modal");
const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const dayIndex = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
let draft = { settings: {}, customCsses: [], tasks: [], images: [] };
let timezone = "UTC";
let dirty = false;
let editingTask = -1;
let editingCss = -1;
let editingImage = -1;

const taskDefaults = {
  id: "new-task", dashboardPath: "/lovelace/0", width: 800, height: 480,
  refreshIntervalSeconds: 300, maximumImageAgeSeconds: 0, waitAfterLoadMs: 3000, colorScheme: "light",
  timezone: "UTC", disableAnimations: true, zoom: 1, format: "png", jpegQuality: 85,
  navigationTimeoutMs: 60000, waitForSelector: "home-assistant", customCss: "",
  customCssFile: "", customCssIds: [], hideCursor: true, outputFilename: "new-task.png",
  imageProcessing: { mode: "color", palette: [], dither: "none", threshold: 128, invert: false, rotation: 0 },
};

function showNotice(message, kind = "danger") {
  notice.textContent = message;
  notice.className = `alert alert-${kind}`;
  notice.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showFormError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function markDirty() {
  dirty = true;
  saveState.textContent = "Unsaved changes";
  saveState.classList.remove("text-white-50");
  saveState.classList.add("text-warning");
}

function markSaved() {
  dirty = false;
  saveState.textContent = "All changes saved";
  saveState.classList.add("text-white-50");
  saveState.classList.remove("text-warning");
}

function uniqueId(prefix, values) {
  let result = prefix;
  let number = 1;
  while (values.has(result)) result = `${prefix}-${++number}`;
  return result;
}

function intervalLabel(seconds) {
  if (seconds === 0) return "Startup only";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function badge(status) {
  const span = document.createElement("span");
  span.className = "badge";
  if (status?.stale) { span.classList.add("text-bg-danger"); span.textContent = "Stale"; }
  else if (status?.lastError) { span.classList.add("text-bg-danger"); span.textContent = "Error"; }
  else if (status?.capturing) { span.classList.add("text-bg-warning"); span.textContent = "Capturing"; }
  else if (status?.ready) { span.classList.add("text-bg-success"); span.textContent = "Ready"; }
  else { span.classList.add("text-bg-secondary"); span.textContent = "Starting"; }
  span.title = status?.lastError || "";
  return span;
}

function link(url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.className = "small font-monospace text-decoration-none url-text d-block";
  anchor.textContent = url;
  return anchor;
}

function preview(url, ready, alt) {
  if (!ready) {
    const value = document.createElement("span");
    value.className = "d-inline-flex align-items-center justify-content-center preview-thumb rounded border small text-body-secondary";
    value.textContent = "No image";
    return value;
  }
  const image = document.createElement("img");
  image.className = "preview-thumb rounded border";
  image.alt = alt;
  image.src = `${url}?preview=${Date.now()}`;
  return image;
}

function actionButton(label, action, id, style = "outline-secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn btn-${style} btn-sm`;
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function renderTasks() {
  tasksBody.replaceChildren();
  for (const task of draft.tasks) {
    const row = document.createElement("tr");
    const previewCell = row.insertCell();
    previewCell.append(preview(task.imageUrl || `/screenshots/${task.id}`, task.status?.imageAvailable, `${task.id} screenshot`));
    const name = row.insertCell();
    const strong = document.createElement("strong"); strong.textContent = task.id;
    name.append(strong, document.createElement("br"), link(task.imageUrl || `/screenshots/${task.id}`));
    row.insertCell().append(badge(task.status));
    const output = row.insertCell(); output.textContent = `${task.width} × ${task.height} · ${task.format.toUpperCase()}`;
    row.insertCell().textContent = intervalLabel(task.refreshIntervalSeconds);
    const actions = row.insertCell(); actions.className = "text-end text-nowrap";
    const group = document.createElement("div"); group.className = "btn-group";
    group.append(actionButton("Capture", "capture", task.id, "outline-success"), actionButton("Edit", "edit-task", task.id), actionButton("Delete", "delete-task", task.id, "outline-danger"));
    actions.append(group);
    tasksBody.append(row);
  }
  document.querySelector("#tasks-table").hidden = draft.tasks.length === 0;
  document.querySelector("#tasks-empty").hidden = draft.tasks.length !== 0;
  document.querySelector("#task-count").textContent = draft.tasks.length;
}

function slotSummary(image) {
  if (!image.slots.length) return "Fallback all week";
  const count = image.slots.length;
  return `${count} override${count === 1 ? "" : "s"}`;
}

function renderImages() {
  imagesBody.replaceChildren();
  for (const item of draft.images) {
    const fallback = draft.tasks.find((task) => task.id === item.fallbackTaskId);
    const active = draft.tasks.find((task) => task.id === item.activeTaskId) || fallback;
    const row = document.createElement("tr");
    row.insertCell().append(preview(item.imageUrl || `/images/${item.id}`, item.status?.imageAvailable, `${item.id} scheduled image`));
    const name = row.insertCell(); const strong = document.createElement("strong"); strong.textContent = item.id;
    name.append(strong, document.createElement("br"), link(item.imageUrl || `/images/${item.id}`));
    const activeCell = row.insertCell(); activeCell.textContent = item.activeTaskId || item.fallbackTaskId; activeCell.append(document.createTextNode(" "), badge(item.status));
    row.insertCell().textContent = item.fallbackTaskId;
    const schedule = row.insertCell(); schedule.textContent = `${slotSummary(item)} · ${active?.width || fallback?.width}×${active?.height || fallback?.height} ${active?.format?.toUpperCase() || ""}`;
    const actions = row.insertCell(); actions.className = "text-end text-nowrap";
    const group = document.createElement("div"); group.className = "btn-group";
    group.append(actionButton("Edit", "edit-image", item.id), actionButton("Delete", "delete-image", item.id, "outline-danger")); actions.append(group);
    imagesBody.append(row);
  }
  document.querySelector("#images-empty").hidden = draft.images.length !== 0;
  document.querySelector("#add-image").disabled = draft.tasks.length === 0;
  document.querySelector("#image-count").textContent = draft.images.length;
}

function renderCustomCsses() {
  cssBody.replaceChildren();
  for (const entry of draft.customCsses) {
    const row = document.createElement("tr");
    const name = document.createElement("strong"); name.textContent = entry.id; row.insertCell().append(name);
    const users = draft.tasks.filter((task) => task.customCssIds?.includes(entry.id)).map((task) => task.id);
    row.insertCell().textContent = users.length ? users.join(", ") : "Not used";
    const previewCell = row.insertCell(); const previewText = document.createElement("code");
    previewText.className = "css-preview"; previewText.textContent = entry.css.trim() || "Empty"; previewCell.append(previewText);
    const actions = row.insertCell(); actions.className = "text-end text-nowrap";
    const group = document.createElement("div"); group.className = "btn-group";
    group.append(actionButton("Edit", "edit-css", entry.id), actionButton("Delete", "delete-css", entry.id, "outline-danger"));
    actions.append(group); cssBody.append(row);
  }
  document.querySelector("#css-table").hidden = draft.customCsses.length === 0;
  document.querySelector("#css-empty").hidden = draft.customCsses.length !== 0;
  document.querySelector("#css-count").textContent = draft.customCsses.length;
}

function render() { renderTasks(); renderCustomCsses(); renderImages(); }

function customCssOptions(selected = []) {
  const select = taskForm.elements.customCssIds;
  select.replaceChildren();
  for (const entry of draft.customCsses) {
    const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.id;
    option.selected = selected.includes(entry.id); select.append(option);
  }
}

function setTaskForm(task) {
  for (const [name, value] of Object.entries({ ...taskDefaults, ...task })) {
    const input = taskForm.elements[name];
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
  }
  customCssOptions(task.customCssIds || []);
  const processing = { ...taskDefaults.imageProcessing, ...task.imageProcessing };
  taskForm.elements.imageProcessingMode.value = processing.mode;
  taskForm.elements.imageProcessingDither.value = processing.dither;
  taskForm.elements.imageProcessingThreshold.value = processing.threshold;
  taskForm.elements.imageProcessingRotation.value = processing.rotation;
  taskForm.elements.imageProcessingInvert.checked = processing.invert;
  updateDitherAvailability();
  document.querySelector("#task-error").hidden = true;
}

function readTask() {
  if (!taskForm.reportValidity()) throw new Error("Correct the highlighted task fields.");
  return {
    id: taskForm.elements.id.value.trim(), dashboardPath: taskForm.elements.dashboardPath.value.trim(),
    width: Number(taskForm.elements.width.value), height: Number(taskForm.elements.height.value),
    refreshIntervalSeconds: Number(taskForm.elements.refreshIntervalSeconds.value),
    maximumImageAgeSeconds: Number(taskForm.elements.maximumImageAgeSeconds.value),
    waitAfterLoadMs: Number(taskForm.elements.waitAfterLoadMs.value), colorScheme: taskForm.elements.colorScheme.value,
    timezone: taskForm.elements.timezone.value.trim(), disableAnimations: taskForm.elements.disableAnimations.checked,
    zoom: Number(taskForm.elements.zoom.value), format: taskForm.elements.format.value,
    jpegQuality: Number(taskForm.elements.jpegQuality.value), navigationTimeoutMs: Number(taskForm.elements.navigationTimeoutMs.value),
    waitForSelector: taskForm.elements.waitForSelector.value.trim(), customCss: taskForm.elements.customCss.value,
    customCssFile: taskForm.elements.customCssFile.value.trim(), hideCursor: taskForm.elements.hideCursor.checked,
    customCssIds: [...taskForm.elements.customCssIds.selectedOptions].map((option) => option.value),
    outputFilename: taskForm.elements.outputFilename.value.trim(),
    imageProcessing: {
      mode: taskForm.elements.imageProcessingMode.value, palette: [],
      dither: taskForm.elements.imageProcessingDither.value,
      threshold: Number(taskForm.elements.imageProcessingThreshold.value),
      invert: taskForm.elements.imageProcessingInvert.checked,
      rotation: Number(taskForm.elements.imageProcessingRotation.value),
    },
  };
}

function updateDitherAvailability() {
  const monochrome = taskForm.elements.imageProcessingMode.value === "monochrome";
  taskForm.elements.imageProcessingDither.disabled = !monochrome;
  taskForm.elements.imageProcessingThreshold.disabled = !monochrome;
  if (!monochrome) taskForm.elements.imageProcessingDither.value = "none";
}

function taskOptions(select, selected) {
  select.replaceChildren();
  for (const task of draft.tasks) {
    const option = document.createElement("option");
    option.value = task.id; option.textContent = `${task.id} (${task.width}×${task.height} ${task.format.toUpperCase()})`;
    option.selected = task.id === selected;
    select.append(option);
  }
}

function addSlot(slot = { days: ["mon", "tue", "wed", "thu", "fri"], start: "06:00", end: "09:00", taskId: draft.tasks[0]?.id }) {
  const row = document.querySelector("#slot-template").content.firstElementChild.cloneNode(true);
  const picker = row.querySelector(".weekday-picker");
  for (const day of weekdays) {
    const label = document.createElement("label"); label.className = "form-check form-check-inline mb-0 me-2";
    const input = document.createElement("input"); input.type = "checkbox"; input.className = "form-check-input"; input.name = "day"; input.value = day; input.checked = slot.days.includes(day);
    label.append(input, document.createTextNode(day[0].toUpperCase() + day.slice(1)));
    picker.append(label);
  }
  row.querySelector('[name="start"]').value = slot.start;
  row.querySelector('[name="end"]').value = slot.end;
  taskOptions(row.querySelector('[name="taskId"]'), slot.taskId);
  row.querySelector(".remove-slot").addEventListener("click", () => { row.remove(); updateSlotsEmpty(); });
  document.querySelector("#slots").append(row);
  updateSlotsEmpty();
}

function updateSlotsEmpty() { document.querySelector("#slots-empty").hidden = document.querySelector("#slots").children.length !== 0; }

function openImageEditor(item, index) {
  editingImage = index;
  imageForm.elements.id.value = item.id;
  taskOptions(imageForm.elements.fallbackTaskId, item.fallbackTaskId);
  document.querySelector("#image-timezone").value = timezone;
  document.querySelector("#image-error").hidden = true;
  document.querySelector("#slots").replaceChildren();
  item.slots.forEach(addSlot);
  updateSlotsEmpty();
  imageModal.show();
}

function readSlots() {
  return [...document.querySelector("#slots").children].map((row) => ({
    days: [...row.querySelectorAll('[name="day"]:checked')].map((input) => input.value),
    start: row.querySelector('[name="start"]').value,
    end: row.querySelector('[name="end"]').value,
    taskId: row.querySelector('[name="taskId"]').value,
  }));
}

function minute(value) { const [hour, part] = value.split(":").map(Number); return hour * 60 + part; }
function validateImage(image) {
  if (!imageForm.reportValidity()) throw new Error("Correct the highlighted image fields.");
  if (draft.images.some((other, index) => index !== editingImage && other.id === image.id)) throw new Error(`Image ID ${image.id} already exists.`);
  const fallback = draft.tasks.find((task) => task.id === image.fallbackTaskId);
  const segments = [];
  image.slots.forEach((slot, slotIndex) => {
    if (!slot.days.length) throw new Error(`Range ${slotIndex + 1} needs at least one weekday.`);
    if (!slot.start || !slot.end || slot.start === slot.end) throw new Error(`Range ${slotIndex + 1} needs different start and end times.`);
    const task = draft.tasks.find((candidate) => candidate.id === slot.taskId);
    if (!task || task.width !== fallback.width || task.height !== fallback.height || task.format !== fallback.format) throw new Error(`Task ${slot.taskId} must match fallback dimensions and format.`);
    for (const day of slot.days) {
      const start = dayIndex[day] * 1440 + minute(slot.start);
      const end = dayIndex[day] * 1440 + minute(slot.end) + (minute(slot.end) < minute(slot.start) ? 1440 : 0);
      if (end <= 10080) segments.push({ start, end, slotIndex });
      else { segments.push({ start, end: 10080, slotIndex }); segments.push({ start: 0, end: end - 10080, slotIndex }); }
    }
  });
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start < segments[index - 1].end) throw new Error(`Ranges ${segments[index - 1].slotIndex + 1} and ${segments[index].slotIndex + 1} overlap.`);
  }
}

tasksBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const index = draft.tasks.findIndex((task) => task.id === button.dataset.id);
  if (button.dataset.action === "edit-task") { editingTask = index; setTaskForm(draft.tasks[index]); taskModal.show(); }
  if (button.dataset.action === "delete-task") {
    if (draft.tasks.length === 1) return showNotice("At least one capture task is required.");
    const referenced = draft.images.find((image) => image.fallbackTaskId === button.dataset.id || image.slots.some((slot) => slot.taskId === button.dataset.id));
    if (referenced) return showNotice(`Task ${button.dataset.id} is used by image URL ${referenced.id}. Edit or delete that image URL first.`);
    draft.tasks.splice(index, 1); markDirty(); render();
  }
  if (button.dataset.action === "capture") {
    if (dirty) return showNotice("Save your changes before starting a capture.");
    button.disabled = true;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(button.dataset.id)}/capture`, { method: "POST", headers: { "X-Requested-With": "ha-screenshot" } });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Capture could not be started");
      showNotice(`Capture started for ${button.dataset.id}.`, "success"); setTimeout(loadConfiguration, 1200);
    } catch (error) { showNotice(error.message); } finally { button.disabled = false; }
  }
});

imagesBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const index = draft.images.findIndex((image) => image.id === button.dataset.id);
  if (button.dataset.action === "edit-image") openImageEditor(draft.images[index], index);
  if (button.dataset.action === "delete-image") { draft.images.splice(index, 1); markDirty(); render(); }
});

cssBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const index = draft.customCsses.findIndex((entry) => entry.id === button.dataset.id);
  if (button.dataset.action === "edit-css") {
    editingCss = index;
    cssForm.elements.id.value = draft.customCsses[index].id;
    cssForm.elements.css.value = draft.customCsses[index].css;
    document.querySelector("#css-error").hidden = true;
    cssModal.show();
  }
  if (button.dataset.action === "delete-css") {
    const user = draft.tasks.find((task) => task.customCssIds?.includes(button.dataset.id));
    if (user) return showNotice(`Custom CSS ${button.dataset.id} is used by task ${user.id}. Remove it from that task first.`);
    draft.customCsses.splice(index, 1); markDirty(); render();
  }
});

document.querySelector("#add-task").addEventListener("click", () => {
  openNewTask();
});
function openNewTask() {
  const id = uniqueId("new-task", new Set(draft.tasks.map((task) => task.id)));
  editingTask = -1; setTaskForm({ ...taskDefaults, id, outputFilename: `${id}.png` }); taskModal.show();
}
document.querySelector("#empty-add-task").addEventListener("click", openNewTask);
document.querySelector("#setup-add-task").addEventListener("click", openNewTask);
document.querySelector("#add-css").addEventListener("click", () => {
  editingCss = -1;
  cssForm.elements.id.value = uniqueId("custom-css", new Set(draft.customCsses.map((entry) => entry.id)));
  cssForm.elements.css.value = "";
  document.querySelector("#css-error").hidden = true;
  cssModal.show();
});
document.querySelector("#add-image").addEventListener("click", () => {
  if (!draft.tasks.length) return showNotice("Add a capture task before creating an image URL.");
  const id = uniqueId("new-image", new Set(draft.images.map((image) => image.id)));
  openImageEditor({ id, fallbackTaskId: draft.tasks[0].id, slots: [] }, -1);
});
document.querySelector("#add-slot").addEventListener("click", () => addSlot());

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const task = readTask();
    if (draft.tasks.some((other, index) => index !== editingTask && other.id === task.id)) throw new Error(`Task ID ${task.id} already exists.`);
    if (draft.tasks.some((other, index) => index !== editingTask && other.outputFilename === task.outputFilename)) throw new Error(`Output filename ${task.outputFilename} already exists.`);
    const oldId = editingTask < 0 ? null : draft.tasks[editingTask].id;
    const candidateTasks = draft.tasks.map((current, index) => index === editingTask ? { ...current, ...task } : current);
    if (editingTask < 0) candidateTasks.push(task);
    const candidateImages = draft.images.map((image) => ({
      ...image,
      fallbackTaskId: image.fallbackTaskId === oldId ? task.id : image.fallbackTaskId,
      slots: image.slots.map((slot) => ({ ...slot, taskId: slot.taskId === oldId ? task.id : slot.taskId })),
    }));
    for (const image of candidateImages) {
      const fallback = candidateTasks.find((candidate) => candidate.id === image.fallbackTaskId);
      for (const taskId of new Set(image.slots.map((slot) => slot.taskId))) {
        const selected = candidateTasks.find((candidate) => candidate.id === taskId);
        if (!selected || selected.width !== fallback.width || selected.height !== fallback.height || selected.format !== fallback.format) {
          throw new Error(`This change would make task ${taskId} incompatible with image URL ${image.id}.`);
        }
      }
    }
    draft.tasks = candidateTasks;
    draft.images = candidateImages;
    markDirty(); render(); taskModal.hide();
  } catch (error) { showFormError(document.querySelector("#task-error"), error.message); }
});

taskForm.elements.imageProcessingMode.addEventListener("change", updateDitherAvailability);

cssForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    if (!cssForm.reportValidity()) throw new Error("Correct the highlighted custom CSS fields.");
    const entry = { id: cssForm.elements.id.value.trim(), css: cssForm.elements.css.value };
    if (draft.customCsses.some((other, index) => index !== editingCss && other.id === entry.id)) {
      throw new Error(`Custom CSS ID ${entry.id} already exists.`);
    }
    const oldId = editingCss < 0 ? null : draft.customCsses[editingCss].id;
    if (editingCss < 0) draft.customCsses.push(entry); else draft.customCsses[editingCss] = entry;
    if (oldId && oldId !== entry.id) {
      draft.tasks = draft.tasks.map((task) => ({
        ...task,
        customCssIds: (task.customCssIds || []).map((id) => id === oldId ? entry.id : id),
      }));
    }
    markDirty(); render(); cssModal.hide();
  } catch (error) { showFormError(document.querySelector("#css-error"), error.message); }
});

imageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const image = { id: imageForm.elements.id.value.trim(), fallbackTaskId: imageForm.elements.fallbackTaskId.value, slots: readSlots() };
    validateImage(image);
    if (editingImage < 0) draft.images.push(image); else draft.images[editingImage] = { ...draft.images[editingImage], ...image };
    markDirty(); render(); imageModal.hide();
  } catch (error) { showFormError(document.querySelector("#image-error"), error.message); }
});

async function loadConfiguration() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load configuration");
    const body = await response.json();
    applyConfiguration(body);
    if (body.setupRequired) bootstrap.Tab.getOrCreateInstance(document.querySelector("#settings-tab")).show();
  } catch (error) { showNotice(error.message); }
}

function applyConfiguration(body) {
  timezone = body.settings.imageScheduleTimezone;
  draft = { settings: body.settings, customCsses: body.customCsses || [], tasks: body.tasks, images: body.images };
  settingsForm.elements.haUrl.value = body.settings.haUrl || "";
  settingsForm.elements.imageScheduleTimezone.value = timezone;
  settingsForm.elements.configUsername.value = body.settings.configUsername || "admin";
  settingsForm.elements.accessToken.value = "";
  settingsForm.elements.configPassword.value = "";
  settingsForm.elements.accessToken.required = !body.settings.accessTokenConfigured;
  settingsForm.elements.configPassword.required = !body.settings.configPasswordConfigured;
  settingsForm.elements.accessToken.placeholder = body.settings.accessTokenConfigured ? "Leave blank to keep the current token" : "Paste a long-lived access token";
  settingsForm.elements.configPassword.placeholder = body.settings.configPasswordConfigured ? "Leave blank to keep the current password" : "At least 12 characters";
  document.querySelector("#setup-notice").hidden = !body.setupRequired;
  document.querySelector("#schedule-timezone").textContent = timezone;
  render(); markSaved();
}

settingsForm.addEventListener("input", markDirty);

saveButton.addEventListener("click", async () => {
  notice.hidden = true; saveButton.disabled = true; saveButton.textContent = "Saving…";
  try {
    if (!settingsForm.reportValidity()) throw new Error("Complete the required service settings.");
    if (!draft.tasks.length) throw new Error("Add at least one capture task before saving.");
    const settings = {
      haUrl: settingsForm.elements.haUrl.value.trim(),
      accessToken: settingsForm.elements.accessToken.value.trim() || undefined,
      imageScheduleTimezone: settingsForm.elements.imageScheduleTimezone.value.trim(),
      configUsername: settingsForm.elements.configUsername.value.trim(),
      configPassword: settingsForm.elements.configPassword.value || undefined,
    };
    const credentialsChanged = Boolean(settings.configPassword)
      || settings.configUsername !== draft.settings.configUsername;
    const tasks = draft.tasks.map(({ status, imageUrl, ...task }) => task);
    const customCsses = draft.customCsses.map((entry) => ({ ...entry }));
    const images = draft.images.map(({ status, imageUrl, activeTaskId, width, height, format, ...image }) => image);
    const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json", "X-Requested-With": "ha-screenshot" }, body: JSON.stringify({ settings, customCsses, tasks, images }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || "Configuration could not be saved");
    applyConfiguration(body);
    if (credentialsChanged) {
      window.location.assign("/admin/");
      return;
    }
    showNotice("Configuration saved and applied.", "success");
  } catch (error) { showNotice(error.message); } finally { saveButton.disabled = false; saveButton.textContent = "Save & apply"; }
});

window.addEventListener("beforeunload", (event) => { if (dirty) event.preventDefault(); });
loadConfiguration();
setInterval(() => { if (!dirty) void loadConfiguration(); }, 10000);
