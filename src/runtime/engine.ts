/*
 * File: engine.ts
 * Project: qwenproxy
 * Agent State Machine Engine - core orchestration loop
 * Manages phase transitions, LLM calls, tool execution, and event emission.
 */

import { v4 as uuidv4 } from "uuid";
import type { FunctionToolDefinition, Message } from "../types/openai.ts";
import type { AgentConfig, AgentState } from "./types.ts";

// ─── State Factory ─────────────────────────────────────────────────────────────

function _createInitialState(
	model: string,
	stream: boolean,
	messages: Message[],
	tools: FunctionToolDefinition[],
	config: AgentConfig,
): AgentState {
	const now = Date.now();
	return {
		phase: "idle",
		runId: uuidv4(),
		model,
		stream,
		messages: [...messages],
		tools,
		turn: 0,
		maxTurns: config.maxTurns ?? 10,
		pendingToolCalls: [],
		toolResults: [],
		finalContent: null,
		finishReason: null,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
		},
		error: null,
		timestamps: {
			created: now,
			started: undefined,
			completed: undefined,
			lastTurnAt: undefined,
			erroredAt: undefined,
		},
		state: config.initialState ? { ...config.initialState } : {},
	};
}

// ─── Tool Execution ────────────────────────────────────────────────────────────

const _TOOL_START_TAG = "<" + "tool_call>";
const _TOOL_END_TAG = "</" + "tool_call>";
