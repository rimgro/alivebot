import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AliveEvent } from "../store/events.js";
import { isOnboardingEvent, OnboardingStore } from "../store/onboarding.js";

export function createOnboardingTool(input: {
	stateDir: string;
	currentEvents: () => AliveEvent[];
}) {
	const store = new OnboardingStore(input.stateDir);
	const preference = () => Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]));
	return defineTool({
		name: "onboarding",
		label: "Conversation preferences",
		description: "Inspect, correct or forget this private conversation's onboarding preferences. Never blocks a task. Save only explicitly stated preferences; never infer personality or import private sources. Mutations need the latest human event id and an exact quote supporting the requested change. Show saved values when asked. null removes one field; reset removes all fields and allows intake again; skip stops intake while preserving saved values. This does not erase history or semantic memory.",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("update"), Type.Literal("complete"), Type.Literal("skip"), Type.Literal("reset")]),
			thread: Type.String(),
			event_id: Type.Optional(Type.String()),
			evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
			preferences: Type.Optional(Type.Object({ language: preference(), tone: preference(), detail: preference(), updates: preference(), focus: preference() }, { additionalProperties: false })),
		}),
		execute: async (_id, params) => {
			const events = input.currentEvents().filter(event => event.thread === params.thread && isOnboardingEvent(event));
			const event = events.at(-1);
			if (!event) throw new Error("Onboarding is only available for a current private human conversation");
			const payload = event.payload as { module?: string; userText?: string; transcription?: { status?: string; text?: string } } | undefined;
			// Telegram event.text can include somebody else's quoted reply. Legacy
			// events without the original body need a fresh human message for writes.
			const humanTexts = payload?.module === "telegram"
				? [payload.userText, ...(payload.transcription?.status === "transcribed" ? [payload.transcription.text] : [])]
				: [event.text];
			if (params.action !== "status" && (params.event_id !== event.id || !params.evidence?.trim() || !humanTexts.some(text => typeof text === "string" && text.includes(params.evidence!)))) {
				throw new Error("Use the latest human event_id and an exact quote from its text as evidence");
			}
			if (params.action === "status" && params.preferences) throw new Error("status cannot change preferences");
			const state = params.action === "status" ? store.get(params.thread) : store.change(params.thread, params.action, event, params.preferences);
			return { content: [{ type: "text" as const, text: JSON.stringify({ thread: params.thread, currentEventId: event.id, ...state }) }], details: { thread: params.thread, state } };
		},
	});
}
