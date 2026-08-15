const imagesElement = document.querySelector("#images");
const tasksElement = document.querySelector("#tasks");
const summary = document.querySelector("#summary");
const updated = document.querySelector("#updated");

function intervalLabel(seconds) {
  if (seconds === 0) return "Startup only";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = "badge";
  if (status.stale) { badge.classList.add("text-bg-danger"); badge.textContent = "Stale"; }
  else if (status.lastError) { badge.classList.add("text-bg-danger"); badge.textContent = "Error"; }
  else if (status.capturing) { badge.classList.add("text-bg-warning"); badge.textContent = "Capturing"; }
  else if (status.ready) { badge.classList.add("text-bg-success"); badge.textContent = "Ready"; }
  else { badge.classList.add("text-bg-secondary"); badge.textContent = "Starting"; }
  return badge;
}

function detail(label, value) {
  const wrapper = document.createElement("div"); wrapper.className = "col";
  const term = document.createElement("div"); term.className = "text-body-secondary text-uppercase small"; term.textContent = label;
  const description = document.createElement("div"); description.className = "small fw-semibold"; description.textContent = value;
  wrapper.append(term, description); return wrapper;
}

function card(item, scheduled) {
  const column = document.createElement("div"); column.className = "col-12 col-lg-6";
  const article = document.createElement("article"); article.className = "card h-100 shadow-sm";
  const target = document.createElement("a"); target.href = item.imageUrl; target.target = "_blank"; target.rel = "noreferrer"; target.className = "border-bottom text-decoration-none";
  if (item.status.imageAvailable) {
    const image = document.createElement("img"); image.className = "card-img-top preview-card"; image.alt = `${item.id} dashboard image`; image.src = `${item.imageUrl}?gallery=${Date.now()}`; target.append(image);
  } else {
    const placeholder = document.createElement("div"); placeholder.className = "preview-card d-flex align-items-center justify-content-center text-body-secondary"; placeholder.textContent = "Waiting for first capture"; target.append(placeholder);
  }
  const body = document.createElement("div"); body.className = "card-body";
  const heading = document.createElement("div"); heading.className = "d-flex justify-content-between align-items-center gap-3 mb-3";
  const title = document.createElement("h3"); title.className = "h5 mb-0"; title.textContent = item.id; heading.append(title, statusBadge(item.status));
  const details = document.createElement("div"); details.className = "row row-cols-2 row-cols-sm-3 g-3 mb-3";
  details.append(detail("Resolution", `${item.width} × ${item.height}`), detail("Format", item.format.toUpperCase()));
  if (scheduled) details.append(detail("Active task", item.activeTaskId));
  else details.append(detail("Refresh", intervalLabel(item.refreshIntervalSeconds)));
  const urls = scheduled ? item.imageUrls : [item.imageUrl];
  const links = document.createElement("div");
  for (const imageUrl of urls) {
    const url = document.createElement("a"); url.href = imageUrl; url.target = "_blank"; url.rel = "noreferrer"; url.className = "font-monospace small text-decoration-none url-text d-block"; url.textContent = imageUrl; links.append(url);
  }
  body.append(heading, details, links); article.append(target, body); column.append(article); return column;
}

async function loadGallery() {
  try {
    const response = await fetch("/api/gallery", { cache: "no-store" });
    if (!response.ok) throw new Error("Gallery is unavailable");
    const body = await response.json();
    imagesElement.replaceChildren(...body.images.map((item) => card(item, true)));
    tasksElement.replaceChildren(...body.tasks.map((item) => card(item, false)));
    document.querySelector("#images-empty").hidden = body.images.length !== 0;
    document.querySelector("#timezone").textContent = `Weekly timezone: ${body.timezone}`;
    const all = [...body.images, ...body.tasks];
    const empty = all.length === 0;
    const setupRequired = Boolean(body.setupRequired);
    document.querySelector("#gallery-empty").hidden = !empty;
    document.querySelector("#gallery-content").hidden = empty;
    document.querySelector("#gallery-empty-heading").textContent = setupRequired ? "Set up your first dashboard image" : "No dashboard images configured";
    document.querySelector("#gallery-empty-copy").textContent = setupRequired
      ? "Connect Home Assistant and add a capture task. Your public image URLs will appear here after the first capture."
      : "The service is configured and idle. Add a capture task whenever you want to publish an image.";
    document.querySelector("#gallery-empty-action").textContent = setupRequired ? "Open settings" : "Open admin";
    summary.textContent = setupRequired ? "Setup required" : empty ? "No images configured" : `${all.filter((item) => item.status.ready).length} of ${all.length} images ready`;
    updated.textContent = empty ? "" : `Updated ${new Date().toLocaleTimeString()}`;
    document.querySelector("#error").hidden = true;
  } catch (error) {
    const element = document.querySelector("#error"); element.textContent = error.message; element.hidden = false;
    summary.textContent = "Unavailable"; updated.textContent = "";
  }
}

loadGallery();
setInterval(loadGallery, 15000);
