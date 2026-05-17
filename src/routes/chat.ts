/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import { createQwenStream, updateSessionParent } from "../services/qwen.ts";
import { StreamingToolParser } from "../tools/parser.ts";
import type { Message, OpenAIRequest } from "../utils/types.ts";

function getIncrementalDelta(oldStr: string, newStr: string): string {
	if (!oldStr) return newStr;
	if (newStr === oldStr) return "";
	if (newStr.startsWith(oldStr)) return newStr.substring(oldStr.length);
	// If it doesn't start with oldStr, assume it's a delta
	return newStr;
}

function parseQwenErrorPayload(
	raw: string,
): { message: string; status: number } | null {
	const text = raw.trim();
	if (!text || text.startsWith("data: ")) return null;

	try {
		const payload = JSON.parse(text);
		if (payload && payload.success === false) {
			const code = payload.data?.code || payload.code || "UpstreamError";
			const details =
				payload.data?.details || payload.message || "Qwen returned an error";
			const wait =
				payload.data?.num !== undefined
					? ` Wait about ${payload.data.num} hour(s) before trying again.`
					: "";
			const status = code === "RateLimited" ? 429 : 502;
			return {
				message: `Qwen upstream error: ${code}: ${details}.${wait}`,
				status,
			};
		}
		if (payload?.error) {
			const msg =
				typeof payload.error === "string"
					? payload.error
					: payload.error.message || JSON.stringify(payload.error);
			return { message: `Qwen upstream error: ${msg}`, status: 502 };
		}
	} catch {
		// Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
		// instead of silently returning an empty assistant message.
		return {
			message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`,
			status: 502,
		};
	}

	return null;
}

export async function chatCompletions(c: Context) {
	try {
		const body: OpenAIRequest = await c.req.json();
		const isStream = body.stream ?? false;

		// Extract the prompt
		let prompt = "";
		const messages = body.messages || [];
		let systemPrompt = "";

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			let contentStr = "";
			if (Array.isArray(msg.content)) {
				contentStr = msg.content
					.map(
						(c: Record<string, unknown>) =>
							(c.text as string) || JSON.stringify(c),
					)
					.join("\n");
			} else if (typeof msg.content === "object" && msg.content !== null) {
				contentStr = JSON.stringify(msg.content);
			} else {
				contentStr = msg.content || "";
			}

			if (msg.role === "system") {
				systemPrompt += `${contentStr}\n\n`;
			} else if (i === messages.length - 1) {
				if (msg.role === "user") {
					prompt += `User: ${contentStr}\n\n`;
				} else if (msg.role === "assistant") {
					let assistantContent = contentStr;
					const msgWithReasoning = msg as Message & {
						reasoning_content?: string;
					};
					if (msgWithReasoning.reasoning_content) {
						assistantContent = `<think>\n${msgWithReasoning.reasoning_content}\n</think>\n${assistantContent}`;
					}
					if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
						for (const tc of msg.tool_calls) {
							let args = tc.function?.arguments || "{}";
							if (typeof args !== "string") args = JSON.stringify(args);
							assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
						}
					}
					prompt += `Assistant: ${assistantContent.trim()}\n\n`;
				} else if (msg.role === "tool" || msg.role === "function") {
					prompt += `Tool Response (${msg.name || "tool"}): ${contentStr}\n\n`;
				}
			}
		}

		// Inject tools instructions
		const bodyWithTools = body as OpenAIRequest & {
			tools?: Array<Record<string, unknown>>;
			tool_choice?: Record<string, unknown>;
		};
		if (
			bodyWithTools.tools &&
			Array.isArray(bodyWithTools.tools) &&
			bodyWithTools.tools.length > 0
		) {
			// Better formatting for tools
			const formattedTools = bodyWithTools.tools.map(
				(t: Record<string, unknown>) => {
					if (t.type === "function") {
						const func = t.function as Record<string, unknown>;
						return {
							name: func.name as string,
							description: (func.description as string) || "",
							parameters: func.parameters,
						};
					}
					return t;
				},
			);
			const toolsJson = JSON.stringify(formattedTools, null, 2);

			systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`;

			if (
				bodyWithTools.tool_choice &&
				typeof bodyWithTools.tool_choice === "object" &&
				bodyWithTools.tool_choice.function
			) {
				const forcedTool = (
					bodyWithTools.tool_choice.function as Record<string, unknown>
				).name as string;
				systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
			}
		}

		const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

		const isThinkingModel = !body.model.includes("no-thinking");

		// A session is new if it doesn't have any assistant messages yet.
		// This handles cases where the first request has [System, User] messages.
		const isNewSession = !messages.some((m) => m.role === "assistant");

		// Empty response retry logic
		let stream: ReadableStream | undefined;
		let uiSessionId = "";
		let retries = 3;
		while (retries > 0) {
			try {
				// If it's a new session, force parent_message_id to null
				const result = await createQwenStream(
					finalPrompt,
					isThinkingModel,
					body.model,
					isNewSession ? null : undefined,
				);
				stream = result.stream;
				uiSessionId = result.uiSessionId;
				break; // Success
			} catch (err) {
				retries--;
				if (retries === 0) throw err;
				// Wait a bit before retrying
				await new Promise((r) => setTimeout(r, 1000));
			}
		}

		const completionId = `chatcmpl-${uuidv4()}`;

		if (!isStream) {
			if (!stream) throw new Error("Failed to create Qwen stream");
			const reader = stream.getReader();
			const decoder = new TextDecoder();

			let currentThoughtIndex = 0;
			let reasoningBuffer = "";
			let lastFullContent = "";
			const toolParser = new StreamingToolParser();
			const toolCallsOut: Array<Record<string, unknown>> = [];
			let buffer = "";
			let completionTokens = 0;
			let promptTokens = Math.ceil(finalPrompt.length / 3.5);
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed?.startsWith("data: ")) continue;

					const dataStr = trimmed.slice(6);
					if (dataStr === "[DONE]") continue;

					try {
						const chunk = JSON.parse(dataStr);

						if (chunk["response.created"]?.response_id) {
							updateSessionParent(
								uiSessionId,
								chunk["response.created"].response_id,
							);
						} else if (chunk.response_id) {
							updateSessionParent(uiSessionId, chunk.response_id);
						}

						if (chunk.usage) {
							if (chunk.usage.output_tokens)
								completionTokens = chunk.usage.output_tokens;
							if (chunk.usage.input_tokens)
								promptTokens = chunk.usage.input_tokens;
						}

						let vStr = "";
						let foundStr = false;
						let isThinkingChunk = false;

						if (chunk.choices?.[0]?.delta) {
							const delta = chunk.choices[0].delta;

							if (delta.phase === "thinking_summary") {
								isThinkingChunk = true;
								if (delta.extra?.summary_thought?.content) {
									const thoughts = delta.extra.summary_thought.content;
									if (thoughts.length > currentThoughtIndex) {
										vStr = thoughts.slice(currentThoughtIndex).join("\n");
										currentThoughtIndex = thoughts.length;
										foundStr = true;
									}
								}
							} else if (delta.phase === "answer") {
								isThinkingChunk = false;
								if (delta.content !== undefined) {
									const newContent = delta.content || "";
									vStr = getIncrementalDelta(lastFullContent, newContent);
									if (vStr) {
										lastFullContent += vStr;
										foundStr = true;
									}
								}
							}
						}

						if (foundStr && vStr !== "") {
							if (vStr === "FINISHED") continue;
							if (isThinkingChunk) {
								reasoningBuffer += vStr;
							} else {
								const { text, toolCalls } = toolParser.feed(vStr);
								if (text) lastFullContent += "";
								for (const tc of toolCalls) {
									toolCallsOut.push({
										id: tc.id,
										type: "function",
										function: {
											name: tc.name,
											arguments: JSON.stringify(tc.arguments),
										},
									});
								}
							}
						}
					} catch (_e) {
						// parse error, ignore partial chunk
					}
				}
			}

			const upstreamError = parseQwenErrorPayload(buffer);
			if (upstreamError) {
				return c.json(
					{ error: { message: upstreamError.message } },
					upstreamError.status as 429 | 502,
				);
			}

			const { text: remainingText, toolCalls: remainingToolCalls } =
				toolParser.flush();
			if (remainingText) {
				// remainingText has already been preserved in lastFullContent by getIncrementalDelta/feed path when present.
			}
			for (const tc of remainingToolCalls) {
				toolCallsOut.push({
					id: tc.id,
					type: "function",
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				});
			}

			const usage = {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
				prompt_tokens_details: { cached_tokens: 0 },
			};
			const message: Record<string, unknown> = {
				role: "assistant",
				content: toolCallsOut.length ? null : lastFullContent,
			};
			if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
			if (toolCallsOut.length) {
				for (let idx = 0; idx < toolCallsOut.length; idx++) {
					toolCallsOut[idx].index = idx;
				}
			}
			if (toolCallsOut.length) message.tool_calls = toolCallsOut;

			return c.json({
				id: completionId,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [
					{
						index: 0,
						message,
						logprobs: null,
						finish_reason: toolCallsOut.length ? "tool_calls" : "stop",
					},
				],
				usage,
			});
		}

		c.header("Content-Type", "text/event-stream");
		c.header("Cache-Control", "no-cache");
		c.header("Connection", "keep-alive");

		return honoStream(c, async (streamWriter) => {
			const writeEvent = async (data: Record<string, unknown>) => {
				await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
			};

			const makeChoice = (
				delta: Record<string, unknown>,
				finishReason: string | null = null,
			) => ({
				index: 0,
				delta,
				logprobs: null,
				finish_reason: finishReason,
			});

			// Send initial chunk
			await writeEvent({
				id: completionId,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [makeChoice({ role: "assistant", content: "" })],
			});

			if (!stream) throw new Error("Failed to create Qwen stream");
			const reader = stream.getReader();
			const decoder = new TextDecoder();

			let _inThinkingState = false;
			const _thinkingFragments: Record<string, boolean> = {};
			let currentThoughtIndex = 0;
			const _currentAppendPath = "";

			let _reasoningBuffer = "";
			let lastFullContent = "";
			const toolParser = new StreamingToolParser();

			let buffer = "";
			let completionTokens = 0;
			let promptTokens = Math.ceil(finalPrompt.length / 3.5);

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed?.startsWith("data: ")) continue;

					const dataStr = trimmed.slice(6);
					if (dataStr === "[DONE]") {
						await streamWriter.write("data: [DONE]\n\n");
						continue;
					}

					try {
						const chunk = JSON.parse(dataStr);

						// Extract response_id for session tracking
						if (chunk["response.created"]?.response_id) {
							updateSessionParent(
								uiSessionId,
								chunk["response.created"].response_id,
							);
						} else if (chunk.response_id) {
							updateSessionParent(uiSessionId, chunk.response_id);
						}

						if (chunk.usage) {
							if (chunk.usage.output_tokens)
								completionTokens = chunk.usage.output_tokens;
							if (chunk.usage.input_tokens)
								promptTokens = chunk.usage.input_tokens;
						}

						let vStr = "";
						let foundStr = false;
						let isThinkingChunk = false;

						if (chunk.choices?.[0]?.delta) {
							const delta = chunk.choices[0].delta;

							if (delta.phase === "thinking_summary") {
								isThinkingChunk = true;
								if (delta.extra?.summary_thought?.content) {
									const thoughts = delta.extra.summary_thought.content;
									if (thoughts.length > currentThoughtIndex) {
										vStr = thoughts.slice(currentThoughtIndex).join("\n");
										currentThoughtIndex = thoughts.length;
										foundStr = true;
									}
								}
							} else if (delta.phase === "answer") {
								isThinkingChunk = false;
								if (delta.content !== undefined) {
									const newContent = delta.content || "";
									vStr = getIncrementalDelta(lastFullContent, newContent);

									if (vStr) {
										lastFullContent += vStr;
										foundStr = true;
									}
								}
							}
						}

						if (foundStr && vStr !== "") {
							if (vStr === "FINISHED") continue;

							if (isThinkingChunk) {
								_inThinkingState = true;
								_reasoningBuffer += vStr;
								await writeEvent({
									id: completionId,
									object: "chat.completion.chunk",
									created: Math.floor(Date.now() / 1000),
									model: body.model,
									choices: [makeChoice({ reasoning_content: vStr })],
								});
							} else {
								_inThinkingState = false;
								const { text, toolCalls } = toolParser.feed(vStr);

								if (text) {
									await writeEvent({
										id: completionId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model: body.model,
										choices: [makeChoice({ content: text })],
									});
								}

								for (const tc of toolCalls) {
									await writeEvent({
										id: completionId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model: body.model,
										choices: [
											makeChoice({
												tool_calls: [
													{
														index:
															toolParser.getEmittedToolCallCount() -
															toolCalls.length +
															toolCalls.indexOf(tc),
														id: tc.id,
														type: "function",
														function: {
															name: tc.name,
															arguments: JSON.stringify(tc.arguments),
														},
													},
												],
											}),
										],
									});
								}
							}
						}
					} catch (_e) {
						// parse error, ignore partial chunk
					}
				}
			}

			const upstreamError = parseQwenErrorPayload(buffer);
			if (upstreamError) {
				await writeEvent({
					id: completionId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: body.model,
					choices: [makeChoice({ content: upstreamError.message })],
				});
				await writeEvent({
					id: completionId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: body.model,
					choices: [makeChoice({}, "stop")],
				});
				await streamWriter.write("data: [DONE]\n\n");
				return;
			}

			// Flush tool parser
			const { text: remainingText, toolCalls: remainingToolCalls } =
				toolParser.flush();
			if (remainingText) {
				await writeEvent({
					id: completionId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: body.model,
					choices: [makeChoice({ content: remainingText })],
				});
			}
			for (const tc of remainingToolCalls) {
				await writeEvent({
					id: completionId,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: body.model,
					choices: [
						makeChoice({
							tool_calls: [
								{
									index:
										toolParser.getEmittedToolCallCount() -
										remainingToolCalls.length +
										remainingToolCalls.indexOf(tc),
									id: tc.id,
									type: "function",
									function: {
										name: tc.name,
										arguments: JSON.stringify(tc.arguments),
									},
								},
							],
						}),
					],
				});
			}

			// Send finish reason
			const usage = {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
				prompt_tokens_details: { cached_tokens: 0 },
			};

			const finalFinishReason =
				toolParser.getEmittedToolCallCount() > 0 ? "tool_calls" : "stop";

			await writeEvent({
				id: completionId,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [makeChoice({}, finalFinishReason)],
				usage: usage,
			});
			await streamWriter.write("data: [DONE]\n\n");
		});
	} catch (err) {
		console.error("Error in chatCompletions:", err);
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: { message } }, 500);
	}
}
