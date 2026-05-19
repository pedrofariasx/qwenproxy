/*
 * File: qwen.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-12
 */

import { v4 as uuidv4 } from "uuid";
import { getBasicHeaders, getQwenHeaders } from "./playwright.ts";

export class RetryableQwenStreamError extends Error {
	readonly retryAfterMs: number;

	constructor(message: string, retryAfterMs: number) {
		super(message);
		this.name = "RetryableQwenStreamError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class QwenUpstreamError extends Error {
	readonly upstreamCode: string;
	readonly upstreamStatus: number;

	constructor(message: string, upstreamCode: string, upstreamStatus: number) {
		super(message);
		this.name = "QwenUpstreamError";
		this.upstreamCode = upstreamCode;
		this.upstreamStatus = upstreamStatus;
	}
}

interface GlobalWithSession {
	_sessionStates?: Record<string, string | null>;
}

const sessionStates: Record<string, string | null> =
	(globalThis as unknown as GlobalWithSession)._sessionStates || {};
(globalThis as unknown as GlobalWithSession)._sessionStates = sessionStates;

export function updateSessionParent(
	sessionId: string,
	parentId: string | null,
) {
	if (sessionId) {
		sessionStates[sessionId] = parentId;
	}
}

export function clearSessionState(sessionId: string) {
	if (sessionId && sessionStates[sessionId] !== undefined) {
		delete sessionStates[sessionId];
	}
}

export interface QwenMessage {
	fid: string;
	parentId: string | null;
	childrenIds: string[];
	role: "user" | "assistant";
	content: string;
	user_action: string;
	files: unknown[];
	timestamp: number;
	models: string[];
	chat_type: string;
	feature_config: {
		thinking_enabled: boolean;
		output_schema: string;
		research_mode: string;
		auto_thinking: boolean;
		thinking_mode: string;
		thinking_format: string;
		auto_search: boolean;
	};
	extra: {
		meta: {
			subChatType: string;
		};
	};
	sub_chat_type: string;
	parent_id: string | null;
}

export interface QwenPayload {
	stream: boolean;
	version: string;
	incremental_output: boolean;
	chat_id: string | null;
	chat_mode: string;
	model: string;
	parent_id: string | null;
	messages: QwenMessage[];
	timestamp: number;
}

let cachedModels: Array<Record<string, unknown>> | null = null;
let lastModelsFetch = 0;
let nativeToolsDisabled = false;
let disablingNativeToolsInProgress = false;

export async function disableNativeTools(): Promise<void> {
	if (nativeToolsDisabled || disablingNativeToolsInProgress) {
		return;
	}
	disablingNativeToolsInProgress = true;

	try {
		const { headers } = await getQwenHeaders();

		const payload = {
			tools_enabled: {
				web_extractor: false,
				web_search_image: false,
				web_search: false,
				image_gen_tool: false,
				code_interpreter: false,
				history_retriever: false,
				image_edit_tool: false,
				bio: false,
				image_zoom_in_tool: false,
			},
		};

		const response = await fetch(
			"https://chat.qwen.ai/api/v2/users/user/settings/update",
			{
				method: "POST",
				headers: {
					accept: "application/json, text/plain, */*",
					"accept-language": "pt-BR,pt;q=0.9",
					"content-type": "application/json",
					cookie: headers.cookie,
					origin: "https://chat.qwen.ai",
					referer: "https://chat.qwen.ai/",
					"user-agent": headers["user-agent"],
					"x-request-id": uuidv4(),
					"bx-ua": headers["bx-ua"],
					"bx-umidtoken": headers["bx-umidtoken"],
					"bx-v": headers["bx-v"],
				},
				body: JSON.stringify(payload),
			},
		);

		if (!response.ok) {
			const text = await response.text();
			console.error(
				`[Qwen] Failed to disable native tools: ${response.status} - ${text}`,
			);
		} else {
			nativeToolsDisabled = true;
		}
	} catch (err: unknown) {
		console.error(
			`[Qwen] Error disabling native tools: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		disablingNativeToolsInProgress = false;
	}
}

export async function fetchQwenModels(): Promise<
	Array<Record<string, unknown>>
> {
	const now = Date.now();
	if (cachedModels && now - lastModelsFetch < 3600000) {
		// 1 hour cache
		return cachedModels;
	}

	const { cookie, userAgent, bxV } = await getBasicHeaders();

	const response = await fetch("https://chat.qwen.ai/api/models", {
		headers: {
			accept: "application/json, text/plain, */*",
			"accept-language": "pt-BR,pt;q=0.9",
			cookie: cookie,
			referer: "https://chat.qwen.ai/",
			"user-agent": userAgent,
			"x-request-id": uuidv4(),
			"bx-v": bxV,
			timezone: new Date().toString(),
			source: "web",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`,
		);
	}

	const json = await response.json();
	if (json.data && Array.isArray(json.data)) {
		const models = json.data.map((m: Record<string, unknown>) => ({
			id: m.id as string,
			object: "model",
			created:
				((m.info as Record<string, unknown>)?.created_at as number) ||
				Math.floor(Date.now() / 1000),
			owned_by: (m.owned_by as string) || "qwen",
		}));

		// Add -no-thinking versions for models that support thinking
		const extendedModels = [...models];
		for (const m of models) {
			extendedModels.push({
				...m,
				id: `${m.id}-no-thinking`,
			});
		}

		cachedModels = extendedModels;
		lastModelsFetch = now;
		return extendedModels;
	}

	return [];
}

export async function createQwenStream(
	prompt: string,
	enableThinking: boolean,
	modelId: string,
	forcedParentId?: string | null,
): Promise<{
	stream: ReadableStream;
	headers: Record<string, string>;
	uiSessionId: string;
}> {
	const { headers, chatSessionId, parentMessageId } = await getQwenHeaders(
		forcedParentId === null,
	);

	let actualParentId: string | null = parentMessageId;

	if (forcedParentId !== undefined) {
		actualParentId = forcedParentId;
	} else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
		actualParentId = sessionStates[chatSessionId];
	}

