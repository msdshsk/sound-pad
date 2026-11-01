// @otoiro/ui — built from https://github.com/msdshsk/otoiro at 7861f66bc25a8179789974f4e10f8aed2492035b (MIT).
// Regenerate: in the otoiro repo run `npm run build -w packages/ui` and copy packages/ui/dist/otoiro-ui.js here.
// ../../node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
function __classPrivateFieldGet(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
	if (kind === "m") throw new TypeError("Private method is not writable");
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
	return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
// ../../node_modules/@tauri-apps/api/core.js
var _Channel_instances;
var _Channel_onmessage;
var _Channel_nextMessageIndex;
var _Channel_pendingMessages;
var _Channel_messageEndIndex;
var _Channel_deliver;
/**
* Invoke your custom commands.
*
* This package is also accessible with `window.__TAURI__.core` when [`app.withGlobalTauri`](https://v2.tauri.app/reference/config/#withglobaltauri) in `tauri.conf.json` is set to `true`.
* @module
*/
/**
* A key to be used to implement a special function
* on your types that define how your type should be serialized
* when passing across the IPC.
* @example
* Given a type in Rust that looks like this
* ```rs
* #[derive(serde::Serialize, serde::Deserialize)
* enum UserId {
*   String(String),
*   Number(u32),
* }
* ```
* `UserId::String("id")` would be serialized into `{ String: "id" }`
* and so we need to pass the same structure back to Rust
* ```ts
* import { SERIALIZE_TO_IPC_FN } from "@tauri-apps/api/core"
*
* class UserIdString {
*   id
*   constructor(id) {
*     this.id = id
*   }
*
*   [SERIALIZE_TO_IPC_FN]() {
*     return { String: this.id }
*   }
* }
*
* class UserIdNumber {
*   id
*   constructor(id) {
*     this.id = id
*   }
*
*   [SERIALIZE_TO_IPC_FN]() {
*     return { Number: this.id }
*   }
* }
*
* type UserId = UserIdString | UserIdNumber
* ```
*
*/
var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
/**
* Stores the callback in a known location, and returns an identifier that can be passed to the backend.
* The backend uses the identifier to `eval()` the callback.
*
* @return An unique identifier associated with the callback function.
*
* @since 1.0.0
*/
function transformCallback(callback, once = false) {
	return window.__TAURI_INTERNALS__.transformCallback(callback, once);
}
/**
* A message channel used to stream values from Rust to the frontend.
*
* A `Channel` is the JavaScript counterpart of [`tauri::ipc::Channel`](https://docs.rs/tauri/2/tauri/ipc/struct.Channel.html).
* Pass an instance as a command argument and the Rust command can declare a
* `tauri::ipc::Channel<T>` parameter with the same name; every value sent from
* Rust is then delivered to {@linkcode Channel.onmessage}. Messages are delivered
* in the order they were sent, even when they arrive out of order.
*
* The channel stays alive until the Rust `Channel` is dropped, so it can be used
* for long-running work such as download progress or log streaming.
*
* Raw byte payloads are delivered to the frontend as an `ArrayBuffer` rather than
* a JSON value, so declare the channel as `Channel<ArrayBuffer>` when the Rust
* side sends `tauri::ipc::InvokeResponseBody::Raw` — for example through a
* `Channel<tauri::ipc::Response>` whose values are built with
* `tauri::ipc::Response::new(bytes)`.
*
* @example
* ```typescript
* import { Channel, invoke } from '@tauri-apps/api/core';
*
* const onEvent = new Channel<string>();
* onEvent.onmessage = (message) => {
*   console.log(`got download event ${message}`);
* };
*
* await invoke('download', { url: 'https://tauri.app', onEvent });
* ```
*
* The matching Rust command:
* ```rust
* #[tauri::command]
* async fn download(url: String, on_event: tauri::ipc::Channel<String>) -> tauri::Result<()> {
*   on_event.send("started".to_string())?;
*   on_event.send("finished".to_string())?;
*   Ok(())
* }
* ```
*
* @since 2.0.0
*/
var Channel = class {
	constructor(onmessage) {
		_Channel_instances.add(this);
		_Channel_onmessage.set(this, void 0);
		_Channel_nextMessageIndex.set(this, 0);
		_Channel_pendingMessages.set(this, []);
		_Channel_messageEndIndex.set(this, void 0);
		__classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {}), "f");
		this.id = transformCallback((rawMessage) => {
			const index = rawMessage.index;
			if ("end" in rawMessage) {
				if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) this.cleanupCallback();
				else __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
				return;
			}
			const message = rawMessage.message;
			if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
				__classPrivateFieldGet(this, _Channel_instances, "m", _Channel_deliver).call(this, message);
				__classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
				while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
					const message = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
					__classPrivateFieldGet(this, _Channel_instances, "m", _Channel_deliver).call(this, message);
					delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
					__classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
				}
				if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) this.cleanupCallback();
			} else __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
		});
	}
	cleanupCallback() {
		window.__TAURI_INTERNALS__.unregisterCallback(this.id);
	}
	/**
	* The handler called for every message sent by the Rust side of this channel.
	*
	* Assigning a new handler replaces the previous one; messages that arrived
	* before a handler was set are not replayed, so set it (or pass it to the
	* constructor) before sending the channel to the backend.
	*/
	set onmessage(handler) {
		__classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
	}
	get onmessage() {
		return __classPrivateFieldGet(this, _Channel_onmessage, "f");
	}
	[(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), _Channel_instances = /* @__PURE__ */ new WeakSet(), _Channel_deliver = function _Channel_deliver(message) {
		try {
			__classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}, SERIALIZE_TO_IPC_FN)]() {
		return `__CHANNEL__:${this.id}`;
	}
	toJSON() {
		return this[SERIALIZE_TO_IPC_FN]();
	}
};
/**
* Sends a message to the backend.
* @example
* ```typescript
* import { invoke } from '@tauri-apps/api/core';
* await invoke('login', { user: 'tauri', password: 'poiwe3h4r5ip3yrhtew9ty' });
* ```
*
* @param cmd The command name.
* @param args The optional arguments to pass to the command.
* @param options The request options.
* @return A promise resolving or rejecting to the backend response.
*
* @since 1.0.0
*/
async function invoke(cmd, args = {}, options) {
	return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
}
// src/player.ts
var IDLE = {
	state: "idle",
	position: 0,
	duration: null,
	path: null,
	volume: .5
};
var cmd = (name, args) => invoke(`plugin:otoiro|${name}`, args);
/**
* Client for `tauri-plugin-otoiro`.
*
* The backend pushes a snapshot on every state change (plus a slow heartbeat while playing).
* Between snapshots, `position()` extrapolates locally, so widgets can redraw every frame
* without any IPC traffic.
*/
var Player = class Player {
	#snapshot = IDLE;
	#anchor = performance.now();
	#listeners = /* @__PURE__ */ new Set();
	constructor() {}
	static async connect() {
		const player = new Player();
		const channel = new Channel();
		channel.onmessage = (event) => player.#receive(event);
		player.#setSnapshot(await cmd("subscribe", { onEvent: channel }));
		return player;
	}
	get snapshot() {
		return this.#snapshot;
	}
	get state() {
		return this.#snapshot.state;
	}
	get duration() {
		return this.#snapshot.duration;
	}
	/** Current audible position, extrapolated from the last snapshot. */
	position(now = performance.now()) {
		const s = this.#snapshot;
		if (s.state !== "playing") return s.position;
		const p = s.position + (now - this.#anchor) / 1e3;
		return s.duration == null ? p : Math.min(p, s.duration);
	}
	on(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	load(path, autoplay = true) {
		return cmd("load", {
			path,
			autoplay
		});
	}
	play() {
		return cmd("play");
	}
	pause() {
		return cmd("pause");
	}
	toggle() {
		return this.state === "playing" ? this.pause() : this.play();
	}
	seek(position) {
		const clamped = this.#clamp(position);
		this.#setSnapshot({
			...this.#snapshot,
			position: clamped
		});
		return cmd("seek", { position: clamped });
	}
	#clamp(position) {
		const duration = this.#snapshot.duration;
		return Math.max(0, duration == null ? position : Math.min(position, duration));
	}
	/**
	* Jumps to `position` and plays a short grain there, leaving playback paused. Call it on
	* every step of a jog/drag gesture for audible scrubbing.
	*/
	scrub(position) {
		const clamped = this.#clamp(position);
		this.#setSnapshot({
			...this.#snapshot,
			state: this.#snapshot.path ? "paused" : this.#snapshot.state,
			position: clamped
		});
		return cmd("scrub", { position: clamped });
	}
	stop() {
		return cmd("stop");
	}
	setVolume(volume) {
		this.#setSnapshot({
			...this.#snapshot,
			volume
		});
		return cmd("set_volume", { volume });
	}
	#receive(event) {
		if (event.type === "snapshot") this.#setSnapshot(event.snapshot);
		for (const listener of this.#listeners) listener(event, this);
	}
	#setSnapshot(snapshot) {
		this.#snapshot = snapshot;
		this.#anchor = performance.now();
	}
};
function formatTime(seconds) {
	if (seconds == null || !Number.isFinite(seconds)) return "--:--";
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor(s % 3600 / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
// src/base.ts
/**
* Shared plumbing for widgets: holds the `player`, runs a rAF loop while connected,
* and forwards engine events.
*/
var PlayerElement = class extends HTMLElement {
	#player = null;
	#unsubscribe = null;
	#raf = 0;
	get player() {
		return this.#player;
	}
	set player(player) {
		this.#unsubscribe?.();
		this.#player = player;
		this.#unsubscribe = player?.on((event) => this.onEvent(event)) ?? null;
		this.render(performance.now());
	}
	connectedCallback() {
		const loop = (now) => {
			this.render(now);
			this.#raf = requestAnimationFrame(loop);
		};
		this.#raf = requestAnimationFrame(loop);
	}
	disconnectedCallback() {
		cancelAnimationFrame(this.#raf);
	}
	onEvent(_event) {}
};
// src/seekbar.ts
var KEY_STEP = 5;
var DEFAULT_MARKER_LABELS = {
	chorus: "Chorus (estimated)",
	vocalStart: "Vocals start (estimated)"
};
var template$2 = document.createElement("template");
template$2.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #7c5cff);
    --_accent-2: var(--oto-accent-2, #22d3ee);
    --_track: var(--oto-track, rgb(255 255 255 / 0.14));
    --_text: var(--oto-text, #f5f5f7);
    --_bubble: var(--oto-bubble, rgb(20 20 28 / 0.92));
    display: block;
    position: relative;
    height: 28px;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    outline: none;
  }
  .rail {
    position: absolute;
    inset: 50% 0 auto 0;
    height: 4px;
    translate: 0 -50%;
    border-radius: 999px;
    background: var(--_track);
    overflow: hidden;
    transition: height 160ms cubic-bezier(.2,.8,.2,1);
  }
  :host(:hover) .rail, :host([dragging]) .rail, :host(:focus-visible) .rail { height: 8px; }
  .fill, .hover-fill {
    position: absolute;
    inset: 0;
    transform-origin: left center;
    transform: scaleX(0);
  }
  .fill {
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    box-shadow: 0 0 12px color-mix(in srgb, var(--_accent) 60%, transparent);
  }
  .hover-fill {
    background: rgb(255 255 255 / 0.12);
    opacity: 0;
    transition: opacity 120ms;
  }
  :host(:hover) .hover-fill { opacity: 1; }
  .thumb {
    position: absolute;
    top: 50%;
    left: 0;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--_accent) 35%, transparent), 0 2px 8px rgb(0 0 0 / 0.4);
    scale: 0;
    transition: scale 160ms cubic-bezier(.3,1.6,.5,1);
    pointer-events: none;
  }
  :host(:hover) .thumb, :host(:focus-visible) .thumb { scale: 1; }
  :host([dragging]) .thumb { scale: 1.25; }
  .bubble {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    translate: -50% 4px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--_bubble);
    color: var(--_text);
    font: 600 12px/1.4 ui-monospace, "Cascadia Mono", monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms, translate 160ms cubic-bezier(.2,.8,.2,1);
  }
  :host(:hover) .bubble, :host([dragging]) .bubble { opacity: 1; translate: -50% 0; }
  .delta { margin-left: 6px; opacity: 0.6; font-weight: 400; }

  /* Waveform mode */
  :host([has-waveform]) { height: var(--oto-wave-height, 72px); }
  .wave {
    position: absolute;
    inset: 0;
    display: none;
    transform-origin: center;
    transform: scaleY(0);
    transition: transform 520ms cubic-bezier(.2,.9,.25,1.15);
  }
  :host([has-waveform]) .wave { display: block; }
  :host([wave-ready]) .wave { transform: scaleY(1); }
  :host([has-waveform]) .rail, :host([has-waveform]) .thumb { display: none; }
  .layer {
    position: absolute;
    inset: 0;
    -webkit-mask: var(--_mask) 0 0 / 100% 100% no-repeat;
    mask: var(--_mask) 0 0 / 100% 100% no-repeat;
  }
  .layer.base { background: var(--oto-wave, rgb(255 255 255 / 0.22)); }
  .layer.hover { background: rgb(255 255 255 / 0.4); opacity: 0; transition: opacity 120ms; }
  :host(:hover) .layer.hover { opacity: 1; }
  .layer.played {
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--_accent) 55%, transparent));
  }
  .marks { position: absolute; inset: 0; pointer-events: none; }
  .boundary {
    position: absolute;
    top: 2px;
    bottom: 2px;
    width: 1px;
    background: rgb(255 255 255 / 0.28);
  }
  .boundary::before {
    content: "";
    position: absolute;
    top: -2px;
    left: -2px;
    width: 5px;
    height: 3px;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.55);
  }
  .highlight-band {
    position: absolute;
    top: 0;
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--_accent), var(--_accent-2));
    opacity: 0.85;
  }
  .highlight-badge {
    position: absolute;
    top: -9px;
    translate: -50% 0;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--_accent);
    color: var(--oto-on-accent, var(--oto-base, #111118));
    font: 700 11px/1 system-ui, sans-serif;
    box-shadow: 0 0 10px color-mix(in srgb, var(--_accent) 70%, transparent);
    cursor: pointer;
    pointer-events: auto;
    transition: scale 140ms cubic-bezier(.3,1.6,.5,1);
  }
  .highlight-badge:hover { scale: 1.2; }
  .vocal-band {
    position: absolute;
    bottom: 0;
    height: 2px;
    border-radius: 1px;
    background: rgb(255 255 255 / 0.55);
  }
  .vocal-badge {
    position: absolute;
    bottom: -8px;
    translate: -50% 0;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.6);
    border-radius: 50%;
    background: rgb(20 20 28 / 0.9);
    color: #fff;
    font: 700 10px/1 system-ui, sans-serif;
    cursor: pointer;
    pointer-events: auto;
    transition: scale 140ms cubic-bezier(.3,1.6,.5,1);
  }
  .vocal-badge:hover { scale: 1.2; }
  .playhead {
    position: absolute;
    top: -4px;
    bottom: -4px;
    left: -1px;
    width: 2px;
    border-radius: 1px;
    background: #fff;
    box-shadow: 0 0 10px color-mix(in srgb, var(--_accent) 80%, white);
    pointer-events: none;
  }
