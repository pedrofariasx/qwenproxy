/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags
 */

import { v4 as uuidv4 } from "uuid";
import { robustParseJSON } from "../utils/json.ts";
import type { ParsedToolCall } from "./types.ts";

export interface ParserResult {
	/** Text content that is NOT part of a tool call */
	text: string;
	/** Fully parsed tool calls */
	toolCalls: ParsedToolCall[];
}

export class StreamingToolParser {
	private buffer = "";
	private insideTool = false;
	private activeToolStart = "";
	private activeToolEnd = "";
	private emittedToolCallCount = 0;

	private static readonly XML_TAG_RE =
		/<\/?[\w-]+(?:\s+[\w-]+="[^"]*")*\s*\/?>/g;
	private static readonly HTML_ENTITY_RE = /&[a-z]+;|&#\d+;|&#x[a-f0-9]+;/gi;

	private static cleanToolJson(raw: string): string {
		return raw
			.replace(StreamingToolParser.XML_TAG_RE, "")
			.replace(StreamingToolParser.HTML_ENTITY_RE, "")
			.trim();
	}

	private static readonly TOOL_SYNTAXES = [
		{ start: "\u003Ctool_call\u003E", end: "\u003C/tool_call\u003E" },
		{ start: "\u09A4\u09A4", end: "\u2728" },
	] as const;

	private findNextStart(): {
		index: number;
		start: string;
		end: string;
	} | null {
		let bestIndex = -1;
		let bestStart = "";
		let bestEnd = "";

		for (const syntax of StreamingToolParser.TOOL_SYNTAXES) {
			const idx = this.buffer.indexOf(syntax.start);
			if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
				bestIndex = idx;
				bestStart = syntax.start;
				bestEnd = syntax.end;
			}
		}