	const timestamp = Math.floor(Date.now() / 1000);
	const fid = uuidv4();
	const model = modelId.replace("-no-thinking", "");

	const payload: QwenPayload = {
		stream: true,
		version: "2.1",
		incremental_output: true,
		chat_id: chatSessionId || null,
		chat_mode: "normal",
		model: model,
		parent_id: actualParentId,
		messages: [
			{
				fid: fid,
				parentId: actualParentId,
				childrenIds: [],
				role: "user",
				content: prompt,
				user_action: "chat",
				files: [],
				timestamp: timestamp,
				models: [model],
				chat_type: "t2t",
				feature_config: {
					thinking_enabled: enableThinking,
					output_schema: "phase",
					research_mode: "normal",
					auto_thinking: false,
					thinking_mode: "Thinking",
					thinking_format: "summary",
					auto_search: true,
				},
				extra: {
					meta: {
						subChatType: "t2t",
					},
				},
				sub_chat_type: "t2t",
				parent_id: actualParentId,
			},
		],
		timestamp: timestamp + 1,
	};

	const url = chatSessionId
		? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`
		: "https://chat.qwen.ai/api/v2/chat/completions";

	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"accept-language": "pt-BR,pt;q=0.9",
			"content-type": "application/json",
			cookie: headers.cookie,
			origin: "https://chat.qwen.ai",
			referer: chatSessionId
				? `https://chat.qwen.ai/c/${chatSessionId}`
				: "https://chat.qwen.ai/",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			timezone: new Date().toString().split(" (")[0],
			"user-agent": headers["user-agent"],
			"x-accel-buffering": "no",
			"x-request-id": uuidv4(),
			"bx-ua": headers["bx-ua"],
			"bx-umidtoken": headers["bx-umidtoken"],
			"bx-v": headers["bx-v"],
		},
		body: JSON.stringify(payload),
	});

	const responseContentType = response.headers.get("content-type") || "";

	if (responseContentType.includes("application/json")) {
		const responseText = await response.text();

		try {
			const errorJson = JSON.parse(responseText);
			if (
				errorJson?.data?.details?.includes("chat is in progress") ||
				errorJson?.data?.details?.includes("The chat is in progress")
			) {
				const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
				throw new RetryableQwenStreamError(
					`Qwen: ${errorJson.data.details}`,
					retryAfterMs,
				);
			}
			if (
				errorJson?.data?.details?.includes("is not exist") ||
				errorJson?.data?.details?.includes("not exist") ||
				errorJson?.data?.details?.includes("does not exist")
			) {
				throw new RetryableQwenStreamError(
					`Qwen: ${errorJson.data.details}`,
					0,
				);
			}
			if (errorJson?.success === false) {
				const code = errorJson.data?.code || errorJson.code || "UpstreamError";
				const details =
					errorJson.data?.details ||
					errorJson.message ||
					"Qwen returned an error";
				const wait =
					errorJson.data?.num !== undefined
						? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
						: "";
				let status: number;
				if (code === "RateLimited") status = 429;
				else if (code === "Not_Found") status = 404;
				else status = 502;
				throw new QwenUpstreamError(
					`Qwen upstream error: ${code}: ${details}.${wait}`,
					code,
					status,
				);
			}
		} catch (parseOrRetryError) {
			if (
				parseOrRetryError instanceof RetryableQwenStreamError ||
				parseOrRetryError instanceof QwenUpstreamError
			) {
				throw parseOrRetryError;
			}
		}

		throw new Error(
			`Qwen returned JSON instead of stream: ${responseText.slice(0, 300)}`,
		);
	}

	if (!response.ok || !response.body) {
		const errText = await response.text().catch(() => "");
		throw new Error(
			`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`,
		);
	}

	return { stream: response.body, headers, uiSessionId: chatSessionId };
}
