# Changelog

## 0.3.0

- Let each scheduled image feed own multiple ordered, movable public URL IDs while keeping one shared schedule and task selection.
- Group a feed's URLs in the editor, gallery, health metadata, and configuration APIs.
- Add complete ESPHome and Arduino four-gray reference configurations for the Seeed Studio TRMNL 7.5-inch DIY Kit.

## 0.2.1

- Queue concurrent Chromium screenshot operations to avoid capture-time CSS latency while keeping dashboard loading and image processing independent.

## 0.2.0

- Add configurable 2–256-level grayscale output, including standard four-level grayscale.
- Support deterministic Floyd–Steinberg and Atkinson dithering for reduced grayscale images.
- Write four-level PNG captures as indexed two-bit images while preserving exact configured output dimensions.

## 0.1.0

- Add Home Assistant App packaging and Supervisor ingress administration.
- Keep unauthenticated public screenshot routes on port 3000.
- Share the same capture, scheduler, persistence, and validation code with the standalone container.