		return bestIndex !== -1
			? { index: bestIndex, start: bestStart, end: bestEnd }
			: null;
	}

	private partialStartLengthAtBufferEnd(): number {
		let longestMatch = 0;
		for (const syntax of StreamingToolParser.TOOL_SYNTAXES) {
			for (let i = syntax.start.length; i >= 1; i--) {
				if (this.buffer.endsWith(syntax.start.substring(0, i))) {
					if (i > longestMatch) {
						longestMatch = i;
					}
				}
			}
		}
		return longestMatch;
	}

	/**
	 * Feeds a chunk of text into the parser and returns any extracted text and tool calls.
	 */
	feed(chunk: string): ParserResult {
		this.buffer += chunk;
		const result: ParserResult = {
			text: "",
			toolCalls: [],
		};

		while (this.buffer.length > 0) {
			if (!this.insideTool) {
				const startMatch = this.findNextStart();
				if (startMatch) {
					const textToEmit = this.buffer.substring(0, startMatch.index);
					if (textToEmit && this.emittedToolCallCount === 0) {
						result.text += textToEmit;
					}
					this.insideTool = true;
					this.activeToolStart = startMatch.start;
					this.activeToolEnd = startMatch.end;
					this.buffer = this.buffer.substring(
						startMatch.index + startMatch.start.length,
					);
				} else {
					const partialLen = this.partialStartLengthAtBufferEnd();
					const flushIndex = this.buffer.length - partialLen;

					const textToEmit = this.buffer.substring(0, flushIndex);
					if (textToEmit && this.emittedToolCallCount === 0) {
						result.text += textToEmit;
					}
					this.buffer = this.buffer.substring(flushIndex);
					break;
				}
			} else {
				const endIdx = this.buffer.indexOf(this.activeToolEnd);
				if (endIdx !== -1) {
					const rawToolJson = this.buffer.substring(0, endIdx).trim();
					const toolJsonStr = StreamingToolParser.cleanToolJson(rawToolJson);
					try {
						const toolCallObj = robustParseJSON(toolJsonStr) as Record<
							string,
							unknown
						> | null;
						if (
							toolCallObj &&
							typeof toolCallObj === "object" &&
							!Array.isArray(toolCallObj)
						) {
							const toolId = `call_${uuidv4()}`;
							const toolName = toolCallObj.name || "";
							let toolArgs: Record<string, unknown> | null = null;

							if (toolCallObj.arguments !== undefined) {
								if (typeof toolCallObj.arguments === "string") {
									try {
										const parsed = JSON.parse(toolCallObj.arguments);
										if (
											typeof parsed === "object" &&
											parsed !== null &&
											!Array.isArray(parsed)
										) {
											toolArgs = parsed as Record<string, unknown>;
										}
									} catch {
										toolArgs = {};
									}
								} else if (
									typeof toolCallObj.arguments === "object" &&
									toolCallObj.arguments !== null &&
									!Array.isArray(toolCallObj.arguments)
								) {
									toolArgs = toolCallObj.arguments as Record<string, unknown>;
								}
							} else {
								const { name, ...rest } = toolCallObj;
								if (typeof rest === "object" && rest !== null) {
									toolArgs = rest as Record<string, unknown>;
								}
							}

							if (
								typeof toolName === "string" &&
								toolName.trim() !== "" &&
								toolArgs !== null
							) {
								result.toolCalls.push({
									id: toolId,
									name: toolName,
									arguments: toolArgs,
								});
								this.emittedToolCallCount++;
							}
						}
					} catch (_e) {
						console.warn(
							`[StreamingToolParser] Parse failed: ${toolJsonStr.slice(0, 200)}`,
						);
					}

					this.insideTool = false;
					this.activeToolStart = "";
					this.activeToolEnd = "";
					this.buffer = this.buffer.substring(
						endIdx + this.activeToolEnd.length,
					);
				} else {
					// Waiting for TOOL_END, buffer the content
					break;
				}
			}
		}

		return result;
	}

	/**
	 * Finalizes the parsing, attempting to extract any remaining content.
	 */
	flush(): ParserResult {
		const result: ParserResult = {
			text: "",
			toolCalls: [],
		};

		if (this.buffer.length > 0) {
			if (this.insideTool) {
				const cleanedBuffer = StreamingToolParser.cleanToolJson(this.buffer);
				try {
					const toolCallObj = robustParseJSON(cleanedBuffer) as Record<
						string,
						unknown
					> | null;
					if (
						toolCallObj &&
						typeof toolCallObj === "object" &&
						!Array.isArray(toolCallObj)
					) {
						const toolId = `call_${uuidv4()}`;
						const toolName = toolCallObj.name || "";
						let toolArgs: Record<string, unknown> | null = null;
						if (toolCallObj.arguments !== undefined) {
							if (typeof toolCallObj.arguments === "string") {
								try {
									const parsed = JSON.parse(toolCallObj.arguments);
									if (
										typeof parsed === "object" &&
										parsed !== null &&
										!Array.isArray(parsed)
									) {
										toolArgs = parsed as Record<string, unknown>;
									}
								} catch {
									toolArgs = {};
								}
							} else if (
								typeof toolCallObj.arguments === "object" &&
								toolCallObj.arguments !== null &&
								!Array.isArray(toolCallObj.arguments)
							) {
								toolArgs = toolCallObj.arguments as Record<string, unknown>;
							}
						} else {
							const { name: _name, ...rest } = toolCallObj;
							if (typeof rest === "object" && rest !== null) {
								toolArgs = rest as Record<string, unknown>;
							}
						}

						if (
							typeof toolName === "string" &&
							toolName.trim() !== "" &&
							toolArgs !== null
						) {
							result.toolCalls.push({
								id: toolId,
								name: toolName,
								arguments: toolArgs,
							});
							this.emittedToolCallCount++;
						}
					}
				} catch (_e) {
					if (this.emittedToolCallCount === 0) {
						result.text = this.activeToolStart + this.buffer;
					}
				}
			} else if (this.emittedToolCallCount === 0) {
				result.text = this.buffer;
			}
		}

		this.buffer = "";
		return result;
	}

	getEmittedToolCallCount(): number {
		return this.emittedToolCallCount;
	}

	isInsideTool(): boolean {
		return this.insideTool;
	}
}
