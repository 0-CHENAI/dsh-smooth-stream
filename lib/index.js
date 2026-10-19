import Schema from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
//#region src/config.ts
/** Defaults shared by the Host schema and the client-side fallback. */
const DEFAULT_STREAM_CONFIG = {
	mode: "typewriter",
	preset: "silky",
	revealCharsPerSec: 80,
	scrollSpeedPxPerSec: 48,
	maxScrollSpeedPxPerSec: 1e3,
	controlScroll: false
};
/**
* Window global the Host writes into the served index HTML. The browser boot
* graph carries no per-entry config, so this inline script is the only
* Host-to-client configuration channel for a composed web plugin.
*/
const STREAM_BOOT_GLOBAL = "__DSH_SMOOTH_STREAM_CONFIG__";
//#endregion
//#region src/boot-config.ts
/**
* Host-rendered configuration bootstrap for the browser half: each index
* response embeds the schema-validated plugin config as a window global the
* client entry reads at apply time. Same pattern as ui-theme's boot theme.
*/
/** Build the inline script assigning the validated config to the boot global. */
function bootConfigScript(config) {
	return `<script>window[${JSON.stringify(STREAM_BOOT_GLOBAL)}]=${JSON.stringify(config)}<\/script>`;
}
/**
* Insert the config bootstrap immediately after the opening body tag, before
* any plugin bundle runs. Body-less fragments receive it at the end, where
* the HTML parser has already synthesized a body.
* @param html - Raw application index HTML.
* @param config - Schema-validated plugin configuration.
* @returns HTML containing the config bootstrap.
*/
function injectStreamConfig(html, config) {
	const script = bootConfigScript(config);
	const body = /<body(?:\s[^>]*)?>/i.exec(html);
	if (body === null) return `${html}${script}`;
	const at = body.index + body[0].length;
	return `${html.slice(0, at)}${script}${html.slice(at)}`;
}
//#endregion
//#region src/package-meta.ts
/** Host-only package metadata. The package manifest remains the source of truth. */
function packageManifestPath() {
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
	} catch {}
	return join(process.cwd(), "package.json");
}
const manifest = JSON.parse(readFileSync(packageManifestPath(), "utf8"));
function readRequiredString(field) {
	const value = manifest[field];
	if (typeof value !== "string" || value.length === 0) throw new Error(`dsh-smooth-stream: package.json must contain a non-empty ${field}`);
	return value;
}
/** npm package name, read from this plugin's manifest. */
const STREAM_PACKAGE_NAME = readRequiredString("name");
/** Version of the code currently loaded by the Host, read from its manifest. */
const STREAM_PACKAGE_VERSION = readRequiredString("version");
//#endregion
//#region src/profile-installation.ts
/** Host-only profile source inspection and fixed npm update runner. */
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function profileDirectory(baseUrl) {
	if (baseUrl === void 0) return void 0;
	try {
		const url = new URL(baseUrl);
		return url.protocol === "file:" ? fileURLToPath(url) : void 0;
	} catch {
		return;
	}
}
function hasBundle(manifest, packageName) {
	const bundles = record(record(manifest.dsh)?.profile)?.bundles;
	return Array.isArray(bundles) && bundles.includes(packageName);
}
function isLocalSpecifier(specifier) {
	return specifier.startsWith("link:") || specifier.startsWith("file:") || specifier.startsWith(".") || isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier);
}
function isRegistrySpecifier(specifier) {
	return specifier.length > 0 && !specifier.includes(":") && !/[\\/]/.test(specifier);
}
function isNpmSpecifier(specifier, packageName) {
	if (!specifier.startsWith("npm:")) return isRegistrySpecifier(specifier);
	const aliased = specifier.slice(4);
	if (aliased === packageName) return true;
	const prefix = `${packageName}@`;
	return aliased.startsWith(prefix) && isRegistrySpecifier(aliased.slice(prefix.length));
}
/**
* Read only the profile manifest anchored by the current Cordis config tree.
* A malformed or unrelated tree never receives an update affordance.
*/
function inspectProfileInstallation(baseUrl, packageName) {
	const profileDir = profileDirectory(baseUrl);
	if (profileDir === void 0) return { kind: "unmanaged" };
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
	} catch {
		return { kind: "unmanaged" };
	}
	const specifier = record(manifest.dependencies)?.[packageName];
	if (typeof specifier !== "string" || !hasBundle(manifest, packageName)) return { kind: "unmanaged" };
	if (isLocalSpecifier(specifier)) return { kind: "development" };
	if (!isNpmSpecifier(specifier, packageName)) return { kind: "unmanaged" };
	return {
		kind: "npm",
		profileDir,
		profileName: basename(profileDir)
	};
}
/** Run the same fixed package update operation that a profile user would invoke. */
function updateNpmProfilePackage(profileDir, packageName) {
	const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	return new Promise((resolve, reject) => {
		const child = spawn(command, ["update", packageName], {
			cwd: profileDir,
			stdio: "ignore",
			shell: false,
			windowsHide: true
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`dsh-smooth-stream: pnpm update failed (${signal ?? String(code)})`));
		});
	});
}
//#endregion
//#region src/settings-channel.ts
/** Largest request body this channel buffers; settings payloads are tiny. */
const MAX_REQUEST_BYTES = 1 << 20;
/** Endpoint segment shape accepted by the Connection router, mirrored here. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;
/** Envelope discriminator the browser caller sends. */
const CLIENT_REQUEST = "client-request";
/** Envelope discriminator the browser caller expects back. */
const SERVER_RESPONSE = "server-response";
/**
* Register the settings RPC channel on the most capable path the kernel has.
* The registration is an effect of `ctx`, so the caller's fiber owns the
* channel's lifetime on either path.
* @param ctx - Host context carrying `connection` and, when composed, `webServer`.
* @param channel - absolute channel prefix, e.g. `/smooth-stream`.
* @param handler - decoded endpoint handler for every endpoint on the channel.
* @returns Disposer that withdraws the channel.
*/
function registerSettingsChannel(ctx, channel, handler) {
	let connection;
	try {
		connection = ctx.get("connection");
	} catch {
		connection = void 0;
	}
	return ctx.effect(() => {
		try {
			const direct = mountDirectRoute(ctx, connection, channel, handler);
			if (direct !== void 0) return direct;
		} catch {}
		const viaService = tryServiceChannel(connection, channel, handler);
		if (viaService !== void 0) return viaService;
		return mountDirectRoute(ctx, connection, channel, handler);
	}, `dsh-smooth-stream: ${channel} RPC channel`);
}
/**
* Try the service-owned registration, which is the only path that also carries
* the kernel's own channel policy.
* @returns Disposer on success, `undefined` when the kernel cannot mount it.
*/
function tryServiceChannel(connection, channel, handler) {
	const rpc = connection?.rpc;
	if (rpc === void 0 || typeof rpc.handle !== "function") return void 0;
	try {
		const release = rpc.handle(channel, handler, { authority: "loopback" });
		if (typeof release !== "function") return void 0;
		return () => {
			release();
		};
	} catch (error) {
		console.warn(`[dsh-smooth-stream] connection.rpc.handle() could not mount ${channel}; falling back to a directly registered route`, error);
		return;
	}
}
/**
* Mount the channel prefix on the Web server.
*
* With the connection service reachable the route sits behind the connection
* trust fence. On dsh 0.2.x the connection service is unresolvable from a
* plugin scope, so the route is then served unfenced (loopback + the app's
* own token gate only) with a warning — the same trade-off the skill center
* plugin ships on 0.2.x.
* @throws fail-closed when the connection service is reachable but cannot
* fence, so the channel is never exposed without the trust policy.
*/
function mountDirectRoute(ctx, connection, channel, handler) {
	const webServer = ctx.get("webServer");
	const reject = connection?.requestRejection;
	if (webServer === void 0 || typeof webServer.register !== "function") throw new Error(`dsh-smooth-stream: webServer is unavailable, so ${channel} cannot be mounted`);
	if (typeof reject !== "function") {
		if (connection !== void 0) throw new Error(`dsh-smooth-stream: connection.requestRejection is unavailable, so ${channel} cannot be mounted behind the connection trust fence`);
		console.warn(`[dsh-smooth-stream] ${channel} mounted without the connection trust fence (dsh 0.2.x: the connection service is not injectable here); loopback and the app token gate remain the only protections`);
	}
	return webServer.register({
		kind: "prefix",
		path: channel,
		handler: async (req, res) => {
			const rejection = reject?.call(connection, req);
			if (rejection !== void 0) {
				res.writeHead(rejection);
				res.end(rejection === 401 ? "unauthorized" : "forbidden");
				return;
			}
			await answer(req, res, channel, handler);
		}
	});
}
/**
* Decode one request envelope, dispatch it, and write the decoded reply.
* Mirrors the Connection router's own carrier rules: method and endpoint must
* agree, the body must be JSON, and only endpoint failures are results while
* transport failures are statuses.
*/
async function answer(req, res, channel, handler) {
	const endpoint = endpointOf(channel, req.url);
	if (req.method !== "POST" || endpoint === void 0) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	if ((req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		res.writeHead(415);
		res.end("content type must be application/json");
		return;
	}
	const body = await readBody(req);
	if (body.kind === "too-large") {
		res.writeHead(413);
		res.end("request body too large");
		return;
	}
	if (body.kind === "invalid") {
		res.writeHead(400);
		res.end("body is not JSON");
		return;
	}
	const envelope = requestEnvelope(body.value);
	if (envelope === void 0) {
		write(res, rpcIdOf(body.value), {
			ok: false,
			error: {
				code: "gateway/bad-request",
				message: "invalid client-request message",
				details: { issues: [] }
			}
		});
		return;
	}
	if (envelope.method !== endpoint) {
		write(res, envelope.rpcId, {
			ok: false,
			error: {
				code: "gateway/bad-request",
				message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
				details: { issues: [] }
			}
		});
		return;
	}
	const controller = new AbortController();
	res.on("close", () => {
		controller.abort();
	});
	try {
		write(res, envelope.rpcId, await handler(endpoint, envelope.payload, controller.signal));
	} catch (error) {
		res.writeHead(500);
		res.end(`handler failure: ${String(error)}`);
	}
}
/**
* Resolve the channel-relative endpoint for one request path.
* @returns The endpoint, or `undefined` when the path is outside the channel
* or carries a segment the Connection router would refuse.
*/
function endpointOf(channel, rawUrl) {
	const pathname = new URL(rawUrl ?? "/", "http://dsh.internal").pathname;
	if (!pathname.startsWith(`${channel}/`)) return void 0;
	const endpoint = pathname.slice(channel.length + 1);
	if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT.test(segment))) return;
	return endpoint;
}
/** Structure one decoded request, rejecting anything the caller could not have sent. */
function requestEnvelope(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	if (record.type !== CLIENT_REQUEST) return void 0;
	if (typeof record.rpcId !== "string" || typeof record.method !== "string") return void 0;
	return {
		rpcId: record.rpcId,
		method: record.method,
		payload: record.payload
	};
}
/** Recover the correlation id of a malformed envelope so the caller can match it. */
function rpcIdOf(value) {
	const raw = value?.rpcId;
	return typeof raw === "string" ? raw : "invalid-request";
}
/** Write one decoded reply in the envelope the browser caller parses. */
function write(res, rpcId, result) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({
		type: SERVER_RESPONSE,
		rpcId,
		result
	}));
}
/** Buffer one request body, refusing both malformed JSON and unbounded input. */
async function readBody(req) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		bytes += buffer.length;
		if (bytes > MAX_REQUEST_BYTES) return { kind: "too-large" };
		chunks.push(buffer);
	}
	try {
		return {
			kind: "value",
			value: JSON.parse(Buffer.concat(chunks).toString("utf8"))
		};
	} catch {
		return { kind: "invalid" };
	}
}
//#endregion
//#region src/settings.ts
/**
* User-owned settings for the smooth-stream plugin, exposed to the Host
* settings service and edited from the Web Settings "plugin configuration"
* page. This is the runtime-editable complement to {@link StreamConfig}: that
* contract is composed at load and bridged once through the boot global, while
* these preferences live in the durable user-settings document and take effect
* live.
*/
/** Settings namespace registered by the Host and served through the plugin RPC. */
const STREAM_SETTINGS_NS = "smooth-stream";
/** Defaults shared by the Host schema and the client-side fallback. */
const DEFAULT_STREAM_SETTINGS = {
	enabled: true,
	controlScroll: true,
	preset: "silky",
	motionPreference: "auto",
	thinkAutoExpand: true,
	logarithmicFade: true,
	debugEnabled: false,
	debugTuning: {
		revealScale: 1,
		queuePressure: .85,
		maxRevealCps: 600,
		springStiffness: 130,
		springDamping: 24,
		springMass: 1,
		runwayPx: 72,
		reserveResponseMs: 180,
		backpressureMinScale: .55
	}
};
//#endregion
//#region src/settings-bridge.ts
/**
* Diagnostic tuning schema, shared by the legacy user section and the modern
* nested config section so both seams validate identically.
*/
const streamDebugTuningSchema = Schema.object({
	revealScale: Schema.number().min(.25).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.revealScale),
	queuePressure: Schema.number().min(0).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.queuePressure),
	maxRevealCps: Schema.number().min(120).max(1e3).default(DEFAULT_STREAM_SETTINGS.debugTuning.maxRevealCps),
	springStiffness: Schema.number().min(40).max(320).default(DEFAULT_STREAM_SETTINGS.debugTuning.springStiffness),
	springDamping: Schema.number().min(8).max(80).default(DEFAULT_STREAM_SETTINGS.debugTuning.springDamping),
	springMass: Schema.number().min(.5).max(3).default(DEFAULT_STREAM_SETTINGS.debugTuning.springMass),
	runwayPx: Schema.number().min(0).max(120).default(DEFAULT_STREAM_SETTINGS.debugTuning.runwayPx),
	reserveResponseMs: Schema.number().min(60).max(600).default(DEFAULT_STREAM_SETTINGS.debugTuning.reserveResponseMs),
	backpressureMinScale: Schema.number().min(.25).max(1).default(DEFAULT_STREAM_SETTINGS.debugTuning.backpressureMinScale)
});
/** Schema of the user-owned fields, shared by both seam generations. */
const streamSettingsSchema = Schema.object({
	enabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled),
	controlScroll: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.controlScroll),
	preset: Schema.union([
		Schema.const("realtime"),
		Schema.const("balanced"),
		Schema.const("silky")
	]).default(DEFAULT_STREAM_SETTINGS.preset),
	motionPreference: Schema.union([
		Schema.const("auto"),
		Schema.const("force-smooth"),
		Schema.const("force-reduced")
	]).default(DEFAULT_STREAM_SETTINGS.motionPreference),
	thinkAutoExpand: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand),
	logarithmicFade: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.logarithmicFade),
	debugEnabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled),
	debugTuning: streamDebugTuningSchema
});
/**
* Mark a field editable through the profile patch. `extra` is the
* version-agnostic spelling of `volatile()`: the modern kernel reads
* `meta.volatile`, every older schemastery simply ignores the metadata.
*/
function volatileField(schema) {
	return schema.extra("volatile", true);
}
/**
* The modern seam's user-owned fields, declared directly on the plugin's
* `Config`.
*
* They are flat rather than nested under a `settings` object because the seam
* validates the *effective form value* it projects from the composed entry, and
* a nested section is rejected as `Config field "…" is not volatile` on the
* kernels this was tested against (0.1.7-alpha.2). Flat volatile leaves are the
* shape the built-in plugins use (`dsh-client-locale`), and they persist as
* ordinary entry config — the profile patch ends up holding
* `config.enabled`, `config.preset`, … next to the composition fields.
*/
const streamSettingsFields = {
	enabled: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled)),
	controlScroll: volatileField(Schema.boolean().default(DEFAULT_STREAM_CONFIG.controlScroll)),
	preset: volatileField(Schema.union([
		Schema.const("realtime"),
		Schema.const("balanced"),
		Schema.const("silky")
	]).default(DEFAULT_STREAM_SETTINGS.preset)),
	motionPreference: volatileField(Schema.union([
		Schema.const("auto"),
		Schema.const("force-smooth"),
		Schema.const("force-reduced")
	]).default(DEFAULT_STREAM_SETTINGS.motionPreference)),
	thinkAutoExpand: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand)),
	logarithmicFade: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.logarithmicFade)),
	debugEnabled: volatileField(Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled)),
	debugTuning: volatileField(streamDebugTuningSchema)
};
/**
* Resolve the effective user settings from either entry-config shape. Legacy
* kernels keep them in a separate registered namespace; modern kernels keep
* them flat on the entry config, next to the composition fields.
* @param config - Schema-validated plugin configuration.
* @returns Complete settings with both generations' values applied.
*/
function resolveStreamSettings(config) {
	return {
		...DEFAULT_STREAM_SETTINGS,
		...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value !== null && typeof value === "object" && typeof Reflect.get(value, "get") === "function" ? value.get() : value])),
		debugTuning: {
			...DEFAULT_STREAM_SETTINGS.debugTuning,
			...config.debugTuning && typeof Reflect.get(config.debugTuning, "get") === "function" ? config.debugTuning.get() : config.debugTuning ?? {}
		}
	};
}
/** Narrow an unknown form value to the settings shape we own, if it is a record. */
function formConfig(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** Detect the modern projection seam: `register` is what the registry had. */
function isModernSeam(service) {
	return typeof service?.register !== "function" && typeof service?.describe === "function";
}
/**
* Register the user-owned settings over whichever seam this kernel ships.
* @param settingsCtx - Context carrying `ctx.settings`.
* @param config - Resolved plugin config, used as the composition `base` on the
* legacy seam and as the live Volatile-backed fallback on the modern seam.
* @returns Scope the Host half reads and writes through.
*/
function createStreamSettingsScope(settingsCtx, config) {
	const service = settingsCtx.settings;
	if (typeof service?.register === "function") {
		const legacy = service;
		const scope = legacy.register(STREAM_SETTINGS_NS, streamSettingsSchema, {
			...config.preset === void 0 ? {} : { base: { preset: config.preset } },
			applies: "live"
		});
		return {
			get: () => scope.get(),
			update: (patch) => scope.update(patch),
			writable: () => legacy.writable
		};
	}
	const modern = isModernSeam(service) ? service : void 0;
	const formOf = () => modern?.describe().find((form) => form.ns === STREAM_SETTINGS_NS);
	return {
		get: () => resolveStreamSettings({
			...resolveStreamSettings(config),
			...formConfig(formOf()?.value)
		}),
		update: async (patch) => {
			const form = formOf();
			if (form === void 0) throw new Error(`smooth-stream has no configurable profile entry "${STREAM_SETTINGS_NS}"`);
			if (!modern?.writable) throw new Error("smooth-stream settings are read-only");
			await modern.update(STREAM_SETTINGS_NS, patch, form.revision);
		},
		writable: () => modern?.writable === true && formOf() !== void 0
	};
}
//#endregion
//#region src/settings-api.ts
/** Shared wire vocabulary for the plugin-owned settings RPC channel. */
/** Dedicated, loopback-only RPC channel registered by the Host half. */
const STREAM_SETTINGS_RPC_CHANNEL = "/smooth-stream";
/** Endpoints accepted by {@link STREAM_SETTINGS_RPC_CHANNEL}. */
const STREAM_SETTINGS_RPC = {
	read: "settings.read",
	write: "settings.write",
	debugRead: "debug.read",
	debugWrite: "debug.write",
	upgrade: "plugin.upgrade"
};
//#endregion
//#region src/plugin.ts
/** Display name shown by the Host loader while the plugin is mounted. */
const name = "dsh-smooth-stream";
const Config = Schema.object({
	mode: Schema.union(["typewriter", "teleprompter"]).default(DEFAULT_STREAM_CONFIG.mode),
	revealCharsPerSec: Schema.number().min(5).max(200).default(DEFAULT_STREAM_CONFIG.revealCharsPerSec),
	scrollSpeedPxPerSec: Schema.number().min(1).max(200).default(DEFAULT_STREAM_CONFIG.scrollSpeedPxPerSec),
	maxScrollSpeedPxPerSec: Schema.number().min(1).max(2e3).default(DEFAULT_STREAM_CONFIG.maxScrollSpeedPxPerSec),
	...streamSettingsFields
});
/**
* Host half: log the resolved configuration and bridge it to the browser
* half. The web boot graph carries no per-entry config, so the validated
* value is injected into every served index response as a boot global the
* client entry reads at apply time.
* @param ctx - Host context carrying the web server service when composed.
* @param config - Schema-validated configuration with defaults filled.
*/
function apply(ctx, config) {
	console.log(`[dsh-smooth-stream] plugin loaded! mode=${config.mode} preset=${resolveStreamSettings(config).preset} seed=${config.revealCharsPerSec}cps scroll=${config.scrollSpeedPxPerSec}px/s maxScroll=${config.maxScrollSpeedPxPerSec}px/s`);
	ctx.inject(["webServer"], (httpCtx) => {
		httpCtx.effect(() => httpCtx.webServer.tapIndex((html) => injectStreamConfig(html, {
			...config,
			...resolveStreamSettings(config)
		})), "dsh-smooth-stream: boot config bridge");
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const scope = createStreamSettingsScope(settingsCtx, config);
		const mountChannel = (channelCtx) => {
			let upgrade;
			const view = () => {
				const installation = inspectProfileInstallation(settingsCtx.baseUrl, STREAM_PACKAGE_NAME);
				const resolved = scope.get();
				return {
					version: STREAM_PACKAGE_VERSION,
					installation: installation.kind,
					writable: scope.writable(),
					enabled: resolved.enabled,
					controlScroll: resolved.controlScroll,
					preset: resolved.preset ?? config.preset,
					motionPreference: resolved.motionPreference,
					thinkAutoExpand: resolved.thinkAutoExpand,
					logarithmicFade: resolved.logarithmicFade,
					canUpgrade: installation.kind === "npm"
				};
			};
			const debugView = () => {
				const resolved = scope.get();
				return {
					debugEnabled: resolved.debugEnabled,
					tuning: { ...resolved.debugTuning }
				};
			};
			const validDebugTuning = (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
				const tuning = value;
				return typeof tuning.revealScale === "number" && tuning.revealScale >= .25 && tuning.revealScale <= 2 && typeof tuning.queuePressure === "number" && tuning.queuePressure >= 0 && tuning.queuePressure <= 2 && typeof tuning.maxRevealCps === "number" && tuning.maxRevealCps >= 120 && tuning.maxRevealCps <= 1e3 && typeof tuning.springStiffness === "number" && tuning.springStiffness >= 40 && tuning.springStiffness <= 320 && typeof tuning.springDamping === "number" && tuning.springDamping >= 8 && tuning.springDamping <= 80 && typeof tuning.springMass === "number" && tuning.springMass >= .5 && tuning.springMass <= 3 && typeof tuning.runwayPx === "number" && tuning.runwayPx >= 0 && tuning.runwayPx <= 120 && typeof tuning.reserveResponseMs === "number" && tuning.reserveResponseMs >= 60 && tuning.reserveResponseMs <= 600 && typeof tuning.backpressureMinScale === "number" && tuning.backpressureMinScale >= .25 && tuning.backpressureMinScale <= 1;
			};
			const handle = async (endpoint, payload) => {
				if (endpoint === STREAM_SETTINGS_RPC.read) return {
					ok: true,
					value: view()
				};
				if (endpoint === STREAM_SETTINGS_RPC.write) {
					if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.enabled !== "boolean" || typeof payload.controlScroll !== "boolean" || typeof payload.thinkAutoExpand !== "boolean") return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "enabled, controlScroll and thinkAutoExpand must be booleans",
							details: { ns: STREAM_SETTINGS_NS }
						}
					};
					if (!scope.writable()) return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "smooth-stream settings are read-only",
							details: { ns: STREAM_SETTINGS_NS }
						}
					};
					try {
						const next = payload;
						if (next.preset !== void 0 && next.preset !== "realtime" && next.preset !== "balanced" && next.preset !== "silky") return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: "preset must be one of realtime | balanced | silky",
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
						if (next.motionPreference !== void 0 && next.motionPreference !== "auto" && next.motionPreference !== "force-smooth" && next.motionPreference !== "force-reduced") return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: "motionPreference must be one of auto | force-smooth | force-reduced",
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
						if (next.logarithmicFade !== void 0 && typeof next.logarithmicFade !== "boolean") return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: "logarithmicFade must be a boolean",
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
						const hasDebug = next.debugEnabled !== void 0 || next.debugTuning !== void 0;
						if (hasDebug && (typeof next.debugEnabled !== "boolean" || !validDebugTuning(next.debugTuning))) return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: "debugEnabled and debugTuning must be provided together and be valid",
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
						await scope.update({
							enabled: next.enabled,
							controlScroll: next.controlScroll,
							...next.preset === void 0 ? {} : { preset: next.preset },
							...next.motionPreference === void 0 ? {} : { motionPreference: next.motionPreference },
							thinkAutoExpand: next.thinkAutoExpand,
							...next.logarithmicFade === void 0 ? {} : { logarithmicFade: next.logarithmicFade },
							...hasDebug ? {
								debugEnabled: next.debugEnabled,
								debugTuning: next.debugTuning
							} : {}
						});
					} catch (cause) {
						return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: `smooth-stream settings update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
					}
					return {
						ok: true,
						value: view()
					};
				}
				if (endpoint === STREAM_SETTINGS_RPC.debugRead) return {
					ok: true,
					value: debugView()
				};
				if (endpoint === STREAM_SETTINGS_RPC.debugWrite) {
					if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "debug settings must be an object",
							details: { ns: STREAM_SETTINGS_NS }
						}
					};
					const next = payload;
					if (typeof next.debugEnabled !== "boolean" || !validDebugTuning(next.tuning)) return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "debugEnabled and tuning are malformed",
							details: { ns: STREAM_SETTINGS_NS }
						}
					};
					if (!scope.writable()) return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "smooth-stream debug settings are read-only",
							details: { ns: STREAM_SETTINGS_NS }
						}
					};
					try {
						await scope.update({
							debugEnabled: next.debugEnabled,
							debugTuning: next.tuning
						});
					} catch {
						return {
							ok: false,
							error: {
								code: "settings-rejected",
								message: "smooth-stream debug settings update failed",
								details: { ns: STREAM_SETTINGS_NS }
							}
						};
					}
					return {
						ok: true,
						value: debugView()
					};
				}
				if (endpoint === STREAM_SETTINGS_RPC.upgrade) {
					const installation = inspectProfileInstallation(settingsCtx.baseUrl, STREAM_PACKAGE_NAME);
					if (installation.kind !== "npm") return {
						ok: false,
						error: {
							code: "internal",
							message: "smooth-stream is not an npm profile dependency",
							details: {}
						}
					};
					if (upgrade !== void 0) return {
						ok: false,
						error: {
							code: "internal",
							message: "smooth-stream update is already running",
							details: {}
						}
					};
					upgrade = updateNpmProfilePackage(installation.profileDir, STREAM_PACKAGE_NAME);
					try {
						await upgrade;
					} catch {
						return {
							ok: false,
							error: {
								code: "internal",
								message: "smooth-stream update failed",
								details: {}
							}
						};
					} finally {
						upgrade = void 0;
					}
					return {
						ok: true,
						value: { restartRequired: true }
					};
				}
				return {
					ok: false,
					error: {
						code: "internal",
						message: `unknown smooth-stream endpoint ${JSON.stringify(endpoint)}`,
						details: {}
					}
				};
			};
			registerSettingsChannel(channelCtx, STREAM_SETTINGS_RPC_CHANNEL, handle);
		};
		if (typeof settingsCtx.settings.register === "function") settingsCtx.inject(["connection"], mountChannel);
		else settingsCtx.inject(["webServer"], mountChannel);
	});
}
//#endregion
export { Config, apply, name };