</style>
<div class="wave" part="wave">
  <div class="layer base"></div>
  <div class="layer hover"></div>
  <div class="layer played"></div>
  <div class="marks" part="marks"></div>
  <div class="playhead" part="playhead"></div>
</div>
<div class="rail" part="rail">
  <div class="hover-fill" part="hover-fill"></div>
  <div class="fill" part="fill"></div>
</div>
<div class="thumb" part="thumb"></div>
<div class="bubble" part="bubble"><span class="time"></span><span class="delta"></span></div>
`;
/**
* `<oto-seekbar>`: a scrubbable timeline driven by `Player.position()` every frame.
*
* - Hover shows the time under the cursor.
* - Dragging previews the target (with the offset from the current position) and seeks on
*   release; Escape cancels.
* - Keyboard: ←/→ ±5s, Home/End, PageUp/PageDown previous/next section.
* - With waveform analysis, section boundaries are marked, every chorus candidate gets a ★
*   badge and band, and (unless `showVocals` is off) sung stretches get a line along the
*   bottom with a ♪ badge at the vocal entry. `markerLabels` sets the tooltips.
*
* Set `waveform` to switch from a thin rail to a waveform timeline (played part in the accent
* gradient, hovered part highlighted, glowing playhead).
*
* Styling: `--oto-accent`, `--oto-accent-2`, `--oto-track`, `--oto-wave`, `--oto-wave-height`,
* `--oto-text`, `--oto-bubble`, and `::part(rail|fill|hover-fill|thumb|bubble|wave|playhead)`.
*/
var OtoSeekbar = class extends PlayerElement {
	#fill;
	#hoverFill;
	#thumb;
	#bubble;
	#bubbleTime;
	#bubbleDelta;
	#wave;
	#waveHover;
	#wavePlayed;
	#playhead;
	#marks;
	#waveform = null;
	#maskUrl = null;
	#maskWidth = 0;
	#maskJob = 0;
	#resizeObserver = new ResizeObserver(() => this.#scheduleMask());
	#hoverRatio = null;
	#dragRatio = null;
	#pointerId = null;
	#ariaText = "";
	#markerLabels = DEFAULT_MARKER_LABELS;
	#showVocals = true;
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.append(template$2.content.cloneNode(true));
		this.#fill = root.querySelector(".fill");
		this.#hoverFill = root.querySelector(".hover-fill");
		this.#thumb = root.querySelector(".thumb");
		this.#bubble = root.querySelector(".bubble");
		this.#bubbleTime = root.querySelector(".time");
		this.#bubbleDelta = root.querySelector(".delta");
		this.#wave = root.querySelector(".wave");
		this.#waveHover = root.querySelector(".layer.hover");
		this.#wavePlayed = root.querySelector(".layer.played");
		this.#playhead = root.querySelector(".playhead");
		this.#marks = root.querySelector(".marks");
		this.tabIndex = 0;
		this.setAttribute("role", "slider");
		this.setAttribute("aria-label", "Seek");
		this.addEventListener("pointerdown", this.#onPointerDown);
		this.addEventListener("pointermove", this.#onPointerMove);
		this.addEventListener("pointerup", this.#onPointerUp);
		this.addEventListener("pointercancel", this.#cancelDrag);
		this.addEventListener("pointerleave", () => this.#hoverRatio = null);
		this.addEventListener("keydown", this.#onKeyDown);
	}
	get waveform() {
		return this.#waveform;
	}
	/** Waveform for the current track, or null to go back to the plain rail. */
	set waveform(waveform) {
		this.#waveform = waveform;
		this.removeAttribute("wave-ready");
		this.toggleAttribute("has-waveform", waveform != null);
		this.#maskWidth = 0;
		this.#scheduleMask();
		this.#renderMarks();
	}
	/** Section start times (seconds), first one at 0. Empty without waveform data. */
	get sectionStarts() {
		return this.#waveform?.sections.map((s) => s.start) ?? [];
	}
	/** Seeks to the next section boundary after the current position. */
	nextSection() {
		const pos = this.player?.position() ?? 0;
		const next = this.sectionStarts.find((t) => t > pos + .5);
		if (next != null) this.player?.seek(next);
	}
	/** Seeks to the start of the current section, or the previous one when already near it. */
	previousSection() {
		const pos = this.player?.position() ?? 0;
		const prev = this.sectionStarts.filter((t) => t < pos - 1.5).pop();
		this.player?.seek(prev ?? 0);
	}
	/** Overrides marker tooltips (e.g. for localisation). */
	set markerLabels(labels) {
		this.#markerLabels = {
			...DEFAULT_MARKER_LABELS,
			...labels
		};
		this.#renderMarks();
	}
	/** Whether to draw vocal stretches and the vocal-entry marker (default true). */
	get showVocals() {
		return this.#showVocals;
	}
	set showVocals(show) {
		this.#showVocals = show;
		this.#renderMarks();
	}
	/**
	* Chorus candidates (seconds): every detected chorus occurrence, or the single loudness
	* highlight when the track has no recognisable repetition.
	*/
	get highlights() {
		const w = this.#waveform;
		if (!w) return [];
		if (w.choruses.length > 0) return w.choruses.map((c) => c.start);
		return w.highlight != null ? [w.highlight] : [];
	}
	/** Seeks to the next chorus candidate after the current position, wrapping to the first. */
	jumpToHighlight() {
		const all = this.highlights;
		if (all.length === 0) return;
		const pos = this.player?.position() ?? 0;
		this.player?.seek(all.find((t) => t > pos + 1) ?? all[0]);
	}
	/** Seeks to where the singing starts, if known. */
	jumpToVocals() {
		const t = this.#waveform?.vocalStart;
		if (t != null) this.player?.seek(t);
	}
	#renderMarks() {
		const waveform = this.#waveform;
		this.#marks.replaceChildren();
		if (!waveform || waveform.duration <= 0) return;
		const pct = (t) => `${t / waveform.duration * 100}%`;
		const width = (a, b) => `${(b - a) / waveform.duration * 100}%`;
		const labels = this.#markerLabels;
		for (const section of waveform.sections.slice(1)) {
			const line = document.createElement("div");
			line.className = "boundary";
			line.style.left = pct(section.start);
			this.#marks.append(line);
		}
		if (this.#showVocals) {
			for (const span of waveform.vocals) {
				const bar = document.createElement("div");
				bar.className = "vocal-band";
				bar.style.left = pct(span.start);
				bar.style.width = width(span.start, span.end);
				this.#marks.append(bar);
			}
			if (waveform.vocalStart != null) this.#marks.append(this.#badge("vocal-badge", "vocal", "♪", labels.vocalStart, pct(waveform.vocalStart), () => this.jumpToVocals()));
		}
		const choruses = waveform.choruses.length > 0 ? waveform.choruses : waveform.sections.filter((s) => s.start === waveform.highlight);
		for (const chorus of choruses) {
			const band = document.createElement("div");
			band.className = "highlight-band";
			band.style.left = pct(chorus.start);
			band.style.width = width(chorus.start, chorus.end);
			this.#marks.append(band);
		}
		for (const t of this.highlights) this.#marks.append(this.#badge("highlight-badge", "highlight", "★", labels.chorus, pct(t), () => {
			this.player?.seek(t);
		}));
	}
	#badge(className, part, glyph, title, left, onClick) {
		const badge = document.createElement("button");
		badge.className = className;
		badge.setAttribute("part", part);
		badge.textContent = glyph;
		badge.title = title;
		badge.style.left = left;
		badge.addEventListener("pointerdown", (e) => e.stopPropagation());
		badge.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		return badge;
	}
	connectedCallback() {
		super.connectedCallback();
		this.#resizeObserver.observe(this);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		this.#resizeObserver.disconnect();
	}
	#scheduleMask() {
		cancelAnimationFrame(this.#maskJob);
		this.#maskJob = requestAnimationFrame(() => void this.#drawMask());
	}
	/**
	* Draws the waveform once into an alpha mask; the colours come from CSS, so palette changes
	* animate without redrawing and each frame only moves a clip edge.
	*/
	async #drawMask() {
		const waveform = this.#waveform;
		const width = this.clientWidth;
		const height = this.clientHeight;
		if (!waveform || width === 0 || height === 0 || width === this.#maskWidth) return;
		this.#maskWidth = width;
		const dpr = window.devicePixelRatio || 1;
		const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
		const ctx = canvas.getContext("2d");
		const bar = Math.max(1, Math.round(2 * dpr));
		const gap = Math.max(1, Math.round(1 * dpr));
		const bars = Math.floor(canvas.width / (bar + gap));
		const mid = canvas.height / 2;
		const { peak, rms } = waveform;
		const n = peak.length;
		const gain = Math.min(1 / Math.max(...peak, .001), 4);
		for (let i = 0; i < bars; i++) {
			const start = Math.floor(i * n / bars);
			const end = Math.max(start + 1, Math.floor((i + 1) * n / bars));
			let p = 0;
			let r = 0;
			for (let j = start; j < end && j < n; j++) {
				p = Math.max(p, peak[j]);
				r = Math.max(r, rms[j]);
			}
			const x = i * (bar + gap);
			const ph = Math.max(dpr, Math.min(1, p * gain) * mid);
			const rh = Math.max(dpr, Math.min(1, r * gain * 1.4) * mid);
			ctx.fillStyle = "rgb(0 0 0 / 0.42)";
			ctx.fillRect(x, mid - ph, bar, ph * 2);
			ctx.fillStyle = "#000";
			ctx.fillRect(x, mid - rh, bar, rh * 2);
		}
		const blob = await canvas.convertToBlob();
		if (waveform !== this.#waveform) return;
		if (this.#maskUrl) URL.revokeObjectURL(this.#maskUrl);
		this.#maskUrl = URL.createObjectURL(blob);
		this.#wave.style.setProperty("--_mask", `url("${this.#maskUrl}")`);
		requestAnimationFrame(() => this.toggleAttribute("wave-ready", true));
	}
	render(now) {
		const player = this.player;
		const duration = player?.duration ?? 0;
		const position = player?.position(now) ?? 0;
		const playedRatio = duration > 0 ? position / duration : 0;
		const shownRatio = this.#dragRatio ?? playedRatio;
		const width = this.clientWidth;
		this.#fill.style.transform = `scaleX(${shownRatio})`;
		this.#thumb.style.transform = `translateX(${shownRatio * width}px)`;
		this.#hoverFill.style.transform = `scaleX(${this.#hoverRatio ?? 0})`;
		if (this.#waveform) {
			this.#wavePlayed.style.clipPath = `inset(0 ${(1 - shownRatio) * 100}% 0 0)`;
			this.#waveHover.style.clipPath = `inset(0 ${(1 - (this.#hoverRatio ?? 0)) * 100}% 0 0)`;
			this.#playhead.style.transform = `translateX(${shownRatio * width}px)`;
		}
		const bubbleRatio = this.#dragRatio ?? this.#hoverRatio;
		if (bubbleRatio != null && duration > 0) {
			const t = bubbleRatio * duration;
			this.#bubble.style.left = `${Math.min(Math.max(bubbleRatio * width, 28), width - 28)}px`;
			this.#bubbleTime.textContent = formatTime(t);
			this.#bubbleDelta.textContent = this.#dragRatio != null ? `${t >= position ? "+" : "−"}${formatTime(Math.abs(t - position))}` : "";
		}
		const ariaText = `${formatTime(position)} / ${formatTime(duration)}`;
		if (ariaText !== this.#ariaText) {
			this.#ariaText = ariaText;
			this.setAttribute("aria-valuemin", "0");
			this.setAttribute("aria-valuemax", String(Math.round(duration)));
			this.setAttribute("aria-valuenow", String(Math.round(position)));
			this.setAttribute("aria-valuetext", ariaText);
		}
	}
	#ratioAt(clientX) {
		const rect = this.getBoundingClientRect();
		return rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0;
	}
	#onPointerDown = (e) => {
		if (e.button !== 0 || !this.player?.duration) return;
		this.#pointerId = e.pointerId;
		this.setPointerCapture(e.pointerId);
		this.#dragRatio = this.#ratioAt(e.clientX);
		this.toggleAttribute("dragging", true);
	};
	#onPointerMove = (e) => {
		const ratio = this.#ratioAt(e.clientX);
		this.#hoverRatio = ratio;
		if (this.#pointerId === e.pointerId) this.#dragRatio = ratio;
	};
	#onPointerUp = (e) => {
		if (this.#pointerId !== e.pointerId) return;
		const ratio = this.#dragRatio;
		this.#endDrag();
		const duration = this.player?.duration;
		if (ratio != null && duration) {
			this.player.seek(ratio * duration);
			this.dispatchEvent(new CustomEvent("oto-seek", {
				detail: { position: ratio * duration },
				bubbles: true
			}));
		}
	};
	#cancelDrag = () => this.#endDrag();
	#endDrag() {
		if (this.#pointerId != null && this.hasPointerCapture(this.#pointerId)) this.releasePointerCapture(this.#pointerId);
		this.#pointerId = null;
		this.#dragRatio = null;
		this.removeAttribute("dragging");
	}
	#onKeyDown = (e) => {
		const player = this.player;
		const duration = player?.duration;
		if (!player || !duration) return;
		if (e.key === "Escape" && this.#dragRatio != null) {
			this.#endDrag();
			return;
		}
		if (e.key === "PageDown" || e.key === "PageUp") {
			e.preventDefault();
			if (e.key === "PageDown") this.nextSection();
			else this.previousSection();
			return;
		}
		const pos = player.position();
		const target = e.key === "ArrowLeft" ? pos - KEY_STEP : e.key === "ArrowRight" ? pos + KEY_STEP : e.key === "Home" ? 0 : e.key === "End" ? duration : null;
		if (target == null) return;
		e.preventDefault();
		player.seek(target);
	};
};
customElements.define("oto-seekbar", OtoSeekbar);
// src/transport.ts
var ICON_PLAY$1 = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`;
var ICON_PAUSE$1 = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>`;
var template$1 = document.createElement("template");
template$1.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #7c5cff);
    --_text: var(--oto-text, #f5f5f7);
    --_muted: var(--oto-muted, rgb(245 245 247 / 0.55));
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--_text);
    font: 500 13px/1 system-ui, sans-serif;
  }
  button {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--_accent);
    /* Accents are kept light for dark UIs, so a dark glyph reads better than white. */
    color: var(--oto-on-accent, var(--oto-base, #111118));
    cursor: pointer;
    box-shadow: 0 6px 20px color-mix(in srgb, var(--_accent) 45%, transparent);
    transition: transform 140ms cubic-bezier(.3,1.6,.5,1), filter 140ms;
  }
  button:hover { transform: scale(1.06); filter: brightness(1.1); }
  button:active { transform: scale(0.94); }
  button:disabled { opacity: 0.4; cursor: default; transform: none; }
  svg { width: 22px; height: 22px; fill: currentColor; }
  .time { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
  .total { color: var(--_muted); }
  .spacer { flex: 1; }
  input[type="range"] { width: 96px; accent-color: var(--_accent); }
</style>
<button part="play" aria-label="Play"></button>
<span class="time" part="time"><span class="current">0:00</span> <span class="total">/ --:--</span></span>
<span class="spacer"></span>
<input part="volume" type="range" min="0" max="1" step="0.01" aria-label="Volume" />
`;
/** `<oto-transport>`: play/pause, elapsed/total time, volume. */
var OtoTransport = class extends PlayerElement {
	#button;
	#current;
	#total;
	#volume;
	#shown = {
		playing: null,
		current: "",
		total: ""
	};
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.append(template$1.content.cloneNode(true));
		this.#button = root.querySelector("button");
		this.#current = root.querySelector(".current");
		this.#total = root.querySelector(".total");
		this.#volume = root.querySelector("input");
		this.#button.addEventListener("click", () => void this.player?.toggle());
		this.#volume.addEventListener("input", () => void this.player?.setVolume(Number(this.#volume.value)));
	}
	render(now) {
		const player = this.player;
		const playing = player?.state === "playing";
		if (playing !== this.#shown.playing) {
			this.#shown.playing = playing;
			this.#button.innerHTML = playing ? ICON_PAUSE$1 : ICON_PLAY$1;
			this.#button.setAttribute("aria-label", playing ? "Pause" : "Play");
		}
		this.#button.disabled = !player?.snapshot.path;
		const current = formatTime(player?.position(now) ?? 0);
		if (current !== this.#shown.current) this.#current.textContent = this.#shown.current = current;
		const total = `/ ${formatTime(player?.duration)}`;
		if (total !== this.#shown.total) this.#total.textContent = this.#shown.total = total;
		if (player && this.shadowRoot.activeElement !== this.#volume) this.#volume.value = String(player.snapshot.volume);
	}
};
customElements.define("oto-transport", OtoTransport);
// src/media.ts
/** Tags and stream parameters, read without starting playback. */
function getMediaInfo(path) {
	return invoke("plugin:otoiro|media_info", { path });
}
/** Embedded cover art as a Blob, or null. */
async function getCoverArt(path, type = "image/jpeg") {
	const bytes = await invoke("plugin:otoiro|cover_art", { path });
	return bytes.byteLength > 0 ? new Blob([bytes], { type }) : null;
}
/** Amplitude overview of the whole file. Decodes the file once, so expect ~0.3–1 s per track. */
function getWaveform(path, buckets = 2048) {
	return invoke("plugin:otoiro|waveform", {
		path,
		buckets
	});
}
function fileName(path) {
	return path.split(/[\\/]/).pop() ?? path;
}
// src/theme.ts
var HUE_BINS = 24;
var hsl = (h, s, l) => `hsl(${(h % 360 + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
var clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function rgbToHsl(r, g, b) {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return {
		h: 0,
		s: 0,
		l
	};
	const s = d / (1 - Math.abs(2 * l - 1));
	return {
		h: max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60,
		s,
		l
	};
}
function build(h1, h2, saturation) {
	const s = clamp(saturation, .12, .9);
	return {
		accent: hsl(h1, s, .64),
		accent2: hsl(h2, s, .6),
		base: hsl(h1, Math.min(s, .45), .07),
		glow: hsl(h1, Math.min(s, .7), .28)
	};
}
/** Picks the dominant vivid hue (and a contrasting second one) from an image. */
async function paletteFromImage(image) {
	const size = 48;
	const bitmap = await createImageBitmap(image, {
		resizeWidth: size,
		resizeHeight: size,
		resizeQuality: "low"
	});
	const ctx = new OffscreenCanvas(size, size).getContext("2d");
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	const { data } = ctx.getImageData(0, 0, size, size);
	const weight = new Float64Array(HUE_BINS);
	const sumX = new Float64Array(HUE_BINS);
	const sumY = new Float64Array(HUE_BINS);
	const sumS = new Float64Array(HUE_BINS);
	let total = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 128) continue;
		const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
		const w = s * s * Math.max(0, 1 - Math.abs(l - .5) * 1.8);
		if (w <= 0) continue;
		const bin = Math.floor(h / 360 * HUE_BINS) % HUE_BINS;
		const rad = h * Math.PI / 180;
		weight[bin] += w;
		sumX[bin] += Math.cos(rad) * w;
		sumY[bin] += Math.sin(rad) * w;
		sumS[bin] += s * w;
		total += w;
	}
	const hueOf = (bin) => Math.atan2(sumY[bin], sumX[bin]) * 180 / Math.PI;
	const order = [...weight.keys()].sort((a, b) => weight[b] - weight[a]);
	const first = order[0];
	if (total < 1 || weight[first] === 0) return build(230, 260, .12);
	const h1 = hueOf(first);
	const s1 = sumS[first] / weight[first];
	const second = order.find((bin) => {
		if (weight[bin] < weight[first] * .15) return false;
		return Math.abs((hueOf(bin) - h1 + 540) % 360 - 180) >= 40;
	});
	return build(h1, second != null ? hueOf(second) : h1 + 38, s1 * 1.1);
}
function hash(text) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967295;
}
/**
* Colour from sound: dark/bassy tracks lean indigo, bright ones lean warm. `seed` (e.g. the
* path) adds a small stable offset so similar tracks still look distinct.
*/
function paletteFromSound(brightness, loudness, seed) {
	const h1 = 250 + clamp((brightness - .5) / .3, 0, 1) * 140 + (hash(seed) - .5) * 36;
	return build(h1, h1 + 42, .5 + clamp(loudness, 0, 1) * .6);
}
var DEFAULT_PALETTE = build(255, 190, .85);
/** Sets `--oto-accent`, `--oto-accent-2`, `--oto-base`, `--oto-glow` on `el`. */
function applyPalette(el, palette) {
	el.style.setProperty("--oto-accent", palette.accent);
	el.style.setProperty("--oto-accent-2", palette.accent2);
	el.style.setProperty("--oto-base", palette.base);
	el.style.setProperty("--oto-glow", palette.glow);
}
/**
* Registers the palette variables as typed colours so changing them animates (call once).
* Pair with `transition: --oto-accent 600ms, ...` on the element you apply palettes to.
*/
function registerPaletteProperties() {
	const props = [
		["--oto-accent", DEFAULT_PALETTE.accent],
		["--oto-accent-2", DEFAULT_PALETTE.accent2],
		["--oto-base", DEFAULT_PALETTE.base],
		["--oto-glow", DEFAULT_PALETTE.glow]
	];
	for (const [name, initialValue] of props) try {
		CSS.registerProperty({
			name,
			syntax: "<color>",
			inherits: true,
			initialValue
		});
	} catch {}
}
// src/art.ts
var SPOKES = 120;
/**
* Stand-in "cover" for tracks without artwork: the track's loudness contour wrapped into a
* ring, in the track's own palette. Same file, same picture, so it works as an identity.
*/
function drawSoundArt(canvas, waveform, palette) {
	const ctx = canvas.getContext("2d");
	const { width: w, height: h } = canvas;
	const size = Math.min(w, h);
	const cx = w / 2;
	const cy = h / 2;
	const bg = ctx.createRadialGradient(cx, cy * .8, 0, cx, cy, size * .75);
	bg.addColorStop(0, palette.glow);
	bg.addColorStop(1, palette.base);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	const { rms } = waveform;
	const n = rms.length;
	const gain = Math.min(1 / Math.max(...rms, .001), 6);
	const inner = size * .2;
	const reach = size * .24;
	const stroke = ctx.createLinearGradient(0, 0, w, h);
	stroke.addColorStop(0, palette.accent);
	stroke.addColorStop(1, palette.accent2);
	ctx.strokeStyle = stroke;
	ctx.lineCap = "round";
	ctx.lineWidth = Math.max(1.5, Math.PI * 2 * inner / SPOKES * .55);
	for (let i = 0; i < SPOKES; i++) {
		const start = Math.floor(i * n / SPOKES);
		const end = Math.max(start + 1, Math.floor((i + 1) * n / SPOKES));
		let level = 0;
		for (let j = start; j < end && j < n; j++) level = Math.max(level, rms[j]);
		const len = Math.max(size * .012, Math.min(1, level * gain) * reach);
		const a = i / SPOKES * Math.PI * 2 - Math.PI / 2;
		ctx.beginPath();
		ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
		ctx.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
		ctx.stroke();
	}
	ctx.fillStyle = palette.accent;
	ctx.globalAlpha = .9;
	ctx.beginPath();
	ctx.arc(cx, cy, size * .035, 0, Math.PI * 2);
	ctx.fill();
	ctx.globalAlpha = 1;
}
// src/jog.ts
/** Drag travel for one notch. Small enough to place a single frame by hand. */
var PIXELS_PER_NOTCH = 10;
/** Wheel travel (pixel-mode deltas, e.g. touchpads) for one notch. */
var WHEEL_PIXELS_PER_NOTCH = 60;
/** After this long without turning, the next turn starts from the player's position again. */
var RESYNC_AFTER_MS = 400;
/** Beat length used when the tempo is unknown. */
var FALLBACK_BEAT_SECONDS = .5;
var UNITS = [
	"beat",
	"bar",
	"section",
	"second",
	"frame"
];
var DEFAULT_LABELS = {
	beat: "1 beat",
	bar: "1 bar",
	bars4: "4 bars",
	section: "section",
	second: "1 s",
	seconds10: "10 s",
	frame: "1 frame",
	frames10: "10 frames",
	seconds: "{s} s"
};
/** Dial rotation per notch, so coarser steps also look bigger. */
var DEGREES = {
	frame: 6,
	frames10: 24,
	beat: 12,
	second: 12,
	bar: 30,
	seconds10: 36,
	bars4: 60,
	section: 45
};
var ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`;
var ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>`;
var template = document.createElement("template");
template.innerHTML = `
<style>
  :host {
    --_accent: var(--oto-accent, #22d3ee);
    --_size: var(--oto-jog-size, 120px);
    display: inline-block;
    position: relative;
    width: var(--_size);
    height: var(--_size);
    cursor: ns-resize;
    touch-action: none;
    user-select: none;
    outline: none;
    border-radius: 50%;
  }
  :host(:focus-visible) { box-shadow: 0 0 0 2px color-mix(in srgb, var(--_accent) 70%, transparent); }
  svg.face { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .rotor { transform-origin: 56px 56px; transition: transform 70ms ease-out; }
  .glow {
    fill: none;
    stroke: var(--_accent);
    stroke-width: 4;
    stroke-dasharray: 1 2;
    opacity: 0;
    filter: drop-shadow(0 0 4px var(--_accent));
  }
  .dot { fill: var(--_accent); filter: drop-shadow(0 0 4px var(--_accent)); }
  :host([turning]) .dot { filter: drop-shadow(0 0 7px var(--_accent)); }
  .center {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 46%;
    height: 46%;
    translate: -50% -50%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--_accent);
    cursor: pointer;
  }
  .center:hover { background: rgb(255 255 255 / 0.04); }
  .center svg { width: 15px; height: 15px; fill: currentColor; }
  .label {
    font: 9px/1.2 Consolas, ui-monospace, monospace;
    color: rgb(230 236 240 / 0.6);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  :host([turning]) .label { color: rgb(240 246 250 / 0.95); }
  .unit {
    position: absolute;
    left: 50%;
    bottom: -7px;
    translate: -50% 0;
    padding: 2px 7px 2px 8px;
    border: 1px solid #56616A;
    border-radius: 999px;
    background: #0d1012;
    color: var(--_accent);
    font: 600 9px/1.3 system-ui, "Segoe UI", "Yu Gothic UI", sans-serif;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.5);
    transition: border-color 120ms, background 120ms;
  }
  .unit::after { content: " ▾"; opacity: 0.6; font-size: 8px; }
  .unit:hover { border-color: var(--_accent); }
  :host([modified]) .unit { background: color-mix(in srgb, var(--_accent) 25%, #0d1012); }
</style>
<svg class="face" viewBox="0 0 112 112" aria-hidden="true">
  <g class="rotor">
    <circle cx="56" cy="56" r="55.5" fill="#080A0C" stroke="#63717B" stroke-width="1"/>
    <circle cx="56" cy="56" r="50.5" fill="#171B1F" stroke="#20262B" stroke-width="3"/>
    <circle cx="56" cy="56" r="43.5" fill="#0D1012" stroke="#56616A" stroke-width="1"/>
    <circle cx="56" cy="56" r="36" fill="none" stroke="#46525B" stroke-width="4" stroke-dasharray="1 2"/>
    <circle class="glow" cx="56" cy="56" r="36"/>
    <circle cx="56" cy="56" r="21.5" fill="#070809" stroke="#77848D" stroke-width="1"/>
    <circle class="dot" cx="56" cy="19" r="5"/>
    <rect x="54.5" y="3" width="3" height="13" rx="1" fill="rgb(255 255 255 / 0.9)"/>
  </g>
</svg>
<button class="center" part="center" aria-label="Play">
  <span class="icon"></span>
  <span class="label" part="label">SCRUB</span>
</button>
<button class="unit" part="unit"></button>
`;
/**
* `<oto-jog>`: a jog wheel that scrubs the player audibly.
*
* - Drag vertically (up = forward, 10 px per notch, remainders carried) or use the wheel
*   (down = forward, like scrolling down a page).
* - One notch moves by `unit`: a beat (default; needs `bpm`, otherwise 0.5 s), a bar
*   (`beats-per-bar`, default 4), a second, or a frame at `fps` (default 30).
*   Shift goes one step coarser (beat→bar, bar→4 bars, 1 s→10 s, 1→10 frames); Ctrl moves
*   by a single frame for fine placement.
* - `section` jumps between `sections` boundaries (and keeps playing if it was).
* - The chip at the bottom cycles the unit and shows what a notch means right now.
* - The centre button plays/pauses. Arrow keys turn it when focused.
*
* Fires `oto-jog` (`JogTurnDetail`) on every turn and `oto-jog-unit` (`{ unit }`) when the
* unit changes. Styling: `--oto-accent`, `--oto-jog-size`, `::part(center|label|unit)`.
*/
var OtoJog = class extends PlayerElement {
	#rotor;
	#glow;
	#icon;
	#label;
	#center;
	#unitChip;
	#labels = DEFAULT_LABELS;
	#modifiers = {
		shift: false,
		ctrl: false
	};
	#shownUnit = "";
	#sections = [];
	#angle = 0;
	#pointerId = null;
	#lastY = 0;
	#carry = 0;
	#wheelCarry = 0;
	#cursor = null;
	#lastTurn = 0;
	#pendingScrub = null;
	#flushJob = 0;
	#shownPlaying = null;
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.append(template.content.cloneNode(true));
		this.#rotor = root.querySelector(".rotor");
		this.#glow = root.querySelector(".glow");
		this.#icon = root.querySelector(".icon");
		this.#label = root.querySelector(".label");
		this.#center = root.querySelector(".center");
		this.#unitChip = root.querySelector(".unit");
		this.#unitChip.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.#unitChip.addEventListener("click", () => this.cycleUnit());
		this.tabIndex = 0;
		this.setAttribute("role", "slider");
		this.setAttribute("aria-label", "Jog");
		this.#center.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.#center.addEventListener("click", () => void this.player?.toggle());
		this.addEventListener("pointerdown", this.#onPointerDown);
		this.addEventListener("pointermove", this.#onPointerMove);
		this.addEventListener("pointerup", this.#endTurn);
		this.addEventListener("pointercancel", this.#endTurn);
		this.addEventListener("lostpointercapture", this.#endTurn);
		this.addEventListener("wheel", this.#onWheel, { passive: false });
		this.addEventListener("keydown", this.#onKeyDown);
	}
	/** Frames per second that one notch represents. */
	get fps() {
		const v = Number(this.getAttribute("fps"));
		return Number.isFinite(v) && v > 0 ? v : 30;
	}
	set fps(value) {
		this.setAttribute("fps", String(value));
	}
	/** Tempo for beat/bar steps; null when unknown (beats fall back to 0.5 s). */
	get bpm() {
		const v = Number(this.getAttribute("bpm"));
		return Number.isFinite(v) && v > 0 ? v : null;
	}
	set bpm(value) {
		if (value != null && value > 0) this.setAttribute("bpm", String(value));
		else this.removeAttribute("bpm");
	}
	get beatsPerBar() {
		const v = Number(this.getAttribute("beats-per-bar"));
		return Number.isInteger(v) && v > 0 ? v : 4;
	}
	set beatsPerBar(value) {
		this.setAttribute("beats-per-bar", String(value));
	}
	get unit() {
		const v = this.getAttribute("unit");
		return v && UNITS.includes(v) ? v : "beat";
	}
	set unit(value) {
		this.setAttribute("unit", value);
	}
	/** Overrides the chip texts (e.g. for localisation). */
	set unitLabels(labels) {
		this.#labels = {
			...DEFAULT_LABELS,
			...labels
		};
	}
	/**
	* Section start times (seconds) for the `section` unit, e.g. from `WaveformData.sections`.
	* Without them the section unit falls back to bars.
	*/
	set sections(starts) {
		this.#sections = [...starts].sort((a, b) => a - b);
	}
	/** Switches to the next base unit (beat → bar → section → second → frame → beat). */
	cycleUnit() {
		this.unit = UNITS[(UNITS.indexOf(this.unit) + 1) % UNITS.length];
		this.dispatchEvent(new CustomEvent("oto-jog-unit", {
			detail: { unit: this.unit },
			bubbles: true
		}));
	}
	connectedCallback() {
		super.connectedCallback();
		window.addEventListener("keydown", this.#trackModifiers);
		window.addEventListener("keyup", this.#trackModifiers);
		window.addEventListener("blur", this.#clearModifiers);
	}
	disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.#trackModifiers);
		window.removeEventListener("keyup", this.#trackModifiers);
		window.removeEventListener("blur", this.#clearModifiers);
	}
	#trackModifiers = (e) => {
		this.#modifiers = {
			shift: e.shiftKey,
			ctrl: e.ctrlKey
		};
	};
	#clearModifiers = () => {
		this.#modifiers = {
			shift: false,
			ctrl: false
		};
	};
	#resolve({ shift = false, ctrl = false }) {
		if (ctrl) return "frame";
		const unit = this.unit === "section" && this.#sections.length < 2 ? "bar" : this.unit;
		if (!shift) return unit;
		switch (unit) {
			case "beat": return "bar";
			case "bar": return "bars4";
			case "section": return "section";
			case "second": return "seconds10";
			case "frame": return "frames10";
		}
	}
	#seconds(resolved) {
		const beat = this.bpm ? 60 / this.bpm : FALLBACK_BEAT_SECONDS;
		switch (resolved) {
			case "beat": return beat;
			case "bar": return beat * this.beatsPerBar;
			case "bars4":
			case "section": return beat * this.beatsPerBar * 4;
			case "second": return 1;
			case "seconds10": return 10;
			case "frame": return 1 / this.fps;
			case "frames10": return 10 / this.fps;
		}
	}
	#unitText(resolved) {
		if ((resolved === "beat" || resolved === "bar" || resolved === "bars4") && !this.bpm) {
			const s = Math.round(this.#seconds(resolved) * 100) / 100;
			return this.#labels.seconds.replace("{s}", String(s));
		}
		return this.#labels[resolved];
	}
	render(now) {
		const playing = this.player?.state === "playing";
		if (playing !== this.#shownPlaying) {
			this.#shownPlaying = playing;
			this.#icon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
			this.#center.setAttribute("aria-label", playing ? "Pause" : "Play");
		}
		const turning = now - this.#lastTurn < 700;
		this.toggleAttribute("turning", turning);
		const idle = this.bpm ? `${Math.round(this.bpm)} BPM` : "SCRUB";
		const text = turning && this.#cursor != null ? formatPrecise(this.#cursor) : idle;
		if (this.#label.textContent !== text) this.#label.textContent = text;
		const modified = this.#modifiers.shift || this.#modifiers.ctrl;
		this.toggleAttribute("modified", modified);
		const unitText = this.#unitText(this.#resolve(this.#modifiers));
		if (unitText !== this.#shownUnit) {
			this.#shownUnit = unitText;
			this.#unitChip.textContent = unitText;
			this.#unitChip.title = `1 notch = ${unitText}`;
		}
	}
	/** Turns the dial by whole notches, as a drag/wheel/key would. */
	turn(notches, { shift = false, ctrl = false } = {}) {
		if (notches === 0) return;
		const resolved = this.#resolve({
			shift,
			ctrl
		});
		const step = this.#seconds(resolved);
		this.#angle = (this.#angle + notches * DEGREES[resolved]) % 360;
		this.#rotor.style.transform = `rotate(${this.#angle}deg)`;
		this.#glow.animate([{ opacity: .9 }, { opacity: 0 }], {
			duration: 450,
			easing: "ease-out"
		});
		const now = performance.now();
		const player = this.player;
		if (this.#cursor == null || now - this.#lastTurn > RESYNC_AFTER_MS) this.#cursor = player?.position() ?? 0;
		this.#lastTurn = now;
		const duration = player?.duration ?? Infinity;
		const from = this.#cursor;
		if (resolved === "section") {
			let target = from;
			for (let i = 0; i < Math.abs(notches); i++) target = notches > 0 ? this.#sections.find((t) => t > target + .25) ?? duration : this.#sections.filter((t) => t < target - .25).pop() ?? 0;
			this.#cursor = Math.min(Math.max(target, 0), duration);
			if (player?.snapshot.path) player.seek(this.#cursor);
		} else {
			this.#cursor = Math.min(Math.max(from + notches * step, 0), duration);
			if (player?.snapshot.path) this.#queueScrub(this.#cursor);
		}
		const delta = this.#cursor - from;
		this.dispatchEvent(new CustomEvent("oto-jog", {
			detail: {
				notches,
				delta,
				position: this.#cursor
			},
			bubbles: true
		}));
	}
	/** At most one scrub per frame; fast drags just move the target further. */
	#queueScrub(position) {
		this.#pendingScrub = position;
		if (this.#flushJob) return;
		this.#flushJob = requestAnimationFrame(() => {
			this.#flushJob = 0;
			const target = this.#pendingScrub;
			this.#pendingScrub = null;
			if (target != null) this.player?.scrub(target);
		});
	}
	#onPointerDown = (e) => {
		if (e.button !== 0) return;
		this.setPointerCapture(e.pointerId);
		this.#pointerId = e.pointerId;
		this.#lastY = e.clientY;
		this.#carry = 0;
		e.preventDefault();
		this.focus();
	};
	#onPointerMove = (e) => {
		if (this.#pointerId !== e.pointerId) return;
		this.#carry += (this.#lastY - e.clientY) / PIXELS_PER_NOTCH;
		this.#lastY = e.clientY;
		const notches = Math.trunc(this.#carry);
		if (notches !== 0) {
			this.#carry -= notches;
			this.turn(notches, {
				shift: e.shiftKey,
				ctrl: e.ctrlKey
			});
		}
	};
	#endTurn = (e) => {
		if (this.#pointerId !== e.pointerId) return;
		if (this.hasPointerCapture(e.pointerId)) this.releasePointerCapture(e.pointerId);
		this.#pointerId = null;
		this.#carry = 0;
	};
	#onWheel = (e) => {
		e.preventDefault();
		const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		let notches;
		if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
			this.#wheelCarry += delta / WHEEL_PIXELS_PER_NOTCH;
			notches = Math.trunc(this.#wheelCarry);
			if (notches === 0 && Math.abs(delta) >= WHEEL_PIXELS_PER_NOTCH) notches = Math.sign(delta);
			this.#wheelCarry -= notches;
		} else notches = Math.sign(delta);
		this.turn(notches, {
			shift: e.shiftKey,
			ctrl: e.ctrlKey
		});
	};
	#onKeyDown = (e) => {
		const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
		if (dir !== 0) {
			e.preventDefault();
			this.turn(dir, {
				shift: e.shiftKey,
				ctrl: e.ctrlKey
			});
		} else if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			this.player?.toggle();
		}
	};
};
/** m:ss.ff-style readout with hundredths, for fine positioning. */
function formatPrecise(seconds) {
	const cs = Math.floor(seconds % 1 * 100);
	return `${formatTime(seconds)}.${String(cs).padStart(2, "0")}`;
}
customElements.define("oto-jog", OtoJog);
export { DEFAULT_PALETTE, OtoJog, OtoSeekbar, OtoTransport, Player, PlayerElement, applyPalette, drawSoundArt, fileName, formatTime, getCoverArt, getMediaInfo, getWaveform, paletteFromImage, paletteFromSound, registerPaletteProperties };
